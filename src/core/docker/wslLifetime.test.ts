// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../ports';
import { withSshPrompts } from '../sshAskpass';
import { WSL_HOST } from './dockerHost';
import { WSL_RUNNING_ARGS, WSL_RUNNING_TIMEOUT_MS, WslLifetime, type WslLifetimeDeps } from './wslLifetime';

const WSL = 'C:\\Windows\\System32\\wsl.exe';
const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() });

/** A fake keeper: `holding` and `stopped` are its answers of holds and stopping. */
function fakeKeeper() {
  const state = { holding: false, stopped: false };
  return {
    state,
    keep: vi.fn(),
    holds: vi.fn(() => state.holding),
    stopping: vi.fn(() => state.stopped),
  };
}

function lifetime(overrides: Partial<WslLifetimeDeps> & { list?: () => RunResult } = {}) {
  const runs: { file: string; args: readonly string[]; options?: RunOptions }[] = [];
  const log = logger();
  const keeper = fakeKeeper();
  const deps: WslLifetimeDeps = {
    runner: {
      run: async (file, args, options) => {
        runs.push({ file, args, options });
        return overrides.list?.() ?? ok('');
      },
    },
    wslPath: () => WSL,
    env: { PATH: 'C:\\Windows\\System32' },
    logger: log,
    keeper,
    ...overrides,
  };
  return { subject: new WslLifetime(deps), runs, log, keeper };
}

describe('WslLifetime.running', () => {
  it('reads the running distributions with wsl.exe --list --running --quiet, with WSL_UTF8 and a time limit, and compares the names without case', async () => {
    const { subject, runs } = lifetime({ list: () => ok('Ubuntu\r\nDevSpaces\r\n') });
    expect(await subject.running('devspaces')).toBe(true);
    expect(runs).toEqual([{ file: WSL, args: WSL_RUNNING_ARGS, options: { env: { PATH: 'C:\\Windows\\System32', WSL_UTF8: '1' }, timeoutMs: WSL_RUNNING_TIMEOUT_MS } }]);
  });

  it('reads the list of an older wsl.exe in UTF-16', async () => {
    const utf16 = Buffer.from('\uFEFFdevspaces\r\n', 'utf16le').toString('utf8');
    const { subject } = lifetime({ list: () => ok(utf16) });
    expect(await subject.running('devspaces')).toBe(true);
  });

  it('is false when the list is empty (no distribution runs) or names only other distributions', async () => {
    expect(await lifetime({ list: () => ok('') }).subject.running('devspaces')).toBe(false);
    expect(await lifetime({ list: () => ok('Ubuntu\n') }).subject.running('devspaces')).toBe(false);
    expect(await lifetime({ list: () => ok('devspaces-old\n') }).subject.running('devspaces')).toBe(false);
  });

  it('calls at the same time share one wsl.exe; a later call asks again', async () => {
    const { subject, runs } = lifetime({ list: () => ok('devspaces\n') });
    expect(await Promise.all([subject.running('devspaces'), subject.running('DevSpaces'), subject.running('Ubuntu')])).toEqual([true, true, false]);
    expect(runs).toHaveLength(1);
    expect(await subject.running('devspaces')).toBe(true);
    expect(runs).toHaveLength(2);
  });

  it('logs a failure that stays once, and again after it worked', async () => {
    let list: RunResult = { exitCode: 1, stdout: '', stderr: 'broken', timedOut: false };
    const { subject, log } = lifetime({ list: () => list });
    await subject.running('devspaces');
    await subject.running('devspaces');
    expect(log.warn).toHaveBeenCalledTimes(1);
    list = ok('');
    await subject.running('devspaces');
    list = { exitCode: 1, stdout: '', stderr: 'broken', timedOut: false };
    await subject.running('devspaces');
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('is undefined, with a warning, when wsl.exe fails, does not answer, or cannot start; and without wsl.exe', async () => {
    const failing = lifetime({ list: () => ({ exitCode: 1, stdout: '', stderr: 'Wsl/Service/E_UNEXPECTED', timedOut: false }) });
    expect(await failing.subject.running('devspaces')).toBeUndefined();
    expect(failing.log.warn).toHaveBeenCalledWith(expect.stringContaining('Wsl/Service/E_UNEXPECTED'));
    const slow = lifetime({ list: () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }) });
    expect(await slow.subject.running('devspaces')).toBeUndefined();
    expect(slow.log.warn).toHaveBeenCalledWith(expect.stringContaining('did not answer'));
    const broken = lifetime({
      list: () => {
        throw new Error('spawn EPERM');
      },
    });
    expect(await broken.subject.running('devspaces')).toBeUndefined();
    const missing = lifetime({ wslPath: () => undefined });
    expect(await missing.subject.running('devspaces')).toBeUndefined();
    expect(missing.runs).toEqual([]);
  });
});

describe('WslLifetime.leavesStopped', () => {
  it('is true in the background for a WSL host whose distribution does not run; logged once', async () => {
    const { subject, log } = lifetime({ list: () => ok('Ubuntu\n') });
    expect(await subject.leavesStopped(WSL_HOST)).toBe(true);
    expect(await subject.leavesStopped(WSL_HOST)).toBe(true);
    const said = log.info.mock.calls.filter(([text]) => String(text).includes('does not run. Devspaces does not start it'));
    expect(said).toHaveLength(1);
  });

  it('is false while the distribution runs, and logs the change after it was stopped', async () => {
    let list = ok('');
    const { subject, log } = lifetime({ list: () => list });
    expect(await subject.leavesStopped(WSL_HOST)).toBe(true);
    list = ok('devspaces\n');
    expect(await subject.leavesStopped(WSL_HOST)).toBe(false);
    expect(log.info).toHaveBeenLastCalledWith(expect.stringContaining('runs, or may be started'));
  });

  // Mutation: a call in the background that runs while the idle script of the keeper of this window ended a moment ago
  // fails it: its wsl.exe would hold the distribution, and its use would start a keeper for two more checks.
  it('is true while the distribution stops (the idle script of the keeper of this window ended), also while it still runs', async () => {
    const { subject, keeper, runs } = lifetime({ list: () => ok('devspaces\n') });
    keeper.state.stopped = true;
    expect(await subject.leavesStopped(WSL_HOST)).toBe(true);
    expect(runs).toEqual([]);
    expect(keeper.stopping).toHaveBeenCalledWith('devspaces');
    keeper.state.stopped = false;
    expect(await subject.leavesStopped(WSL_HOST)).toBe(false);
  });

  // Mutation: a check that asks WSL while the keeper of this window holds the distribution fails it (a wsl.exe per call).
  it('asks WSL nothing while the keeper of this window holds the distribution (it runs)', async () => {
    const { subject, keeper, runs } = lifetime({ list: () => ok('') });
    keeper.state.holding = true;
    expect(await subject.leavesStopped(WSL_HOST)).toBe(false);
    expect(runs).toEqual([]);
    expect(keeper.holds).toHaveBeenCalledWith('devspaces');
  });

  it('logs the stop again after a flow of the user or a keeper of this window', async () => {
    const { subject, keeper, log } = lifetime({ list: () => ok('') });
    expect(await subject.leavesStopped(WSL_HOST)).toBe(true);
    expect(await withSshPrompts(() => subject.leavesStopped(WSL_HOST))).toBe(false);
    expect(await subject.leavesStopped(WSL_HOST)).toBe(true);
    keeper.state.holding = true;
    expect(await subject.leavesStopped(WSL_HOST)).toBe(false);
    keeper.state.holding = false;
    expect(await subject.leavesStopped(WSL_HOST)).toBe(true);
    expect(log.info.mock.calls.filter(([text]) => String(text).includes('does not run. Devspaces does not start it'))).toHaveLength(3);
  });

  it('is false in a flow of the user, which starts the distribution, also while it stops', async () => {
    const { subject, runs, keeper } = lifetime({ list: () => ok('') });
    keeper.state.stopped = true;
    expect(await withSshPrompts(() => subject.leavesStopped(WSL_HOST))).toBe(false);
    expect(runs).toEqual([]);
  });

  it('is false when the state cannot be told (the call runs as before)', async () => {
    const { subject } = lifetime({ list: () => ({ exitCode: 1, stdout: '', stderr: 'broken', timedOut: false }) });
    expect(await subject.leavesStopped(WSL_HOST)).toBe(false);
  });

  it('is false for the local Docker and for SSH hosts, without a question to WSL', async () => {
    const { subject, runs } = lifetime({ list: () => ok('') });
    expect(await subject.leavesStopped('')).toBe(false);
    expect(await subject.leavesStopped('build-server')).toBe(false);
    expect(await subject.leavesStopped('wsl:2222')).toBe(false);
    expect(runs).toEqual([]);
  });
});

describe('WslLifetime.use', () => {
  it('starts the keeper of the distribution at each wsl.exe of the window (the keeper starts at most once a minute)', () => {
    const { subject, keeper, runs } = lifetime();
    subject.use(WSL_HOST);
    subject.use(WSL_HOST);
    expect(keeper.keep.mock.calls).toEqual([['devspaces'], ['devspaces']]);
    expect(runs).toEqual([]);
  });

  // Mutation: a use in the background that starts a keeper while the distribution stops fails it: the idle script would
  // hold the distribution for two more checks, again and again while the window works in the background.
  it('starts no keeper in the background while the distribution stops, but in a flow of the user', async () => {
    const { subject, keeper } = lifetime();
    keeper.state.stopped = true;
    subject.use(WSL_HOST);
    expect(keeper.keep).not.toHaveBeenCalled();
    await withSshPrompts(async () => subject.use(WSL_HOST));
    expect(keeper.keep).toHaveBeenCalledWith('devspaces');
  });

  it('starts nothing for other hosts and after dispose', () => {
    const { subject, keeper } = lifetime();
    subject.use('');
    subject.use('build-server');
    subject.use('wsl:2222');
    subject.dispose();
    subject.use(WSL_HOST);
    expect(keeper.keep).not.toHaveBeenCalled();
  });
});
