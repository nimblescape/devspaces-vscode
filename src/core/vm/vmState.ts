// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The state of the VM of Devspaces for its row in the view "Docker Hosts" (docs/requirements.md R-VM-010): not set up,
// stopped, running, with its memory, its CPUs and the space of its disk on this computer. The read never starts the VM:
// on macOS and Linux `limactl list` of the pinned Lima that is installed already (never a download), on Windows the
// registration of the WSL distribution of Devspaces and `wsl.exe --list --running` (WslLifetime.running), which start
// nothing. No `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../errors';
import type { Logger, ProcessRunner } from '../ports';
import { LIMA_INSTANCE, LimaInstance, type LimaPaths } from './limaInstance';

export type VmStateKind = 'notSetUp' | 'stopped' | 'running' | 'broken' | 'unknown';

export interface VmState {
  kind: VmStateKind;
  /** The memory of the VM in GiB, where known (Lima). */
  memoryGiB?: number;
  /** The CPUs of the VM, where known (Lima). */
  cpus?: number;
  /** The space that the disk of the VM takes on this computer, in bytes. */
  diskBytes?: number;
  /** Why the state is `unknown` or `broken`. */
  detail?: string;
}

/**
 * The space that the files `files` take on the disk of this computer: the blocks of each file (a disk of a VM is a sparse
 * file, whose size is the largest size), else its size. Missing files count 0. Undefined when no file exists.
 */
export async function diskSpace(files: readonly string[]): Promise<number | undefined> {
  let total: number | undefined;
  for (const file of files) {
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) continue;
      total = (total ?? 0) + (stat.blocks > 0 ? stat.blocks * 512 : stat.size);
    } catch {
      // Not there.
    }
  }
  return total;
}

/**
 * The space that a user who is not root may still use on the file system of `folder` (statfs), for the disk of the VM
 * on this computer: of the nearest folder above it that exists, when it does not exist. Undefined when none can be read.
 */
export async function freeSpace(folder: string): Promise<number | undefined> {
  for (let current = path.resolve(folder); ; ) {
    try {
      const stats = await fs.promises.statfs(current);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/** The regular files in `folder` and up to `depth` levels below it that `accept` takes. */
async function filesBelow(folder: string, depth: number, accept: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  const look = async (dir: string, left: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isFile() && accept(entry.name)) found.push(file);
      else if (entry.isDirectory() && left > 0) await look(file, left - 1);
    }
  };
  await look(folder, depth);
  return found;
}

/**
 * The files of the Lima VM of Devspaces: every file of its instance folder and one level below it (its disks, whose
 * names differ between the versions and drivers of Lima, its cloud-init image and its logs; sockets are no files).
 */
export function limaInstanceFiles(paths: Pick<LimaPaths, 'home'>): Promise<string[]> {
  return filesBelow(path.join(paths.home, LIMA_INSTANCE), 1, () => true);
}

/** The virtual disks (`*.vhdx`) of the WSL distribution of Devspaces in its folder and one level below it. */
export function wslDiskFiles(folder: string): Promise<string[]> {
  return filesBelow(folder, 1, (name) => name.toLowerCase().endsWith('.vhdx'));
}

export interface LimaVmStateDeps {
  /** Whether the VM was created (LimaVm.exists). */
  exists: () => Promise<boolean>;
  /** The `limactl` of the pinned Lima when it is installed (presentLima), else undefined: nothing is downloaded. */
  limactl: () => string | undefined;
  paths: LimaPaths;
  runner: ProcessRunner;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** The state of the Lima VM of Devspaces, without a start and without a download. Never throws. */
export async function limaVmState(deps: LimaVmStateDeps): Promise<VmState> {
  try {
    if (!(await deps.exists())) return { kind: 'notSetUp' };
    const diskBytes = await diskSpace(await limaInstanceFiles(deps.paths));
    const disk = diskBytes === undefined ? {} : { diskBytes };
    const limactl = deps.limactl();
    if (limactl === undefined) return { kind: 'unknown', ...disk, detail: 'The pinned Lima is not installed.' };
    const instance = new LimaInstance({ limactl, paths: deps.paths, runner: deps.runner, logger: deps.logger, env: deps.env });
    const info = await instance.info(deps.signal);
    const resources = info.resources === undefined ? {} : { memoryGiB: info.resources.memoryGiB, cpus: info.resources.cpus };
    switch (info.status) {
      case 'running':
        return { kind: 'running', ...resources, ...disk };
      case 'stopped':
        return { kind: 'stopped', ...resources, ...disk };
      case 'missing':
        return { kind: 'notSetUp' };
      case 'broken':
        return { kind: 'broken', ...resources, ...disk, detail: 'Lima reports the VM as broken.' };
      case 'other':
        return { kind: 'unknown', ...resources, ...disk, detail: 'Lima reports another state than running or stopped.' };
    }
  } catch (error) {
    return { kind: 'unknown', detail: errorMessage(error) };
  }
}

export interface WslVmStateDeps {
  /** Whether Devspaces set up the distribution (WslSetup.registration): `foreign` is a distribution of the user. */
  registration: () => Promise<'own' | 'foreign' | 'none'>;
  /** Whether the distribution runs (WslLifetime.running); undefined when that cannot be told. */
  running: () => Promise<boolean | undefined>;
  /** The folder of the distribution (wslSetupFolder). */
  folder: string;
}

/**
 * The state of the WSL distribution of Devspaces, without a start. A distribution `devspaces` that Devspaces did not set
 * up is not the VM of Devspaces: not set up. Never throws.
 */
export async function wslVmState(deps: WslVmStateDeps): Promise<VmState> {
  try {
    if ((await deps.registration()) !== 'own') return { kind: 'notSetUp' };
    const diskBytes = await diskSpace(await wslDiskFiles(deps.folder));
    const disk = diskBytes === undefined ? {} : { diskBytes };
    const running = await deps.running();
    if (running === undefined) return { kind: 'unknown', ...disk, detail: 'wsl.exe does not tell whether the distribution runs.' };
    return { kind: running ? 'running' : 'stopped', ...disk };
  } catch (error) {
    return { kind: 'unknown', detail: errorMessage(error) };
  }
}
