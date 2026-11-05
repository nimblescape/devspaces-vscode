// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker CLI in a WSL distribution, for the build of the helper image there with its buildx
// (BootstrapDockerOptions.hostCli): `wsl.exe -d <distribution> -u root --cd / --exec env DEVSPACES_RUN=<mark> docker
// <args>`. A program in the distribution does not always end when its `wsl.exe` ends, so after a Cancel or a time limit,
// which end `wsl.exe`, a second `wsl.exe` ends the processes with that mark in their environment (the Docker CLI and its
// buildx), and the engine then stops their build. No `vscode`.
import * as crypto from 'crypto';
import { errorMessage } from '../errors';
import { abortError, isStartError, type Logger, type RunOptions, type RunResult } from '../ports';
import type { HostDockerCli } from './bootstrapDocker';
import { WSL_START_ATTEMPTS, wslCommandArgs, wslStartTimedOut, wslText } from './dockerHost';
import { endOf, outputOf } from './wslSetup';

/** The variable of the environment that marks the processes of one call (wslMarkedCommand). */
const MARK_VARIABLE = 'DEVSPACES_RUN';

/**
 * The script that sends SIGTERM to each process whose environment has the line `$1` (`DEVSPACES_RUN=<mark>`), as root
 * (it reads /proc/<pid>/environ of every process); twice, 2 seconds apart, for a process that `wsl.exe` started only
 * just before its Cancel. Errors of processes that ended meanwhile are not shown.
 */
const END_SCRIPT =
  'exec 2>/dev/null; end() { for p in /proc/[0-9]*; do if tr "\\000" "\\n" < "$p/environ" | grep -qxF -e "$1"; then kill "${p#/proc/}"; fi; done; }; ' +
  'end "$1"; sleep 2; end "$1"; exit 0';

/** Time limit of the call that ends the processes of a call. */
export const WSL_END_TIMEOUT_MS = 60_000;

/** `command` with the mark `mark` in its environment: `env DEVSPACES_RUN=<mark> <command…>`. */
export function wslMarkedCommand(mark: string, command: readonly string[]): string[] {
  return ['env', `${MARK_VARIABLE}=${mark}`, ...command];
}

/** The command that ends the processes of the mark `mark` (wslMarkedCommand) in the distribution: `sh -c <script>`. */
export function wslEndCommand(mark: string): string[] {
  return ['sh', '-c', END_SCRIPT, 'sh', `${MARK_VARIABLE}=${mark}`];
}

/**
 * `docker <args>` in the WSL distribution `distribution` (wslCommandArgs, wslMarkedCommand), with `runWsl`, which runs
 * `wsl.exe <args>`; its output is read with wslText (the messages of an older `wsl.exe` are UTF-16). When WSL ran out of
 * time to start the distribution (wslStartTimedOut), the call runs again, at most WSL_START_ATTEMPTS times, as the other
 * calls of Devspaces in WSL. When the call is cancelled (AbortError), ends by its time limit, or fails after `wsl.exe`
 * started (for example too much output), the processes of its mark are ended in the background (wslEndCommand); a
 * failure of that is logged. A signal that aborted before the call starts nothing.
 */
export function wslDockerCli(runWsl: (args: readonly string[], options: RunOptions) => Promise<RunResult>, distribution: string, logger: Logger): HostDockerCli {
  return async (args, options) => {
    if (options.signal?.aborted) throw abortError();
    const mark = crypto.randomBytes(16).toString('hex');
    const end = (): void => {
      const failed = (detail: string): void =>
        logger.warn(`The Docker CLI in the WSL distribution ${distribution} could not be ended after its stop, so its work may go on there: ${detail}`);
      runWsl(wslCommandArgs(distribution, wslEndCommand(mark)), { timeoutMs: WSL_END_TIMEOUT_MS }).then(
        (result) => {
          if (result.exitCode !== 0) failed(`${endOf(result, WSL_END_TIMEOUT_MS)}: ${outputOf(result).slice(-500)}`);
        },
        (error: unknown) => failed(errorMessage(error)),
      );
    };
    for (let attempt = 1; ; attempt++) {
      let result: RunResult;
      try {
        result = await runWsl(wslCommandArgs(distribution, wslMarkedCommand(mark, ['docker', ...args])), options);
      } catch (error) {
        // `wsl.exe` that did not start started nothing in the distribution.
        if (!isStartError(error)) end();
        throw error;
      }
      if (result.timedOut) end();
      const text = { ...result, stdout: wslText(result.stdout), stderr: wslText(result.stderr) };
      if (result.exitCode === 0 || result.timedOut || attempt >= WSL_START_ATTEMPTS || !wslStartTimedOut(`${text.stdout}\n${text.stderr}`)) return text;
      logger.info(`WSL ran out of time to start the distribution ${distribution} (attempt ${attempt} of ${WSL_START_ATTEMPTS}), so Devspaces starts it again: ${outputOf(text)}`);
    }
  };
}
