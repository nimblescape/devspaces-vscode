// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The state of the VM of Devspaces for its row in the view "Docker Hosts" (R-VM-010): read without a start.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger, type Logger, type ProcessRunner, type RunResult } from '../ports';
import { limaPaths, type LimaPaths } from './limaInstance';
import { diskSpace, freeSpace, limaInstanceFiles, limaVmState, wslDiskFiles, wslVmState } from './vmState';

const silent: Logger = silentLogger;

let home: string;
let paths: LimaPaths;

beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vm-state-'));
  paths = limaPaths(home);
});

afterEach(async () => {
  await fs.promises.rm(home, { recursive: true, force: true });
});

function runner(result: RunResult, calls: string[][] = []): ProcessRunner {
  return {
    run: async (file: string, args: readonly string[]) => {
      calls.push([file, ...args]);
      return result;
    },
  } as unknown as ProcessRunner;
}

const listLine = (status: string) => `${JSON.stringify({ name: 'devspaces', status, cpus: 2, memory: 4 * 2 ** 30 })}\n`;

describe('limaVmState', () => {
  it('is not set up before the VM was created, and runs no limactl', async () => {
    const calls: string[][] = [];
    const state = await limaVmState({ exists: async () => false, limactl: () => '/x/limactl', paths, runner: runner({ exitCode: 0, stdout: '', stderr: '', timedOut: false }, calls), logger: silent });
    expect(state).toEqual({ kind: 'notSetUp' });
    expect(calls).toEqual([]);
  });

  it('reads the state, the memory and the CPUs with limactl list, and the space of the disk', async () => {
    await fs.promises.mkdir(path.join(paths.home, 'devspaces'), { recursive: true });
    // A disk with a name of Lima 2 (any file of the instance folder counts), and one in a folder below it.
    await fs.promises.writeFile(path.join(paths.home, 'devspaces', 'disk'), Buffer.alloc(8192, 1));
    await fs.promises.mkdir(path.join(paths.home, 'devspaces', 'extra'), { recursive: true });
    await fs.promises.writeFile(path.join(paths.home, 'devspaces', 'extra', 'data'), Buffer.alloc(4096, 1));
    expect((await limaInstanceFiles(paths)).map((file) => path.relative(paths.home, file)).sort()).toEqual([path.join('devspaces', 'disk'), path.join('devspaces', 'extra', 'data')]);
    const calls: string[][] = [];
    const state = await limaVmState({ exists: async () => true, limactl: () => '/x/limactl', paths, runner: runner({ exitCode: 0, stdout: listLine('Stopped'), stderr: '', timedOut: false }, calls), logger: silent });
    expect(state).toMatchObject({ kind: 'stopped', memoryGiB: 4, cpus: 2 });
    expect(state.diskBytes).toBeGreaterThanOrEqual(8192 + 4096);
    // Only the list: never a start.
    expect(calls).toEqual([['/x/limactl', 'list', '--json']]);
  });

  it('is unknown without the pinned Lima: nothing is downloaded', async () => {
    const state = await limaVmState({ exists: async () => true, limactl: () => undefined, paths, runner: runner({ exitCode: 0, stdout: '', stderr: '', timedOut: false }), logger: silent });
    expect(state.kind).toBe('unknown');
  });

  it('is unknown when limactl list fails', async () => {
    const state = await limaVmState({ exists: async () => true, limactl: () => '/x/limactl', paths, runner: runner({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }), logger: silent });
    expect(state).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('boom') });
  });
});

describe('wslVmState', () => {
  it('is not set up for a distribution that Devspaces did not set up', async () => {
    expect(await wslVmState({ registration: async () => 'foreign', running: async () => true, folder: home })).toEqual({ kind: 'notSetUp' });
    expect(await wslVmState({ registration: async () => 'none', running: async () => true, folder: home })).toEqual({ kind: 'notSetUp' });
  });

  it('runs or is stopped as wsl.exe says, with the space of its virtual disk', async () => {
    await fs.promises.mkdir(path.join(home, 'disk'), { recursive: true });
    await fs.promises.writeFile(path.join(home, 'disk', 'ext4.vhdx'), Buffer.alloc(4096, 1));
    expect(await wslDiskFiles(home)).toEqual([path.join(home, 'disk', 'ext4.vhdx')]);
    const running = await wslVmState({ registration: async () => 'own', running: async () => true, folder: home });
    expect(running.kind).toBe('running');
    expect(running.diskBytes).toBeGreaterThanOrEqual(4096);
    expect((await wslVmState({ registration: async () => 'own', running: async () => false, folder: home })).kind).toBe('stopped');
    expect((await wslVmState({ registration: async () => 'own', running: async () => undefined, folder: home })).kind).toBe('unknown');
  });
});

describe('diskSpace', () => {
  it('is undefined when no file exists', async () => {
    expect(await diskSpace([path.join(home, 'missing')])).toBeUndefined();
  });
});

describe('freeSpace', () => {
  it('reads the file system of the folder, or of the nearest folder above it that exists', async () => {
    const free = await freeSpace(home);
    expect(free).toBeGreaterThan(0);
    expect(await freeSpace(path.join(home, 'not', 'yet'))).toBeGreaterThan(0);
  });

  it('goes up from a path below a file to the file system of that file', async () => {
    await fs.promises.writeFile(path.join(home, 'file'), 'x');
    // ENOTDIR: the folder can never exist, its parent is the file system of the file.
    expect(await freeSpace(path.join(home, 'file', 'below'))).toBeGreaterThan(0);
  });
});
