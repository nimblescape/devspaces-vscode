// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The lifetime of a WSL distribution that is a Docker host of Devspaces (docs/architecture.md "The WSL distribution of
// Devspaces", R-VM-004). WSL stops a distribution 15 seconds after the last `wsl.exe` process for it ended, with Docker
// and the containers in it. Each `wsl.exe` that a window starts there (`use`) starts the keeper of the distribution
// (wslKeeper.ts), which runs the idle script of the image of the VM and so holds it while something runs there, also
// after VS Code closed; no other process holds it. A Docker call in the background leaves a distribution that does not
// run, or that stops now, stopped (`leavesStopped`); a flow of the user starts it. No `vscode`.
import { errorMessage } from '../errors';
import type { Logger, ProcessRunner, RunResult } from '../ports';
import { sshPromptsAllowed } from '../sshAskpass';
import { hostAccessOf, parseWslList, wslEnv, wslText } from './dockerHost';
import type { WslKeeper } from './wslKeeper';

/** The arguments of `wsl.exe` that list the names of the running WSL distributions, one per line (none: no output). */
export const WSL_RUNNING_ARGS: readonly string[] = ['--list', '--running', '--quiet'];
/** The time limit of `wsl.exe --list --running --quiet`. */
export const WSL_RUNNING_TIMEOUT_MS = 5_000;

export interface WslLifetimeDeps {
  runner: Pick<ProcessRunner, 'run'>;
  /** The path of `wsl.exe` (findExecutable), or undefined (not on Windows, or without WSL). */
  wslPath: () => string | undefined;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /** The keeper of the distribution (WslKeeper), which holds it while something runs there, also after VS Code closed. */
  keeper: Pick<WslKeeper, 'keep' | 'holds' | 'stopping'>;
}

/**
 * The rule for the `wsl.exe` of this window and for its Docker calls in the background on a WSL host. Hosts that are no
 * WSL distribution are not touched.
 */
export class WslLifetime {
  /** The `wsl.exe --list --running --quiet` that runs now, which the calls at the same time share. */
  private listing: Promise<RunResult> | undefined;
  /** The last state that `leavesStopped` logged, by host: true while it leaves the distribution stopped. */
  private readonly saidStopped = new Map<string, boolean>();
  /** The last warning of `running`, by distribution, so that a failure that stays is logged once. */
  private readonly runningWarnings = new Map<string, string>();
  private disposed = false;

  constructor(private readonly deps: WslLifetimeDeps) {}

  /**
   * Whether the WSL distribution `distribution` runs now (`wsl.exe --list --running --quiet`; WSL compares the names
   * without case). With `--quiet`, WSL answers exit code 0 and no line when no distribution runs (ListDistributionsHelper
   * of src/windows/common/WslClient.cpp in microsoft/WSL); without it, it would say so with an exit code that is not 0.
   * Undefined when that cannot be told: without `wsl.exe`, or when it fails or does not answer within
   * WSL_RUNNING_TIMEOUT_MS (logged once until it works again). Never rejects.
   */
  async running(distribution: string): Promise<boolean | undefined> {
    const wsl = this.deps.wslPath();
    if (wsl === undefined) return undefined;
    try {
      this.listing ??= this.deps.runner.run(wsl, WSL_RUNNING_ARGS, { env: wslEnv(this.deps.env), timeoutMs: WSL_RUNNING_TIMEOUT_MS }).finally(() => {
        this.listing = undefined;
      });
      const result = await this.listing;
      if (result.timedOut) throw new Error(`it did not answer within ${WSL_RUNNING_TIMEOUT_MS / 1000} seconds`);
      if (result.exitCode !== 0) throw new Error(`exit code ${result.exitCode}: ${wslText(result.stderr || result.stdout).trim()}`);
      this.runningWarnings.delete(distribution);
      const name = distribution.toLowerCase();
      return parseWslList(result.stdout).some((listed) => listed.toLowerCase() === name);
    } catch (error) {
      const warning = `wsl.exe ${WSL_RUNNING_ARGS.join(' ')} failed, so Devspaces does not know whether the WSL distribution ${distribution} runs: ${errorMessage(error)}`;
      if (this.runningWarnings.get(distribution) !== warning) this.deps.logger.warn(warning);
      this.runningWarnings.set(distribution, warning);
      return undefined;
    }
  }

  /**
   * Whether a Docker call on the engine `host` must not run now, because it would start a WSL distribution that does
   * not run, or hold one that stops now: true only for a WSL host, outside of a flow of the user (withSshPrompts), and
   * when the idle script of the keeper of this window ended there within the last minute (WslKeeper.stopping), or
   * `running` says that the distribution does not run. Any other host, a flow of the user, a keeper of this window that
   * runs there (the distribution runs), and a state that cannot be told give false: the call runs, and `wsl.exe` starts
   * the distribution when it does not run. Each change of the answer for a host is logged once. Never rejects.
   */
  async leavesStopped(host: string): Promise<boolean> {
    const access = hostAccessOf(host);
    if (access?.kind !== 'wsl') return false;
    if (sshPromptsAllowed() || this.deps.keeper.holds(access.distribution)) {
      // A flow of the user starts the distribution, and a keeper of this window holds it: the next time that a call
      // leaves it stopped is logged again.
      this.saidStopped.delete(host);
      return false;
    }
    const stopped = this.deps.keeper.stopping(access.distribution) || (await this.running(access.distribution)) === false;
    if (stopped !== (this.saidStopped.get(host) ?? false)) {
      this.saidStopped.set(host, stopped);
      this.deps.logger.info(
        stopped
          ? `The WSL distribution ${access.distribution} does not run. Devspaces does not start it for its work in the background; a Start or an Open does.`
          : `The WSL distribution ${access.distribution} runs, or may be started for the work in the background again.`,
      );
    }
    return stopped;
  }

  /**
   * Devspaces starts a `wsl.exe` for the WSL host `host` now (a shell, a connection of the relay, a connection of a
   * Docker pipe): the keeper of the distribution starts (WslKeeper.keep: at most once a minute, and not while the one
   * of this window runs or waits). Outside of a flow of the user, not while the distribution stops (WslKeeper.stopping):
   * the idle script of this window ended, and a call in the background must not hold the distribution for two more
   * checks. Nothing for any other host, and after `dispose`. Never throws.
   */
  use(host: string): void {
    const access = hostAccessOf(host);
    if (this.disposed || access?.kind !== 'wsl') return;
    if (!sshPromptsAllowed() && this.deps.keeper.stopping(access.distribution)) return;
    this.deps.keeper.keep(access.distribution);
  }

  /** The window closes: nothing starts after this. A keeper that runs goes on (WslKeeper). */
  dispose(): void {
    this.disposed = true;
  }
}
