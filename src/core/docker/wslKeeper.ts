// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The keeper of a WSL distribution that is a Docker host of Devspaces (docs/architecture.md "The WSL distribution of
// Devspaces", R-VM-004): a `wsl.exe` that is not a child of VS Code and runs the idle script of the image of the VM
// (/usr/lib/devspaces/idle, the same script as the service devspaces-idle in Lima), so that it holds the distribution
// while something runs there, also after VS Code closed. When the script ends, nothing ran at two checks in a row, and
// WSL stops the distribution 15 seconds after the last `wsl.exe` for it. One keeper at a time runs in a distribution.
// Each `wsl.exe` that a window starts there starts it (`keep`, at most once a minute). No `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../errors';
import type { Logger } from '../ports';
import { envValue } from './dockerCli';
import { WSL_DISTRIBUTION, wslCommandArgs } from './dockerHost';

/**
 * A window starts the keeper at most this often. After the idle script of its keeper ended, the distribution stops for
 * the window this long (WslKeeper.stopping).
 */
export const KEEPER_LAUNCH_MS = 60_000;
/**
 * A keeper that ends earlier than this after its start ended at once (logged): the idle script ends at the earliest
 * after two checks, two minutes.
 */
export const KEEPER_EARLY_END_MS = 10_000;
/**
 * How long a new keeper waits for the lock of the keeper that runs: longer than the two last checks of the idle script
 * of that keeper (two waits of a minute and two `docker ps` at their time limit of 30 seconds), so that a keeper that
 * ends just after the start of a new one hands over to it; and long, because a window starts its next keeper only after
 * this one ended (about every 11 minutes while another keeper runs, for example the one of another window).
 */
export const KEEPER_LOCK_WAIT_SECONDS = 600;
/** The lock file of the keeper in the distribution (a tmpfs, empty after each start of the distribution). */
export const KEEPER_LOCK = '/run/devspaces-keeper';
/** The idle script of the image of the VM (vm/rootfs/usr/lib/devspaces/idle). */
export const WSL_IDLE_SCRIPT = '/usr/lib/devspaces/idle';
/** The log of the idle script of the keeper in the distribution: its last lines, kept at each start. */
export const WSL_IDLE_LOG = '/var/log/devspaces-idle.log';
/** The lines of WSL_IDLE_LOG that each keeper keeps from earlier ones. */
export const WSL_IDLE_LOG_LINES = 300;

/**
 * The script of the keeper (`sh -c`), as root in the distribution. It holds the lock KEEPER_LOCK (`flock`): while
 * another keeper holds it, it waits for it up to KEEPER_LOCK_WAIT_SECONDS and then ends; so a keeper that started while
 * another one ran its last checks takes over when that one ends, and at most a few wait while one runs. With the lock,
 * it keeps the last WSL_IDLE_LOG_LINES lines of WSL_IDLE_LOG, writes its start with the time into it, and runs the idle
 * script WSL_IDLE_SCRIPT with its output into that log. The idle script ends with exit code 0 after two checks in a row,
 * one minute apart, at which nothing ran (no container, no program connected to Docker Engine, no package upgrade);
 * the keeper ends with it, with its exit code. The idle script does not get the lock (`9>&-`), so that the lock goes
 * with the end of the keeper. `flock` (util-linux) is in every Debian. A distribution without the idle script (one that
 * an earlier version of Devspaces set up) ends the keeper at once with exit code 127. One line without a double quote
 * and a backslash, so that the quoting of a command line on Windows cannot change it.
 */
export const KEEPER_SCRIPT = [
  `exec >/dev/null 2>&1 9>${KEEPER_LOCK}`,
  `flock -w ${KEEPER_LOCK_WAIT_SECONDS} 9||exit`,
  `[ -f ${WSL_IDLE_LOG} ]&&tail -n ${WSL_IDLE_LOG_LINES} ${WSL_IDLE_LOG} >${WSL_IDLE_LOG}.part&&mv -f ${WSL_IDLE_LOG}.part ${WSL_IDLE_LOG}`,
  `exec >>${WSL_IDLE_LOG} 2>&1`,
  'echo $(date -u -Iseconds) The keeper runs the idle script.',
  `${WSL_IDLE_SCRIPT} 9>&-`,
].join(';');

/**
 * `wslg.exe` of WSL from the Microsoft Store: `%ProgramFiles%\WSL\wslg.exe`, a program without a console window
 * (`ProgramW6432` first, the 64-bit folder also for a 32-bit process, as findDockerCli).
 */
export function wslgPathOf(env: NodeJS.ProcessEnv): string {
  const programs = envValue(env, 'ProgramW6432', 'win32') ?? envValue(env, 'ProgramFiles', 'win32') ?? 'C:\\Program Files';
  return path.win32.join(programs, 'WSL', 'wslg.exe');
}

/**
 * The arguments of `wslg.exe` that start the keeper in `distribution`: `--shell-type none` runs `sh` without a shell
 * of the user, and `wslg.exe` reads the words from the first one that is no option (`sh`) as `wsl.exe --exec` does
 * (CommandLineToArgvW; WslgMain in src/windows/common/WslClient.cpp of microsoft/WSL).
 */
export function keeperWslgArgs(distribution: string): string[] {
  return ['-d', distribution, '-u', 'root', '--cd', '/', '--shell-type', 'none', 'sh', '-c', KEEPER_SCRIPT];
}

export interface WslKeeperDeps {
  /** The path of `wsl.exe` (findExecutable), or undefined (not on Windows, or without WSL); read only without `wslg.exe`. */
  wslPath: () => string | undefined;
  env: NodeJS.ProcessEnv;
  /**
   * Starts a program that is not a child of this process and outlives it, without a window (launchDetachedProcess);
   * `onExit` runs with its exit code when it ended while this process runs.
   */
  launch: (file: string, args: readonly string[], onExit: (code: number | null) => void) => Promise<void>;
  logger: Logger;
  /**
   * Runs when the idle script of a keeper of this window ended (`stopping` turns true): nothing ran in the distribution
   * at its last two checks, so a `wsl.exe` of this window that only waits there (the shell before the relay, which
   * the view Docker Hosts keeps open for 2 minutes) must end, because it would hold the distribution (R-VM-004).
   */
  onIdleEnded?: (distribution: string) => void;
  /** For the tests. Default: whether the file exists. */
  exists?: (file: string) => boolean;
  /** For the tests. Default: Date.now. */
  now?: () => number;
}

/**
 * The keeper of the WSL distribution of Devspaces (WSL_DISTRIBUTION; a distribution of the user keeps its own rules:
 * the keeper would hold it while any container of the user runs there).
 */
export class WslKeeper {
  /** The time of the last start of the keeper, by distribution. */
  private readonly launchedAt = new Map<string, number>();
  /** The distributions where the keeper that this window started still runs or waits for the lock. */
  private readonly running = new Set<string>();
  /**
   * The time of the end of the last keeper that this window started, by distribution, when its idle script ended (exit
   * code 0 after it ran): nothing ran there at its last two checks, and WSL stops the distribution unless another
   * `wsl.exe` holds it.
   */
  private readonly idleEndedAt = new Map<string, number>();
  /**
   * The last warning about the start of the keeper or its end at once, so that a failure that stays is logged once;
   * cleared when a keeper ran longer than KEEPER_EARLY_END_MS.
   */
  private launchWarning: string | undefined;
  /** Whether this window logged the start of a keeper. */
  private startLogged = false;
  private disposed = false;

  constructor(private readonly deps: WslKeeperDeps) {}

  /**
   * This window uses the WSL distribution `distribution` now (it starts a `wsl.exe` there): starts the keeper there,
   * only in the WSL distribution of Devspaces, and unless the keeper that this window started there still runs or waits
   * for the lock, or this window started one within the last minute (KEEPER_LAUNCH_MS). `wslg.exe` when it exists, so
   * that no console window opens; else `wsl.exe`. While another keeper runs there, the new one waits for its end
   * (KEEPER_LOCK_WAIT_SECONDS). A keeper that ends at once is logged once while it stays so. Nothing after `dispose`.
   * Never throws.
   */
  keep(distribution: string): void {
    if (this.disposed || distribution !== WSL_DISTRIBUTION || this.running.has(distribution)) return;
    const now = this.now();
    const last = this.launchedAt.get(distribution);
    if (last !== undefined && Math.abs(now - last) < KEEPER_LAUNCH_MS) return;
    this.launchedAt.set(distribution, now);
    this.idleEndedAt.delete(distribution);
    void this.launchKeeper(distribution);
  }

  /** Whether the keeper that this window started in `distribution` runs or waits for the lock: the distribution runs. */
  holds(distribution: string): boolean {
    return this.running.has(distribution);
  }

  /**
   * Whether the WSL distribution `distribution` stops now: the idle script of the keeper that this window started there
   * ended within the last KEEPER_LAUNCH_MS (nothing ran there at its last two checks), and no keeper of this window
   * started since. WSL stops the distribution 15 seconds after the last `wsl.exe` for it, so the work in the background
   * leaves it alone meanwhile (WslLifetime), as the VM of Lima powers off.
   */
  stopping(distribution: string): boolean {
    const ended = this.idleEndedAt.get(distribution);
    return ended !== undefined && !this.running.has(distribution) && Math.abs(this.now() - ended) < KEEPER_LAUNCH_MS;
  }

  /** No keeper starts after this; a keeper that runs goes on. */
  dispose(): void {
    this.disposed = true;
  }

  private async launchKeeper(distribution: string): Promise<void> {
    const program = this.keeperProgram(distribution);
    if (program === undefined) return;
    const startedAt = this.now();
    this.running.add(distribution);
    try {
      await this.deps.launch(program.file, program.args, (code) => {
        this.running.delete(distribution);
        if (Math.abs(this.now() - startedAt) >= KEEPER_EARLY_END_MS) {
          this.launchWarning = undefined;
          // Exit code 0: the idle script ended. Any other one: the wait for the lock ended, or the distribution stopped.
          if (code === 0) {
            this.idleEndedAt.set(distribution, this.now());
            this.deps.onIdleEnded?.(distribution);
          }
          return;
        }
        // A keeper that ends at once could not open the lock (no /run), found no idle script (exit code 127), or
        // wslg.exe or wsl.exe could not run it, or does not wait for its end.
        const missing =
          code === 127
            ? `; the distribution may have no idle script ${WSL_IDLE_SCRIPT}, because an earlier version of Devspaces set it up: remove it with "Remove the WSL Distribution of Devspaces…" and set it up again`
            : '';
        this.warnLaunch(`The keeper of the WSL distribution ${distribution} ended at once (exit code ${code ?? 'none'})${missing}`);
      });
      if (!this.startLogged) {
        this.startLogged = true;
        this.deps.logger.info(
          `Devspaces starts the keeper of the WSL distribution ${distribution} (${path.win32.basename(program.file)}): the idle script of the VM holds the distribution while something runs there, also after VS Code closed.`,
        );
      }
    } catch (error) {
      this.running.delete(distribution);
      this.warnLaunch(`The keeper of the WSL distribution ${distribution} could not start: ${errorMessage(error)}`);
    }
  }

  /** Logs `problem` of the keeper once while it stays. */
  private warnLaunch(problem: string): void {
    const warning = `${problem}. Without a keeper, WSL stops the distribution 15 seconds after the last command of Devspaces there ended, also while a container runs there.`;
    if (warning !== this.launchWarning) this.deps.logger.warn(warning);
    this.launchWarning = warning;
  }

  /** `wslg.exe` with keeperWslgArgs when it exists, else `wsl.exe --exec`; undefined without either. */
  private keeperProgram(distribution: string): { file: string; args: string[] } | undefined {
    const wslg = this.wslg();
    if (wslg !== undefined) return { file: wslg, args: keeperWslgArgs(distribution) };
    const wsl = this.deps.wslPath();
    return wsl === undefined ? undefined : { file: wsl, args: wslCommandArgs(distribution, ['sh', '-c', KEEPER_SCRIPT]) };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The path of `wslg.exe` (wslgPathOf) when it exists. */
  private wslg(): string | undefined {
    const file = wslgPathOf(this.deps.env);
    return (this.deps.exists ?? fs.existsSync)(file) ? file : undefined;
  }
}
