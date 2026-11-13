// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The setup of the Lima VM of Devspaces on macOS and Linux (docs/architecture.md "The Lima VM of Devspaces", R-VM-001),
// without a question: the pinned Lima, the disk of the image of the VM for the processor of this computer (vmImage.ts),
// the configuration of Devspaces (limaConfig), `limactl create`, the first start, and the answer of Docker Engine in the
// VM. On Linux the computer must have `/dev/kvm` with access for the user, and QEMU: Devspaces never starts a VM with an
// emulated processor. A VM that exists is never created again. No `vscode`.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findExecutable } from '../docker/dockerCli';
import { errorMessage } from '../errors';
import { abortError, isAbortError, type Logger, type ProcessRunner } from '../ports';
import { LockTimeoutError, withLockFolder } from '../storage/lockFolder';
import { pathState } from '../storage/paths';
import { downloadVmImage, vmImageFile, type DownloadVmImageOptions } from './vmImage';
import { LIMA_INSTANCE, LimaInstance, limaConfig, limaEnv, limaResources, LIMA_SETUP_LOCK_TIMINGS, limaSetupLockFolder, limaSshArgs, type LimaResources } from './limaInstance';
import type { LimaVm } from './limaVm';

/** Why the setup cannot run or failed. */
export type LimaSetupProblem =
  /** Not macOS or Linux, or another processor than x64 and arm64. */
  | 'platform'
  /** Linux without `/dev/kvm`: the processor has no virtualization, or it is turned off. */
  | 'kvmMissing'
  /** Linux: `/dev/kvm` exists, but the user may not use it. */
  | 'kvmAccess'
  /** Linux: QEMU (`qemu-system-<arch>` and `qemu-img`) is not installed. */
  | 'qemuMissing'
  /** The pin names no image of the VM yet (before the first push to ghcr.io). */
  | 'imageMissing'
  /** The VM exists, but Lima reports it as broken. */
  | 'broken'
  /** Another window sets up the VM now. */
  | 'busy'
  /** A download, `limactl`, or Docker Engine in the VM failed. */
  | 'failed';

export class LimaSetupError extends Error {
  constructor(
    readonly problem: LimaSetupProblem,
    message: string,
  ) {
    super(message);
    this.name = 'LimaSetupError';
  }
}

/** A step of the setup, for the progress. */
export type LimaSetupStep =
  | { kind: 'lima' }
  | { kind: 'download'; received: number; total: number | undefined }
  | { kind: 'create' }
  | { kind: 'start' }
  | { kind: 'docker' };

/** The time limit of `docker info` in the VM after its first start. */
const DOCKER_TIMEOUT_MS = 3 * 60_000;

export interface LimaSetupDeps {
  vm: LimaVm;
  runner: ProcessRunner;
  logger: Logger;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  /** The memory and the CPUs that the settings wish (R-VM-006). Default: none, so 4 GiB and 4 CPUs at most. */
  resources?: () => Partial<LimaResources>;
  /** For tests. Default: os.totalmem() and os.availableParallelism(). */
  machine?: { totalMemory: number; cpus: number };
  /** For tests. Default: downloadVmImage. */
  downloadImage?: (options: DownloadVmImageOptions) => Promise<unknown>;
  /** For tests. Default: vmImageFile of the pin. */
  imageDigest?: () => string | undefined;
  /** For tests: whether `/dev/kvm` exists and the user may read and write it. Default: the file system. */
  kvm?: () => 'ok' | 'missing' | 'access';
}

/** The QEMU program of the processor of this computer on Linux. */
function qemuSystem(arch: string): string {
  return arch === 'arm64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64';
}

function kvmState(): 'ok' | 'missing' | 'access' {
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    return 'ok';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'access';
  }
}

export class LimaSetup {
  constructor(private readonly deps: LimaSetupDeps) {}

  /**
   * What stops the setup on this computer, before anything is downloaded: a LimaSetupError, or undefined when the setup
   * can run. On Linux: `/dev/kvm` and QEMU.
   */
  precondition(): LimaSetupError | undefined {
    const { platform, arch } = this.deps;
    if ((platform !== 'darwin' && platform !== 'linux') || (arch !== 'x64' && arch !== 'arm64')) {
      return new LimaSetupError('platform', `Devspaces has no VM for ${platform} on ${arch}.`);
    }
    if (platform !== 'linux') return undefined;
    const { kvm, qemuMissing } = this.linuxNeeds();
    if (kvm === 'missing') return new LimaSetupError('kvmMissing', 'This computer has no /dev/kvm: its processor has no virtualization, or it is turned off.');
    if (kvm === 'access') return new LimaSetupError('kvmAccess', 'Your user may not use /dev/kvm.');
    if (qemuMissing.length > 0) return new LimaSetupError('qemuMissing', `QEMU is not installed: ${qemuMissing.join(' and ')} not found.`);
    return undefined;
  }

  /** Linux: the state of `/dev/kvm` for the user, and the programs of QEMU that are not found (qemuInstall.ts installs them). */
  linuxNeeds(): { kvm: 'ok' | 'missing' | 'access'; qemuMissing: string[] } {
    const { platform, arch, env } = this.deps;
    const kvm = (this.deps.kvm ?? kvmState)();
    return { kvm, qemuMissing: [qemuSystem(arch), 'qemu-img'].filter((name) => findExecutable(name, env, platform) === undefined) };
  }

  /**
   * Sets up the VM and returns when Docker Engine in it answers: creates it when it is missing (after the download of
   * Lima and of the disk of the image), and starts it. Throws a LimaSetupError, and an AbortError when the signal aborts.
   */
  async setUp(onStep: (step: LimaSetupStep) => void, signal?: AbortSignal): Promise<void> {
    const blocked = this.precondition();
    if (blocked !== undefined) throw blocked;
    const { vm, logger } = this.deps;
    onStep({ kind: 'lima' });
    const instance = await this.step(() => vm.lima(signal));
    // Two windows never create the VM at the same time; a window that comes after the creation finds the VM.
    await this.locked(async () => {
      const status = await this.step(() => instance.status(signal));
      if (status === 'broken') throw new LimaSetupError('broken', 'The VM of Devspaces is broken: Lima cannot start it.');
      if (status === 'missing') await this.create(instance, onStep, signal);
      else logger.info('The Lima VM of Devspaces exists; it is not created again.');
    });
    onStep({ kind: 'start' });
    await this.step(() => vm.ready(signal));
    onStep({ kind: 'docker' });
    await this.dockerAnswers(signal);
  }

  /**
   * "Stop the VM…" (R-VM-010): `limactl stop`, a shutdown of the VM with the containers in it. Nothing when the VM does
   * not exist or does not run. Throws a LimaSetupError, and an AbortError when the signal aborts.
   */
  async stop(signal?: AbortSignal): Promise<void> {
    const { vm, logger } = this.deps;
    const instance = await this.step(() => vm.lima(signal));
    const status = await this.step(() => instance.status(signal));
    if (status !== 'running') {
      logger.info(`The Lima VM of Devspaces does not run (${status}), so it is not stopped.`);
      return;
    }
    logger.info('Devspaces stops the Lima VM of Devspaces (limactl stop).');
    await this.step(() => instance.stop(signal));
    vm.forgetRunning();
    logger.info('The Lima VM of Devspaces was stopped.');
  }

  /**
   * "Remove the VM…" (R-VM-010): `limactl delete --force`, which deletes the VM with its disk and every devspace in it,
   * under the lock of the setup for all windows, so that no window creates the VM meanwhile. False when the VM did not
   * exist. Not cancelled once it runs: a half deleted VM would help nobody. The folder of a VM without its lima.yaml goes
   * without Lima. Throws a LimaSetupError.
   */
  async remove(): Promise<boolean> {
    const { vm, logger } = this.deps;
    const folder = path.join(vm.paths.home, LIMA_INSTANCE);
    const config = path.join(folder, 'lima.yaml');
    // Lima (it may be downloaded) before the lock, so that its download does not hold the lock of all windows; only for
    // a VM with its lima.yaml, which Lima knows.
    const lima = (await pathState(config)) === 'missing' ? undefined : await this.step(() => vm.lima());
    let removed = false;
    await this.locked(async () => {
      // Without its lima.yaml, Lima does not know the VM: a `limactl create` that ended before it wrote it leaves only
      // the folder, which `limactl delete` would leave, so Devspaces deletes it itself, also without Lima.
      const deleteFolder = async (why: string): Promise<void> => {
        logger.info(`Devspaces removes the folder of ${why} (${folder}).`);
        await this.step(() => fs.promises.rm(folder, { recursive: true, force: true }));
        vm.forgetRunning();
        removed = true;
      };
      if ((await pathState(config)) === 'missing') {
        if ((await pathState(folder)) === 'missing') {
          logger.info('The Lima VM of Devspaces does not exist, so it is not removed.');
          return;
        }
        await deleteFolder('a Lima VM that was not created to the end');
        return;
      }
      // Lima is there already when another window created the VM meanwhile.
      const instance = lima ?? (await this.step(() => vm.lima()));
      const status = await this.step(() => instance.status());
      // A folder with its lima.yaml that Lima does not list: `limactl delete --force` may still know it (it stops a VM
      // that runs), and when it fails, the VM stays with its error, because it may still run. What a successful delete
      // leaves, Devspaces deletes itself, because the files step of "Remove Devspaces from This Computer…" keeps the
      // folder of Devspaces while it is there.
      if (status === 'missing') {
        if ((await pathState(folder)) === 'missing') {
          logger.info('The Lima VM of Devspaces does not exist, so it is not removed.');
          return;
        }
        await this.step(() => instance.delete());
        if ((await pathState(folder)) === 'missing') {
          vm.forgetRunning();
          removed = true;
          logger.info('The Lima VM of Devspaces was removed.');
          return;
        }
        await deleteFolder('a Lima VM that Lima does not list');
        return;
      }
      logger.info(`Devspaces removes the Lima VM of Devspaces with its disk (${folder}).`);
      await this.step(() => instance.delete());
      vm.forgetRunning();
      removed = true;
      logger.info('The Lima VM of Devspaces was removed.');
    });
    return removed;
  }

  private async create(instance: LimaInstance, onStep: (step: LimaSetupStep) => void, signal: AbortSignal | undefined): Promise<void> {
    const { vm, logger, arch, platform } = this.deps;
    const digest = (this.deps.imageDigest ?? (() => vmImageFile('lima', arch)?.digest))();
    if (digest === undefined) throw new LimaSetupError('imageMissing', 'The image of the VM of Devspaces is not published yet.');
    const { download, root } = vm.paths;
    const disk = path.join(download, `devspaces-vm-${arch}.qcow2`);
    try {
      await fs.promises.mkdir(download, { recursive: true });
      onStep({ kind: 'download', received: 0, total: undefined });
      await this.step(() =>
        (this.deps.downloadImage ?? downloadVmImage)({ kind: 'lima', arch, target: disk, signal, onProgress: (received, total) => onStep({ kind: 'download', received, total }) }),
      );
      const machine = this.deps.machine ?? { totalMemory: os.totalmem(), cpus: os.availableParallelism() };
      const resources = limaResources(machine.totalMemory, machine.cpus, this.deps.resources?.() ?? {});
      const config = path.join(root, 'lima.yaml');
      await fs.promises.writeFile(config, limaConfig({ platform, arch, image: { file: disk, digest }, resources }));
      logger.info(`The Lima VM of Devspaces gets ${resources.memoryGiB} GiB of memory and ${resources.cpus} CPUs.`);
      onStep({ kind: 'create' });
      await this.step(() => instance.create(config, signal, (line) => logger.info(`limactl: ${line}`)));
    } finally {
      // Lima keeps its own copy of the disk in the folder of the instance.
      await fs.promises.rm(disk, { force: true }).catch(() => undefined);
    }
  }

  /** `docker info` as root in the VM over the SSH of Lima; throws a LimaSetupError when Docker Engine does not answer. */
  private async dockerAnswers(signal: AbortSignal | undefined): Promise<void> {
    const { vm, runner, env, platform } = this.deps;
    const ssh = findExecutable('ssh', env, platform);
    if (ssh === undefined) throw new LimaSetupError('failed', 'The SSH client (ssh) was not found on this computer.');
    const result = await runner.run(ssh, limaSshArgs(vm.paths, "docker info --format '{{.ServerVersion}}'"), {
      env: limaEnv(env, vm.paths),
      timeoutMs: DOCKER_TIMEOUT_MS,
      signal,
    });
    if (signal?.aborted === true) throw abortError();
    if (result.exitCode !== 0 || result.stdout.trim() === '') {
      const detail = result.timedOut ? 'it did not answer in time' : `${result.stderr}${result.stdout}`.trim() || `exit code ${result.exitCode}`;
      throw new LimaSetupError('failed', `Docker Engine in the VM of Devspaces did not answer: ${detail}`);
    }
    this.deps.logger.info(`Docker Engine ${result.stdout.trim()} runs in the Lima VM of Devspaces.`);
  }

  /**
   * Runs `task` while this window holds the lock of the creation for all windows (`<root>/vm-setup.lock`). Throws
   * LimaSetupError `busy`, without `task`, while another window holds it.
   */
  private async locked(task: () => Promise<void>): Promise<void> {
    let started = false;
    await this.step(async () => {
      try {
        await withLockFolder(
          limaSetupLockFolder(this.deps.vm.paths),
          () => {
            started = true;
            return task();
          },
          LIMA_SETUP_LOCK_TIMINGS,
        );
      } catch (error) {
        if (!started && error instanceof LockTimeoutError) throw new LimaSetupError('busy', 'Another window sets up the VM of Devspaces now.');
        throw error;
      }
    });
  }

  /** Runs `task`; an error that is no LimaSetupError and no AbortError becomes a LimaSetupError `failed`. */
  private async step<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (error instanceof LimaSetupError || isAbortError(error)) throw error;
      throw new LimaSetupError('failed', errorMessage(error));
    }
  }
}
