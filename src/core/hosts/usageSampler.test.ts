// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { silentLogger, type RunResult } from '../ports';
import {
  MAX_USAGE_INTERVAL_MS,
  MIN_USAGE_ANSWER_MS,
  USAGE_DISK_EVERY,
  USAGE_NAMES_ARGS,
  USAGE_NAMES_EVERY_MS,
  USAGE_NAMES_RETRY_MS,
  USAGE_ROOT_ARGS,
  USAGE_ROOT_RETRY_MS,
  UsageSampler,
  VM_USAGE_INTERVAL_MS,
  type UsageEnd,
  type UsageRun,
  type UsageSamplerOptions,
  type UsageTimers,
} from './usageSampler';
import type { UsageBlock, UsageHeader } from './usageSample';
import { usageDockerScript } from './usageScript';
import type { HostUsage } from './usageRates';

const BOOT = 'c979624d-e703-46d3-ae35-c4cb34a59e91';
const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const OK = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const ran = (result: RunResult): UsageRun => ({ kind: 'ran', result });

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

  get waiting(): number {
    return this.pending.size;
  }

  /** Moves the clock by `ms`, runs each timer that is due, and lets the promises after it run. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.pending.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
      await flush();
    }
    this.time = end;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** The values that USAGE_SCRIPT got (usageScript). */
interface Sent {
  seq: number;
  kind: string;
  wslIdle: boolean;
  root: string;
  timeoutMs: number;
}

/**
 * A host that answers each sample as the script would: a header with `boot`, and a block with the `containers`, the
 * `idle` check, and a duration of `durationCs`.
 */
class FakeHost {
  readonly sent: Sent[] = [];
  boot = BOOT;
  containers: string[] = [];
  idle = true;
  durationCs = 1;
  uptimeCs = 100_000;
  /** When set, the next run gives this instead of the output of the script. */
  next: UsageRun | Error | undefined;

  run = async (script: string, timeoutMs: number): Promise<UsageRun> => {
    const match = /^mk=([0-9a-f]{32}) seq=(\d+) c=([td]) wi=([01]) rd='([^']*)'$/m.exec(script);
    if (match === null) throw new Error('not the script');
    const [, marker, seq, kind, wi, root] = match;
    this.sent.push({ seq: Number(seq), kind, wslIdle: wi === '1', root, timeoutMs });
    const next = this.next;
    this.next = undefined;
    if (next instanceof Error) throw next;
    if (next !== undefined) return next;
    const start = this.uptimeCs;
    this.uptimeCs += this.durationCs;
    const time = (cs: number) => `${Math.floor(cs / 100)}.${String(cs % 100).padStart(2, '0')}`;
    const lines = [`@${marker}`, `#H 2 2 0 ${this.boot} 5000 -`, `#T ${seq} ${time(start)}`, `cpu  ${100 * Number(seq)} 0 0 ${900 * Number(seq)} 0 0 0 0`, 'M MemTotal: 1000', 'M MemAvailable: 400'];
    if (kind === 'd' && wi === '1') lines.push(`I ${this.idle ? 1 : 0}`);
    for (const id of this.containers) lines.push(`C ${id}`, 'm 10');
    lines.push(`#E ${seq} ${time(this.uptimeCs)}`, '');
    return { kind: 'ran', result: OK(lines.join('\n')) };
  };
}

interface Started {
  sampler: UsageSampler;
  timers: FakeTimers;
  host: FakeHost;
  blocks: Array<{ block: UsageBlock; usage: HostUsage; names: ReadonlyMap<string, string> | undefined }>;
  headers: UsageHeader[];
  ends: UsageEnd[];
  dockerCalls: string[][];
}

/** The fake answer of a Docker call of the samples, by its arguments. */
type FakeDocker = (args: readonly string[], timeoutMs: number) => Promise<UsageRun>;

/** The scripts of the Docker calls of the sampler, and their arguments. */
const DOCKER_SCRIPTS = new Map([USAGE_NAMES_ARGS, USAGE_ROOT_ARGS].map((args) => [usageDockerScript(args), args]));

/**
 * Starts a sampler on `host`: its samples go to `run` (default the host), its Docker calls to `docker` (default: the
 * names of the containers of the host, and /var/lib/docker; null: a Docker call fails the test).
 */
async function start(options: Partial<UsageSamplerOptions> & { host?: FakeHost; docker?: FakeDocker | null } = {}): Promise<Started> {
  const { host: givenHost, docker: givenDocker, run: givenRun, ...rest } = options;
  const timers = new FakeTimers();
  const host = givenHost ?? new FakeHost();
  const started: Started = { timers, host, blocks: [], headers: [], ends: [], dockerCalls: [] } as unknown as Started;
  const docker: FakeDocker | undefined =
    givenDocker === null
      ? undefined
      : (givenDocker ??
        (async (args) => {
          if (args[0] === 'ps') return ran(OK(host.containers.map((id, index) => `${id} c${index}`).join('\n')));
          return ran(OK('/var/lib/docker\n'));
        }));
  const samples = givenRun ?? host.run;
  const run = async (script: string, timeoutMs: number): Promise<UsageRun> => {
    const args = DOCKER_SCRIPTS.get(script);
    if (args === undefined) return samples(script, timeoutMs);
    if (docker === undefined) throw new Error('A Docker call in a test without Docker.');
    started.dockerCalls.push([...args]);
    return docker(args, timeoutMs);
  };
  started.sampler = UsageSampler.start({
    logger: silentLogger,
    name: 'box',
    intervalMs: VM_USAGE_INTERVAL_MS,
    onHeader: (header) => started.headers.push(header),
    onBlock: (block, usage, names) => started.blocks.push({ block, usage, names }),
    onEnd: (end) => started.ends.push(end),
    timers,
    ...rest,
    run,
  });
  await flush();
  return started;
}

describe('UsageSampler', () => {
  it('runs a d first, then t, with a d every fifth sample, each at the interval from the start of the one before it', async () => {
    const { host, timers, blocks } = await start({ docker: null });
    expect(host.sent.map((sent) => [sent.seq, sent.kind])).toEqual([[1, 'd']]);
    expect(host.sent[0].timeoutMs).toBe(Math.max(3 * VM_USAGE_INTERVAL_MS, MIN_USAGE_ANSWER_MS));
    await timers.advance(VM_USAGE_INTERVAL_MS - 1);
    expect(host.sent).toHaveLength(1);
    await timers.advance(1);
    expect(host.sent).toHaveLength(2);
    await timers.advance(5 * VM_USAGE_INTERVAL_MS);
    expect(host.sent.map((sent) => sent.kind)).toEqual(['d', 't', 't', 't', 't', 'd', 't']);
    expect(blocks.map(({ block }) => block.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // The rates come from the block before: the first has none.
    expect(blocks[0].usage.cpu).toBeUndefined();
    expect(blocks[1].usage.cpu).toBeDefined();
  });

  it('gives no rate across a new start of the kernel, and the new header', async () => {
    const { host, timers, blocks, headers } = await start({ docker: null });
    await timers.advance(VM_USAGE_INTERVAL_MS);
    host.boot = 'd979624d-e703-46d3-ae35-c4cb34a59e91';
    await timers.advance(VM_USAGE_INTERVAL_MS);
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(headers.map((header) => header.bootId)).toEqual([BOOT, host.boot]);
    expect(blocks.map(({ usage }) => usage.cpu !== undefined)).toEqual([false, true, false, true]);
  });

  it('takes a boot ID that the host could not read once for no new start of the kernel', async () => {
    const { host, timers, blocks, headers } = await start({ docker: null });
    await timers.advance(VM_USAGE_INTERVAL_MS);
    host.boot = '-';
    await timers.advance(VM_USAGE_INTERVAL_MS);
    host.boot = BOOT;
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(headers.map((header) => header.bootId)).toEqual([BOOT]);
    expect(blocks.map(({ usage }) => usage.cpu !== undefined)).toEqual([false, true, true, true]);
    // A new start after a boot ID that could not be read is still one.
    host.boot = '-';
    await timers.advance(VM_USAGE_INTERVAL_MS);
    host.boot = 'd979624d-e703-46d3-ae35-c4cb34a59e91';
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(headers.map((header) => header.bootId)).toEqual([BOOT, host.boot]);
    expect(blocks[blocks.length - 1].usage.cpu).toBeUndefined();
  });

  it('gives a host whose uptime jumps (for example after a suspend) at most MAX_USAGE_INTERVAL_MS between the samples', async () => {
    const host = new FakeHost();
    // A sample of 10 hours by the uptime of the host.
    host.durationCs = 3_600_000;
    const { timers } = await start({ host, docker: null });
    await timers.advance(MAX_USAGE_INTERVAL_MS - 1);
    expect(host.sent).toHaveLength(1);
    await timers.advance(1);
    expect(host.sent).toHaveLength(2);
    expect(host.sent[1].timeoutMs).toBe(3 * MAX_USAGE_INTERVAL_MS);
  });

  it('gives a slow host more time between the samples', async () => {
    const host = new FakeHost();
    host.durationCs = 100;
    const { timers } = await start({ host, docker: null });
    // 1 s for the sample: 4 s until the next one.
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(host.sent).toHaveLength(1);
    await timers.advance(4_000 - VM_USAGE_INTERVAL_MS);
    expect(host.sent).toHaveLength(2);
  });

  it('reads the names with docker ps when the set of containers changed, at most every 10 s, and the data folder of Docker once', async () => {
    const host = new FakeHost();
    host.containers = [ID_A];
    const started = await start({ host });
    const { timers, blocks, dockerCalls } = started;
    // docker ps after the first block, and the names with the next block; docker info between the next two samples.
    expect(dockerCalls).toEqual([[...USAGE_NAMES_ARGS]]);
    expect(blocks[0].names).toBeUndefined();
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(blocks[1].names).toEqual(new Map([[ID_A, 'c0']]));
    expect(dockerCalls).toEqual([[...USAGE_NAMES_ARGS], [...USAGE_ROOT_ARGS]]);
    // A new container: docker ps again, but not before 10 s after the last one.
    host.containers = [ID_A, ID_B];
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(dockerCalls).toHaveLength(2);
    await timers.advance(USAGE_NAMES_EVERY_MS);
    expect(dockerCalls).toEqual([[...USAGE_NAMES_ARGS], [...USAGE_ROOT_ARGS], [...USAGE_NAMES_ARGS]]);
    expect(blocks[blocks.length - 1].names).toEqual(new Map([[ID_A, 'c0'], [ID_B, 'c1']]));
    // The same set: no more Docker calls.
    await timers.advance(10 * USAGE_NAMES_EVERY_MS);
    expect(dockerCalls).toHaveLength(3);
    // /var/lib/docker is read by the script anyway.
    expect(host.sent.every((sent) => sent.root === '')).toBe(true);
  });

  it('reads the disk of another data folder of Docker in each sample d after docker info', async () => {
    const host = new FakeHost();
    host.containers = [ID_A];
    const { timers } = await start({ host, docker: async (args) => ran(OK(args[0] === 'ps' ? `${ID_A} web\n` : '/data/docker/\n')) });
    await timers.advance(5 * VM_USAGE_INTERVAL_MS);
    // docker ps between the first two samples, docker info between the next two: one Docker call between two samples.
    expect(host.sent.map((sent) => [sent.kind, sent.root])).toEqual([
      ['d', ''],
      ['t', ''],
      ['t', '/data/docker'],
      ['t', '/data/docker'],
      ['t', '/data/docker'],
      ['d', '/data/docker'],
    ]);
  });

  it('runs docker ps once more after 10 s when it did not list a container of the block (one that was starting)', async () => {
    const host = new FakeHost();
    host.containers = [ID_A, ID_B];
    let listed = [ID_A];
    const { timers, blocks, dockerCalls } = await start({ host, docker: async (args) => ran(OK(args[0] === 'ps' ? listed.map((id) => `${id} n-${id[0]}`).join('\n') : '/var/lib/docker\n')) });
    const ps = () => dockerCalls.filter((args) => args[0] === 'ps').length;
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(blocks[1].names).toEqual(new Map([[ID_A, 'n-a']]));
    listed = [ID_A, ID_B];
    await timers.advance(USAGE_NAMES_EVERY_MS - 2 * VM_USAGE_INTERVAL_MS);
    expect(ps()).toBe(1);
    await timers.advance(2 * VM_USAGE_INTERVAL_MS);
    expect(ps()).toBe(2);
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(blocks[blocks.length - 1].names).toEqual(new Map([[ID_A, 'n-a'], [ID_B, 'n-b']]));
    // All named: no more docker ps for the same set.
    await timers.advance(3 * USAGE_NAMES_RETRY_MS);
    expect(ps()).toBe(2);
  });

  it('asks only once more for a container that docker ps cannot list (of the rootless Docker of another user)', async () => {
    const host = new FakeHost();
    host.containers = [ID_A, ID_B];
    const { timers, dockerCalls } = await start({ host, docker: async (args) => ran(OK(args[0] === 'ps' ? `${ID_A} web\n` : '/var/lib/docker\n')) });
    await timers.advance(10 * USAGE_NAMES_RETRY_MS);
    expect(dockerCalls.filter((args) => args[0] === 'ps')).toHaveLength(2);
    // A new set: docker ps at once, and once more.
    host.containers = [ID_B];
    await timers.advance(10 * USAGE_NAMES_RETRY_MS);
    expect(dockerCalls.filter((args) => args[0] === 'ps')).toHaveLength(4);
  });

  it('asks docker info again after 300 s when its answer was empty (an Engine that starts)', async () => {
    const host = new FakeHost();
    host.containers = [ID_A];
    let root = '\n';
    const { timers, dockerCalls } = await start({ host, docker: async (args) => ran(OK(args[0] === 'ps' ? `${ID_A} web\n` : root)) });
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(dockerCalls.filter((args) => args[0] === 'info')).toHaveLength(1);
    root = '/data/docker\n';
    await timers.advance(USAGE_ROOT_RETRY_MS - 2 * VM_USAGE_INTERVAL_MS);
    expect(dockerCalls.filter((args) => args[0] === 'info')).toHaveLength(1);
    await timers.advance(3 * VM_USAGE_INTERVAL_MS);
    expect(dockerCalls.filter((args) => args[0] === 'info')).toHaveLength(2);
    await timers.advance(USAGE_DISK_EVERY * VM_USAGE_INTERVAL_MS);
    expect(host.sent[host.sent.length - 1].root).toBe('/data/docker');
  });

  it('ends with failed when run rejects for a Docker call, as for a sample', async () => {
    const host = new FakeHost();
    host.containers = [ID_A];
    const { ends, timers } = await start({
      host,
      docker: async () => {
        throw new Error('adapter broke');
      },
    });
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(ends).toEqual([{ kind: 'failed', detail: 'adapter broke' }]);
  });

  it('reads the data folder of Docker again after a new start of the kernel', async () => {
    const host = new FakeHost();
    host.containers = [ID_A];
    const { timers, dockerCalls } = await start({ host });
    await timers.advance(2 * VM_USAGE_INTERVAL_MS);
    expect(dockerCalls.filter((args) => args[0] === 'info')).toHaveLength(1);
    host.boot = 'd979624d-e703-46d3-ae35-c4cb34a59e91';
    // docker ps again at most 10 s after the last one, then docker info.
    await timers.advance(USAGE_NAMES_EVERY_MS + 2 * VM_USAGE_INTERVAL_MS);
    expect(dockerCalls.map((args) => args[0])).toEqual(['ps', 'info', 'ps', 'info']);
  });

  it('tries a failed docker ps again after a minute, and goes on with the samples', async () => {
    const host = new FakeHost();
    host.containers = [ID_A];
    let calls = 0;
    const { timers, blocks } = await start({
      host,
      docker: async () => {
        calls++;
        return ran({ exitCode: 1, stdout: '', stderr: 'permission denied', timedOut: false });
      },
    });
    expect(calls).toBe(1);
    await timers.advance(USAGE_NAMES_RETRY_MS - VM_USAGE_INTERVAL_MS);
    expect(calls).toBe(1);
    await timers.advance(2 * VM_USAGE_INTERVAL_MS);
    expect(calls).toBe(2);
    expect(blocks.length).toBeGreaterThan(20);
    expect(blocks.every(({ names }) => names === undefined)).toBe(true);
  });

  it('ends with vmStopped when a Docker call between two samples could not run, and runs no other sample', async () => {
    const host = new FakeHost();
    host.containers = [ID_A];
    const { timers, ends, blocks } = await start({ host, docker: async () => ({ kind: 'notRun', reason: 'vmStopped' }) });
    expect(blocks).toHaveLength(1);
    expect(ends).toEqual([{ kind: 'vmStopped' }]);
    await timers.advance(10 * VM_USAGE_INTERVAL_MS);
    expect(host.sent).toHaveLength(1);
  });

  it('reports the end of a run that throws at once only after start returned', async () => {
    const holder: { sampler?: UsageSampler } = {};
    const seen: boolean[] = [];
    holder.sampler = UsageSampler.start({
      logger: silentLogger,
      name: 'box',
      intervalMs: VM_USAGE_INTERVAL_MS,
      run: () => {
        throw new Error('gone');
      },
      onBlock: () => undefined,
      onEnd: (end) => seen.push(holder.sampler !== undefined && end.kind === 'failed'),
      timers: new FakeTimers(),
    });
    expect(seen).toEqual([]);
    await flush();
    expect(seen).toEqual([true]);
    expect(holder.sampler.ended).toBe(true);
  });

  it('asks nothing of Docker while no container runs', async () => {
    const { timers, dockerCalls } = await start();
    await timers.advance(20 * VM_USAGE_INTERVAL_MS);
    expect(dockerCalls).toEqual([]);
  });

  it('runs no sample while paused; the one that runs is still reported, and resume runs the next at once after a long pause', async () => {
    const host = new FakeHost();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const run = async (script: string, timeoutMs: number): Promise<UsageRun> => {
      if (host.sent.length === 1) await slow;
      return host.run(script, timeoutMs);
    };
    const { sampler, timers, blocks } = await start({ host, run, docker: null });
    expect(host.sent).toHaveLength(1);
    await timers.advance(VM_USAGE_INTERVAL_MS);
    // The second sample waits for the host.
    expect(host.sent).toHaveLength(1);
    sampler.pause();
    release();
    await flush();
    expect(blocks).toHaveLength(2);
    await timers.advance(10 * VM_USAGE_INTERVAL_MS);
    expect(host.sent).toHaveLength(2);
    expect(timers.waiting).toBe(0);
    sampler.resume();
    await timers.advance(0);
    expect(host.sent).toHaveLength(3);
    // No rate from the block before the pause: it would be the mean of the whole pause.
    expect(blocks[2].usage.cpu).toBeUndefined();
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(blocks[3].usage.cpu).toBeDefined();
  });

  it('keeps the interval and the rates when the page is hidden and shown again at once', async () => {
    const { sampler, timers, host, blocks } = await start({ docker: null });
    expect(host.sent).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      sampler.pause();
      sampler.resume();
      await timers.advance(100);
    }
    expect(host.sent).toHaveLength(1);
    await timers.advance(VM_USAGE_INTERVAL_MS - 500);
    expect(host.sent).toHaveLength(2);
    // No sample was left out: the block has its rates.
    expect(blocks[1].usage.cpu).toBeDefined();
  });

  it('keeps the rates after a short pause that follows a slow sample', async () => {
    const host = new FakeHost();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const run = async (script: string, timeoutMs: number): Promise<UsageRun> => {
      if (host.sent.length === 1) await slow;
      return host.run(script, timeoutMs);
    };
    const { sampler, timers, blocks } = await start({ host, run, docker: null });
    // The second sample waits 10 s on the shell (for example behind a long command of the view), then ends.
    await timers.advance(VM_USAGE_INTERVAL_MS);
    await timers.advance(10_000);
    release();
    await flush();
    expect(blocks).toHaveLength(2);
    // The page is hidden before the third sample starts, and shown again 100 ms later: no sample was left out.
    sampler.pause();
    await timers.advance(100);
    sampler.resume();
    await timers.advance(0);
    expect(host.sent).toHaveLength(3);
    expect(blocks).toHaveLength(3);
    expect(blocks[2].usage.cpu).toBeDefined();
  });

  it('runs no Docker call after a sample that ended while the page was hidden', async () => {
    const host = new FakeHost();
    host.containers = [ID_A];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const run = async (script: string, timeoutMs: number): Promise<UsageRun> => {
      await slow;
      return host.run(script, timeoutMs);
    };
    const { sampler, blocks, dockerCalls } = await start({ host, run });
    sampler.pause();
    release();
    await flush();
    expect(blocks).toHaveLength(1);
    expect(dockerCalls).toEqual([]);
  });

  it('takes its hold at the start and ends it once at the end', async () => {
    let holds = 0;
    let releases = 0;
    const { sampler } = await start({
      docker: null,
      hold: () => {
        holds++;
        return () => releases++;
      },
    });
    expect([holds, releases]).toEqual([1, 0]);
    // The hold stays while paused, so that the shell is there at the resume.
    sampler.pause();
    sampler.resume();
    expect([holds, releases]).toEqual([1, 0]);
    sampler.stop();
    sampler.stop();
    expect([holds, releases]).toEqual([1, 1]);
  });

  it('logs a handler of the end that throws, and stays ended', async () => {
    const host = new FakeHost();
    // A run that rejects: its end comes from the catch of the sample, where a throw would be an unhandled rejection.
    host.next = new Error('gone');
    const { sampler, timers } = await start({
      host,
      docker: null,
      onEnd: () => {
        throw new Error('page gone');
      },
    });
    await timers.advance(5 * VM_USAGE_INTERVAL_MS);
    expect(sampler.ended).toBe(true);
    expect(host.sent).toHaveLength(1);
  });

  it('reports a sample that runs after stop not, and runs no other', async () => {
    const host = new FakeHost();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const run = async (script: string, timeoutMs: number): Promise<UsageRun> => {
      await slow;
      return host.run(script, timeoutMs);
    };
    const { sampler, timers, blocks, ends } = await start({ host, run, docker: null });
    sampler.stop();
    release();
    await flush();
    await timers.advance(10 * VM_USAGE_INTERVAL_MS);
    expect(blocks).toEqual([]);
    expect(ends).toEqual([{ kind: 'stopped' }]);
    expect(host.sent).toHaveLength(1);
    expect(sampler.ended).toBe(true);
  });

  describe('ends once, and runs no other sample', () => {
    const cases: Array<[string, UsageRun | Error, UsageEnd]> = [
      ['a VM that does not run', { kind: 'notRun', reason: 'vmStopped' }, { kind: 'vmStopped' }],
      ['a host without the program of its transport', { kind: 'notRun', reason: 'noTransport' }, { kind: 'noTransport' }],
      ['a sample that did not end in time', { kind: 'ran', result: { exitCode: null, stdout: '', stderr: '', timedOut: true } }, { kind: 'noAnswer', detail: '' }],
      ['a login of the shell that did not answer in time', { kind: 'ran', result: { exitCode: null, stdout: '', stderr: 'ssh did not answer within 30 seconds.', timedOut: true } }, { kind: 'noAnswer', detail: 'ssh did not answer within 30 seconds.' }],
      ['a failed login of the shell', { kind: 'ran', result: { exitCode: 255, stdout: '', stderr: 'ssh: connect to host box port 22: Connection refused\n', timedOut: false } }, { kind: 'exited', exitCode: 255, detail: 'ssh: connect to host box port 22: Connection refused' }],
      ['output that is not of the script', { kind: 'ran', result: OK('hello\n') }, { kind: 'badOutput', detail: 'The host did not run the utilization sample.' }],
      ['a run that failed', new Error('broken'), { kind: 'failed', detail: 'broken' }],
    ];
    for (const [name, next, end] of cases) {
      it(name, async () => {
        const host = new FakeHost();
        host.next = next;
        const { timers, ends, blocks } = await start({ host, docker: null });
        await timers.advance(10 * VM_USAGE_INTERVAL_MS);
        expect(ends).toEqual([end]);
        expect(blocks).toEqual([]);
        expect(host.sent).toHaveLength(1);
      });
    }

    it('a host that is no Linux', async () => {
      const host = new FakeHost();
      const run = async (script: string): Promise<UsageRun> => {
        const marker = /^mk=([0-9a-f]{32})/m.exec(script)?.[1] ?? '';
        host.sent.push({ seq: 1, kind: 'd', wslIdle: false, root: '', timeoutMs: 0 });
        return { kind: 'ran', result: OK(`@${marker}\n#X noproc\n`) };
      };
      const { timers, ends } = await start({ host, run, docker: null });
      await timers.advance(10 * VM_USAGE_INTERVAL_MS);
      expect(ends).toEqual([{ kind: 'notLinux' }]);
      expect(host.sent).toHaveLength(1);
    });

    it('a handler of the page that throws', async () => {
      const host = new FakeHost();
      const ends: UsageEnd[] = [];
      const timers = new FakeTimers();
      UsageSampler.start({
        logger: silentLogger,
        name: 'box',
        intervalMs: VM_USAGE_INTERVAL_MS,
        run: host.run,
        onBlock: () => {
          throw new Error('page broke');
        },
        onEnd: (end) => ends.push(end),
        timers,
      });
      await flush();
      await timers.advance(10 * VM_USAGE_INTERVAL_MS);
      expect(ends).toEqual([{ kind: 'failed', detail: 'page broke' }]);
      expect(host.sent).toHaveLength(1);
    });
  });

  it('ends when the idle script of WSL ran and ended, so that the samples do not hold the distribution', async () => {
    const host = new FakeHost();
    host.idle = false;
    const { timers, ends, blocks } = await start({ host, wslIdle: true, docker: null });
    // Not yet seen: a keeper that just starts. The samples go on.
    await timers.advance(5 * VM_USAGE_INTERVAL_MS);
    expect(ends).toEqual([]);
    host.idle = true;
    await timers.advance(5 * VM_USAGE_INTERVAL_MS);
    expect(ends).toEqual([]);
    host.idle = false;
    await timers.advance(5 * VM_USAGE_INTERVAL_MS);
    expect(ends).toEqual([{ kind: 'vmIdle' }]);
    // The block of that sample still reached the page.
    expect(blocks[blocks.length - 1].block.idle).toBe(false);
    expect(host.sent.every((sent) => sent.wslIdle)).toBe(true);
  });
});
