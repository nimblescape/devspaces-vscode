// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Show Log of a container (docs/requirements.md R-ENG-008, R-ENG-010): one fixed call that reads the last lines of the
// log of a container (by its full ID, or the Monitor by its name) and never follows it; the shared shell knows this call
// exactly; the output and the errors of the container come in the order of their times, each line with one time; a
// failure says why.
import { describe, expect, it } from 'vitest';
import { CommandError } from '../errors';
import type { RunOptions, RunResult } from '../ports';
import {
  CONTAINER_LOG_LINES,
  containerLogArgs,
  isContainerLogCall,
  isNoLogDriverError,
  mergedLogLines,
  monitorLogArgs,
  readContainerLog,
  readMonitorLog,
  readableTimes,
} from './monitorLog';

const ID = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';

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

describe('the call of Show Log', () => {
  it('reads the last lines of a container by its full ID, or of the Monitor, with their times, and never follows the log', () => {
    expect(monitorLogArgs()).toEqual(['logs', '--tail', String(CONTAINER_LOG_LINES), '--timestamps', 'devspaces-monitor']);
    expect(containerLogArgs(ID)).toEqual(['logs', '--tail', String(CONTAINER_LOG_LINES), '--timestamps', ID]);
    expect(monitorLogArgs()).not.toContain('--follow');
    expect(monitorLogArgs()).not.toContain('-f');
  });

  it('refuses any other name of a container: a name, a short ID, an option', () => {
    for (const name of ['shop-web-1', ID.slice(0, 12), `${ID}0`, ID.toUpperCase(), '--follow', '', `${ID.slice(0, 63)};`]) expect(() => containerLogArgs(name), name).toThrow();
  });

  it('is known exactly: another container, another number of lines, or one more word is another call', () => {
    expect(isContainerLogCall(monitorLogArgs())).toBe(true);
    expect(isContainerLogCall(containerLogArgs(ID))).toBe(true);
    expect(isContainerLogCall(['logs', '--tail', String(CONTAINER_LOG_LINES), '--timestamps', 'shop-web-1'])).toBe(false);
    expect(isContainerLogCall(['logs', '--tail', String(CONTAINER_LOG_LINES), '--timestamps', ID.slice(0, 12)])).toBe(false);
    expect(isContainerLogCall(['logs', '--tail', '100000', '--timestamps', 'devspaces-monitor'])).toBe(false);
    expect(isContainerLogCall(['logs', '--tail', String(CONTAINER_LOG_LINES), '--follow', ID])).toBe(false);
    expect(isContainerLogCall([...monitorLogArgs(), '--follow'])).toBe(false);
    expect(isContainerLogCall(['logs', '--follow', 'devspaces-monitor'])).toBe(false);
    expect(isContainerLogCall([])).toBe(false);
  });
});

describe('readContainerLog', () => {
  it('reads the log of a container by its ID, and knows the error of a log driver that gives no log', async () => {
    const docker = fakeDocker({ exitCode: 0, stdout: `${T(1)} listening on :80\n`, stderr: '', timedOut: false });
    expect(await readContainerLog(docker, ID, 'UTC')).toBe(`${L(1)} listening on :80`);
    expect(docker.calls[0].args).toEqual(containerLogArgs(ID));
    const none = readContainerLog(fakeDocker({ exitCode: 1, stdout: '', stderr: 'Error response from daemon: configured logging driver does not support reading\n', timedOut: false }), ID, 'UTC');
    await expect(none).rejects.toBeInstanceOf(CommandError);
    await expect(none).rejects.toSatisfy((error: CommandError) => isNoLogDriverError(error.message));
    expect(isNoLogDriverError('Error response from daemon: No such container: x')).toBe(false);
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
