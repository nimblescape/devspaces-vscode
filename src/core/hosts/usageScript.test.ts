// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_USAGE_HEARTBEAT_SECONDS, MIN_USAGE_HEARTBEAT_SECONDS, USAGE_SCRIPT, newUsageMarker, usageScript } from './usageScript';
import { UsageStreamReader, type UsageBlock, type UsageHeader } from './usageStream';

const MARKER = '0123456789abcdef0123456789abcdef';

describe('usageScript', () => {
  it('fills the marker, the time without a request and the idle check', () => {
    const script = usageScript(MARKER, 45, true);
    expect(script).toContain(`mk=${MARKER} hb=45 wi=1\n`);
    expect(usageScript(MARKER)).toContain(`mk=${MARKER} hb=30 wi=0\n`);
    expect(script).not.toMatch(/@(MARK|HB|WI)@/);
  });

  it('refuses any other value, so that no other text reaches the shell', () => {
    for (const marker of ['', MARKER.toUpperCase(), MARKER.slice(1), `${MARKER}\n`, `${MARKER.slice(1)};`]) expect(() => usageScript(marker)).toThrow(/marker/);
    for (const seconds of [MIN_USAGE_HEARTBEAT_SECONDS - 1, MAX_USAGE_HEARTBEAT_SECONDS + 1, 30.5, Number.NaN]) expect(() => usageScript(MARKER, seconds)).toThrow(/integer/);
  });

  it('makes a new marker of 32 hexadecimal digits each time', () => {
    const marker = newUsageMarker();
    expect(marker).toMatch(/^[0-9a-f]{32}$/);
    expect(newUsageMarker()).not.toBe(marker);
  });

  it('is one compound command, and writes no file: every redirection goes to /dev/null or a descriptor', () => {
    expect(USAGE_SCRIPT.startsWith('{\n')).toBe(true);
    expect(USAGE_SCRIPT.endsWith('\n}\n')).toBe(true);
    for (const placeholder of ['@MARK@', '@HB@', '@WI@']) expect(USAGE_SCRIPT.split(placeholder)).toHaveLength(2);
    // Without the comments: whole lines, and the end of a line after ` # `.
    const code = USAGE_SCRIPT.split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .map((line) => line.replace(/\s#\s.*$/, ''))
      .join('\n');
    for (const word of ['<<', 'mktemp', 'mkfifo', 'touch', 'tee', 'rm ', 'mkdir', 'docker run', 'docker exec', 'docker create']) expect(code).not.toContain(word);
    // `>&-`, `1>&-`, `>&2`, `>/dev/null` and `2>/dev/null` only; `>=` is a comparison of test.
    const redirections = code.match(/\d?>[^=\s]*/g) ?? [];
    for (const redirection of redirections) expect(redirection).toMatch(/^\d?>(&-|&\d|\/dev\/null)/);
  });
});

/** The ID of a fake container. */
const id = (digit: string) => digit.repeat(64);

/**
 * A fake cgroup v2 tree with three containers: one with a process (the test itself, so its network is the one of the
 * host), one with its process one cgroup below (docker-in-docker), and one without a process.
 */
function fakeCgroups(root: string): void {
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(path.join(root, 'cgroup.controllers'), 'cpu io memory pids\n');
  const scope = (digit: string) => path.join(root, 'system.slice', `docker-${id(digit)}.scope`);
  for (const digit of ['1', '2', '3']) {
    const dir = scope(digit);
    write(path.join(dir, 'cpu.stat'), `usage_usec ${digit}234\nuser_usec 1000\nsystem_usec 234\n`);
    write(path.join(dir, 'memory.current'), '4096\n');
    write(path.join(dir, 'memory.max'), digit === '1' ? 'max\n' : '1048576\n');
    write(path.join(dir, 'memory.stat'), 'anon 100\nfile 200\nkernel 5\ninactive_file 50\n');
    write(path.join(dir, 'memory.events'), 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 2\n');
    write(path.join(dir, 'io.stat'), '8:0 rbytes=10 wbytes=20 rios=1 wios=1 dbytes=0 dios=0\n');
    write(path.join(dir, 'pids.current'), '3\n');
    write(path.join(dir, 'cgroup.procs'), digit === '1' ? `${process.pid}\n` : '');
  }
  write(path.join(scope('2'), 'init', 'cgroup.procs'), `${process.pid}\n`);
}

/** A fake Docker CLI with the answers of a small engine. */
function fakeDocker(bin: string): void {
  fs.mkdirSync(bin, { recursive: true });
  const df = JSON.stringify({ Images: [], Containers: [], Volumes: [], BuildCache: [] });
  fs.writeFileSync(
    path.join(bin, 'docker'),
    [
      '#!/bin/sh',
      'case "$*" in',
      `  "ps --no-trunc --format {{.ID}} {{.Names}}") printf '%s web\\n%s db,other/alias\\n' ${id('1')} ${id('2')};;`,
      '  "info --format {{.DockerRootDir}}") echo /var/lib/docker;;',
      `  "system df --verbose --format {{json .}}") echo '${df}';;`,
      '  *label=nimblescape.devspaces.id*dangling*) ;;',
      `  *label=nimblescape.devspaces.id*) echo sha256:${'a'.repeat(64)};;`,
      '  *label=nimblescape.devspaces.worker=true*dangling*) ;;',
      `  *label=nimblescape.devspaces.worker=true*) echo sha256:${'b'.repeat(64)};;`,
      `  "network ls --no-trunc --format {{json .}}") echo '{"Name":"bridge","Driver":"bridge"}';;`,
      `  "image ls --no-trunc --format {{json .}}") echo '{"ID":"sha256:x","Repository":"a","Tag":"1"}';;`,
      '  *) exit 3;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

/** The shells of this computer to run the script in: sh (dash on Debian and Ubuntu), and bash and dash when present. */
const SHELLS = [...new Map(['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash'].filter((shell) => fs.existsSync(shell)).map((shell) => [fs.realpathSync(shell), shell])).values()];

interface Stream {
  child: ChildProcessWithoutNullStreams;
  headers: UsageHeader[];
  blocks: UsageBlock[];
  errors: Error[];
  /** The line `#H` came: the shell read the whole script, so request bytes reach the clock (as the session waits). */
  started: Promise<void>;
  exited: Promise<{ code: number | null; at: number }>;
  next(count: number): Promise<void>;
}

/** Runs the script in `shell` with the fake cgroups and the fake Docker CLI; `heartbeat` may be below the bound here. */
function runScript(shell: string, root: string, bin: string, heartbeat = 30, env: Record<string, string> = {}): Stream {
  const script = USAGE_SCRIPT.replace('@MARK@', MARKER).replace('@HB@', String(heartbeat)).replace('@WI@', '1').replace('C=/sys/fs/cgroup', `C=${root}`);
  const child = spawn(shell, ['-s'], { env: { ...process.env, ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: root } });
  const stream: Stream = { child, headers: [], blocks: [], errors: [] } as unknown as Stream;
  const waiters: Array<() => void> = [];
  let started!: () => void;
  stream.started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no line #H within 10 s')), 10_000);
    started = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  const reader = new UsageStreamReader(MARKER, {
    header: (header) => {
      stream.headers.push(header);
      started();
    },
    notLinux: () => stream.errors.push(new Error('not Linux')),
    block: (block) => {
      stream.blocks.push(block);
      for (const wake of waiters.splice(0)) wake();
    },
  });
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      reader.push(chunk);
    } catch (error) {
      stream.errors.push(error as Error);
    }
  });
  child.stderr.on('data', () => undefined);
  child.stdin.on('error', () => undefined);
  stream.exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, at: Date.now() })));
  stream.next = async (count) => {
    while (stream.blocks.length < count) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no block ${count} within 10 s`)), 10_000);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
  child.stdin.write(script);
  return stream;
}

const linux = process.platform === 'linux' && fs.existsSync('/proc/stat');

describe.skipIf(!linux)('USAGE_SCRIPT in the shells of this computer', () => {
  let dir: string;
  let root: string;
  let bin: string;
  let slowBin: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-usage-script-'));
    root = path.join(dir, 'cgroup');
    bin = path.join(dir, 'bin');
    slowBin = path.join(dir, 'slow-bin');
    fakeCgroups(root);
    fakeDocker(bin);
    fs.mkdirSync(slowBin, { recursive: true });
    fs.writeFileSync(path.join(slowBin, 'docker'), '#!/bin/sh\ncase "$*" in "system df"*) exec sleep "$SLOW_SECONDS";; *) exit 3;; esac\n', { mode: 0o755 });
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const shell of SHELLS) {
    describe.concurrent(shell, () => {
      it('answers each request with one block, and ends at the end of its input', async () => {
        const stream = runScript(shell, root, bin);
        // The bytes may come together: dd reads exactly one each time.
        await stream.started;
        stream.child.stdin.write('dts');
        await stream.next(3);
        expect(stream.errors).toEqual([]);
        expect(stream.headers).toHaveLength(1);
        expect(stream.headers[0]).toMatchObject({ cgroup: 2, byteMode: true });
        const [d, t, s] = stream.blocks;
        expect([d.seq, t.seq, s.seq]).toEqual([1, 2, 3]);
        expect(d.cpu).toBeDefined();
        expect(d.memoryKb.MemTotal).toBeGreaterThan(0n);
        expect(d.idle).toBe(false);
        expect(t.idle).toBeUndefined();
        expect(d.containers.map((container) => [container.id, container.network])).toEqual([
          [id('1'), { kind: 'host' }],
          [id('2'), { kind: 'host' }],
          [id('3'), { kind: 'unknown' }],
        ]);
        expect(d.containers[0]).toMatchObject({ cpuUsec: 1234n, memoryBytes: 4096n, memoryStat: { anon: 100n, file: 200n, inactive_file: 50n }, oomKills: 2n, readBytes: 10n, writeBytes: 20n, pids: 3n });
        expect(d.containers[0].memoryLimitBytes).toBeUndefined();
        expect(d.containers[1].memoryLimitBytes).toBe(1048576n);
        // The names come once, when the set of containers changed.
        expect(d.names).toEqual({ complete: true, names: new Map([[id('1'), 'web'], [id('2'), 'db']]) });
        expect(t.names).toBeUndefined();
        expect(s.sizes).toEqual({
          ok: true,
          df: { Images: [], Containers: [], Volumes: [], BuildCache: [] },
          devspaceImageIds: [`sha256:${'a'.repeat(64)}`],
          helperImageIds: [`sha256:${'b'.repeat(64)}`],
          networks: [{ Name: 'bridge', Driver: 'bridge' }],
          imageTags: [{ ID: 'sha256:x', Repository: 'a', Tag: '1' }],
        });
        const before = Date.now();
        stream.child.stdin.end();
        const { code, at } = await stream.exited;
        expect(code).toBe(0);
        expect(at - before).toBeLessThan(3_000);
      }, 20_000);

      it('ends when no byte came for its time without a request', async () => {
        const stream = runScript(shell, root, bin, 2);
        await stream.started;
        stream.child.stdin.write('t');
        await stream.next(1);
        const before = Date.now();
        const { at } = await stream.exited;
        expect(at - before).toBeLessThan(5_000);
      }, 20_000);

      it('ends when its reader is gone', async () => {
        const stream = runScript(shell, root, bin, 30);
        await stream.started;
        stream.child.stdin.write('t');
        await stream.next(1);
        stream.child.stdout.destroy();
        const before = Date.now();
        // The first request makes the sampler fail its write and end; a later one then makes the clock fail its write.
        const requests = setInterval(() => stream.child.stdin.write('t'), 100);
        const { at } = await stream.exited;
        clearInterval(requests);
        expect(at - before).toBeLessThan(5_000);
      }, 20_000);

      it('ends when its output is blocked (a reader that reads nothing) and no byte comes', async () => {
        const stream = runScript(shell, root, bin, 2);
        await stream.started;
        stream.child.stdin.write('t');
        await stream.next(1);
        stream.child.stdout.pause();
        // About 1 KB per block: 300 blocks fill the pipe, so the sampler blocks in its write.
        stream.child.stdin.write('t'.repeat(300));
        const before = Date.now();
        const { at } = await stream.exited;
        // The time without a byte, then the clock kills the blocked sampler about 2 s later.
        expect(at - before).toBeLessThan(9_000);
      }, 20_000);

      it('leaves no Docker CLI on the host when its input ends during a slow sizes read', async () => {
        // A fake `docker system df` that takes long: one process (as the real CLI), named by a number of this test.
        const seconds = String(7000 + SHELLS.indexOf(shell) * 10 + (process.pid % 7));
        const stream = runScript(shell, root, slowBin, 30, { SLOW_SECONDS: seconds });
        await stream.started;
        stream.child.stdin.write('s');
        await waitFor(() => sleepers(seconds).length > 0, 5_000);
        const before = Date.now();
        stream.child.stdin.end();
        const { at } = await stream.exited;
        // The clock waits 2 s for the sampler, then stops its children and the sampler.
        expect(at - before).toBeLessThan(6_000);
        await waitFor(() => sleepers(seconds).length === 0, 5_000);
        expect(sleepers(seconds)).toEqual([]);
      }, 30_000);
    });
  }
});

/** The processes `sleep <seconds>` of this computer. */
function sleepers(seconds: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8') === `sleep\0${seconds}\0`) found.push(entry);
    } catch {
      // The process ended meanwhile.
    }
  }
  return found;
}

async function waitFor(condition: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
}
