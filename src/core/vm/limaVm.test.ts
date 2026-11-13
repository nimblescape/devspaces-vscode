// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { silentLogger, type ProcessRunner, type RunResult } from '../ports';
import { limaPaths } from './limaInstance';
import { LimaVm, LimaVmMissingError } from './limaVm';

const LIST = { running: '{"name":"devspaces","status":"Running"}', stopped: '{"name":"devspaces","status":"Stopped"}', missing: '' };

/** A runner that answers `limactl list` with `state()` and `limactl start` after `startWait`, and records the calls. */
function fakeLima(state: () => keyof typeof LIST, startWait: Promise<void> = Promise.resolve()): { runner: ProcessRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      run: async (_file, args): Promise<RunResult> => {
        calls.push(args[0]);
        if (args[0] === 'start') await startWait;
        return { exitCode: 0, stdout: args[0] === 'list' ? LIST[state()] : '', stderr: '', timedOut: false };
      },
    },
  };
}

function vm(runner: ProcessRunner, options: { now?: () => number; install?: () => Promise<string> } = {}): LimaVm {
  return new LimaVm({
    runner,
    logger: silentLogger,
    platform: 'linux',
    arch: 'x64',
    paths: limaPaths('/home/ada'),
    install: options.install ?? (async () => '/lima/bin/limactl'),
    now: options.now,
  });
}

describe('LimaVm', () => {
  it('starts a stopped VM once for the calls at the same time, and checks a VM that ran again only after a minute', async () => {
    let state: keyof typeof LIST = 'stopped';
    let release: () => void = () => undefined;
    const fake = fakeLima(
      () => state,
      new Promise((resolve) => (release = resolve)),
    );
    let now = 1_000;
    const lima = vm(fake.runner, { now: () => now });
    const first = lima.ready();
    const second = lima.ready();
    await new Promise((resolve) => setTimeout(resolve, 0));
    state = 'running';
    release();
    await Promise.all([first, second]);
    expect(fake.calls).toEqual(['list', 'start']);
    now += 59_000;
    await lima.ready();
    expect(fake.calls).toEqual(['list', 'start']);
    now += 2_000;
    await lima.ready();
    expect(fake.calls).toEqual(['list', 'start', 'list']);
    // After a failed transport, the next call checks again.
    lima.forgetRunning();
    await lima.ready();
    expect(fake.calls).toEqual(['list', 'start', 'list', 'list']);
    // A read of the state that found the VM running counts as the check (the view Docker Hosts reads it every 30 s).
    lima.forgetRunning();
    lima.noteRunning();
    await lima.ready();
    expect(fake.calls).toEqual(['list', 'start', 'list', 'list']);
  });

  it('refuses a VM that is not set up, and installs Lima again after a failed install', async () => {
    await expect(vm(fakeLima(() => 'missing').runner).ready()).rejects.toBeInstanceOf(LimaVmMissingError);
    let installs = 0;
    const lima = vm(fakeLima(() => 'running').runner, {
      install: async () => {
        installs++;
        if (installs === 1) throw new Error('The download of Lima failed.');
        return '/lima/bin/limactl';
      },
    });
    await expect(lima.ready()).rejects.toThrow('The download of Lima failed.');
    await expect(lima.ready()).resolves.toBeUndefined();
    expect(installs).toBe(2);
  });

  it('stops waiting for a caller whose signal aborts, while the start goes on for the others', async () => {
    let release: () => void = () => undefined;
    let state: keyof typeof LIST = 'stopped';
    const fake = fakeLima(
      () => state,
      new Promise((resolve) => (release = resolve)),
    );
    const lima = vm(fake.runner);
    const cancel = new AbortController();
    const cancelled = lima.ready(cancel.signal);
    const other = lima.ready();
    cancel.abort();
    await expect(cancelled).rejects.toThrow('The operation was cancelled.');
    state = 'running';
    release();
    await expect(other).resolves.toBeUndefined();
    expect(fake.calls).toEqual(['list', 'start']);
  });

  it('gives a stopped VM the memory and CPUs of the settings before its start, and never a running one', async () => {
    const calls: string[][] = [];
    let status = 'Stopped';
    const runner: ProcessRunner = {
      run: async (_file, args): Promise<RunResult> => {
        calls.push([...args]);
        if (args[0] === 'start') status = 'Running';
        const stdout = args[0] === 'list' ? JSON.stringify({ name: 'devspaces', status, cpus: 4, memory: 4 * 2 ** 30 }) : '';
        return { exitCode: 0, stdout, stderr: '', timedOut: false };
      },
    };
    const lima = new LimaVm({ runner, logger: silentLogger, platform: 'linux', arch: 'x64', paths: limaPaths('/home/ada'), install: async () => 'limactl', resources: () => ({ memoryGiB: 6, cpus: 2 }) });
    await lima.ready();
    expect(calls.map((call) => call.join(' '))).toEqual(['list --json', 'edit --tty=false --cpus=2 --memory=6 devspaces', 'start --tty=false --timeout=10m devspaces']);
    // A running VM keeps what it has until its next start.
    lima.forgetRunning();
    await lima.ready();
    expect(calls).toHaveLength(4);
    // The same resources: no edit.
    status = 'Stopped';
    const same = new LimaVm({ runner, logger: silentLogger, platform: 'linux', arch: 'x64', paths: limaPaths('/home/ada'), install: async () => 'limactl', resources: () => ({ memoryGiB: 4, cpus: 4 }) });
    await same.ready();
    expect(calls.slice(4).map((call) => call[0])).toEqual(['list', 'start']);
  });

  it('knows a created VM by the configuration of its instance, without Lima', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-lima-vm-'));
    try {
      let installs = 0;
      const paths = limaPaths(home);
      const lima = new LimaVm({ runner: fakeLima(() => 'missing').runner, logger: silentLogger, platform: 'darwin', arch: 'arm64', paths, install: async () => `${installs++}` });
      await expect(lima.exists()).resolves.toBe(false);
      fs.mkdirSync(path.join(paths.home, 'devspaces'), { recursive: true });
      fs.writeFileSync(path.join(paths.home, 'devspaces', 'lima.yaml'), '{}');
      await expect(lima.exists()).resolves.toBe(true);
      expect(installs).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
