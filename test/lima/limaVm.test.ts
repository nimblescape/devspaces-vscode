// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Lima VM of Devspaces with the real Lima of the pin (src/core/vm/limaPin.json), on Linux with KVM and QEMU, and the
// disk of a build of the image (DEVSPACES_LIMA_TEST_DISK, vm/build.sh): the download of Lima, the create and the start of
// the VM with the configuration of Devspaces, Docker Engine as root over the SSH of Lima, its Docker socket on this
// computer with the Docker context of the setting devspaces.createDockerContext, the power-off by the idle check of the
// image (also after a connection to that socket), and other CPUs and memory for the next start. The job "lima test" of
// .github/workflows/vm-image.yml runs it (npm run test:lima).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/core/ports';
import { NodeProcessRunner } from '../../src/core/process';
import { installLima, limaVersion } from '../../src/core/vm/lima';
import { DOCKER_CONTEXT, dockerContextFile, syncDockerContext } from '../../src/core/vm/dockerContext';
import { LimaInstance, limaConfig, limaDockerSocket, limaEnv, limaPaths, limaResources, limaSshArgs, type LimaPaths } from '../../src/core/vm/limaInstance';

const logger: Logger = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
  output: (text) => process.stdout.write(text),
};
const runner = new NodeProcessRunner();
/** How long the test waits for the power-off by the idle check: two quiet checks a minute apart, and some slack. */
const POWER_OFF_MS = 8 * 60_000;

let home: string | undefined;
let paths: LimaPaths;
let instance: LimaInstance | undefined;

/** Runs `command` as root in the VM over the SSH of Lima, as the transport of Devspaces does. */
async function inVm(command: string): Promise<string> {
  const result = await runner.run('ssh', limaSshArgs(paths, command), { env: limaEnv(process.env, paths), timeoutMs: 5 * 60_000 });
  if (result.exitCode !== 0) throw new Error(`${command}: exit code ${result.exitCode}: ${result.stderr}${result.stdout}`);
  return result.stdout.trim();
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
  if (instance !== undefined) {
    const lines = path.join(paths.home, 'devspaces', 'serial.log');
    if (fs.existsSync(lines)) console.log(`The end of the serial console of the VM:\n${fs.readFileSync(lines, 'utf8').slice(-4000)}`);
    await instance.delete().catch((error: unknown) => console.warn(`The VM could not be deleted: ${String(error)}`));
  }
  if (home !== undefined) fs.rmSync(home, { recursive: true, force: true });
});

describe('the Lima VM of Devspaces', () => {
  it('runs Docker Engine as root over the SSH of Lima, and powers itself off when nothing runs', async () => {
    const limactl = await installLima({ folder: paths.lima, platform: process.platform, arch: process.arch, logger });
    const version = await runner.run(limactl, ['--version'], { timeoutMs: 30_000 });
    expect(version.stdout).toContain(`limactl version ${limaVersion()}`);

    const disk = path.resolve(process.env.DEVSPACES_LIMA_TEST_DISK ?? '');
    const resources = limaResources(os.totalmem(), os.availableParallelism());
    const config = path.join(paths.root, 'lima.yaml');
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(config, limaConfig({ platform: process.platform, arch: process.arch, image: { file: disk, digest: `sha256:${await sha256(disk)}` }, resources }));
    instance = new LimaInstance({ limactl, paths, runner, logger });
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
    expect(await syncDockerContext(contextDeps, socket)).toEqual({ kind: 'created' });
    expect(await syncDockerContext(contextDeps, socket)).toEqual({ kind: 'unchanged' });
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
});
