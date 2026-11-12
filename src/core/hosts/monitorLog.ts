// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Show Log of the Monitor on the report of the container of the Monitor (docs/requirements.md R-ENG-010): the last lines
// of the log of the container devspaces-monitor of a host, read with one fixed `docker logs` call on the shared shell of
// the host (isMonitorLogCall), never followed. No `vscode`.
import type { BootstrapDocker } from '../docker/bootstrapDocker';
import { CommandError } from '../errors';
import { readableStderr } from '../loader/pipeLoader';
import { REMOTE_MONITOR_CONTAINER } from '../remoteMonitor/protocol';

/** The lines of the log of the Monitor that Show Log of the Monitor gives (its log driver keeps at most 2 files of 1 MB). */
export const MONITOR_LOG_LINES = 2000;
/** The time limit of the read of the log of the Monitor. */
const MONITOR_LOG_TIMEOUT_MS = 60_000;
/** The most characters of the errors of the call that a failure keeps (its end). */
const ERROR_LENGTH = 2000;

/** The call of Show Log of the Monitor: the last MONITOR_LOG_LINES lines of its log, with their times, never followed. */
export function monitorLogArgs(): string[] {
  return ['logs', '--tail', String(MONITOR_LOG_LINES), '--timestamps', REMOTE_MONITOR_CONTAINER];
}

/** Whether `args` is exactly the call of monitorLogArgs (a read that the shared shell of a host runs too). */
export function isMonitorLogCall(args: readonly string[]): boolean {
  const expected = monitorLogArgs();
  return args.length === expected.length && args.every((arg, index) => arg === expected[index]);
}

/**
 * The log of the Monitor of the host (Show Log of the Monitor), as Docker gives it: its output and its errors, each line
 * with its time. Throws a CommandError when Docker fails (for example when the Monitor has no container), and an
 * AbortError.
 */
export async function readMonitorLog(docker: Pick<BootstrapDocker, 'run'>, signal?: AbortSignal): Promise<string> {
  const args = monitorLogArgs();
  const result = await docker.run(args, { timeoutMs: MONITOR_LOG_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) });
  if (result.exitCode !== 0 || result.timedOut) {
    const stderr = result.timedOut ? 'The command did not end within the time limit.' : readableStderr(result.stderr.slice(-ERROR_LENGTH), ERROR_LENGTH);
    throw new CommandError(`docker logs ${REMOTE_MONITOR_CONTAINER}`, result.exitCode, '', stderr, result.timedOut);
  }
  return mergedLogLines(result.stdout, result.stderr).join('\n');
}

/**
 * The lines of the output and of the errors of a container (Docker gives each in its own stream) in the order of their
 * times (`--timestamps`: each line starts with its time in UTC, RFC 3339 with always 9 digits of nanoseconds, so the
 * texts sort as the times). Each stream keeps its own order; a line without a time stays after the line before it.
 */
export function mergedLogLines(stdout: string, stderr: string): string[] {
  const lines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
  const out = lines(stdout);
  const err = lines(stderr);
  const time = (line: string): string => /^\d{4}-\d{2}-\d{2}T\S+Z /.exec(line)?.[0] ?? '';
  const merged: string[] = [];
  let i = 0;
  let j = 0;
  let lastOut = '';
  let lastErr = '';
  while (i < out.length || j < err.length) {
    const nextOut = i < out.length ? time(out[i]) || lastOut : undefined;
    const nextErr = j < err.length ? time(err[j]) || lastErr : undefined;
    if (nextErr === undefined || (nextOut !== undefined && nextOut <= nextErr)) {
      merged.push(out[i++]);
      lastOut = nextOut ?? lastOut;
    } else {
      merged.push(err[j++]);
      lastErr = nextErr;
    }
  }
  return merged;
}
