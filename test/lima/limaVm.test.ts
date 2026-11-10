// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Lima VM of Devspaces with the real Lima of the pin (src/core/vm/limaPin.json), on Linux with KVM and QEMU, and the
// disk of a build of the image (DEVSPACES_LIMA_TEST_DISK, vm/build.sh): the download of Lima, the create and the start of
// the VM with the configuration of Devspaces, Docker Engine as root over the SSH of Lima, its Docker socket on this
// computer with the Docker context of the setting devspaces.createDockerContext, the power-off by the idle check of the
// image (also after a connection to that socket), and other CPUs and memory for the next start. Then the scheduled task
// of the user (R-VM-009) with the systemd of the user of the runner. The job "lima test" of
// .github/workflows/vm-image.yml runs it (npm run test:lima).
import * as crypto from 'crypto';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packageBundleOptions, sharedBundleOptions, workerBundleOptions } from '../../scripts/bundleOptions.mjs';
import type { Logger } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { IMAGE_SETTINGS_FILE, REMOTE_MONITOR_CONTAINER, REMOTE_MONITOR_SCRIPT_PATH, REMOTE_MONITOR_STATE_DIR, REMOTE_MONITOR_VOLUME } from '../../src/core/remoteMonitor/protocol';
import { installLima, limaVersion } from '../../src/core/vm/lima';
import { DOCKER_CONTEXT, dockerContextFile, syncDockerContext } from '../../src/core/vm/dockerContext';
import { LimaInstance, limaConfig, limaDockerSocket, limaEnv, limaPaths, limaResources, limaSshArgs, type LimaPaths } from '../../src/core/vm/limaInstance';
import { VM_TASK_UNIT, VM_TASK_WAIT_MS, VmTask, parseVmTaskStamp, vmTaskDefinitionFiles, vmTaskPaths, vmTaskStampText } from '../../src/core/vm/vmTask';
import { LimaSetup } from '../../src/core/vm/limaSetup';
import { LimaVm } from '../../src/core/vm/limaVm';
import { limaVmState } from '../../src/core/vm/vmState';

const logger: Logger = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
  output: (text) => process.stdout.write(text),
};
const runner = new NodeProcessRunner();
/** How long the test waits for the power-off by the idle check: two quiet checks a minute apart, and some slack. */
const POWER_OFF_MS = 8 * 60_000;
/** The image of the stand-in of the Monitor: Node.js 24, as in the helper image of the real Monitor. */
const MONITOR_STAND_IN_IMAGE = 'mirror.gcr.io/library/node:24-alpine';
/** Node.js in a container: GET /_ping on the Docker socket of the engine; exit code 0 for its answer 200. */
const PING_SOCKET_SCRIPT =
  'require("http").get({ socketPath: "/var/run/docker.sock", path: "/_ping" }, (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on("error", (e) => { console.error(e.message); process.exit(1); })';
/** The stand-in of the Monitor ends this long after its start, as an idle Monitor ends when no devspace runs. */
const MONITOR_STAND_IN_SECONDS = 60;
/** A schedule with a time in the last 25 hours, whenever the test runs. */
const TASK_SCHEDULE = '7 6 * * *';

let home: string | undefined;
let paths: LimaPaths;
let limactl: string | undefined;
let instance: LimaInstance | undefined;
/** The scheduled task of the second test, removed at the end also when the test fails. */
let task: VmTask | undefined;

/** Runs `command` as root in the VM over the SSH of Lima, as the transport of Devspaces does. */
async function inVm(command: string): Promise<string> {
  const result = await runner.run('ssh', limaSshArgs(paths, command), { env: limaEnv(process.env, paths), timeoutMs: 5 * 60_000 });
  if (result.exitCode !== 0) throw new Error(`${command}: exit code ${result.exitCode}: ${result.stderr}${result.stdout}`);
  return result.stdout.trim();
}

/** The Docker CLI of the runner with the Docker socket of the VM on this computer, without the Docker settings of the runner. */
function hostDocker(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_CONFIG: path.join(home ?? '', 'docker-config') };
  delete env.DOCKER_HOST;
  delete env.DOCKER_CONTEXT;
  return runner.run('docker', ['-H', `unix://${limaDockerSocket(paths)}`, ...args], { env, timeoutMs: 60_000 });
}

/** The text of a bundle with `options`, as a production build of esbuild.mjs makes it. */
async function bundle(options: esbuild.BuildOptions): Promise<string> {
  const result = await esbuild.build({ ...options, write: false, logLevel: 'silent' });
  return result.outputFiles[0].text;
}

async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

beforeAll(() => {
  if (!process.env.DEVSPACES_LIMA_TEST_DISK) throw new Error('DEVSPACES_LIMA_TEST_DISK names no disk of a build of the image (vm/build.sh).');
  if (limaVersion() === undefined) throw new Error('The pin of Lima names no version yet (scripts/lima-pin.mjs).');
  // A short home folder: Lima puts its sockets into the folder of the instance.
  const folder = fs.mkdtempSync('/tmp/dsl-');
  home = folder;
  paths = limaPaths(folder);
});

afterAll(async () => {
  await task?.remove();
  if (instance !== undefined) {
    const lines = path.join(paths.home, 'devspaces', 'serial.log');
    if (fs.existsSync(lines)) console.log(`The end of the serial console of the VM:\n${fs.readFileSync(lines, 'utf8').slice(-4000)}`);
    await instance.delete().catch((error: unknown) => console.warn(`The VM could not be deleted: ${String(error)}`));
  }
  if (home !== undefined) fs.rmSync(home, { recursive: true, force: true });
});

describe('the Lima VM of Devspaces', () => {
  it('runs Docker Engine as root over the SSH of Lima, and powers itself off when nothing runs', async () => {
    const installed = await installLima({ folder: paths.lima, platform: process.platform, arch: process.arch, logger });
    limactl = installed;
    const version = await runner.run(installed, ['--version'], { timeoutMs: 30_000 });
    expect(version.stdout).toContain(`limactl version ${limaVersion()}`);

    const disk = path.resolve(process.env.DEVSPACES_LIMA_TEST_DISK ?? '');
    const resources = limaResources(os.totalmem(), os.availableParallelism());
    const config = path.join(paths.root, 'lima.yaml');
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(config, limaConfig({ platform: process.platform, arch: process.arch, image: { file: disk, digest: `sha256:${await sha256(disk)}` }, resources }));
    instance = new LimaInstance({ limactl: installed, paths, runner, logger });
    expect(await instance.status()).toBe('missing');
    const log = (line: string): void => console.log(`limactl: ${line}`);
    await instance.create(config, undefined, log);
    expect(await instance.status()).toBe('stopped');
    const started = Date.now();
    await instance.start(undefined, log);
    console.log(`The VM started in ${Math.round((Date.now() - started) / 1000)} seconds (${resources.memoryGiB} GiB, ${resources.cpus} CPUs).`);
    expect(await instance.status()).toBe('running');

    expect(await inVm('id -u')).toBe('0');
    console.log(`Docker Engine ${await inVm("docker version --format '{{.Server.Version}}'")}`);
    await inVm('docker run --rm mirror.gcr.io/library/busybox:latest true');
    // The Docker socket stays root:docker with mode 0660, as in the WSL distribution of Devspaces; the user of Lima reaches
    // it through its ACL entry (the provision script, below through the SSH of Lima). So a container of root without
    // capabilities reaches it, as the build container of the helper image (buildxRunArgs: --cap-drop ALL,
    // no-new-privileges, the socket as a bind mount).
    expect(await inVm("stat -c '%U:%G %a' /run/docker.sock")).toBe('root:docker 660');
    await inVm(`docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock ${MONITOR_STAND_IN_IMAGE} node -e '${PING_SOCKET_SCRIPT}'`);
    // No folder of this computer in the VM, and Lima installed no containerd of its own.
    expect(await inVm("findmnt --noheadings --output TARGET --types virtiofs,9p,fuse.sshfs || true")).toBe('');
    expect(await inVm('command -v nerdctl || true')).toBe('');

    // The Docker socket of the VM in the folder of the instance, which Lima carries over its SSH, and the Docker context
    // of the setting devspaces.createDockerContext for it, with the Docker CLI of the runner and a configuration folder
    // of the test.
    const socket = limaDockerSocket(paths);
    const dockerConfig = path.join(home ?? '', 'docker-config');
    const dockerEnv: NodeJS.ProcessEnv = { ...process.env, DOCKER_CONFIG: dockerConfig };
    delete dockerEnv.DOCKER_HOST;
    delete dockerEnv.DOCKER_CONTEXT;
    const docker = (args: string[]) => runner.run('docker', args, { env: dockerEnv, timeoutMs: 60_000 });
    // Lima sets up the socket after the start; wait for its first answer.
    const socketVersion = async (): Promise<string> => {
      const waited = Date.now();
      for (;;) {
        const result = await docker(['-H', `unix://${socket}`, 'info', '--format', '{{.ServerVersion}}']);
        if (result.exitCode === 0) return result.stdout.trim();
        if (Date.now() - waited > 60_000) throw new Error(`The Docker socket ${socket} did not answer within a minute: ${result.stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    };
    const engineVersion = await inVm("docker info --format '{{.ServerVersion}}'");
    expect(await socketVersion()).toBe(engineVersion);
    const contextDeps = { file: dockerContextFile(dockerConfig), docker };
    expect(await syncDockerContext(contextDeps, `unix://${socket}`)).toEqual({ kind: 'created' });
    expect(await syncDockerContext(contextDeps, `unix://${socket}`)).toEqual({ kind: 'unchanged' });
    const viaContext = await docker(['--context', DOCKER_CONTEXT, 'info', '--format', '{{.ServerVersion}}']);
    expect(viaContext.exitCode, viaContext.stderr).toBe(0);
    expect(viaContext.stdout.trim()).toBe(engineVersion);
    // It never becomes the current context; turning the setting off removes it.
    expect((await docker(['context', 'show'])).stdout.trim()).toBe('default');
    expect(await syncDockerContext(contextDeps, undefined)).toEqual({ kind: 'removed' });
    expect(fs.existsSync(contextDeps.file)).toBe(false);

    const quiet = Date.now();
    while ((await instance.status()) !== 'stopped') {
      if (Date.now() - quiet > POWER_OFF_MS) throw new Error(`The VM did not power itself off within ${POWER_OFF_MS / 60_000} minutes.`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    console.log(`The VM powered itself off ${Math.round((Date.now() - quiet) / 1000)} seconds after its last container.`);

    // Other CPUs and memory for the next start (the settings vmCpus and vmMemoryGiB, LimaVm.ready).
    await instance.setResources({ memoryGiB: 2, cpus: 1 });
    expect((await instance.info()).resources).toEqual({ memoryGiB: 2, cpus: 1 });

    // The second start: the disk of the first one, without cloud-init of a new VM.
    await instance.start(undefined, log);
    expect(await inVm("docker info --format '{{.ServerVersion}}'")).not.toBe('');
    expect(await inVm('nproc')).toBe('1');
    // The Docker socket on this computer again, after the provision script of the second start.
    expect(await socketVersion()).toBe(engineVersion);
    // MemTotal in KiB: 2 GiB less what the kernel keeps for itself.
    const memory = Number(await inVm("awk '/^MemTotal:/ { print $2 }' /proc/meminfo"));
    expect(memory).toBeGreaterThan(1.5 * 2 ** 20);
    expect(memory).toBeLessThanOrEqual(2 * 2 ** 20);
  });

  // R-VM-009: the scheduled task of R-VM-005 with a time of the schedule in the past, through the systemd of the user of
  // the runner (the job "lima test" starts it): the timer and the service as Devspaces writes them, the program of the
  // task (dist/vmTask.js) with Node.js in place of the Electron of VS Code, its wait of 5 minutes, the start of the
  // stopped VM, the start of the Monitor with the settings of the task, and the power-off by the idle check afterwards.
  // The Monitor is a stand-in: a container of Node.js with the name, the volume and the script of the Monitor (the
  // worker's bundle, whose `settings -` stores the settings in the volume); it ends after a minute, as an idle Monitor
  // ends.
  it('the scheduled task starts the stopped VM and the Monitor after a time of the schedule passed, and the VM powers itself off again', async () => {
    if (instance === undefined || limactl === undefined) throw new Error('The first test created no VM.');
    const definitions = vmTaskDefinitionFiles('linux', os.homedir());
    const present = definitions.filter((file) => fs.existsSync(file));
    if (present.length > 0) throw new Error(`A scheduled task of Devspaces exists on this computer (${present.join(', ')}); the test would replace it.`);

    // The stand-in of the Monitor in the running VM; its script goes in over the Docker socket of the VM.
    expect(await instance.status()).toBe('running');
    await inVm(`docker create --name ${REMOTE_MONITOR_CONTAINER} --volume ${REMOTE_MONITOR_VOLUME}:${REMOTE_MONITOR_STATE_DIR} ${MONITOR_STAND_IN_IMAGE} sleep ${MONITOR_STAND_IN_SECONDS}`);
    const scriptFolder = path.posix.dirname(REMOTE_MONITOR_SCRIPT_PATH);
    const localScriptFolder = path.join(home ?? '', 'monitor', path.posix.basename(scriptFolder));
    fs.mkdirSync(localScriptFolder, { recursive: true });
    fs.writeFileSync(path.join(localScriptFolder, path.posix.basename(REMOTE_MONITOR_SCRIPT_PATH)), await bundle(workerBundleOptions(sharedBundleOptions({ production: true }))));
    const copied = await hostDocker(['cp', localScriptFolder, `${REMOTE_MONITOR_CONTAINER}:${path.posix.dirname(scriptFolder)}`]);
    expect(copied.exitCode, copied.stderr).toBe(0);
    await instance.stop();
    expect(await instance.status()).toBe('stopped');

    // The task as Devspaces writes it (VmTask), with Node.js in place of the Electron of VS Code.
    const bundledProgram = path.join(home ?? '', 'vmTask.js');
    const programOptions = packageBundleOptions(sharedBundleOptions({ production: true })).find((options) => options.outfile === 'dist/vmTask.js');
    if (programOptions === undefined) throw new Error('esbuild.mjs builds no dist/vmTask.js.');
    fs.writeFileSync(bundledProgram, await bundle({ ...programOptions, outfile: undefined }));
    const taskPaths = vmTaskPaths(paths.root);
    const warnings: string[] = [];
    const taskLogger: Logger = {
      ...logger,
      warn: (line) => {
        warnings.push(line);
        logger.warn(line);
      },
    };
    task = new VmTask({ runner, logger: taskLogger, platform: 'linux', homeDir: os.homedir(), paths: taskPaths, bundledProgram, uid: () => process.getuid?.() ?? 0 });
    const settings = { schedule: TASK_SCHEDULE, timeZone: 'UTC' };
    await task.update({ config: { ...settings, limactl, limaHome: paths.home }, electron: process.execPath });
    expect(warnings).toEqual([]);
    const systemctl = (args: string[], timeoutMs = 60_000) => runner.run('systemctl', ['--user', ...args], { timeoutMs });
    expect((await systemctl(['is-enabled', `${VM_TASK_UNIT}.timer`])).stdout.trim()).toBe('enabled');
    expect((await systemctl(['is-active', `${VM_TASK_UNIT}.timer`])).stdout.trim()).toBe('active');
    // A new task counts from now. The test moves its last start a day back, so that a time of the schedule passed.
    expect(parseVmTaskStamp(fs.readFileSync(taskPaths.stamp, 'utf8'))).toBeGreaterThan(Date.now() - 5 * 60_000);
    fs.writeFileSync(taskPaths.stamp, vmTaskStampText(Date.now() - 25 * 3_600_000));

    // The timer starts the service at the minute of the schedule; the test starts it now. `systemctl start` returns at
    // the end of the program.
    const before = Date.now();
    const started = await systemctl(['start', `${VM_TASK_UNIT}.service`], VM_TASK_WAIT_MS + 10 * 60_000);
    const log = fs.readFileSync(taskPaths.log, 'utf8');
    console.log(`The log of the task:\n${log}`);
    if (started.exitCode !== 0) console.log((await runner.run('journalctl', ['--user', '--unit', `${VM_TASK_UNIT}.service`, '--no-pager'], { timeoutMs: 30_000 })).stdout);
    expect(started.exitCode, started.stderr).toBe(0);
    expect(Date.now() - before).toBeGreaterThanOrEqual(VM_TASK_WAIT_MS);
    expect(log).toContain(`The Monitor runs with the schedule "${TASK_SCHEDULE}" (UTC).`);
    expect(log).not.toContain(' WARN ');
    expect(parseVmTaskStamp(fs.readFileSync(taskPaths.stamp, 'utf8'))).toBeGreaterThanOrEqual(before - 1_000);
    // The VM runs on after the end of the service (systemd stops what a service leaves; `limactl start` ran in a scope
    // of its own), and the Monitor stored the settings of the task in its volume.
    expect(await instance.status()).toBe('running');
    const stored = await inVm(`docker run --rm --volume ${REMOTE_MONITOR_VOLUME}:/state mirror.gcr.io/library/busybox:latest cat /state/${IMAGE_SETTINGS_FILE}`);
    expect(JSON.parse(stored)).toEqual(settings);

    // The Monitor ends after its minute, and the idle check powers the VM off.
    const quiet = Date.now();
    while ((await instance.status()) !== 'stopped') {
      if (Date.now() - quiet > POWER_OFF_MS) throw new Error(`The VM did not power itself off within ${POWER_OFF_MS / 60_000} minutes after the task.`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    console.log(`The VM powered itself off ${Math.round((Date.now() - quiet) / 1000)} seconds after the end of the task.`);

    // At the next start no time of the schedule passed since the last start: the program ends at once and writes
    // nothing, and the VM stays off.
    const again = Date.now();
    const second = await systemctl(['start', `${VM_TASK_UNIT}.service`], 2 * 60_000);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(Date.now() - again).toBeLessThan(VM_TASK_WAIT_MS);
    expect(fs.readFileSync(taskPaths.log, 'utf8')).toBe(log);
    expect(await instance.status()).toBe('stopped');

    // The removal of the task: the units and the folder of the task go.
    await task.remove();
    task = undefined;
    expect(warnings).toEqual([]);
    for (const file of definitions) expect(fs.existsSync(file), file).toBe(false);
    expect(fs.existsSync(taskPaths.folder)).toBe(false);
    expect((await systemctl(['is-enabled', `${VM_TASK_UNIT}.timer`])).exitCode).not.toBe(0);
  });

  // The row of the VM in the view "Docker Hosts" (R-VM-010): its state without a start, and Stop the VM (`limactl stop`)
  // and Remove the VM (`limactl delete`) of LimaSetup, as the menu of the row runs them.
  it('reads the state of the VM without a start, and stops and removes the VM as its row in the view Docker Hosts does', async () => {
    if (instance === undefined || limactl === undefined) throw new Error('The first test created no VM.');
    const installed = limactl;
    const created = instance;
    const vm = new LimaVm({ runner, logger, platform: process.platform, arch: process.arch, paths, install: async () => installed });
    const setup = new LimaSetup({ vm, runner, logger, platform: process.platform, arch: process.arch, env: process.env, machine: { totalMemory: os.totalmem(), cpus: os.availableParallelism() } });
    const state = () => limaVmState({ exists: () => vm.exists(), limactl: () => installed, paths, runner, logger });
    // The VM is stopped after the test before; its read starts nothing.
    const stopped = await state();
    expect(stopped).toMatchObject({ kind: 'stopped', memoryGiB: limaResources(os.totalmem(), os.availableParallelism()).memoryGiB, cpus: limaResources(os.totalmem(), os.availableParallelism()).cpus });
    expect(stopped.diskBytes).toBeGreaterThan(100 * 2 ** 20);
    expect(await created.status()).toBe('stopped');
    await created.start(undefined, (line) => console.log(`limactl: ${line}`));
    expect((await state()).kind).toBe('running');
    await setup.stop();
    expect((await state()).kind).toBe('stopped');
    await expect(setup.remove()).resolves.toBe(true);
    expect(await state()).toEqual({ kind: 'notSetUp' });
    expect(await created.status()).toBe('missing');
    // Nothing is left for afterAll to delete.
    instance = undefined;
  });
});
