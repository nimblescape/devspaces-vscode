// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The uninstall hook of the extension (R-GEN-008), bundled to dist/uninstall.js: `vscode:uninstall` in the `scripts` of
// package.json. VS Code runs it once, at its next start after the extension was uninstalled from every profile, as a
// Node.js program without a window and without the `vscode` API, and ends it after 5 seconds; then VS Code deletes the
// global storage folder of the extension itself (the records, the list of remote hosts and the downloaded Docker CLI).
// The hook removes what would otherwise go on working by itself or stay unused on this computer, in this order:
//   1. the scheduled task of the user that starts the VM of Devspaces and its Monitor at the times of
//      devspaces.cacheUpdateSchedule (R-VM-005): the launch agent on macOS, the systemd user timer on Linux, the task of
//      Task Scheduler on Windows;
//   2. the Docker context `devspaces` of the setting devspaces.createDockerContext (R-ENG-007), only the own one and
//      not while it is the current context;
//   3. the folder of Devspaces outside of VS Code (`~/.nimblescape/devspaces` with Lima on macOS and Linux,
//      `%LOCALAPPDATA%\nimblescape\devspaces` on Windows), only when no VM of Devspaces is in it.
// It never deletes the VM of Devspaces, the WSL distribution or a devspace: they can hold work that is not pushed, and
// the hook cannot ask. It never contacts a Docker engine or a remote host. Each step that fails is logged, and the next
// step runs. VS Code writes the output into its log of the shared process. Only Node.js built-ins and modules of
// src/core.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WslTask } from '../core/docker/wslTask';
import { wslSetupFolder } from '../core/docker/wslSetup';
import { errorMessage } from '../core/errors';
import type { Logger, ProcessRunner } from '../core/ports';
import { NodeProcessRunner } from '../core/process';
import { LockTimeoutError, withLockFolder } from '../core/storage/lockFolder';
import { dockerConfigDir, removeDockerContextFiles } from '../core/vm/dockerContext';
import { LIMA_INSTANCE, limaPaths } from '../core/vm/limaInstance';
import { VmTask, vmTaskPaths } from '../core/vm/vmTask';

/**
 * The locks of the setup of the VM for all windows (limaSetup.ts, wslSetup.ts): a lock older than a minute is of a
 * window that ended. The hook waits for a held lock at most one second, and then keeps the folder.
 */
const SETUP_LOCK_TIMINGS = { staleMs: 60_000, timeoutMs: 1_000 };
/** The file name extension of the virtual disk of a WSL distribution. */
const WSL_DISK_EXTENSION = '.vhdx';

export interface UninstallDeps {
  runner: Pick<ProcessRunner, 'run'>;
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
  /** The name of the lock folder of the setup in `root`, which only the window that holds it removes. */
  lockName: string;
  /** True when the VM of Devspaces, or what is left of it, is in the folder. */
  hasVm: () => Promise<boolean>;
  /** The name of the VM in the log. */
  vmName: string;
}

/** Runs the three steps of the hook. Never rejects. */
export async function runUninstall(deps: UninstallDeps): Promise<void> {
  const { logger } = deps;
  logger.info('nimblescape Devspaces 2 was uninstalled: Devspaces removes its scheduled task, its Docker context and its files outside of VS Code.');
  await step(logger, 'The scheduled task', () => removeScheduledTask(deps));
  await step(logger, 'The Docker context devspaces', () => removeDockerContext(deps));
  await step(logger, 'The folder of Devspaces', () => removeDevspacesFolder(deps));
}

async function step(logger: Logger, what: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    logger.warn(`${what} could not be removed: ${errorMessage(error)}`);
  }
}

/**
 * A path that the hook may use as the start of the paths that it removes: only an absolute one, so that a missing home
 * folder or LOCALAPPDATA never makes a path relative to the current folder of the process.
 */
function absolute(folder: string | undefined): string | undefined {
  return folder !== undefined && folder !== '' && path.isAbsolute(folder) ? folder : undefined;
}

/** 1. The scheduled task (R-VM-005). VmTask and WslTask remove only a task that this computer has. */
async function removeScheduledTask(deps: UninstallDeps): Promise<void> {
  const { runner, logger, platform, env } = deps;
  if (platform === 'darwin' || platform === 'linux') {
    const homeDir = absolute(deps.homeDir);
    if (homeDir === undefined) throw new Error(`the home folder "${deps.homeDir}" is not an absolute path`);
    const paths = vmTaskPaths(limaPaths(homeDir).root);
    // The program of the task is not written by a removal, so the task needs no bundled program.
    await new VmTask({ runner, logger, platform, homeDir, paths, bundledProgram: '', uid: deps.uid }).remove();
    return;
  }
  if (platform !== 'win32') return;
  const wslFolder = wslFolderOf(deps);
  if (wslFolder === undefined) return;
  // Next to the folder of the distribution, as in extension.ts: %LOCALAPPDATA%\nimblescape\devspaces\task.
  await new WslTask({ runner, logger, env, folder: path.join(path.dirname(wslFolder), 'task'), program: () => undefined }).remove();
}

/** 2. The Docker context `devspaces` of the setting devspaces.createDockerContext (R-ENG-007). */
async function removeDockerContext(deps: UninstallDeps): Promise<void> {
  const { logger } = deps;
  const configDir = absolute(dockerConfigDir(deps.env, deps.platform, deps.homeDir));
  if (configDir === undefined) throw new Error('the folder of the configuration of the Docker CLI is not an absolute path');
  const result = await removeDockerContextFiles(configDir);
  switch (result.kind) {
    case 'removed':
      logger.info(`Devspaces removed its Docker context devspaces from ${configDir}.`);
      return;
    case 'missing':
      return;
    case 'taken':
      logger.info('The Docker context devspaces was not created by Devspaces, so it stays.');
      return;
    case 'current':
      logger.warn(`The Docker context devspaces is the current Docker context in ${path.join(configDir, 'config.json')}, so it stays. To remove it, run "docker context use default" and then "docker context rm devspaces".`);
      return;
    case 'failed':
      throw new Error(result.detail);
  }
}

/** The folder of the WSL distribution of Devspaces (`%LOCALAPPDATA%\nimblescape\devspaces\wsl`); undefined without LOCALAPPDATA. */
function wslFolderOf(deps: UninstallDeps): string | undefined {
  return absolute(deps.wslFolder ?? wslSetupFolder(deps.env));
}

/** The folder of Devspaces outside of VS Code on this platform, or undefined where there is none. */
function devspacesFolder(deps: UninstallDeps): DevspacesFolder | undefined {
  if (deps.platform === 'darwin' || deps.platform === 'linux') {
    const homeDir = absolute(deps.homeDir);
    if (homeDir === undefined) return undefined;
    const paths = limaPaths(homeDir);
    // Also a VM that `limactl create` left half done: only `limactl delete` removes it.
    return { root: paths.root, lockName: 'vm-setup.lock', hasVm: () => exists(path.join(paths.home, LIMA_INSTANCE)), vmName: 'The VM of Devspaces' };
  }
  if (deps.platform !== 'win32') return undefined;
  const wslFolder = wslFolderOf(deps);
  if (wslFolder === undefined) return undefined;
  // A distribution of Devspaces has its virtual disk in a folder `disk` (or `disk-2` and so on) of the folder `wsl`.
  return { root: path.dirname(wslFolder), lockName: `${path.basename(wslFolder)}.lock`, hasVm: () => holdsFileWith(wslFolder, WSL_DISK_EXTENSION), vmName: 'The WSL distribution of Devspaces' };
}

/**
 * 3. The folder of Devspaces outside of VS Code, only when no VM of Devspaces is in it, under the lock of the setup, so
 * that no window of another VS Code on this computer creates the VM meanwhile. Then its parent `nimblescape` goes too,
 * when it is empty.
 */
async function removeDevspacesFolder(deps: UninstallDeps): Promise<void> {
  const { logger } = deps;
  const folder = devspacesFolder(deps);
  if (folder === undefined || !(await exists(folder.root))) return;
  let removed = false;
  try {
    await withLockFolder(
      path.join(folder.root, folder.lockName),
      async () => {
        if (await folder.hasVm()) {
          logger.info(`${folder.vmName} exists, so its folder ${folder.root} stays. The user guide says how to delete it (Uninstall).`);
          return;
        }
        for (const name of await fs.promises.readdir(folder.root)) {
          if (name !== folder.lockName) await fs.promises.rm(path.join(folder.root, name), { recursive: true, force: true });
        }
        removed = true;
      },
      SETUP_LOCK_TIMINGS,
    );
  } catch (error) {
    if (!(error instanceof LockTimeoutError)) throw error;
    logger.info(`Another window sets up the VM of Devspaces now, so the folder ${folder.root} stays.`);
    return;
  }
  if (!removed) return;
  // Not empty when another window began a setup after the lock was free again: then the folder stays.
  if (await removeEmptyFolder(folder.root)) await removeEmptyFolder(path.dirname(folder.root));
  logger.info(`Devspaces removed its folder ${folder.root}.`);
}

/** Removes `folder` when it is empty. False when it is not empty or cannot be removed. */
async function removeEmptyFolder(folder: string): Promise<boolean> {
  try {
    await fs.promises.rmdir(folder);
    return true;
  } catch {
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

/** True when `folder` or a folder in it holds a file whose name ends with `extension` (any case). */
async function holdsFileWith(folder: string, extension: string): Promise<boolean> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(folder, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return entries.some((entry) => !entry.isDirectory() && entry.name.toLowerCase().endsWith(extension));
}

/** A logger for the log of VS Code: each line on stdout, an error on stderr. */
export function consoleLogger(out: (text: string) => void, err: (text: string) => void): Logger {
  return {
    info: (text) => out(`INFO ${text}\n`),
    warn: (text) => out(`WARN ${text}\n`),
    error: (text, error) => err(`ERROR ${error === undefined ? text : `${text} ${errorMessage(error)}`}\n`),
    output: (text) => out(text),
  };
}

/** Runs the hook when this file is the main module. */
async function main(): Promise<void> {
  await runUninstall({
    runner: new NodeProcessRunner(),
    logger: consoleLogger(
      (text) => process.stdout.write(text),
      (text) => process.stderr.write(text),
    ),
    platform: process.platform,
    env: process.env,
    homeDir: os.homedir(),
    uid: () => os.userInfo().uid,
  });
  process.exitCode = 0;
}

if (require.main === module) void main();
