// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The start of the log of a worker (protocol.ts "The log of a worker", R-ENG-010): only in a worker container that the
// extension started (its variable, channelRunArgs) and whose host name is the short ID of its container, so the prepare
// worker of the Monitor and the Docker tests write none; the removal of the logs of the workers that ended; the first
// entry; the touch every hour; and the reason of an uncaught error, by its kind only.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_PROTOCOL_VERSION, WORKER_LOG_ENV, WORKER_LOG_KEEP_MS, WORKER_LOG_TOUCH_MS } from '../core/helperChannel/protocol';
import { VERSION_ENV } from '../core/http';
import { fatalHandler, startWorkerLog } from './main';

const ID = '0123456789ab';
const AT = Date.parse('2026-11-14T07:00:00.000Z');
let root: string;
let folder: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-log-start-'));
  folder = path.join(root, 'worker-logs');
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('startWorkerLog', () => {
  it('writes no log without the variable of the extension, or with a host name that is no short ID of a container', () => {
    expect(startWorkerLog({ env: {}, hostname: ID, folder })).toBeUndefined();
    expect(startWorkerLog({ env: { [WORKER_LOG_ENV]: 'yes' }, hostname: ID, folder })).toBeUndefined();
    for (const hostname of ['devspaces-vm', '0123456789AB', '0123456789abc', '']) expect(startWorkerLog({ env: { [WORKER_LOG_ENV]: '1' }, hostname, folder })).toBeUndefined();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('removes the logs of the workers that ended, notes its start, and touches its log every hour', () => {
    vi.useFakeTimers();
    let now = AT;
    fs.mkdirSync(folder, { mode: 0o700 });
    const ended = path.join(folder, 'aaaaaaaaaaaa.log');
    fs.writeFileSync(ended, 'x\n');
    const old = (AT - WORKER_LOG_KEEP_MS - 1000) / 1000;
    fs.utimesSync(ended, old, old);
    const log = startWorkerLog({ env: { [WORKER_LOG_ENV]: '1', [VERSION_ENV]: '0.4.1' }, hostname: ID, folder, now: () => now });
    expect(log?.file).toBe(path.join(folder, `${ID}.log`));
    expect(fs.existsSync(ended)).toBe(false);
    expect(fs.readFileSync(path.join(folder, `${ID}.log`), 'utf8')).toBe(
      `2026-11-14T07:00:00.000Z The worker started: Devspaces 0.4.1, Node.js ${process.version}, channel protocol ${CHANNEL_PROTOCOL_VERSION}.\n`,
    );
    now += WORKER_LOG_TOUCH_MS;
    vi.advanceTimersByTime(WORKER_LOG_TOUCH_MS);
    expect(Math.abs(fs.statSync(path.join(folder, `${ID}.log`)).mtimeMs - now)).toBeLessThan(1000);
    log?.close();
    // A version that is no x.y.z is not written.
    const other = startWorkerLog({ env: { [WORKER_LOG_ENV]: '1', [VERSION_ENV]: '0.4.1 --flag' }, hostname: 'bbbbbbbbbbbb', folder, now: () => now });
    other?.close();
    expect(fs.readFileSync(path.join(folder, 'bbbbbbbbbbbb.log'), 'utf8')).toContain('The worker started: Devspaces (no version),');
  });
});

describe('fatalHandler', () => {
  it('gives the shutdown the kind of the error as its reason, never its message', () => {
    vi.useFakeTimers();
    const shutdown = vi.fn();
    const fatal = fatalHandler({ shutdown }, () => {});
    fatal(new TypeError(`token ghp_secret`));
    fatal('a text');
    expect(shutdown.mock.calls).toEqual([['an unexpected error of the script (TypeError)'], ['an unexpected error of the script (string)']]);
  });
});
