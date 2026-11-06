// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The keeper of a WSL distribution that is a Docker host of Devspaces (docs/architecture.md "The WSL distribution of
// Devspaces"): a `wsl.exe` that is not a child of VS Code, so that it also holds the distribution after VS Code closed,
// while a container runs there. It ends itself when no container ran at two checks in a row; one keeper at a time runs
// in a distribution. A window that holds the idle session starts it (`keep`, at most once a minute). No `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../errors';
import type { Logger } from '../ports';
import { envValue } from './dockerCli';
import { WSL_DISTRIBUTION, wslCommandArgs } from './dockerHost';

/** A window that holds the idle session starts the keeper at most this often. */
export const KEEPER_LAUNCH_MS = 60_000;
/**
 * A keeper that ends earlier than this after its start ended at once (logged): the script ends at the earliest after
 * two checks, two minutes.
 */
export const KEEPER_EARLY_END_MS = 10_000;
/** How often the keeper looks whether a container runs. */
export const KEEPER_CHECK_SECONDS = 60;
/** The keeper ends after this many checks in a row at which no container ran. */
export const KEEPER_QUIET_CHECKS = 2;
/** The time limit of the `docker ps` of the keeper. */
export const KEEPER_PS_TIMEOUT_SECONDS = 10;
/**
 * How long a new keeper waits for the lock of the keeper that runs: longer than the two last checks of that keeper
 * (two waits and two `docker ps` at their time limit), so that a keeper that ends just after the start of a new one
 * hands over to it; and long, because a window starts its next keeper only after this one ended (about every 11
 * minutes while another keeper runs, for example the one of another window).
 */
export const KEEPER_LOCK_WAIT_SECONDS = 600;
/** The lock file of the keeper in the distribution (a tmpfs, empty after each start of the distribution). */
export const KEEPER_LOCK = '/run/devspaces-keeper';

/**
 * The script of the keeper (`sh -c`), as root in the distribution. Its output goes nowhere. It holds the lock
 * KEEPER_LOCK (`flock`): while another keeper holds it, it waits for it up to KEEPER_LOCK_WAIT_SECONDS and then ends;
 * so a keeper that started while another one ran its last checks takes over when that one ends, and at most a few wait
 * while one runs. Every KEEPER_CHECK_SECONDS, `docker ps` looks for a running container, any container, because a
 * container that runs must not be stopped with the distribution; it has a time limit (`timeout`), and a check that
 * finds none, also a failed one, counts as quiet. After KEEPER_QUIET_CHECKS quiet checks in a row, it ends. `sleep`
 * does not get the lock (`9>&-`), so that the lock goes with the end of the script. `flock` (util-linux) and `timeout`
 * (coreutils) are in the distribution of Devspaces; without them, the keeper ends at once or after two minutes, as if
 * none ran. One line without a double quote and a backslash, so that the quoting of a command line on Windows cannot
 * change it.
 */
export const KEEPER_SCRIPT = [
  `exec >/dev/null 2>&1 9>${KEEPER_LOCK}`,
  `flock -w ${KEEPER_LOCK_WAIT_SECONDS} 9||exit`,
  'q=0',
  `while [ $q -lt ${KEEPER_QUIET_CHECKS} ]`,
  `do sleep ${KEEPER_CHECK_SECONDS} 9>&-`,
  `timeout ${KEEPER_PS_TIMEOUT_SECONDS} docker ps -q|grep -q .&&q=0||q=$((q+1))`,
  'done',
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
   * The last warning about the start of the keeper or its end at once, so that a failure that stays is logged once;
   * cleared when a keeper ran longer than KEEPER_EARLY_END_MS.
   */
  private launchWarning: string | undefined;
  /** Whether this window logged the start of a keeper. */
  private startLogged = false;
  private disposed = false;

  constructor(private readonly deps: WslKeeperDeps) {}

  /**
   * This window holds the idle session of the WSL distribution `distribution` and uses it now: starts the keeper
   * there, only in the WSL distribution of Devspaces, and unless the keeper that this window started there still runs
   * or waits for the lock, or this window started one within the last minute (KEEPER_LAUNCH_MS). `wslg.exe` when it
   * exists, so that no console window opens; else `wsl.exe`. While another keeper runs there, the new one waits for its
   * end (KEEPER_LOCK_WAIT_SECONDS). A keeper that ends at once is logged once while it stays so. Nothing after
   * `dispose`. Never throws.
   */
  keep(distribution: string): void {
    if (this.disposed || distribution !== WSL_DISTRIBUTION || this.running.has(distribution)) return;
    const now = (this.deps.now ?? Date.now)();
    const last = this.launchedAt.get(distribution);
    if (last !== undefined && Math.abs(now - last) < KEEPER_LAUNCH_MS) return;
    this.launchedAt.set(distribution, now);
    void this.launchKeeper(distribution);
  }

  /** No keeper starts after this; a keeper that runs goes on. */
  dispose(): void {
    this.disposed = true;
  }

  private async launchKeeper(distribution: string): Promise<void> {
    const program = this.keeperProgram(distribution);
    if (program === undefined) return;
    const now = this.deps.now ?? Date.now;
    const startedAt = now();
    this.running.add(distribution);
    try {
      await this.deps.launch(program.file, program.args, (code) => {
        this.running.delete(distribution);
        if (Math.abs(now() - startedAt) >= KEEPER_EARLY_END_MS) {
          this.launchWarning = undefined;
          return;
        }
        // A keeper that ends at once could not open the lock (no flock, no /run), or wslg.exe or wsl.exe could not run
        // it, or does not wait for its end.
        this.warnLaunch(`The keeper of the WSL distribution ${distribution} ended at once (exit code ${code ?? 'none'})`);
      });
      if (!this.startLogged) {
        this.startLogged = true;
        this.deps.logger.info(
          `Devspaces starts the keeper of the WSL distribution ${distribution} (${path.win32.basename(program.file)}), so that it runs while a container runs there, also after VS Code closed.`,
        );
      }
    } catch (error) {
      this.running.delete(distribution);
      this.warnLaunch(`The keeper of the WSL distribution ${distribution} could not start: ${errorMessage(error)}`);
    }
  }

  /** Logs `problem` of the keeper once while it stays. */
  private warnLaunch(problem: string): void {
    const warning = `${problem}. Without a keeper, WSL stops the distribution 15 seconds after VS Code closed, also while a container runs there.`;
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

  /** The path of `wslg.exe` (wslgPathOf) when it exists. */
  private wslg(): string | undefined {
    const file = wslgPathOf(this.deps.env);
    return (this.deps.exists ?? fs.existsSync)(file) ? file : undefined;
  }
}
