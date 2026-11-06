// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Lima VM of Devspaces on macOS and Linux (docs/architecture.md "The Lima VM of Devspaces", R-VM-001, R-VM-005):
// one instance `devspaces` in a Lima home of its own (LIMA_HOME), so that the instances of a Lima of the user stay apart.
// Its configuration comes from Devspaces only: the disk of the image of the VM (vmImage.ts), Apple Virtualization on
// macOS and QEMU with KVM on Linux, the memory and the CPUs (limaResources), no folder of this computer in the VM, no
// containerd of Lima, no SSH key of the user, and no port of the VM on this computer. Devspaces reaches it with `ssh` and
// the SSH configuration that Lima writes for it (limaSshArgs). No `vscode`.
import * as os from 'os';
import * as path from 'path';
import { errorMessage } from '../errors';
import type { Logger, ProcessRunner, RunResult } from '../ports';

/** The name of the Lima instance of Devspaces. */
export const LIMA_INSTANCE = 'devspaces';
/** The host of the SSH configuration that Lima writes for an instance: `lima-<instance>`. */
export const LIMA_SSH_HOST = `lima-${LIMA_INSTANCE}`;
/** The memory of the VM by default, in GiB (R-VM-005), at most half of the memory of this computer. */
export const DEFAULT_VM_MEMORY_GIB = 4;
/** The CPUs of the VM by default (R-VM-005), at most half of the CPUs of this computer. */
export const DEFAULT_VM_CPUS = 4;
/**
 * The size of the disk of the VM in GiB: the largest size, not the space that it takes. The disk file grows with the
 * data of the devspaces (the default of Lima).
 */
export const VM_DISK_GIB = 100;
/** The time limit of `limactl list`. */
const LIST_TIMEOUT_MS = 30_000;
/** The time limit of `limactl create`, which copies or converts the disk of the image. */
const CREATE_TIMEOUT_MS = 10 * 60_000;
/** The time limit of `limactl start` (also its own `--timeout`): the first start runs cloud-init. */
const START_TIMEOUT_MINUTES = 10;
/** The time limit of `limactl stop`. */
const STOP_TIMEOUT_MS = 3 * 60_000;
/** The last characters of the output of a failed `limactl` that a message names. */
const MAX_DETAIL = 2000;

/** The folders of the Lima VM of Devspaces in the home folder of the user: `~/.nimblescape/devspaces`. */
export interface LimaPaths {
  /** The folder of the files of Devspaces outside of VS Code. */
  root: string;
  /** The versions of Lima (lima.ts): `<lima>/<version>/bin/limactl`. */
  lima: string;
  /** LIMA_HOME: the instance `devspaces` is `<home>/devspaces`. */
  home: string;
  /** The download of the disk of the image, removed after the VM was created. */
  download: string;
}

/**
 * The folders of the Lima VM of Devspaces under `homeDir` (os.homedir()): `~/.nimblescape/devspaces` with `lima`, `vm`
 * (LIMA_HOME) and `download`. The path is short and has no spaces, because Lima puts its sockets into the folder of the
 * instance, and the path of a socket has at most 104 bytes on macOS.
 */
export function limaPaths(homeDir: string = os.homedir()): LimaPaths {
  const root = path.join(homeDir, '.nimblescape', 'devspaces');
  return { root, lima: path.join(root, 'lima'), home: path.join(root, 'vm'), download: path.join(root, 'download') };
}

/** The environment of `limactl` and of the `ssh` to the VM: LIMA_HOME of Devspaces. */
export function limaEnv(base: NodeJS.ProcessEnv, paths: LimaPaths): NodeJS.ProcessEnv {
  return { ...base, LIMA_HOME: paths.home };
}

/** The SSH configuration that Lima writes for the instance of Devspaces. */
export function limaSshConfigFile(paths: LimaPaths): string {
  return path.join(paths.home, LIMA_INSTANCE, 'ssh.config');
}

/**
 * The arguments of `ssh` that run `command` in the VM as root (`sudo -n`, as the root of the WSL distribution of
 * Devspaces): the SSH configuration of Lima (its key of Devspaces, the port on this computer, no known hosts), without
 * questions (`BatchMode`), without a terminal.
 */
export function limaSshArgs(paths: LimaPaths, command: string): string[] {
  return ['-F', limaSshConfigFile(paths), '-o', 'BatchMode=yes', '-T', LIMA_SSH_HOST, `sudo -n ${command}`];
}

/** The memory in GiB and the CPUs of the VM. */
export interface LimaResources {
  memoryGiB: number;
  cpus: number;
}

/**
 * The memory and the CPUs of the VM (R-VM-005): the wish (the settings, else 4 GiB and 4 CPUs), each at most half of this
 * computer, and at least 1 GiB and 1 CPU. `totalMemory` in bytes (os.totalmem()), `cpuCount` (os.availableParallelism()).
 */
export function limaResources(totalMemory: number, cpuCount: number, wish: Partial<LimaResources> = {}): LimaResources {
  const halfMemory = Math.floor(totalMemory / 2 ** 30 / 2);
  const halfCpus = Math.floor(cpuCount / 2);
  const memoryWish = wish.memoryGiB !== undefined && Number.isInteger(wish.memoryGiB) && wish.memoryGiB > 0 ? wish.memoryGiB : DEFAULT_VM_MEMORY_GIB;
  const cpuWish = wish.cpus !== undefined && Number.isInteger(wish.cpus) && wish.cpus > 0 ? wish.cpus : DEFAULT_VM_CPUS;
  return { memoryGiB: Math.max(1, Math.min(memoryWish, halfMemory)), cpus: Math.max(1, Math.min(cpuWish, halfCpus)) };
}

export interface LimaConfigOptions {
  platform: NodeJS.Platform;
  /** The processor of this computer (`process.arch`): `arm64` or `x64`. */
  arch: string;
  /** The disk of the image of the VM (an absolute path) and its digest (`sha256:<hex>`). */
  image: { file: string; digest: string };
  resources: LimaResources;
}

/**
 * The configuration of the instance (`lima.yaml`) as JSON, which is YAML too, so that every value is quoted correctly.
 * Lima copies the disk of the image into the folder of the instance when it creates it.
 */
export function limaConfig(options: LimaConfigOptions): string {
  const arch = options.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const config = {
    // Apple Virtualization on macOS, QEMU with KVM on Linux (Lima never emulates the processor of another architecture).
    vmType: options.platform === 'darwin' ? 'vz' : 'qemu',
    os: 'Linux',
    arch,
    images: [{ location: options.image.file, arch, digest: options.image.digest }],
    cpus: options.resources.cpus,
    memory: `${options.resources.memoryGiB}GiB`,
    disk: `${VM_DISK_GIB}GiB`,
    // No folder of this computer in the VM: the devspaces keep their files in Docker volumes.
    mounts: [],
    // Docker Engine of the image runs the containers; Lima installs no containerd and no nerdctl.
    containerd: { system: false, user: false },
    // Lima makes a key of its own for the login; no key of the user goes into the VM, and nothing is forwarded.
    ssh: { localPort: 0, loadDotSSHPubKeys: false, forwardAgent: false, forwardX11: false },
    // No port of the VM on this computer: VS Code reaches the ports of a devspace through its own connection.
    portForwards: [
      { guestIP: '127.0.0.1', guestPortRange: [1, 65535], ignore: true },
      { guestIP: '0.0.0.0', guestPortRange: [1, 65535], ignore: true },
    ],
    // The image upgrades itself (devspaces-upgrade); Lima installs no packages at the start.
    upgradePackages: false,
    video: { display: 'none' },
  };
  return `${JSON.stringify(config, undefined, 2)}\n`;
}

/** The state of the instance in `limactl list`: `missing` when it does not exist. */
export type LimaStatus = 'running' | 'stopped' | 'broken' | 'missing' | 'other';

/** One line of `limactl list --json`. */
interface LimaListEntry {
  name?: unknown;
  status?: unknown;
}

/** The state of the instance `name` in the output of `limactl list --json` (one JSON object per line). */
export function parseLimaList(stdout: string, name: string = LIMA_INSTANCE): LimaStatus {
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let entry: LimaListEntry;
    try {
      entry = JSON.parse(line) as LimaListEntry;
    } catch {
      continue;
    }
    if (entry.name !== name) continue;
    if (entry.status === 'Running') return 'running';
    if (entry.status === 'Stopped') return 'stopped';
    if (entry.status === 'Broken') return 'broken';
    return 'other';
  }
  return 'missing';
}

/** A `limactl` that failed: its command and the end of its output. */
export class LimaError extends Error {
  constructor(
    readonly step: 'list' | 'create' | 'start' | 'stop' | 'delete',
    readonly detail: string,
  ) {
    super(`limactl ${step} failed: ${detail}`);
    this.name = 'LimaError';
  }
}

export interface LimaInstanceDeps {
  /** The program `limactl` (installLima). */
  limactl: string;
  paths: LimaPaths;
  runner: ProcessRunner;
  logger: Logger;
  /** The environment of this process. Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

/** The instance `devspaces` of Lima: its state, create, start, stop and delete with `limactl`. */
export class LimaInstance {
  constructor(private readonly deps: LimaInstanceDeps) {}

  private run(args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal; onLine?: (line: string) => void }): Promise<RunResult> {
    const env = limaEnv(this.deps.env ?? process.env, this.deps.paths);
    const { onLine } = options;
    // One splitter per stream, so that the parts of the lines of both streams do not mix.
    const onStdout = onLine === undefined ? undefined : lineSplitter(onLine);
    const onStderr = onLine === undefined ? undefined : lineSplitter(onLine);
    return this.deps.runner.run(this.deps.limactl, args, { env, timeoutMs: options.timeoutMs, signal: options.signal, onStdout, onStderr });
  }

  private fail(step: LimaError['step'], result: RunResult): never {
    const output = `${result.stderr}\n${result.stdout}`.trim();
    const detail = result.timedOut ? 'it did not end in time' : output.slice(-MAX_DETAIL) || `exit code ${result.exitCode}`;
    throw new LimaError(step, detail);
  }

  /** The state of the instance. */
  async status(signal?: AbortSignal): Promise<LimaStatus> {
    const result = await this.run(['list', '--json'], { timeoutMs: LIST_TIMEOUT_MS, signal });
    if (result.exitCode !== 0) this.fail('list', result);
    return parseLimaList(result.stdout);
  }

  /** Creates the instance from the configuration file `config` (limaConfig); it does not start it. */
  async create(config: string, signal?: AbortSignal, onLine?: (line: string) => void): Promise<void> {
    this.deps.logger.info(`The Lima VM of Devspaces is created in ${path.join(this.deps.paths.home, LIMA_INSTANCE)}.`);
    const result = await this.run(['create', `--name=${LIMA_INSTANCE}`, '--tty=false', config], { timeoutMs: CREATE_TIMEOUT_MS, signal, onLine });
    if (result.exitCode !== 0) this.fail('create', result);
  }

  /** Starts the instance and returns when Lima can log in to it (`limactl start` waits for that). */
  async start(signal?: AbortSignal, onLine?: (line: string) => void): Promise<void> {
    this.deps.logger.info('The Lima VM of Devspaces starts.');
    const result = await this.run(['start', '--tty=false', `--timeout=${START_TIMEOUT_MINUTES}m`, LIMA_INSTANCE], {
      timeoutMs: (START_TIMEOUT_MINUTES + 1) * 60_000,
      signal,
      onLine,
    });
    if (result.exitCode !== 0) this.fail('start', result);
  }

  /** Stops the instance (a shutdown of the VM). */
  async stop(signal?: AbortSignal): Promise<void> {
    const result = await this.run(['stop', LIMA_INSTANCE], { timeoutMs: STOP_TIMEOUT_MS, signal });
    if (result.exitCode !== 0) this.fail('stop', result);
  }

  /** Deletes the instance with its disk: every devspace in it is lost. */
  async delete(signal?: AbortSignal): Promise<void> {
    const result = await this.run(['delete', '--force', LIMA_INSTANCE], { timeoutMs: STOP_TIMEOUT_MS, signal });
    if (result.exitCode !== 0) this.fail('delete', result);
  }

  /** Starts the instance when it is stopped; true when it runs afterwards. Logs a failure and returns false. */
  async ensureRunning(signal?: AbortSignal, onLine?: (line: string) => void): Promise<boolean> {
    try {
      const status = await this.status(signal);
      if (status === 'running') return true;
      if (status === 'missing') return false;
      await this.start(signal, onLine);
      return true;
    } catch (error) {
      if (signal?.aborted === true) throw error;
      this.deps.logger.warn(`The Lima VM of Devspaces could not be started: ${errorMessage(error)}`);
      return false;
    }
  }
}

/** Calls `onLine` with each complete line of a text stream (the last part of a line waits for its end). */
function lineSplitter(onLine: (line: string) => void): (text: string) => void {
  let rest = '';
  return (text) => {
    const parts = (rest + text).split(/\r?\n/);
    rest = parts.pop() ?? '';
    for (const part of parts) if (part.trim() !== '') onLine(part);
  };
}
