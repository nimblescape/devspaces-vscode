// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WSL_DISTRIBUTION, wslCommandArgs } from './dockerHost';
import {
  KEEPER_EARLY_END_MS,
  KEEPER_LAUNCH_MS,
  KEEPER_LOCK,
  KEEPER_LOCK_WAIT_SECONDS,
  KEEPER_SCRIPT,
  WSL_IDLE_LOG,
  WSL_IDLE_LOG_LINES,
  WSL_IDLE_SCRIPT,
  WslKeeper,
  keeperWslgArgs,
  wslgPathOf,
  type WslKeeperDeps,
} from './wslKeeper';

const WSL = 'C:\\Windows\\System32\\wsl.exe';
const WSLG = 'C:\\Program Files\\WSL\\wslg.exe';
const ENV = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' };
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() });

/** A keeper with fakes. Each launch keeps `exit`, the end of that keeper (default exit code 0). */
function keeper(over: Partial<WslKeeperDeps> & { wslg?: boolean; now?: () => number } = {}) {
  const launches: { file: string; args: readonly string[]; exit: (code?: number | null) => void }[] = [];
  const log = logger();
  const deps: WslKeeperDeps = {
    wslPath: () => WSL,
    env: ENV,
    launch: async (file, args, onExit) => {
      launches.push({ file, args, exit: (code = 0) => onExit(code) });
    },
    logger: log,
    exists: (file) => file === WSLG && (over.wslg ?? true),
    ...over,
  };
  return { subject: new WslKeeper(deps), launches, log };
}

describe('the keeper of the WSL distribution', () => {
  it('starts with wslg.exe (no console window): sh -c with the script as root, from the root folder', async () => {
    const { subject, launches, log } = keeper();
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    expect(launches[0]).toMatchObject({ file: WSLG, args: ['-d', 'devspaces', '-u', 'root', '--cd', '/', '--shell-type', 'none', 'sh', '-c', KEEPER_SCRIPT] });
    // `wslg.exe` in the 64-bit folder of the programs, also for a 32-bit process.
    expect(wslgPathOf(ENV)).toBe(WSLG);
    expect(wslgPathOf({ PROGRAMFILES: 'D:\\Apps' })).toBe('D:\\Apps\\WSL\\wslg.exe');
    expect(wslgPathOf({ ProgramFiles: 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files' })).toBe(WSLG);
    expect(launches[0]?.args).toEqual(keeperWslgArgs(WSL_DISTRIBUTION));
    await vi.waitFor(() => expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Devspaces starts the keeper of the WSL distribution devspaces (wslg.exe)')));
  });

  // Mutation: a keeper in a distribution of the user fails it: it would hold that distribution while any container of
  // the user runs there.
  it('starts only in the WSL distribution of Devspaces', async () => {
    const { subject, launches } = keeper();
    subject.keep('Ubuntu');
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toEqual([]);
  });

  it('starts with wsl.exe --exec without wslg.exe, and not at all without either', async () => {
    const plain = keeper({ wslg: false });
    plain.subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(plain.launches).toMatchObject([{ file: WSL, args: wslCommandArgs(WSL_DISTRIBUTION, ['sh', '-c', KEEPER_SCRIPT]) }]));
    const none = keeper({ wslg: false, wslPath: () => undefined });
    none.subject.keep(WSL_DISTRIBUTION);
    await new Promise((resolve) => setImmediate(resolve));
    expect(none.launches).toEqual([]);
  });

  // Mutation: a keeper that starts at each use (each Docker connection) fails it; so does one that starts while the one
  // of the window still runs or waits for the lock (a window would keep several waiting).
  it('starts at most once a minute in a window, only after its last one ended, and not after dispose', async () => {
    let now = 1_000_000;
    const { subject, launches } = keeper({ now: () => now });
    subject.keep(WSL_DISTRIBUTION);
    subject.keep(WSL_DISTRIBUTION);
    now += KEEPER_LAUNCH_MS;
    subject.keep(WSL_DISTRIBUTION);
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toHaveLength(1);
    launches[0]?.exit();
    now -= 1;
    launches[0]?.exit();
    subject.keep(WSL_DISTRIBUTION);
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toHaveLength(1);
    now += 1;
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(2));
    launches[1]?.exit();
    now += KEEPER_LAUNCH_MS;
    subject.dispose();
    subject.keep(WSL_DISTRIBUTION);
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toHaveLength(2);
  });

  it('logs a start that fails once while it stays the same', async () => {
    let now = 1_000_000;
    const { subject, log } = keeper({ now: () => now, launch: async () => Promise.reject(new Error('spawn EPERM')) });
    subject.keep(WSL_DISTRIBUTION);
    now += KEEPER_LAUNCH_MS;
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(
        'The keeper of the WSL distribution devspaces could not start: spawn EPERM. Without a keeper, WSL stops the distribution 15 seconds after the last command of Devspaces there ended, also while a container runs there.',
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.warn.mock.calls.filter(([text]) => String(text).includes('could not start'))).toHaveLength(1);
  });

  // Mutation: a keeper whose end is not looked at fails it (a keeper that cannot hold the lock, or a wslg.exe that does
  // not wait, would end at once each minute without a word); so does a warning at each end, or one that is not logged
  // again after a keeper that ran.
  it('logs a keeper that ends at once, once while it stays so, and again after a keeper that ran', async () => {
    let now = 1_000_000;
    const { subject, launches, log } = keeper({ now: () => now });
    const endsAtOnce = () => log.warn.mock.calls.filter(([text]) => String(text).includes('ended at once'));
    const start = async (count: number) => {
      now += KEEPER_LAUNCH_MS;
      subject.keep(WSL_DISTRIBUTION);
      await vi.waitFor(() => expect(launches).toHaveLength(count));
    };
    await start(1);
    now += KEEPER_EARLY_END_MS - 1;
    launches[0]?.exit(1);
    expect(log.warn).toHaveBeenCalledWith(
      'The keeper of the WSL distribution devspaces ended at once (exit code 1). Without a keeper, WSL stops the distribution 15 seconds after the last command of Devspaces there ended, also while a container runs there.',
    );
    await start(2);
    launches[1]?.exit(1);
    expect(endsAtOnce()).toHaveLength(1);
    // A keeper that ran (two checks, or a wait for the lock) is no failure, also with exit code 1 after its wait.
    await start(3);
    now += KEEPER_EARLY_END_MS;
    launches[2]?.exit(1);
    expect(endsAtOnce()).toHaveLength(1);
    await start(4);
    launches[3]?.exit(null);
    expect(endsAtOnce()).toHaveLength(2);
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining('ended at once (exit code none)'));
  });

  // Mutation: a hint that is missing for exit code 127 fails it: a distribution of an earlier version has no idle script.
  it('names the missing idle script for a keeper that ends at once with exit code 127', async () => {
    const { subject, launches, log } = keeper({ now: () => 1_000_000 });
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    launches[0]?.exit(127);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'ended at once (exit code 127); the distribution may have no idle script /usr/lib/devspaces/idle, because an earlier version of Devspaces set it up: remove it with "Remove the WSL Distribution of Devspaces…" and set it up again.',
      ),
    );
  });

  // Mutation: holds that stays true after the end, or stopping after an end with another exit code (the wait for the lock
  // ended, the distribution stopped), after an end at once, after a minute, or after a new keeper, fails it.
  it('holds while its keeper runs, and stops for a minute after its idle script ended (exit code 0)', async () => {
    let now = 1_000_000;
    const { subject, launches } = keeper({ now: () => now });
    expect(subject.holds(WSL_DISTRIBUTION)).toBe(false);
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    expect(subject.holds(WSL_DISTRIBUTION)).toBe(true);
    expect(subject.stopping(WSL_DISTRIBUTION)).toBe(false);
    now += 2 * KEEPER_LAUNCH_MS;
    launches[0]?.exit(0);
    expect(subject.holds(WSL_DISTRIBUTION)).toBe(false);
    expect(subject.stopping(WSL_DISTRIBUTION)).toBe(true);
    expect(subject.stopping('Ubuntu')).toBe(false);
    now += KEEPER_LAUNCH_MS - 1;
    expect(subject.stopping(WSL_DISTRIBUTION)).toBe(true);
    now += 1;
    expect(subject.stopping(WSL_DISTRIBUTION)).toBe(false);
    // A new keeper ends the stop.
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(2));
    now += 2 * KEEPER_LAUNCH_MS;
    launches[1]?.exit(0);
    expect(subject.stopping(WSL_DISTRIBUTION)).toBe(true);
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(3));
    expect(subject.stopping(WSL_DISTRIBUTION)).toBe(false);
    // The end of the wait for the lock (exit code 1) is no stop.
    now += 2 * KEEPER_LAUNCH_MS;
    launches[2]?.exit(1);
    expect(subject.stopping(WSL_DISTRIBUTION)).toBe(false);
    // A keeper that a flow starts within the stop ends it, also when it ends at once.
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(4));
    now += 2 * KEEPER_LAUNCH_MS;
    launches[3]?.exit(0);
    expect(subject.stopping(WSL_DISTRIBUTION)).toBe(true);
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(5));
    launches[4]?.exit(0);
    expect(subject.stopping(WSL_DISTRIBUTION)).toBe(false);
  });

  // Mutation: a start log that is used up by a keep without a program fails it.
  it('logs the start of the first keeper that starts in the window, once', async () => {
    let now = 1_000_000;
    let wsl: string | undefined;
    const { subject, launches, log } = keeper({ now: () => now, wslg: false, wslPath: () => wsl });
    const starts = () => log.info.mock.calls.filter(([text]) => String(text).includes('Devspaces starts the keeper'));
    subject.keep(WSL_DISTRIBUTION);
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches).toEqual([]);
    wsl = WSL;
    now += KEEPER_LAUNCH_MS;
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(starts()).toHaveLength(1));
    expect(starts()[0]?.[0]).toContain('(wsl.exe)');
    launches[0]?.exit();
    now += KEEPER_LAUNCH_MS;
    subject.keep(WSL_DISTRIBUTION);
    await vi.waitFor(() => expect(launches).toHaveLength(2));
    expect(starts()).toHaveLength(1);
  });
});

// The keeper script with the real `sh`, `flock`, `tail` and `date`, and with an idle script of the test in place of
// WSL_IDLE_SCRIPT. The lock file and the log are files of the test instead of KEEPER_LOCK and WSL_IDLE_LOG.
describe.skipIf(process.platform === 'win32')('the keeper script', () => {
  let folder: string | undefined;
  afterEach(() => {
    if (folder !== undefined) fs.rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  });

  /**
   * Starts the script with an idle script in its own folder `name` that writes two lines, says whether it got the file
   * descriptor 9 of the lock, sleeps `idleSeconds` and ends with `exitCode`; `noIdle`: without an idle script.
   * `lockWait`: the wait for the lock in seconds, in place of KEEPER_LOCK_WAIT_SECONDS. All keepers of a test share the
   * lock and the log.
   */
  function startScript(options: { name?: string; idleSeconds?: number; exitCode?: number; lockWait?: number; noIdle?: boolean } = {}) {
    folder ??= fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-keeper-'));
    const lock = path.join(folder, 'lock');
    const log = path.join(folder, 'idle.log');
    const dir = path.join(folder, options.name ?? 'first');
    fs.mkdirSync(dir, { recursive: true });
    const idle = path.join(dir, 'idle');
    if (options.noIdle !== true) {
      fs.writeFileSync(
        idle,
        [
          '#!/bin/sh',
          `echo "idle ${options.name ?? 'first'} runs"`,
          `touch '${dir}/ran'`,
          '[ -e /proc/self/fd/9 ] && echo "idle has the lock" || echo "idle has no lock"',
          `sleep ${options.idleSeconds ?? 0}`,
          `exit ${options.exitCode ?? 0}`,
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
    }
    const script = KEEPER_SCRIPT.replace(KEEPER_LOCK, lock)
      .split(WSL_IDLE_LOG)
      .join(log)
      .replace(WSL_IDLE_SCRIPT, idle)
      .replace(`-w ${KEEPER_LOCK_WAIT_SECONDS} `, `-w ${options.lockWait ?? KEEPER_LOCK_WAIT_SECONDS} `);
    const child = spawn('sh', ['-c', script], { stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, exited, ran: () => fs.existsSync(path.join(dir, 'ran')), log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
  }

  it('is one line without a double quote and without a backslash, and runs the idle script of the image', () => {
    expect(KEEPER_SCRIPT).not.toMatch(/["\\\n\r]/);
    expect(KEEPER_SCRIPT).toContain(`;${WSL_IDLE_SCRIPT} 9>&-`);
    expect(WSL_IDLE_SCRIPT).toBe('/usr/lib/devspaces/idle');
  });

  // Mutation: an idle script that gets the file descriptor of the lock fails it (a `sleep` of a killed keeper would hold
  // the lock); so does a keeper that does not end with the idle script, or loses its output.
  it('runs the idle script without the lock, with its output in the log after a line with the time, and ends with its exit code', async () => {
    const done = startScript();
    expect(await done.exited).toBe(0);
    expect(done.log()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00 The keeper runs the idle script\.\nidle first runs\nidle has no lock\n$/);
    const failed = startScript({ name: 'second', exitCode: 3 });
    expect(await failed.exited).toBe(3);
    expect(failed.log()).toContain('idle second runs');
  });

  it('keeps the last 300 lines of the log of earlier keepers', async () => {
    const first = startScript();
    await first.exited;
    const log = path.join(folder as string, 'idle.log');
    fs.writeFileSync(log, Array.from({ length: 400 }, (_, index) => `old ${index}`).join('\n') + '\n');
    expect(WSL_IDLE_LOG_LINES).toBe(300);
    const second = startScript({ name: 'second' });
    await second.exited;
    const lines = second.log().trimEnd().split('\n');
    expect(lines).toHaveLength(WSL_IDLE_LOG_LINES + 3);
    expect(lines[0]).toBe('old 100');
    expect(lines.at(-2)).toBe('idle second runs');
  });

  // Mutation: a script without the lock lets every window start one more idle script; one that ends at once while
  // another holds the lock leaves no keeper when that one ends right after (it was on its last check).
  it('waits for the lock while another keeper holds it, and takes over when that one ends', async () => {
    const first = startScript({ idleSeconds: 5 });
    await vi.waitFor(() => expect(first.ran()).toBe(true));
    const second = startScript({ name: 'second' });
    let secondEnded = false;
    void second.exited.then(() => (secondEnded = true));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(secondEnded).toBe(false);
    expect(second.ran()).toBe(false);
    // The end of the first one frees the lock at once, also while its idle script runs on (it does not hold the lock).
    first.child.kill();
    await first.exited;
    expect(await second.exited).toBe(0);
    expect(second.ran()).toBe(true);
  });

  it('ends after its wait for the lock while another keeper holds it, without the idle script', async () => {
    const first = startScript({ idleSeconds: 5 });
    await vi.waitFor(() => expect(first.ran()).toBe(true));
    const second = startScript({ name: 'second', lockWait: 1 });
    expect(await second.exited).not.toBe(0);
    expect(second.ran()).toBe(false);
    first.child.kill();
    await first.exited;
  });

  it('ends at once with exit code 127 in a distribution without the idle script', async () => {
    const missing = startScript({ noIdle: true });
    expect(await missing.exited).toBe(127);
  });
});
