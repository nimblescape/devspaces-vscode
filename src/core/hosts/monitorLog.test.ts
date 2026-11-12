// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Show Log of the Monitor (docs/requirements.md R-ENG-010): one fixed call that reads the last lines of the log of the
// container of the Monitor and never follows it; the shared shell knows this call exactly; the output and the errors of
// the container come in the order of their times, each line with one time; a failure says why.
import { describe, expect, it } from 'vitest';
import { CommandError } from '../errors';
import type { RunOptions, RunResult } from '../ports';
import { MONITOR_LOG_LINES, isMonitorLogCall, mergedLogLines, monitorLogArgs, readMonitorLog, readableTimes } from './monitorLog';

const T = (second: number) => `2026-11-12T07:52:${String(second).padStart(2, '0')}.000000000Z`;
/** The same time in milliseconds, as the Monitor writes it. */
const M = (second: number) => `2026-11-12T07:52:${String(second).padStart(2, '0')}.000Z`;
/** The same time as Show Log of the Monitor gives it (the tests read in UTC). */
const L = (second: number) => `2026-11-12 07:52:${String(second).padStart(2, '0')}.000`;

function fakeDocker(result: RunResult) {
  const calls: Array<{ args: string[]; options: RunOptions | undefined }> = [];
  return {
    calls,
    run: async (args: string[], options?: RunOptions): Promise<RunResult> => {
      calls.push({ args, options });
      return result;
    },
  };
}

describe('the call of Show Log of the Monitor', () => {
  it('reads the last lines of the container devspaces-monitor with their times, and never follows the log', () => {
    expect(monitorLogArgs()).toEqual(['logs', '--tail', String(MONITOR_LOG_LINES), '--timestamps', 'devspaces-monitor']);
    expect(monitorLogArgs()).not.toContain('--follow');
    expect(monitorLogArgs()).not.toContain('-f');
  });

  it('is known exactly: another container, another number of lines, or one more word is another call', () => {
    expect(isMonitorLogCall(monitorLogArgs())).toBe(true);
    expect(isMonitorLogCall(['logs', '--tail', String(MONITOR_LOG_LINES), '--timestamps', 'shop-web-1'])).toBe(false);
    expect(isMonitorLogCall(['logs', '--tail', '100000', '--timestamps', 'devspaces-monitor'])).toBe(false);
    expect(isMonitorLogCall([...monitorLogArgs(), '--follow'])).toBe(false);
    expect(isMonitorLogCall(['logs', '--follow', 'devspaces-monitor'])).toBe(false);
    expect(isMonitorLogCall([])).toBe(false);
  });
});

describe('readMonitorLog', () => {
  it('gives the output and the errors in the order of their times, with a time limit and the signal', async () => {
    const docker = fakeDocker({ exitCode: 0, stdout: `${T(1)} run started\n${T(3)} run ended\n`, stderr: `${T(2)} warning: slow pull\n`, timedOut: false });
    const signal = new AbortController().signal;
    expect(await readMonitorLog(docker, 'UTC', signal)).toBe(`${L(1)} run started\n${L(2)} warning: slow pull\n${L(3)} run ended`);
    expect(docker.calls).toHaveLength(1);
    expect(docker.calls[0].args).toEqual(monitorLogArgs());
    expect(docker.calls[0].options?.timeoutMs).toBeGreaterThan(0);
    expect(docker.calls[0].options?.signal).toBe(signal);
  });

  it('says why the log could not be read: the error of Docker, or the time limit', async () => {
    const missing = readMonitorLog(fakeDocker({ exitCode: 1, stdout: '', stderr: 'Error response from daemon: No such container: devspaces-monitor\n', timedOut: false }), 'UTC');
    await expect(missing).rejects.toBeInstanceOf(CommandError);
    await expect(missing).rejects.toMatchObject({ stderr: expect.stringContaining('No such container: devspaces-monitor') });
    await expect(readMonitorLog(fakeDocker({ exitCode: 0, stdout: `${T(1)} a\n`, stderr: '', timedOut: true }), 'UTC')).rejects.toMatchObject({
      timedOut: true,
      stderr: 'The command did not end within the time limit.',
    });
  });

  it('gives an empty text when the Monitor wrote nothing yet', async () => {
    expect(await readMonitorLog(fakeDocker({ exitCode: 0, stdout: '', stderr: '', timedOut: false }), 'UTC')).toBe('');
  });
});

describe('readableTimes', () => {
  it('gives the time of Docker and the time of the Monitor as date and time in the time zone of this computer', async () => {
    const line = '2026-11-12T21:07:25.606275133Z 2026-11-12T21:07:25.606Z Monitor started.';
    expect(readableTimes(line, 'Europe/Vienna')).toBe('2026-11-12 22:07:25.606 2026-11-12 22:07:25.606 Monitor started.');
    expect(readableTimes(line, 'UTC')).toBe('2026-11-12 21:07:25.606 2026-11-12 21:07:25.606 Monitor started.');
    await expect(readLog(`${T(1)} ${M(1)} a\n`, `${T(2)} ${M(2)} b\n`)).resolves.toBe(`${L(1)} ${L(1)} a\n${L(2)} ${L(2)} b`);
  });

  it('gives only the time of Docker on a line without a time of the Monitor; a line without a time stays', () => {
    expect(readableTimes('2026-11-12T21:07:25.606275133Z     at main (main.js:1:1)', 'UTC')).toBe('2026-11-12 21:07:25.606     at main (main.js:1:1)');
    expect(readableTimes('2026-11-12T21:07:25Z node: out of memory', 'UTC')).toBe('2026-11-12 21:07:25.000 node: out of memory');
    expect(readableTimes('  detail without a time', 'UTC')).toBe('  detail without a time');
    expect(readableTimes('', 'UTC')).toBe('');
  });
});

function readLog(stdout: string, stderr: string): Promise<string> {
  return readMonitorLog(fakeDocker({ exitCode: 0, stdout, stderr, timedOut: false }), 'UTC');
}

describe('mergedLogLines', () => {
  it('keeps the order of each stream; at the same time the output comes first', () => {
    expect(mergedLogLines(`${T(1)} a\n${T(2)} b\n`, `${T(2)} x\n${T(4)} y\n`)).toEqual([`${T(1)} a`, `${T(2)} b`, `${T(2)} x`, `${T(4)} y`]);
    expect(mergedLogLines('', `${T(1)} x\n`)).toEqual([`${T(1)} x`]);
    expect(mergedLogLines(`${T(1)} a`, '')).toEqual([`${T(1)} a`]);
  });

  it('keeps a line without a time after the line before it in its stream', () => {
    const stdout = `${T(1)} error report:\n  first detail\n  second detail\n${T(5)} next\n`;
    const stderr = `${T(3)} warning\n`;
    expect(mergedLogLines(stdout, stderr)).toEqual([`${T(1)} error report:`, '  first detail', '  second detail', `${T(3)} warning`, `${T(5)} next`]);
  });
});
