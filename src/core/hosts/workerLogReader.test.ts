// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reader of the log of a worker (R-ENG-010): its call of `docker run` with the limits of the reader of the shared
// volumes, exactly that call on the shared shell, and its script, run here with the Node.js of the tests on a folder
// like the volume of the Monitor.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSharedShellCall } from '../docker/bootstrapDocker';
import { WORKER_LOG_FOLDER } from '../helperChannel/protocol';
import { CONTAINER_LOG_LINES } from './monitorLog';
import { newReaderName } from './volumeReader';
import {
  NO_WORKER_LOG_EXIT,
  WORKER_LOG_READER_CODE,
  WORKER_LOG_READER_ROOT,
  WORKER_LOG_READ_BYTES,
  isWorkerLogReaderCall,
  workerLogReaderArgs,
} from './workerLogReader';

const IMAGE = `sha256:${'ab'.repeat(32)}`;
const ID = '0123456789ab';
const NAME = 'devspaces-reader-0a1b2c3d';
const call = () => workerLogReaderArgs({ image: IMAGE, volume: 'devspaces-monitor', id: ID, name: NAME });

describe('the call of the reader of the log of a worker', () => {
  it('runs the image of the worker with the limits of the readers: no pull, no network, read only, one capability, no log, removed at its end', () => {
    expect(call()).toEqual([
      'run',
      '--rm',
      '--name',
      NAME,
      '--pull',
      'never',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'DAC_READ_SEARCH',
      '--security-opt',
      'no-new-privileges',
      '--log-driver',
      'none',
      '--mount',
      `type=volume,source=devspaces-monitor,target=${WORKER_LOG_READER_ROOT},readonly`,
      '--entrypoint',
      'node',
      IMAGE,
      '-e',
      WORKER_LOG_READER_CODE,
      WORKER_LOG_READER_ROOT,
      ID,
    ]);
    expect(isWorkerLogReaderCall(call())).toBe(true);
    expect(isWorkerLogReaderCall(workerLogReaderArgs({ image: IMAGE, volume: 'devspaces-monitor', id: ID, name: newReaderName() }))).toBe(true);
  });

  it('refuses a name, an image, a volume or an ID that the call cannot carry', () => {
    const args = { image: IMAGE, volume: 'devspaces-monitor', id: ID, name: NAME };
    for (const name of ['other', 'devspaces-reader-0A1B2C3D', '']) expect(() => workerLogReaderArgs({ ...args, name })).toThrow();
    for (const image of ['devspaces-worker:abc', '-v', `sha256:${'ab'.repeat(31)}`]) expect(() => workerLogReaderArgs({ ...args, image })).toThrow();
    for (const volume of ['a,readonly=false', '/', '-v', '']) expect(() => workerLogReaderArgs({ ...args, volume })).toThrow();
    for (const id of ['0123456789a', '0123456789AB', '../x', `${ID}0`]) expect(() => workerLogReaderArgs({ ...args, id })).toThrow();
  });

  it('runs on the shared shell of a host exactly as workerLogReaderArgs makes it, no other docker run', () => {
    for (const vm of [false, true]) {
      expect(isSharedShellCall(call(), vm)).toBe(true);
      // Another script, another folder, another ID, a writable volume, or a further option: refused.
      const changed = (index: number, value: string) => call().map((arg, i) => (i === index ? value : arg));
      expect(isSharedShellCall(changed(23, 'require("child_process").execSync("id")'), vm)).toBe(false);
      expect(isSharedShellCall(changed(24, '/'), vm)).toBe(false);
      expect(isSharedShellCall(changed(18, `type=volume,source=devspaces-monitor,target=${WORKER_LOG_READER_ROOT}`), vm)).toBe(false);
      expect(isSharedShellCall(changed(8, '--privileged'), vm)).toBe(false);
      expect(isSharedShellCall([...call(), 'more'], vm)).toBe(false);
      expect(isSharedShellCall(call().slice(0, -1), vm)).toBe(false);
    }
  });
});

describe('the script of the reader', () => {
  let root: string;
  let folder: string;
  const read = (id = ID) => spawnSync(process.execPath, ['-e', WORKER_LOG_READER_CODE, root, id], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-11-14T07:00:00.000Z entry ${from + i}`);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-log-reader-'));
    folder = path.join(root, WORKER_LOG_FOLDER);
    fs.mkdirSync(folder, { mode: 0o700 });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is one line for the shared shell: no line break, no single quote, no template literal, no comment', () => {
    expect(WORKER_LOG_READER_CODE).not.toMatch(/[\n\r\0'`]/);
    expect(WORKER_LOG_READER_CODE).not.toContain('//');
    expect(WORKER_LOG_READER_CODE.length).toBeLessThan(4 * 1024);
  });

  it('prints the older part and the log together, the last lines only', () => {
    fs.writeFileSync(path.join(folder, `${ID}.log.1`), `${lines(1, 3).join('\n')}\n`);
    fs.writeFileSync(path.join(folder, `${ID}.log`), `${lines(4, 5).join('\n')}\n`);
    const result = read();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(lines(1, 5).join('\n'));
    // Without the older part; and the last CONTAINER_LOG_LINES lines of a longer log.
    fs.rmSync(path.join(folder, `${ID}.log.1`));
    fs.writeFileSync(path.join(folder, `${ID}.log`), `${lines(1, CONTAINER_LOG_LINES + 10).join('\n')}\n`);
    const long = read();
    expect(long.stdout.split('\n')).toEqual(lines(11, CONTAINER_LOG_LINES + 10));
  });

  it('reads at most its limit of bytes of each file, from its end', () => {
    const entry = `2026-11-14T07:00:00.000Z ${'x'.repeat(1000)}\n`;
    fs.writeFileSync(path.join(folder, `${ID}.log`), `2026-11-14T06:00:00.000Z the first entry\n${entry.repeat(Math.ceil(WORKER_LOG_READ_BYTES / entry.length) + 5)}`);
    const result = read();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('the first entry');
    expect(result.stdout.split('\n')).toHaveLength(CONTAINER_LOG_LINES);
  });

  it('exits with NO_WORKER_LOG_EXIT without a log, and never reads through a link', () => {
    expect(read().status).toBe(NO_WORKER_LOG_EXIT);
    if (process.platform !== 'win32') {
      fs.writeFileSync(path.join(root, 'secret'), 'not a log\n');
      fs.symlinkSync(path.join(root, 'secret'), path.join(folder, `${ID}.log`));
      const linked = read();
      expect(linked.status).toBe(NO_WORKER_LOG_EXIT);
      expect(linked.stdout).toBe('');
    }
    // A folder of the logs that is missing.
    fs.rmSync(folder, { recursive: true, force: true });
    expect(read().status).toBe(NO_WORKER_LOG_EXIT);
  });

  it('refuses an argument that is no short ID of a container', () => {
    fs.writeFileSync(path.join(folder, `${ID}.log`), 'x\n');
    for (const id of ['../worker-logs/0123456789ab', '0123456789AB', '']) {
      const result = read(id);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
    }
  });
});
