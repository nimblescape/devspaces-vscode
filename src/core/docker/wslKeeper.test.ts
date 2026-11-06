// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WSL_DISTRIBUTION, wslCommandArgs } from './dockerHost';
import { KEEPER_EARLY_END_MS, KEEPER_LAUNCH_MS, KEEPER_LOCK, KEEPER_LOCK_WAIT_SECONDS, KEEPER_SCRIPT, WslKeeper, keeperWslgArgs, wslgPathOf, type WslKeeperDeps } from './wslKeeper';

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
        'The keeper of the WSL distribution devspaces could not start: spawn EPERM. Without a keeper, WSL stops the distribution 15 seconds after VS Code closed, also while a container runs there.',
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
      'The keeper of the WSL distribution devspaces ended at once (exit code 1). Without a keeper, WSL stops the distribution 15 seconds after VS Code closed, also while a container runs there.',
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

// The keeper script with the real `sh`, `flock`, `timeout` and `grep`, and with a `sleep` that returns at once and a
// `docker` that answers from a file of the test. The lock file is one of the test instead of KEEPER_LOCK.
describe.skipIf(process.platform === 'win32')('the keeper script', () => {
  let folder: string | undefined;
  afterEach(() => {
    if (folder !== undefined) fs.rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  });

  /**
   * Starts the script in its own folder `name`, with the lock of the test: `docker ps -q` prints the next line of
   * `answers` (the last one stays); `none`: nothing. `lockWait`: the wait for the lock in seconds, in place of
   * KEEPER_LOCK_WAIT_SECONDS.
   */
  function startScript(answers: readonly string[], options: { slowSleep?: boolean; name?: string; lockWait?: number } = {}) {
    folder ??= fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-keeper-'));
    const lock = path.join(folder, 'lock');
    const dir = path.join(folder, options.name ?? 'first');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(dir, 'answers'), answers.join('\n') + '\n');
    fs.writeFileSync(path.join(bin, 'sleep'), `#!/bin/sh\nexec /bin/sleep ${options.slowSleep ? '5' : '0.01'}\n`, { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, 'docker'),
      [
        '#!/bin/sh',
        `dir='${dir}'`,
        'echo "$*" >> "$dir/args"',
        'n=$(($(cat "$dir/calls" 2>/dev/null || echo 0) + 1)); echo "$n" > "$dir/calls"',
        'total=$(wc -l < "$dir/answers")',
        '[ "$n" -le "$total" ] || n=$total',
        'line=$(sed -n "${n}p" "$dir/answers")',
        '[ "$line" = none ] && exit 0',
        'printf "%s\\n" "$line"',
      ].join('\n'),
      { mode: 0o755 },
    );
    const script = KEEPER_SCRIPT.replace(KEEPER_LOCK, lock).replace(`-w ${KEEPER_LOCK_WAIT_SECONDS} `, `-w ${options.lockWait ?? KEEPER_LOCK_WAIT_SECONDS} `);
    expect(script).not.toBe(KEEPER_SCRIPT);
    const child = spawn('sh', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const calls = () => (fs.existsSync(path.join(dir, 'calls')) ? Number(fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim()) : 0);
    return { child, exited, calls, args: () => fs.readFileSync(path.join(dir, 'args'), 'utf8') };
  }

  it('is one line without a double quote and without a backslash', () => {
    expect(KEEPER_SCRIPT).not.toMatch(/["\\\n\r]/);
  });

  it('ends after two checks in a row without a running container, and runs on while one runs', async () => {
    const { exited, calls, args } = startScript(['abc123', 'abc123', 'none']);
    expect(await exited).toBe(0);
    expect(calls()).toBe(4);
    expect(args()).toContain('ps -q');
  });

  it('starts the count again after a check that found a running container', async () => {
    const { exited, calls } = startScript(['none', 'abc123', 'none', 'none']);
    expect(await exited).toBe(0);
    expect(calls()).toBe(4);
  });

  // Mutation: a script without the lock lets every window start one more keeper; one that ends at once while another
  // holds the lock leaves no keeper when that one ends right after (it was on its last check).
  it('waits for the lock while another keeper holds it, and takes over when that one ends', async () => {
    const first = startScript(['abc123'], { slowSleep: true });
    await vi.waitFor(() => expect(fs.existsSync(path.join(folder as string, 'lock'))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = startScript(['none'], { name: 'second' });
    let secondEnded = false;
    void second.exited.then(() => (secondEnded = true));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(secondEnded).toBe(false);
    expect(second.calls()).toBe(0);
    // The end of the first one frees the lock at once, also while its `sleep` runs on (it does not hold the lock).
    first.child.kill();
    await first.exited;
    expect(await second.exited).toBe(0);
    expect(second.calls()).toBe(2);
  });

  it('ends after its wait for the lock while another keeper holds it', async () => {
    const first = startScript(['abc123'], { slowSleep: true });
    await vi.waitFor(() => expect(fs.existsSync(path.join(folder as string, 'lock'))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = startScript(['abc123'], { name: 'second', lockWait: 1 });
    expect(await second.exited).not.toBe(0);
    expect(second.calls()).toBe(0);
    first.child.kill();
    await first.exited;
  });
});
