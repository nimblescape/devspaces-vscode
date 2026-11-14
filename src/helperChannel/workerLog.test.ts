// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The log of a worker in the volume of the Monitor (protocol.ts "The log of a worker", R-ENG-010): its lines, its
// files (0700 folder, 0600 file, never through a link), its older part at the size limit, and the removal of the logs
// of the workers that ended.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKER_LOG_KEEP_MS, workerLogName } from '../core/helperChannel/protocol';
import { WorkerLog, sweepWorkerLogs, workerLogLine } from './workerLog';

const ID = '0123456789ab';
const AT = Date.parse('2026-11-14T07:00:00.000Z');
let root: string;
let folder: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-log-'));
  folder = path.join(root, 'worker-logs');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('workerLogName', () => {
  it('names the log by the short ID of the container, and nothing for a value that is no ID', () => {
    expect(workerLogName(ID)).toBe(`${ID}.log`);
    expect(workerLogName(`${ID}${'cd'.repeat(26)}`)).toBe(`${ID}.log`);
    for (const value of ['', '0123456789a', 'devspaces-api-worker1', '../0123456789ab', '0123456789AB']) expect(workerLogName(value)).toBeUndefined();
  });
});

describe('workerLogLine', () => {
  it('starts each entry with its time in UTC and indents the further lines of its text', () => {
    expect(workerLogLine(AT, '#3 open started.')).toBe('2026-11-14T07:00:00.000Z #3 open started.\n');
    expect(workerLogLine(AT, 'first\nsecond\r\nthird\rfourth')).toBe('2026-11-14T07:00:00.000Z first\n    second\n    third\n    fourth\n');
  });
});

describe('WorkerLog', () => {
  it('creates its folder (0700) and its file (0600), and appends each entry', () => {
    let now = AT;
    const log = new WorkerLog({ folder, name: `${ID}.log`, now: () => now });
    log.write('The worker started.');
    now += 1500;
    log.write('#1 probe started.');
    log.close();
    expect(fs.readFileSync(log.file, 'utf8')).toBe('2026-11-14T07:00:00.000Z The worker started.\n2026-11-14T07:00:01.500Z #1 probe started.\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
      expect(fs.statSync(log.file).mode & 0o777).toBe(0o600);
    }
    // A worker that the relay starts again in the same container goes on in the same log.
    const again = new WorkerLog({ folder, name: `${ID}.log`, now: () => now });
    again.write('The worker started.');
    again.close();
    expect(fs.readFileSync(log.file, 'utf8').split('\n').filter((line) => line !== '')).toHaveLength(3);
  });

  it('moves the log to its older part at the size limit, which replaces an older part', () => {
    const log = new WorkerLog({ folder, name: `${ID}.log`, now: () => AT, maxBytes: 100 });
    for (let i = 1; i <= 7; i++) log.write(`entry ${i} ${'x'.repeat(20)}`);
    log.close();
    const current = fs.readFileSync(log.file, 'utf8');
    const older = fs.readFileSync(`${log.file}.1`, 'utf8');
    expect(Buffer.byteLength(current)).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(older)).toBeLessThanOrEqual(100);
    // An entry has 54 bytes, so each part holds one: only the last two entries stay, the newest in the log itself.
    expect(older).toBe('2026-11-14T07:00:00.000Z entry 6 xxxxxxxxxxxxxxxxxxxx\n');
    expect(current).toBe('2026-11-14T07:00:00.000Z entry 7 xxxxxxxxxxxxxxxxxxxx\n');
  });

  it('moves the log only once when two processes of one container write it (the workers of a relay)', () => {
    const first = new WorkerLog({ folder, name: `${ID}.log`, now: () => AT, maxBytes: 100 });
    const second = new WorkerLog({ folder, name: `${ID}.log`, now: () => AT, maxBytes: 100 });
    second.write(`second 1 ${'x'.repeat(19)}`);
    // The log is full: the first moves it and writes into a new log; the second still has the moved file open, sees
    // that it is no longer the log, and writes into the new log too, without moving it again.
    first.write(`first 1 ${'x'.repeat(20)}`);
    second.write(`second 2 ${'x'.repeat(19)}`);
    first.close();
    second.close();
    expect(fs.readFileSync(`${first.file}.1`, 'utf8')).toBe('2026-11-14T07:00:00.000Z second 1 xxxxxxxxxxxxxxxxxxx\n');
    expect(fs.readFileSync(first.file, 'utf8')).toBe('2026-11-14T07:00:00.000Z first 1 xxxxxxxxxxxxxxxxxxxx\n2026-11-14T07:00:00.000Z second 2 xxxxxxxxxxxxxxxxxxx\n');
  });

  it('moves the log only under its lock: while another process holds it, it goes on writing, and a lock left by an ended process is taken over', () => {
    const log = new WorkerLog({ folder, name: `${ID}.log`, now: () => AT, maxBytes: 100 });
    log.write(`entry 1 ${'x'.repeat(20)}`);
    const lock = `${log.file}.lock`;
    fs.mkdirSync(lock);
    log.write(`entry 2 ${'x'.repeat(20)}`);
    expect(fs.existsSync(`${log.file}.1`)).toBe(false);
    expect(fs.readFileSync(log.file, 'utf8').split('\n').filter((line) => line !== '')).toHaveLength(2);
    // A lock older than a minute: its process ended during the move.
    const old = (Date.now() - 5 * 60_000) / 1000;
    fs.utimesSync(lock, old, old);
    log.write(`entry 3 ${'x'.repeat(20)}`);
    log.close();
    expect(fs.readFileSync(`${log.file}.1`, 'utf8')).toContain('entry 2');
    expect(fs.readFileSync(log.file, 'utf8')).toBe('2026-11-14T07:00:00.000Z entry 3 xxxxxxxxxxxxxxxxxxxx\n');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('never writes through a link or into something that is no regular file, and then writes nothing more', () => {
    if (process.platform === 'win32') return;
    fs.mkdirSync(folder, { mode: 0o700 });
    const target = path.join(root, 'elsewhere.txt');
    fs.writeFileSync(target, 'kept\n');
    fs.symlinkSync(target, path.join(folder, `${ID}.log`));
    const log = new WorkerLog({ folder, name: `${ID}.log`, now: () => AT });
    log.write('The worker started.');
    log.write('#1 probe started.');
    expect(fs.readFileSync(target, 'utf8')).toBe('kept\n');
    // A folder of the logs that is a link: no write either.
    const linkedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-log-link-'));
    try {
      fs.symlinkSync(root, path.join(linkedRoot, 'worker-logs'));
      const linked = new WorkerLog({ folder: path.join(linkedRoot, 'worker-logs'), name: 'abcdefabcdef.log', now: () => AT });
      linked.write('The worker started.');
      expect(fs.existsSync(path.join(root, 'abcdefabcdef.log'))).toBe(false);
    } finally {
      fs.rmSync(linkedRoot, { recursive: true, force: true });
    }
    // A folder in place of the file.
    const other = 'fedcbafedcba.log';
    fs.mkdirSync(path.join(folder, other));
    const intoFolder = new WorkerLog({ folder, name: other, now: () => AT });
    expect(() => intoFolder.write('The worker started.')).not.toThrow();
  });

  it('touch sets the time of the log, so that the start of another worker keeps it', () => {
    let now = AT;
    const log = new WorkerLog({ folder, name: `${ID}.log`, now: () => now });
    log.touch();
    log.write('The worker started.');
    now += 3 * 60 * 60_000;
    log.touch();
    expect(Math.abs(fs.statSync(log.file).mtimeMs - now)).toBeLessThan(1000);
    log.close();
    expect(() => log.touch()).not.toThrow();
  });
});

describe('sweepWorkerLogs', () => {
  it('removes the logs that nobody touched for the keep time, never its own, a young one, or what is no log of a worker', () => {
    fs.mkdirSync(folder, { mode: 0o700 });
    const old = (AT - WORKER_LOG_KEEP_MS - 60_000) / 1000;
    const files = {
      own: `${ID}.log`,
      ownOlder: `${ID}.log.1`,
      ended: 'aaaaaaaaaaaa.log',
      endedOlder: 'aaaaaaaaaaaa.log.1',
      young: 'bbbbbbbbbbbb.log',
      // The older part of a log that its worker still touches: kept, however old it is.
      youngOlder: 'bbbbbbbbbbbb.log.1',
      other: 'notes.txt',
    };
    for (const name of Object.values(files)) {
      fs.writeFileSync(path.join(folder, name), 'x\n');
      if (name !== files.young) fs.utimesSync(path.join(folder, name), old, old);
    }
    // A link with the name of a log, to a file elsewhere, and a folder with such a name: not removed.
    let link: string | undefined;
    if (process.platform !== 'win32') {
      fs.writeFileSync(path.join(root, 'target'), 'kept\n');
      link = 'cccccccccccc.log';
      fs.symlinkSync(path.join(root, 'target'), path.join(folder, link));
    }
    fs.mkdirSync(path.join(folder, 'dddddddddddd.log'));
    expect(sweepWorkerLogs(folder, files.own, AT, WORKER_LOG_KEEP_MS)).toBe(2);
    const left = fs.readdirSync(folder).sort();
    expect(left).toEqual([files.own, files.ownOlder, files.young, files.youngOlder, ...(link !== undefined ? [link] : []), 'dddddddddddd.log', files.other].sort());
    if (link !== undefined) expect(fs.readFileSync(path.join(root, 'target'), 'utf8')).toBe('kept\n');
  });

  it('removes nothing and does not throw when the folder is missing or no folder', () => {
    expect(sweepWorkerLogs(folder, `${ID}.log`, AT, WORKER_LOG_KEEP_MS)).toBe(0);
    fs.writeFileSync(folder, 'x');
    expect(sweepWorkerLogs(folder, `${ID}.log`, AT, WORKER_LOG_KEEP_MS)).toBe(0);
  });
});
