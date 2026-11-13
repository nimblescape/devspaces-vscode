// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Show Log on the view Docker Hosts and its reports (docs/requirements.md R-ENG-008, R-ENG-010): the last lines of the
// log of a container of a host, read with one fixed `docker logs` call (isContainerLogCall) on the shared shell of the
// host, or through the Docker pipe of the extension, which lets through the log of any container while the setting
// allowContainerLogs is on; never followed. The container is named by its full ID (a row of the view), or by the name
// of the Monitor (Show Log of the Monitor, also on the report of its volume). Each line starts with the time of Docker
// (which also sorts the output and the errors) and a time in UTC that the program wrote at the start of its text (the
// Monitor does), both as `2026-11-12 22:07:25.606` in the time zone of this computer, as the report page gives times.
// No `vscode`.
import type { BootstrapDocker } from '../docker/bootstrapDocker';
import { CommandError } from '../errors';
import { readableStderr } from '../loader/pipeLoader';
import { REMOTE_MONITOR_CONTAINER } from '../remoteMonitor/protocol';
import { logTimeText } from './reportModel';

/** The lines of the log of a container that Show Log gives (the log driver of the Monitor keeps at most 2 files of 1 MB). */
export const CONTAINER_LOG_LINES = 2000;
/** The time limit of the read of the log of a container. */
const CONTAINER_LOG_TIMEOUT_MS = 60_000;
/** The most characters of the errors of the call that a failure keeps (its end). */
const ERROR_LENGTH = 2000;
/** The full ID of a container, as the view Docker Hosts knows it (`--no-trunc`). */
const CONTAINER_ID = /^[0-9a-f]{64}$/;

/** Whether `container` is a container that Show Log reads: a full ID, or the name of the Monitor. */
export function isLogContainer(container: string): boolean {
  return container === REMOTE_MONITOR_CONTAINER || CONTAINER_ID.test(container);
}

/**
 * The call of Show Log: the last CONTAINER_LOG_LINES lines of the log of `container` (isLogContainer), with their times,
 * never followed. Throws for any other name, so that no other call can come from it.
 */
export function containerLogArgs(container: string): string[] {
  if (!isLogContainer(container)) throw new Error('Show Log reads only a container by its full ID, or the Monitor.');
  return ['logs', '--tail', String(CONTAINER_LOG_LINES), '--timestamps', container];
}

/** The call of Show Log of the Monitor (containerLogArgs of its container). */
export function monitorLogArgs(): string[] {
  return containerLogArgs(REMOTE_MONITOR_CONTAINER);
}

/** Whether `args` is exactly a call of containerLogArgs (a read that the shared shell of a host runs too). */
export function isContainerLogCall(args: readonly string[]): boolean {
  if (args.length !== 5 || !isLogContainer(args[4])) return false;
  const expected = containerLogArgs(args[4]);
  return args.every((arg, index) => arg === expected[index]);
}

/**
 * The log of `container` (isLogContainer) on the host (Show Log): its output and its errors, with the times of each line
 * in `timeZone` (readableTimes). Throws a CommandError when Docker fails (for example when the container is gone, or
 * when its log driver gives no log), and an AbortError.
 */
export async function readContainerLog(docker: Pick<BootstrapDocker, 'run'>, container: string, timeZone: string, signal?: AbortSignal): Promise<string> {
  const args = containerLogArgs(container);
  const result = await docker.run(args, { timeoutMs: CONTAINER_LOG_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) });
  if (result.exitCode !== 0 || result.timedOut) {
    const stderr = result.timedOut ? 'The command did not end within the time limit.' : readableStderr(result.stderr.slice(-ERROR_LENGTH), ERROR_LENGTH);
    throw new CommandError(`docker logs ${container}`, result.exitCode, '', stderr, result.timedOut);
  }
  return mergedLogLines(result.stdout, result.stderr)
    .map((line) => readableTimes(line, timeZone))
    .join('\n');
}

/** The log of the Monitor of the host (Show Log of the Monitor): readContainerLog of its container. */
export function readMonitorLog(docker: Pick<BootstrapDocker, 'run'>, timeZone: string, signal?: AbortSignal): Promise<string> {
  return readContainerLog(docker, REMOTE_MONITOR_CONTAINER, timeZone, signal);
}

/** Whether the error of a failed Show Log says that the log driver of the container gives no log (for example `none`). */
export function isNoLogDriverError(detail: string): boolean {
  return /does not support reading/i.test(detail);
}

/** A time in UTC at the start of a text and its space: of Docker (`--timestamps`, 9 digits), of the Monitor (`toISOString`). */
const UTC_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z /;

/** The time at the start of `text` (UTC_TIME) in milliseconds, and the text after it; undefined without one. */
function leadingTime(text: string): { at: number; rest: string } | undefined {
  const match = UTC_TIME.exec(text);
  if (match === null) return undefined;
  const at = Date.parse(`${match[1]}.${(match[2] ?? '').slice(0, 3).padEnd(3, '0')}Z`);
  return Number.isNaN(at) ? undefined : { at, rest: text.slice(match[0].length) };
}

/**
 * A line of the log with its times as `2026-11-12 22:07:25.606` in `timeZone`: the time of Docker, and a time in UTC that
 * the program wrote at the start of its text, as the Monitor does (a line without it, for example of an error of
 * Node.js, has only the time of Docker). A line without the time of Docker stays as it is.
 */
export function readableTimes(line: string, timeZone: string): string {
  const docker = leadingTime(line);
  if (docker === undefined) return line;
  const own = leadingTime(docker.rest);
  const text = own !== undefined ? `${logTimeText(own.at, timeZone)} ${own.rest}` : docker.rest;
  return `${logTimeText(docker.at, timeZone)} ${text}`;
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
