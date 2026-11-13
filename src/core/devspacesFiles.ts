// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The files of Devspaces on this computer outside of VS Code (R-GEN-008), removed by the uninstall hook
// (src/uninstall/main.ts) and at the end of "Remove Devspaces from This Computer…" (R-GEN-009), in this order:
//   1. the Docker context `devspaces` of the setting devspaces.createDockerContext (R-ENG-007), only the own one and
//      not while it is the current context; first, because it only changes files and takes no time;
//   2. the scheduled task of the user that starts the VM of Devspaces and its Monitor at the times of
//      devspaces.cacheUpdateSchedule (R-VM-005): the launch agent on macOS, the systemd user timer on Linux, the task of
//      Task Scheduler on Windows;
//   3. the folder of Devspaces outside of VS Code (`~/.nimblescape/devspaces` with Lima on macOS and Linux,
//      `%LOCALAPPDATA%\nimblescape\devspaces` on Windows), only when no VM of Devspaces is in it. On Windows, the
//      record of a task that step 2 could not remove stays, so that a later install of Devspaces can still remove it.
// It never deletes the VM of Devspaces, the WSL distribution or a devspace: they can hold work that is not pushed. It
// never contacts a Docker engine or a remote host. Each step that fails is logged, and the next step runs. Only Node.js
// built-ins and modules of src/core, without `vscode`, because the hook has no API of VS Code.
import * as fs from 'fs';
import * as path from 'path';
import { envValue, findExecutable } from './docker/dockerCli';
import { WSL_SETUP_LOCK_TIMINGS, WslSetup, wslSetupFolder, wslSetupLockFolder } from './docker/wslSetup';
import { WSL_TASK_FOLDER, WslTask } from './docker/wslTask';
import { errorMessage } from './errors';
import type { Logger, ProcessRunner } from './ports';
import { LockTimeoutError, lockTakeoverFolder, withLockFolder, type LockTimings } from './storage/lockFolder';
import { errorCode, retryTransient } from './storage/paths';
import { dockerConfigDir, removeDockerContextFiles } from './vm/dockerContext';
import { LIMA_INSTANCE, LIMA_SETUP_LOCK_TIMINGS, limaPaths, limaSetupLockFolder } from './vm/limaInstance';
import { VmTask, vmTaskDefinitionFiles, vmTaskPaths } from './vm/vmTask';

/** The file name extension of the virtual disk of a WSL distribution. */
const WSL_DISK_EXTENSION = '.vhdx';

export interface DevspacesFilesDeps {
  runner: ProcessRunner;
  logger: Logger;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The home folder of the user (os.homedir()). */
  homeDir: string;
  /** The user ID of this process, for `launchctl … gui/<uid>` (macOS). */
  uid: () => number;
  /** For tests: the folder of the WSL distribution of Devspaces. Default: wslSetupFolder of `env` (Windows). */
  wslFolder?: string;
}

/** The folder of Devspaces outside of VS Code, its lock of the setup of the VM, and whether a VM of Devspaces is in it. */
interface DevspacesFolder {
  root: string;
  /** The lock folder of the setup in `root` (limaSetupLockFolder, wslSetupLockFolder), which only its holder removes. */
  lock: string;
  /** The timings of the setup for its lock: the hook waits for a held lock as long as a window does (one second). */
  lockTimings: LockTimings;
  /**
   * Why the folder stays, for the log: the VM of Devspaces, or what is left of it, is in it, or the hook cannot tell.
   * Undefined when no VM is in it.
   */
  staysBecause: () => Promise<string | undefined>;
  /** The names in `root` that stay although no VM is there. */
  keep: () => Promise<string[]>;
}

/**
 * Runs the three steps, one after the other: a step that fails does not stop the next one. Returns what stays of
 * Devspaces, one text per step that left something (each one is in the log too); empty when nothing stays. Never
 * rejects.
 */
export async function removeDevspacesFiles(deps: DevspacesFilesDeps): Promise<string[]> {
  const steps: [string, () => Promise<string | undefined>][] = [
    ['The Docker context devspaces', () => removeDockerContext(deps)],
    ['The scheduled task', () => removeScheduledTask(deps)],
    ['The folder of Devspaces', () => removeDevspacesFolder(deps)],
  ];
  const left: string[] = [];
  for (const [what, task] of steps) {
    const stays = await step(deps.logger, what, task);
    if (stays !== undefined) left.push(stays);
  }
  return left;
}

/** Runs `task`: what stays after it, also its failure (logged). */
async function step(logger: Logger, what: string, task: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await task();
  } catch (error) {
    const text = `${what} could not be removed: ${errorMessage(error)}`;
    logger.warn(text);
    return text;
  }
}

/**
 * A path that the hook may use as the start of the paths that it removes: only an absolute one, so that a missing home
 * folder or LOCALAPPDATA never makes a path relative to the current folder of the process.
 */
function absolute(folder: string | undefined): string | undefined {
  return folder !== undefined && folder !== '' && path.isAbsolute(folder) ? folder : undefined;
}

/**
 * 1. The Docker context `devspaces` of the setting devspaces.createDockerContext (R-ENG-007). A context that Devspaces
 * did not create is no part of Devspaces, so it is not named as left.
 */
async function removeDockerContext(deps: DevspacesFilesDeps): Promise<string | undefined> {
  const { logger } = deps;
  const configDir = absolute(dockerConfigDir(deps.env, deps.platform, deps.homeDir));
  if (configDir === undefined) throw new Error('the folder of the configuration of the Docker CLI is not an absolute path');
  const result = await removeDockerContextFiles(configDir, envValue(deps.env, 'DOCKER_CONTEXT', deps.platform));
  switch (result.kind) {
    case 'removed':
      logger.info(`Devspaces removed its Docker context devspaces from ${configDir}.`);
      return undefined;
    case 'missing':
      return undefined;
    case 'taken':
      logger.info('The Docker context devspaces was not created by Devspaces, or its file cannot be read, so it stays.');
      return undefined;
    case 'current':
      return warned(
        logger,
        `The Docker context devspaces is the current Docker context (DOCKER_CONTEXT, or ${path.join(configDir, 'config.json')}), so it stays. To remove it, run "docker context use default" and then "docker context rm devspaces".`,
      );
    case 'unreadable':
      return warned(
        logger,
        `Devspaces cannot read ${path.join(configDir, 'config.json')}, so it cannot tell whether the Docker context devspaces is the current Docker context, and the context stays. To remove it, run "docker context rm devspaces".`,
      );
    case 'failed':
      throw new Error(result.detail);
  }
}

function warned(logger: Logger, text: string): string {
  logger.warn(text);
  return text;
}

/**
 * 2. The scheduled task (R-VM-005). VmTask and WslTask remove only a task that this computer has, and log a failure;
 * the task is left when its definition files (macOS and Linux) or its record (Windows) are still there afterwards.
 */
async function removeScheduledTask(deps: DevspacesFilesDeps): Promise<string | undefined> {
  const { runner, logger, platform } = deps;
  const left = 'The scheduled task of the VM of Devspaces could not be removed (details in the log). The user guide says how to remove it (Uninstall).';
  if (platform === 'darwin' || platform === 'linux') {
    const homeDir = absolute(deps.homeDir);
    if (homeDir === undefined) throw new Error(`the home folder "${deps.homeDir}" is not an absolute path`);
    const paths = vmTaskPaths(limaPaths(homeDir).root);
    // The program of the task is not written by a removal, so the task needs no bundled program.
    await new VmTask({ runner, logger, platform, homeDir, paths, bundledProgram: '', uid: deps.uid }).remove();
    const files = await Promise.all(vmTaskDefinitionFiles(platform, homeDir).map(pathState));
    return files.every((state) => state === 'missing') ? undefined : left;
  }
  if (platform !== 'win32') return undefined;
  const folders = windowsFolders(deps);
  if (folders === undefined) throw new Error('LOCALAPPDATA is missing or not an absolute path, so the folder of Devspaces is not known');
  const task = wslTaskOf(deps, folders.root);
  await task.remove();
  return (await pathState(task.file)) === 'missing' ? undefined : left;
}

/** The task of Task Scheduler with its record in `root` (as in extension.ts); a removal needs no program of the task. */
function wslTaskOf(deps: DevspacesFilesDeps, root: string): WslTask {
  return new WslTask({ runner: deps.runner, logger: deps.logger, env: deps.env, folder: path.join(root, WSL_TASK_FOLDER), program: () => undefined });
}

/**
 * The folder of the WSL distribution of Devspaces (`%LOCALAPPDATA%\nimblescape\devspaces\wsl`) and the folder of
 * Devspaces on Windows around it (`root`), next to which nothing else is touched; undefined without LOCALAPPDATA.
 */
function windowsFolders(deps: DevspacesFilesDeps): { wslFolder: string; root: string } | undefined {
  const wslFolder = absolute(deps.wslFolder ?? wslSetupFolder(deps.env));
  return wslFolder === undefined ? undefined : { wslFolder, root: path.dirname(wslFolder) };
}

/** The folder of Devspaces outside of VS Code on this platform, or undefined where there is none. */
function devspacesFolder(deps: DevspacesFilesDeps): DevspacesFolder | undefined {
  if (deps.platform === 'darwin' || deps.platform === 'linux') {
    const homeDir = absolute(deps.homeDir);
    if (homeDir === undefined) return undefined;
    const paths = limaPaths(homeDir);
    return {
      root: paths.root,
      lock: limaSetupLockFolder(paths),
      lockTimings: LIMA_SETUP_LOCK_TIMINGS,
      // Also a VM that `limactl create` left half done: only `limactl delete` removes it.
      staysBecause: async () => {
        const state = await pathState(path.join(paths.home, LIMA_INSTANCE));
        return state === 'missing' ? undefined : state === 'present' ? 'The VM of Devspaces exists' : 'Devspaces cannot tell whether the VM of Devspaces exists';
      },
      // A task that step 2 could not unload (launchctl, systemctl) finds no program anymore, so it starts nothing, and it
      // is gone at the next login, because its definition file is gone. A task of Task Scheduler stays until it is deleted.
      keep: async () => [],
    };
  }
  if (deps.platform !== 'win32') return undefined;
  const folders = windowsFolders(deps);
  if (folders === undefined) return undefined;
  const { wslFolder, root } = folders;
  const task = wslTaskOf(deps, root);
  const setup = new WslSetup({
    runner: deps.runner,
    wslPath: () => findExecutable('wsl', deps.env, 'win32'),
    env: deps.env,
    arch: async () => process.arch,
    folder: wslFolder,
    logger: deps.logger,
  });
  return {
    root,
    lock: wslSetupLockFolder(wslFolder),
    lockTimings: WSL_SETUP_LOCK_TIMINGS,
    // The registry of WSL names the folder of the disk of every distribution. The virtual disk of a distribution of
    // Devspaces is in a folder `disk` (or `disk-2` and so on) of the folder `wsl`; one without a distribution is left
    // by a setup that did not end, and it stays too, because the hook cannot ask.
    staysBecause: async () => {
      const folder = await pathState(wslFolder);
      if (folder === 'missing') return undefined;
      const unknown = 'Devspaces cannot tell whether the WSL distribution of Devspaces exists';
      if (folder === 'unknown') return unknown;
      const users = await setup.folderUsers();
      if (users !== undefined && users.length > 0) return 'The WSL distribution of Devspaces exists';
      const disk = await holdsFileWith(wslFolder, WSL_DISK_EXTENSION).catch(() => undefined);
      if (disk === true) return `A virtual disk of WSL (${WSL_DISK_EXTENSION}) is in the folder ${wslFolder}`;
      return disk === undefined || users === undefined ? unknown : undefined;
    },
    // The record of a task that step 2 could not remove: without it, a later install of Devspaces cannot remove the task.
    keep: async () => ((await pathState(task.file)) === 'missing' ? [] : [WSL_TASK_FOLDER]),
  };
}

/**
 * 3. The folder of Devspaces outside of VS Code, only when no VM of Devspaces is in it, under the lock of the setup, so
 * that no window of another VS Code on this computer creates the VM meanwhile. Then its parent `nimblescape` goes too,
 * when it is empty. A folder that stays is left, with the reason (the VM is in it, or another window sets it up); a
 * folder that stays only because it keeps the record of a task that step 2 could not remove is not named again.
 */
async function removeDevspacesFolder(deps: DevspacesFilesDeps): Promise<string | undefined> {
  const { logger } = deps;
  const folder = devspacesFolder(deps);
  if (folder === undefined || (await pathState(folder.root)) === 'missing') return undefined;
  let failed: string[] | undefined;
  let stays: string | undefined;
  try {
    await withLockFolder(
      folder.lock,
      async () => {
        const reason = await folder.staysBecause();
        if (reason !== undefined) {
          stays = `${reason}, so the folder ${folder.root} stays. The user guide says how to delete it (Uninstall).`;
          logger.info(stays);
          return;
        }
        // The lock, and the guard of a takeover of a stale lock that a window of another VS Code may hold now.
        const kept = [path.basename(folder.lock), path.basename(lockTakeoverFolder(folder.lock)), ...(await folder.keep())];
        failed = [];
        for (const name of await fs.promises.readdir(folder.root)) {
          if (kept.includes(name)) continue;
          try {
            // A virus scanner or the indexer of Windows can hold a file for a short time.
            await retryTransient(() => fs.promises.rm(path.join(folder.root, name), { recursive: true, force: true }));
          } catch (error) {
            failed.push(`${name} (${errorMessage(error)})`);
          }
        }
      },
      folder.lockTimings,
    );
  } catch (error) {
    if (!(error instanceof LockTimeoutError)) throw error;
    stays = `Another window sets up the VM of Devspaces now, so the folder ${folder.root} stays.`;
    logger.info(stays);
    return stays;
  }
  if (failed === undefined) return stays;
  if (failed.length > 0) throw new Error(`these files in ${folder.root} could not be removed: ${failed.join(', ')}`);
  // Not empty when it keeps the record of a task, or when another window began a setup after the lock was free again.
  if (await removeEmptyFolder(folder.root)) {
    await removeEmptyFolder(path.dirname(folder.root));
    logger.info(`Devspaces removed its folder ${folder.root}.`);
  } else {
    logger.info(`Devspaces removed its files in ${folder.root}; the folder stays, because it is not empty.`);
  }
  return undefined;
}

/** Removes `folder` when it is empty. False when it is not empty or cannot be removed. */
async function removeEmptyFolder(folder: string): Promise<boolean> {
  try {
    // A virus scanner or the indexer of Windows can hold an entry that was just removed for a short time.
    await retryTransient(() => fs.promises.rmdir(folder));
    return true;
  } catch {
    return false;
  }
}

/** Whether `file` exists: `unknown` when lstat fails for another reason than a missing path (for example EACCES). */
async function pathState(file: string): Promise<'present' | 'missing' | 'unknown'> {
  try {
    await fs.promises.lstat(file);
    return 'present';
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown';
  }
}


/** True when `folder` or a folder in it holds a file whose name ends with `extension` (any case). */
async function holdsFileWith(folder: string, extension: string): Promise<boolean> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(folder, { withFileTypes: true, recursive: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
  return entries.some((entry) => !entry.isDirectory() && entry.name.toLowerCase().endsWith(extension));
}

