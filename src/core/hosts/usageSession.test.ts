// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import type { StartedByteProcess } from '../ports';
import { MIN_USAGE_HEARTBEAT_SECONDS, USAGE_DOCKER_SECONDS, USAGE_SCRIPT, USAGE_SIZES_SECONDS } from './usageScript';
import { MIN_USAGE_ANSWER_MS, USAGE_KEEP_ALIVE_MS, USAGE_SIZES_ANSWER_MS, UsageSession, type UsageEnd, type UsageSessionOptions, type UsageTimers } from './usageSession';
import type { UsageBlock, UsageHeader } from './usageStream';
import type { HostUsage } from './usageRates';

const MARKER = 'fedcba9876543210fedcba9876543210';
const HEADER = (byteMode: boolean) => `@${MARKER}\n#H 1 2 0 ${byteMode ? 1 : 0} - 5000 -\n`;

/** Timers that run only when the test moves the clock. */
class FakeTimers implements UsageTimers {
  time = 0;
  private next = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.pending.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = end;
  }
}

/** A started process whose output the test writes, and whose input the test reads. */
class FakeProcess implements StartedByteProcess {
  readonly input: string[] = [];
  ended = false;
  kills = 0;
  private stdout: ((chunk: Buffer) => void) | undefined;
  private stderr: ((text: string) => void) | undefined;
  private resolveExit!: (value: { exitCode: number | null; error?: Error }) => void;
  readonly exited = new Promise<{ exitCode: number | null; error?: Error }>((resolve) => (this.resolveExit = resolve));

  write(chunk: Buffer): boolean {
    this.input.push(chunk.toString('utf8'));
    return true;
  }
  onDrain(): void {}
  end(): void {
    this.ended = true;
  }
  kill(): void {
    this.kills++;
  }
  onStdout(listener: (chunk: Buffer) => void): void {
    this.stdout = listener;
  }
  pauseStdout(): void {}
  resumeStdout(): void {}
  onStderr(listener: (text: string) => void): void {
    this.stderr = listener;
  }

  print(text: string): void {
    this.stdout?.(Buffer.from(text, 'utf8'));
  }
  printError(text: string): void {
    this.stderr?.(text);
  }
  exit(exitCode: number | null): Promise<void> {
    this.resolveExit({ exitCode });
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  /** What the session wrote after the script. */
  get requests(): string[] {
    return this.input.slice(1);
  }
}

function blockText(seq: number, startCs: number, durationCs = 1, extra: string[] = []): string {
  const time = (cs: number) => `${Math.floor(cs / 100)}.${String(cs % 100).padStart(2, '0')}`;
  return [`#T ${seq} ${time(startCs)}`, `cpu  ${seq * 10} 0 0 ${seq * 10} 0 0 0 0`, ...extra, `#E ${seq} ${time(startCs + durationCs)}`, ''].join('\n');
}

interface Run {
  process: FakeProcess;
  timers: FakeTimers;
  session: UsageSession;
  headers: UsageHeader[];
  blocks: Array<{ block: UsageBlock; usage: HostUsage }>;
  ends: UsageEnd[];
  logs: string[];
}

function start(options: Partial<UsageSessionOptions> = {}): Run {
  const process = new FakeProcess();
  const timers = new FakeTimers();
  const run = { process, timers, headers: [], blocks: [], ends: [], logs: [] } as unknown as Run;
  run.session = UsageSession.start(process, {
    logger: { info: (m) => run.logs.push(m), warn: (m) => run.logs.push(m), error: (m) => run.logs.push(m), output: () => undefined },
    name: 'host-a',
    intervalMs: 2_000,
    timers,
    marker: MARKER,
    onHeader: (header) => run.headers.push(header),
    onBlock: (block, usage) => run.blocks.push({ block, usage }),
    onEnd: (end) => run.ends.push(end),
    ...options,
  });
  return run;
}

describe('UsageSession', () => {
  it('writes the filled script and nothing else until the marker line came', () => {
    const run = start({ heartbeatSeconds: 45, wslIdle: true });
    expect(run.process.input).toEqual([USAGE_SCRIPT.replace('@MARK@', MARKER).replace('@HB@', '45').replace('@WI@', '1')]);
    run.timers.advance(20_000);
    run.process.print('greeting of the login\n');
    expect(run.process.requests).toEqual([]);
    run.process.print(HEADER(true));
    expect(run.headers).toEqual([{ cgroup: 2, uid: 0, byteMode: true, pid1AgeCs: 5000 }]);
    expect(run.session.live).toBe(true);
    // The first request asks for the disks too.
    expect(run.process.requests).toEqual(['d']);
  });

  it('asks with one byte at the interval after each block, with d every fifth request', () => {
    const run = start();
    run.process.print(HEADER(true));
    for (let seq = 1; seq <= 6; seq++) {
      run.process.print(blockText(seq, seq * 200));
      run.timers.advance(1_999);
      expect(run.process.requests).toHaveLength(seq);
      run.timers.advance(1);
    }
    expect(run.process.requests).toEqual(['d', 't', 't', 't', 't', 'd', 't']);
    expect(run.blocks.map(({ block }) => block.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    // The rates come from the block before.
    expect(run.blocks[0].usage.cpu).toBeUndefined();
    expect(run.blocks[1].usage.cpu).toEqual({ busy: 50, iowait: 0, steal: 0 });
  });

  it('asks by lines on a host without timeout or dd, and sends no spaces there', () => {
    const run = start();
    run.process.print(HEADER(false));
    run.process.print(blockText(1, 100));
    run.timers.advance(2_000);
    expect(run.process.requests).toEqual(['d\n', 't\n']);
    run.session.pause();
    run.process.print(blockText(2, 300));
    run.timers.advance(60_000);
    expect(run.process.requests).toEqual(['d\n', 't\n']);
    expect(run.logs.some((line) => line.includes('asks by lines'))).toBe(true);
  });

  it('waits longer between the requests when the host needs long for a block', () => {
    const run = start();
    run.process.print(HEADER(true));
    // The block took 1 s: the next request goes out 4 s after the first.
    run.process.print(blockText(1, 100, 100));
    run.timers.advance(3_999);
    expect(run.process.requests).toEqual(['d']);
    run.timers.advance(1);
    expect(run.process.requests).toEqual(['d', 't']);
  });

  it('sends a space when nothing went out for the keep-alive time, also while paused', () => {
    const run = start();
    run.process.print(HEADER(true));
    run.process.print(blockText(1, 100));
    run.session.pause();
    run.timers.advance(USAGE_KEEP_ALIVE_MS - 1);
    expect(run.process.requests).toEqual(['d']);
    run.timers.advance(1);
    run.timers.advance(USAGE_KEEP_ALIVE_MS);
    expect(run.process.requests).toEqual(['d', ' ', ' ']);
    // Resume asks at once.
    run.session.resume();
    expect(run.process.requests).toEqual(['d', ' ', ' ', 't']);
  });

  it('asks for the sizes after the block that is awaited, and gives the sizes read its longer time', () => {
    const run = start();
    run.process.print(HEADER(true));
    expect(run.session.readSizes()).toBe(true);
    expect(run.session.readingSizes).toBe(true);
    expect(run.session.readSizes()).toBe(false);
    expect(run.process.requests).toEqual(['d']);
    run.process.print(blockText(1, 100));
    expect(run.process.requests).toEqual(['d', 's']);
    // A space every keep-alive time while the sizes are read, and no end before USAGE_SIZES_ANSWER_MS.
    run.timers.advance(USAGE_SIZES_ANSWER_MS - 1);
    expect(run.process.requests.filter((request) => request === ' ')).toHaveLength(Math.floor((USAGE_SIZES_ANSWER_MS - 1) / USAGE_KEEP_ALIVE_MS));
    expect(run.ends).toEqual([]);
    run.process.print(blockText(2, 20_000, 9_000, ['Z df {}', 'Z.']));
    expect(run.blocks[1].block.sizes).toMatchObject({ ok: true });
    expect(run.session.readingSizes).toBe(false);
    // The slow sizes read does not slow the next requests.
    run.timers.advance(2_000);
    expect(run.process.requests.at(-1)).toBe('t');
  });

  it('sends no sizes read while the page is hidden: a read that waits for the block goes out after resume', () => {
    const run = start();
    run.process.print(HEADER(true));
    expect(run.session.readSizes()).toBe(true);
    run.session.pause();
    run.process.print(blockText(1, 100));
    run.timers.advance(USAGE_KEEP_ALIVE_MS);
    expect(run.process.requests).toEqual(['d', ' ']);
    expect(run.session.readingSizes).toBe(true);
    run.session.resume();
    expect(run.process.requests).toEqual(['d', ' ', 's']);
  });

  it('sends one request when the handler of the header asks for the sizes itself', () => {
    let session: UsageSession | undefined;
    const run = start({ onHeader: () => session?.readSizes() });
    session = run.session;
    run.process.print(HEADER(true));
    expect(run.process.requests).toEqual(['s']);
    run.process.print(blockText(1, 100, 1, ['Z df {}', 'Z.']));
    expect(run.ends).toEqual([]);
    expect(run.blocks).toHaveLength(1);
  });

  it('keeps one chain of requests when the handler of a block asks for the sizes itself', () => {
    let session: UsageSession | undefined;
    let asked = false;
    const run = start({
      onBlock: () => {
        if (!asked) asked = session?.readSizes() ?? false;
      },
    });
    session = run.session;
    const asks = () => run.process.requests.filter((request) => request !== ' ');
    run.process.print(HEADER(true));
    // The host answers each request 50 ms later; the first block comes after 300 ms.
    run.timers.advance(300);
    run.process.print(blockText(1, 100, 30));
    expect(asks()).toEqual(['d', 's']);
    let answered = 1;
    for (let step = 0; step < 600; step++) {
      run.timers.advance(50);
      while (answered < asks().length) {
        answered++;
        run.process.print(blockText(answered, 100 + answered * 100, 5, asks()[answered - 1] === 's' ? ['Z df {}', 'Z.'] : []));
      }
    }
    // 30 s at an interval of 2 s: about 15 requests after the sizes, not two chains of them.
    expect(asks().length).toBeLessThanOrEqual(18);
    expect(run.ends).toEqual([]);
  });

  it('stops the started transport when the script refuses a value', () => {
    const process = new FakeProcess();
    expect(() =>
      UsageSession.start(process, { logger: { info: () => undefined, warn: () => undefined, error: () => undefined, output: () => undefined }, name: 'h', intervalMs: 2_000, heartbeatSeconds: 10, onBlock: () => undefined, onEnd: () => undefined }),
    ).toThrow(/integer/);
    expect(process.ended).toBe(true);
    expect(process.kills).toBe(1);
    expect(process.input).toEqual([]);
  });

  it('keeps a stream that is paused before its start with spaces, and asks at the resume', () => {
    const run = start();
    run.session.pause();
    run.process.print(HEADER(true));
    expect(run.process.requests).toEqual([' ']);
    run.timers.advance(USAGE_KEEP_ALIVE_MS);
    expect(run.process.requests).toEqual([' ', ' ']);
    run.session.resume();
    expect(run.process.requests).toEqual([' ', ' ', 'd']);
  });

  it('stops the process when a handler of the page throws, and throws the error on', () => {
    const run = start({
      onBlock: () => {
        throw new Error('the page broke');
      },
    });
    run.process.print(HEADER(true));
    expect(() => run.process.print(blockText(1, 100))).toThrow('the page broke');
    expect(run.ends).toEqual([{ kind: 'failed', detail: 'the page broke' }]);
    expect(run.process.ended).toBe(true);
    run.timers.advance(USAGE_KEEP_ALIVE_MS * 3);
    expect(run.process.requests).toEqual(['d']);
  });

  it('asks for the sizes at once when no block is awaited, and refuses while paused', () => {
    const run = start();
    run.process.print(HEADER(true));
    run.process.print(blockText(1, 100));
    expect(run.session.readSizes()).toBe(true);
    expect(run.process.requests).toEqual(['d', 's']);
    run.process.print(blockText(2, 300));
    run.session.pause();
    expect(run.session.readSizes()).toBe(false);
  });

  it('stops a host that does not answer a request in time', () => {
    const run = start({ intervalMs: 5_000 });
    run.process.print(HEADER(true));
    run.timers.advance(15_000 - 1);
    expect(run.ends).toEqual([]);
    run.timers.advance(1);
    expect(run.ends).toEqual([{ kind: 'noAnswer', stage: 'sample' }]);
    expect(run.process.ended).toBe(true);
    run.timers.advance(5_000);
    expect(run.process.kills).toBe(1);
  });

  it('gives a block more time than its one Docker call, and a sizes read more than all of its calls', () => {
    expect(MIN_USAGE_ANSWER_MS).toBeGreaterThanOrEqual(2 * USAGE_DOCKER_SECONDS * 1000);
    expect(USAGE_SIZES_ANSWER_MS).toBeGreaterThan((USAGE_SIZES_SECONDS + USAGE_DOCKER_SECONDS) * 1000);
    expect(MIN_USAGE_HEARTBEAT_SECONDS * 1000).toBeGreaterThanOrEqual(3 * USAGE_KEEP_ALIVE_MS);
  });

  it('gives a fast interval at least the shortest answer time', () => {
    const run = start({ intervalMs: 1_000 });
    run.process.print(HEADER(true));
    run.timers.advance(MIN_USAGE_ANSWER_MS - 1);
    expect(run.ends).toEqual([]);
    run.timers.advance(1);
    expect(run.ends).toEqual([{ kind: 'noAnswer', stage: 'sample' }]);
  });

  it('stops a login that does not start the script in time, without a limit while a question of the login is open', () => {
    let listener: ((open: boolean) => void) | undefined;
    const run = start({ loginTimeoutMs: 30_000, prompts: { onPrompt: (next) => ((listener = next), () => (listener = undefined)) } });
    run.timers.advance(10_000);
    listener?.(true);
    run.timers.advance(10 * 60_000);
    expect(run.ends).toEqual([]);
    listener?.(false);
    run.timers.advance(30_000 - 1);
    expect(run.ends).toEqual([]);
    run.timers.advance(1);
    expect(run.ends).toEqual([{ kind: 'noAnswer', stage: 'login' }]);
    expect(listener).toBeUndefined();
  });

  it('ends with bad output, and stops the process, for output that breaks the stream', () => {
    const run = start();
    run.process.print(HEADER(true));
    run.process.print('#T 7 1.00\n#E 7 1.01\n');
    expect(run.ends).toEqual([{ kind: 'badOutput', detail: 'The host answered with block 7, but block 1 was asked for.' }]);
    expect(run.process.ended).toBe(true);
    const other = start();
    other.process.print(`@${MARKER}\n#H 9 2 0 1 - - -\n`);
    expect(other.ends).toEqual([{ kind: 'badOutput', detail: 'The host answered with an unknown version of the utilization stream.' }]);
  });

  it('reports a host without /proc as no Linux', () => {
    const run = start();
    run.process.print(`@${MARKER}\n#X noproc\n`);
    expect(run.ends).toEqual([{ kind: 'notLinux' }]);
  });

  it('reports the end of a login that failed with its exit code and error output', async () => {
    const run = start();
    run.process.printError('Permission denied (publickey).\n');
    await run.process.exit(255);
    expect(run.ends).toEqual([{ kind: 'exited', exitCode: 255, beforeStart: true, detail: 'Permission denied (publickey).' }]);
  });

  it('adds what wsl.exe wrote to its standard output to the reason', async () => {
    const run = start({ program: 'wsl.exe' });
    run.process.print('Error code: Wsl/Service/CreateInstance/ERROR_TIMEOUT\n');
    await run.process.exit(1);
    expect(run.ends).toEqual([{ kind: 'exited', exitCode: 1, beforeStart: true, detail: 'Error code: Wsl/Service/CreateInstance/ERROR_TIMEOUT' }]);
  });

  it('reports a stream that ended by itself after it started', async () => {
    const run = start();
    run.process.print(HEADER(true));
    run.process.printError('Killed\n');
    await run.process.exit(0);
    expect(run.ends).toEqual([{ kind: 'exited', exitCode: 0, beforeStart: false, detail: 'Killed' }]);
  });

  it('stops: closes the input, stops the process after the grace when it did not end, and reports once', async () => {
    const run = start({ closeKillMs: 5_000 });
    run.process.print(HEADER(true));
    run.session.stop();
    run.session.stop();
    expect(run.ends).toEqual([{ kind: 'stopped' }]);
    expect(run.process.ended).toBe(true);
    // No more requests or spaces after the stop.
    run.process.print(blockText(1, 100));
    run.timers.advance(USAGE_KEEP_ALIVE_MS * 3);
    expect(run.process.requests).toEqual(['d']);
    expect(run.blocks).toEqual([]);
    expect(run.process.kills).toBe(1);
    await run.process.exit(null);
    expect(run.ends).toEqual([{ kind: 'stopped' }]);
  });

  it('does not stop a process that ended within the grace', async () => {
    const run = start({ closeKillMs: 5_000 });
    run.process.print(HEADER(true));
    run.session.stop();
    await run.process.exit(0);
    run.timers.advance(5_000);
    expect(run.process.kills).toBe(0);
  });
});
