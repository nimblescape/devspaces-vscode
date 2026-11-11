// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USAGE_DOCKER_SECONDS, USAGE_SCRIPT, isUsableDockerRoot, newUsageMarker, usageDockerScript, usageScript, type UsageSampleValues } from './usageScript';
import { readUsageSample, type UsageBlock, type UsageHeader } from './usageSample';

const MARKER = '0123456789abcdef0123456789abcdef';

describe('usageScript', () => {
  it('fills the marker, the number, the kind, the idle check and the data folder of Docker', () => {
    const script = usageScript({ marker: MARKER, seq: 7, kind: 'd', wslIdle: true, dockerRoot: '/data/docker root' });
    expect(script).toContain(`mk=${MARKER} seq=7 c=d wi=1 rd='/data/docker root'\n`);
    expect(usageScript({ marker: MARKER, seq: 1, kind: 't' })).toContain(`mk=${MARKER} seq=1 c=t wi=0 rd=''\n`);
    expect(script).not.toMatch(/@(MARK|SEQ|KIND|WI|ROOT)@/);
    // A `$&` in the folder is no pattern of String.replace.
    expect(usageScript({ marker: MARKER, seq: 1, kind: 't', dockerRoot: '/a$&b' })).toContain("rd='/a$&b'");
  });

  it('refuses any other value, so that no other text reaches the shell', () => {
    const ok: UsageSampleValues = { marker: MARKER, seq: 1, kind: 't' };
    for (const marker of ['', MARKER.toUpperCase(), MARKER.slice(1), `${MARKER}\n`, `${MARKER.slice(1)};`]) expect(() => usageScript({ ...ok, marker })).toThrow(/marker/);
    for (const seq of [0, -1, 1.5, Number.NaN, 2 ** 60]) expect(() => usageScript({ ...ok, seq })).toThrow(/number/);
    expect(() => usageScript({ ...ok, kind: 's' as 't' })).toThrow(/kind/);
    for (const dockerRoot of ['relative', "/it's", '/a\nb', '/a\0b']) expect(() => usageScript({ ...ok, dockerRoot })).toThrow(/data folder/);
  });

  it('takes as the data folder of Docker only an absolute path without a quote or a line break', () => {
    expect(isUsableDockerRoot('/var/lib/docker')).toBe(true);
    expect(isUsableDockerRoot('/mnt/my data/$x')).toBe(true);
    for (const folder of ['', 'docker', "/a'b", '/a\rb', `/${'x'.repeat(1024)}`]) expect(isUsableDockerRoot(folder)).toBe(false);
  });

  it('makes each Docker call of the samples one compound command with its words quoted, and refuses a line break', () => {
    const script = usageDockerScript(['ps', '--format', "{{.ID}} it's"]);
    expect(script.startsWith('{\nexec 0</dev/null\n')).toBe(true);
    expect(script.endsWith('\n}\n')).toBe(true);
    expect(script).toContain(`exec timeout ${USAGE_DOCKER_SECONDS} 'docker' 'ps' '--format' '{{.ID}} it'\\''s'`);
    expect(() => usageDockerScript(['ps', 'a\nb'])).toThrow(/line break/);
  });

  it('makes a new marker of 32 hexadecimal digits each time', () => {
    const marker = newUsageMarker();
    expect(marker).toMatch(/^[0-9a-f]{32}$/);
    expect(newUsageMarker()).not.toBe(marker);
  });

  it('is one compound command that writes no file and calls no Docker CLI: every redirection goes to /dev/null or a descriptor', () => {
    expect(USAGE_SCRIPT.startsWith('{\n')).toBe(true);
    expect(USAGE_SCRIPT.endsWith('\n}\n')).toBe(true);
    for (const placeholder of ['@MARK@', '@SEQ@', '@KIND@', '@WI@', '@ROOT@']) expect(USAGE_SCRIPT.split(placeholder)).toHaveLength(2);
    // Without the comments: whole lines, and the end of a line after ` # `.
    const code = USAGE_SCRIPT.split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .map((line) => line.replace(/\s#\s.*$/, ''))
      .join('\n');
    for (const word of ['<<', 'mktemp', 'mkfifo', 'touch', 'tee', 'rm ', 'mkdir', 'timeout']) expect(code).not.toContain(word);
    // `docker` only in paths (/var/lib/docker, docker-<id>.scope) and `kill` only in oom_kill, never as a command.
    expect(code).not.toMatch(/(^|[\s;&|(`])(docker|kill)\s/m);
    // `>&2`, `>/dev/null` and `2>/dev/null` only; `>=` is a comparison of test.
    const redirections = code.match(/\d?>[^=\s]*/g) ?? [];
    for (const redirection of redirections) expect(redirection).toMatch(/^\d?>(&\d|\/dev\/null)/);
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

/** The shells of this computer to run the script in: sh (dash on Debian and Ubuntu), and bash and dash when present. */
const SHELLS = [...new Map(['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash'].filter((shell) => fs.existsSync(shell)).map((shell) => [fs.realpathSync(shell), shell])).values()];

/** Runs one sample in `shell` with the fake cgroups, as the shared shell does: `sh -s` with the script as its input. */
function runSample(shell: string, root: string, values: Omit<UsageSampleValues, 'marker'>, env: Record<string, string> = {}): { header: UsageHeader; block: UsageBlock } {
  const script = usageScript({ marker: MARKER, ...values }).replace('C=/sys/fs/cgroup', `C=${root}`);
  const result = spawnSync(shell, ['-s'], { input: script, env: { ...process.env, ...env, HOME: root }, encoding: 'utf8', timeout: 10_000 });
  expect(result.status).toBe(0);
  const output = readUsageSample(result.stdout, MARKER, values.seq);
  if (output.kind !== 'block') throw new Error('no block');
  return output;
}

const linux = process.platform === 'linux' && fs.existsSync('/proc/stat');

describe.skipIf(!linux)('USAGE_SCRIPT in the shells of this computer', () => {
  let dir: string;
  let root: string;
  let idleScript: string;
  /** Folders with a fake `docker`: one that prints its arguments, one that does not answer. */
  let fakeBin: string;
  let slowBin: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-usage-script-'));
    root = path.join(dir, 'cgroup');
    fakeCgroups(root);
    idleScript = path.join(dir, 'idle-bin', 'idle');
    fs.mkdirSync(path.dirname(idleScript));
    fs.writeFileSync(idleScript, '#!/bin/sh\nwhile :; do sleep 1; done\n', { mode: 0o755 });
    fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'docker'), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n', { mode: 0o755 });
    slowBin = path.join(dir, 'slow-bin');
    fs.mkdirSync(slowBin);
    fs.writeFileSync(path.join(slowBin, 'docker'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  });

  it('ends a Docker call that does not answer after its time limit on the host, before the one of the shell', () => {
    // Only where this computer has a `timeout` of that form, as the script checks it.
    if (spawnSync('/bin/sh', ['-c', 'timeout 1 true']).status !== 0) return;
    const started = Date.now();
    const result = spawnSync('/bin/sh', ['-s'], { input: usageDockerScript(['ps']), env: { ...process.env, PATH: `${slowBin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 20_000 });
    expect(result.status).toBe(124);
    expect(Date.now() - started).toBeLessThan(USAGE_DOCKER_SECONDS * 1000 + 3000);
  }, 20_000);

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const shell of SHELLS) {
    describe(shell, () => {
      it('prints one block per run: d with the disks and the idle check, t without them', () => {
        const d = runSample(shell, root, { seq: 1, kind: 'd', wslIdle: true, dockerRoot: dir });
        expect(d.header).toMatchObject({ cgroup: 2 });
        expect(d.header.uid).toBe(process.getuid?.());
        expect(d.block.seq).toBe(1);
        expect(d.block.cpu).toBeDefined();
        expect(d.block.memoryKb.MemTotal).toBeGreaterThan(0n);
        expect(d.block.endCs).toBeGreaterThanOrEqual(d.block.startCs);
        // The data folder of Docker is read too (the other folders do not exist here).
        expect(d.block.disks?.map((disk) => disk.path)).toContain(dir);
        // Another test file may run a process "idle" now (the WSL keeper), so only the kind is checked here.
        expect(typeof d.block.idle).toBe('boolean');
        expect(d.block.containers.map((container) => [container.id, container.network])).toEqual([
          [id('1'), { kind: 'host' }],
          [id('2'), { kind: 'host' }],
          [id('3'), { kind: 'unknown' }],
        ]);
        expect(d.block.containers[0]).toMatchObject({ cpuUsec: 1234n, memoryBytes: 4096n, memoryStat: { anon: 100n, file: 200n, inactive_file: 50n }, oomKills: 2n, readBytes: 10n, writeBytes: 20n, pids: 3n });
        expect(d.block.containers[0].memoryLimitBytes).toBeUndefined();
        expect(d.block.containers[1].memoryLimitBytes).toBe(1048576n);
        expect(d.block.skipped).toBe(0);
        const t = runSample(shell, root, { seq: 2, kind: 't', wslIdle: true, dockerRoot: dir });
        expect(t.block.seq).toBe(2);
        expect(t.block.disks).toBeUndefined();
        expect(t.block.idle).toBeUndefined();
        expect(t.block.containers).toHaveLength(3);
      });

      it('reads a data folder of Docker that it reads anyway (rootless Docker) only once', () => {
        const rootless = path.join(root, '.local', 'share', 'docker');
        fs.mkdirSync(rootless, { recursive: true });
        const paths = runSample(shell, root, { seq: 1, kind: 'd', dockerRoot: rootless }).block.disks?.map((disk) => disk.path) ?? [];
        expect(paths.filter((folder) => folder === rootless)).toHaveLength(1);
      });

      it('runs a Docker call of the samples with its arguments', () => {
        const result = spawnSync(shell, ['-s'], { input: usageDockerScript(['ps', '--format', "{{.ID}} it's"]), env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10_000 });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("ps\n--format\n{{.ID}} it's\n");
      });

      it('sees a running process "idle" in the idle check of a sample d, and leaves the check out without wslIdle', async () => {
        // A script named idle has the name idle, as the idle script of the WSL keeper.
        const idle = spawn(idleScript, [], { stdio: 'ignore' });
        try {
          await waitFor(() => fs.existsSync(`/proc/${idle.pid}/comm`) && fs.readFileSync(`/proc/${idle.pid}/comm`, 'utf8') === 'idle\n', 5_000);
          expect(runSample(shell, root, { seq: 1, kind: 'd', wslIdle: true }).block.idle).toBe(true);
          expect(runSample(shell, root, { seq: 1, kind: 'd' }).block.idle).toBeUndefined();
        } finally {
          idle.kill();
        }
      }, 20_000);
    });
  }
});

async function waitFor(condition: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
}
