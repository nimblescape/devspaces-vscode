// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reader of the shared volumes (docs/requirements.md R-ENG-008, the reports of the view Docker Hosts): its script,
// run here with the Node.js of the tests on a folder tree as the container would mount the volumes, reads what each
// volume contains, never follows a link, and keeps its limits; its output is checked; its call is exact (the shared
// shell runs only that call); a read tries the next image when Docker no longer has one, and says why it failed
// otherwise.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../ports';
import {
  OLD_CLI_DETAIL,
  READER_MAX_FILE,
  READER_ROOT,
  VOLUME_READER_SCRIPT,
  VOLUME_READER_CODE,
  isVolumeReaderCall,
  newReaderName,
  parseVolumeReading,
  readSharedVolumes,
  readSharedVolumesSafely,
  readerImages,
  volumeReaderArgs,
  type VolumeReading,
} from './volumeReader';

const COMMIT = 'a'.repeat(40);
const OLD_COMMIT = 'b'.repeat(40);
const HELPER = 'devspaces-worker:0123456789ab';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-reader-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string | Buffer, time?: Date): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (time !== undefined) fs.utimesSync(file, time, time);
}

/** The script on `root`, as the container runs it (`node -e <code> <root>`), with its output checked. */
function runReader(): VolumeReading {
  const output = execFileSync(process.execPath, ['-e', VOLUME_READER_CODE, root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const reading = parseVolumeReading(output);
  if (reading === undefined) throw new Error(`The output of the reader could not be read: ${output.slice(0, 200)}`);
  return reading;
}

describe('the script of the reader', () => {
  it('is one line without comments, as a line of the shared shell carries it', () => {
    expect(VOLUME_READER_CODE).not.toMatch(/[\n\r\0]/);
    expect(VOLUME_READER_CODE).not.toContain('//');
    expect(VOLUME_READER_CODE.length).toBeLessThan(16 * 1024);
  });

  it('reads the records of the Monitor with their texts, and only the names and sizes of the worker scripts', () => {
    const at = new Date('2026-11-12T06:07:00Z');
    write('monitor/cache-run.json', '{"lastRunEndedAt":1}', at);
    write('monitor/runs.json', '{"runs":[]}');
    write('monitor/cache-run.json.1.2.tmp', 'partial');
    write('monitor/heartbeats/abc.def.json', '{"at":2}');
    write('monitor/extensions/failures.json', '{}');
    write('monitor/extensions/wanted/dev1.json', '{"extensions":[]}');
    write('monitor/extensions/.chosen.json.0123456789ab.tmp', 'partial');
    write(`monitor/worker-scripts/${'c'.repeat(64)}.js`, 'x'.repeat(300));
    write(`monitor/worker-scripts/${'c'.repeat(64)}.json`, '{"version":"0.4.2"}');
    write('monitor/notes.txt', 'not a record');
    const files = runReader().monitor?.files ?? [];
    const byPath = new Map(files.map((file) => [file.path, file]));
    expect([...byPath.keys()].sort()).toEqual(
      [
        'cache-run.json',
        'runs.json',
        'heartbeats/abc.def.json',
        'extensions/failures.json',
        'extensions/wanted/dev1.json',
        `worker-scripts/${'c'.repeat(64)}.js`,
        `worker-scripts/${'c'.repeat(64)}.json`,
      ].sort(),
    );
    expect(byPath.get('cache-run.json')).toEqual({ path: 'cache-run.json', bytes: 20, modifiedAt: at.getTime(), text: '{"lastRunEndedAt":1}' });
    expect(byPath.get('extensions/wanted/dev1.json')?.text).toBe('{"extensions":[]}');
    expect(byPath.get(`worker-scripts/${'c'.repeat(64)}.js`)).toMatchObject({ bytes: 300 });
    expect(byPath.get(`worker-scripts/${'c'.repeat(64)}.js`)?.text).toBeUndefined();
    expect(byPath.get(`worker-scripts/${'c'.repeat(64)}.json`)?.text).toBe('{"version":"0.4.2"}');
  });

  it('reads the servers, the markers of use, the extension files and the temporary files of the store of VS Code', () => {
    const used = new Date('2026-11-11T08:00:00Z');
    write(`vscode/server/stable/linux-arm64/${COMMIT}/product.json`, JSON.stringify({ version: '1.141.0', commit: COMMIT }));
    write(`vscode/server/stable/linux-arm64/${COMMIT}/node`, 'n'.repeat(1000));
    write(`vscode/server/stable/linux-arm64/${COMMIT}/bin/code-server`, '#!/bin/sh');
    // A server without its script and without a product.json: no version, and `script` false.
    write(`vscode/server/insider/linux-x64/${OLD_COMMIT}/node`, 'n');
    write(`vscode/used/stable-linux-arm64-${COMMIT}`, '', used);
    write('vscode/extensions/universal/dbaeumer.vscode-eslint-3.0.16', 'e'.repeat(50));
    write('vscode/extensions/linux-arm64/golang.go-0.48.0', 'g'.repeat(70));
    write('vscode/extensions/tmp/download.part', 't'.repeat(5));
    write('vscode/tmp/stable-linux-arm64-abc-1/file', 't'.repeat(7));
    write('vscode/locks/server.lock', '');
    const store = runReader().vscode;
    expect(store?.servers).toEqual([
      {
        quality: 'insider',
        platform: 'linux-x64',
        commit: OLD_COMMIT,
        modifiedAt: expect.any(Number),
        node: true,
        script: false,
        usage: { bytes: 1, files: 1, cut: false },
      },
      {
        quality: 'stable',
        platform: 'linux-arm64',
        commit: COMMIT,
        version: '1.141.0',
        modifiedAt: expect.any(Number),
        node: true,
        script: true,
        usage: { bytes: JSON.stringify({ version: '1.141.0', commit: COMMIT }).length + 1000 + 9, files: 3, cut: false },
      },
    ]);
    expect(store?.used).toEqual([{ name: `stable-linux-arm64-${COMMIT}`, at: used.getTime() }]);
    expect(store?.extensions).toEqual([
      { folder: 'universal', name: 'dbaeumer.vscode-eslint-3.0.16', bytes: 50, modifiedAt: expect.any(Number) },
      { folder: 'linux-arm64', name: 'golang.go-0.48.0', bytes: 70, modifiedAt: expect.any(Number) },
    ]);
    expect(store?.temporary).toEqual({ bytes: 7, files: 1, cut: false });
    expect(store?.extensionTemporary).toEqual({ bytes: 5, files: 1, cut: false });
    expect(store?.locks).toBe(1);
    expect(store?.cut).toBe(false);
  });

  it('reads the top level of the cache of the workers with the kind and size of each entry', () => {
    write('worker-cache/devcontainer-cli/a', 'a'.repeat(10));
    write('worker-cache/devcontainer-cli/sub/b', 'b'.repeat(20));
    write('worker-cache/state.json', '{}');
    fs.symlinkSync('/etc/passwd', path.join(root, 'worker-cache', 'link'));
    const cache = runReader().workerCache;
    expect(cache?.more).toBe(0);
    expect(cache?.entries.map(({ name, kind, usage }) => ({ name, kind, usage }))).toEqual([
      { name: 'devcontainer-cli', kind: 'folder', usage: { bytes: 30, files: 2, cut: false } },
      { name: 'link', kind: 'link', usage: { bytes: '/etc/passwd'.length, files: 1, cut: false } },
      { name: 'state.json', kind: 'file', usage: { bytes: 2, files: 1, cut: false } },
    ]);
  });

  it('gives only the volumes that are mounted', () => {
    expect(runReader()).toEqual({ stopped: false, unreadable: 0, tooLong: false });
    write('monitor/runs.json', '{}');
    const reading = runReader();
    expect(reading.monitor?.files.map((file) => file.path)).toEqual(['runs.json']);
    expect(reading.vscode).toBeUndefined();
    expect(reading.workerCache).toBeUndefined();
  });

  it('never follows a link: no text through a link, no server or size behind one', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-reader-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.json'), '{"secret":true}');
      fs.mkdirSync(path.join(outside, 'big'));
      fs.writeFileSync(path.join(outside, 'big', 'file'), 'x'.repeat(5000));
      fs.mkdirSync(path.join(root, 'monitor', 'heartbeats'), { recursive: true });
      fs.symlinkSync(path.join(outside, 'secret.json'), path.join(root, 'monitor', 'image-settings.json'));
      fs.symlinkSync(outside, path.join(root, 'monitor', 'extensions'));
      fs.mkdirSync(path.join(root, 'vscode', 'server', 'stable', 'linux-x64'), { recursive: true });
      fs.symlinkSync(path.join(outside, 'big'), path.join(root, 'vscode', 'server', 'stable', 'linux-x64', COMMIT));
      fs.mkdirSync(path.join(root, 'vscode', 'tmp'), { recursive: true });
      fs.symlinkSync(path.join(outside, 'big'), path.join(root, 'vscode', 'tmp', 'link'));
      // A product.json that is a link gives no version.
      write(`vscode/server/stable/linux-arm64/${COMMIT}/node`, 'n');
      fs.symlinkSync(path.join(outside, 'secret.json'), path.join(root, 'vscode', 'server', 'stable', 'linux-arm64', COMMIT, 'product.json'));
      const reading = runReader();
      expect(reading.monitor?.files).toEqual([]);
      expect(reading.vscode?.servers.map((server) => [server.platform, server.version])).toEqual([['linux-arm64', undefined]]);
      // The link itself counts with its own size, not with the folder it names.
      expect(reading.vscode?.temporary.bytes).toBeLessThan(5000);
      expect(JSON.stringify(reading)).not.toContain('secret');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)('marks a size as incomplete and counts the folder that it could not list', () => {
    write('vscode/tmp/open/file', 'x'.repeat(10));
    write('vscode/tmp/closed/file', 'x'.repeat(10));
    fs.chmodSync(path.join(root, 'vscode', 'tmp', 'closed'), 0o000);
    try {
      const reading = runReader();
      expect(reading.unreadable).toBe(1);
      expect(reading.vscode?.temporary).toEqual({ bytes: 10, files: 1, cut: true });
      expect(reading.vscode?.extensionTemporary.cut).toBe(false);
    } finally {
      fs.chmodSync(path.join(root, 'vscode', 'tmp', 'closed'), 0o755);
    }
  });

  it('stops at its limit of entries: the sizes and lists are then incomplete', () => {
    for (let i = 0; i < 30; i++) write(`vscode/extensions/universal/a.b${i}-1.0.0`, 'x');
    write('worker-cache/one/file', 'x');
    const code = VOLUME_READER_CODE.replace(/entries: \d+,/, 'entries: 10,');
    expect(code).not.toBe(VOLUME_READER_CODE);
    const reading = parseVolumeReading(execFileSync(process.execPath, ['-e', code, root], { encoding: 'utf8' }));
    expect(reading?.stopped).toBe(true);
    expect(reading?.vscode?.cut).toBe(true);
    expect(reading?.vscode?.extensions.length).toBeLessThan(30);
    expect(reading?.workerCache).toEqual({ entries: [], more: 1 });
  });

  it('leaves out the texts when the output would be longer than its limit in bytes, also with characters of several bytes', () => {
    // 340,000 characters of 3 bytes: about 1 MB of output, over a limit of 1,000,000 bytes that a count of the
    // characters would not reach.
    write('monitor/runs.json', '€'.repeat(340_000));
    write('monitor/cleanup.json', '{}');
    const code = VOLUME_READER_CODE.replace(/output: \d+,/, 'output: 1000000,');
    const output = execFileSync(process.execPath, ['-e', code, root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1_000_000);
    const reading = parseVolumeReading(output);
    expect(reading?.monitor?.textsDropped).toBe(true);
    expect(reading?.monitor?.files.map((file) => [file.path, file.text, file.omitted])).toEqual([
      ['cleanup.json', undefined, 'output'],
      ['runs.json', undefined, 'output'],
    ]);
  });

  it('counts a file with several hard links once, and makes a size with a name that is no UTF-8 incomplete', () => {
    write('worker-cache/store/file', 'x'.repeat(100));
    fs.linkSync(path.join(root, 'worker-cache', 'store', 'file'), path.join(root, 'worker-cache', 'store', 'link'));
    write('vscode/tmp/plain', 'x'.repeat(3));
    fs.writeFileSync(Buffer.concat([Buffer.from(path.join(root, 'vscode', 'tmp') + '/'), Buffer.from([0xff, 0x41])]), 'y'.repeat(5));
    const reading = runReader();
    expect(reading.workerCache?.entries).toEqual([{ name: 'store', kind: 'folder', modifiedAt: expect.any(Number), usage: { bytes: 100, files: 1, cut: false } }]);
    expect(reading.vscode?.temporary).toEqual({ bytes: 3, files: 1, cut: true });
  });

  it('says why it left out the text of a record: over the rest of its budget, or after its limit of entries', () => {
    write('monitor/a.json', 'x'.repeat(600));
    write('monitor/b.json', 'y'.repeat(600));
    const budget = VOLUME_READER_CODE.replace(/texts: \d+,/, 'texts: 1000,');
    const files = parseVolumeReading(execFileSync(process.execPath, ['-e', budget, root], { encoding: 'utf8' }))?.monitor?.files;
    expect(files?.map((file) => [file.path, file.text?.length, file.omitted])).toEqual([
      ['a.json', 600, undefined],
      ['b.json', undefined, 'budget'],
    ]);
  });

  it('keeps its limits in the code that it sends', () => {
    expect(VOLUME_READER_SCRIPT).toContain(`file: ${READER_MAX_FILE},`);
  });

  it('prints no text of a file larger than its limit, but names the file with its size', () => {
    write('monitor/registry-digests.json', 'x'.repeat(READER_MAX_FILE + 1));
    write('monitor/runs.json', '{}');
    const files = runReader().monitor?.files ?? [];
    expect(files.find((file) => file.path === 'registry-digests.json')).toEqual({ path: 'registry-digests.json', bytes: READER_MAX_FILE + 1, modifiedAt: expect.any(Number), omitted: 'size' });
    expect(files.find((file) => file.path === 'runs.json')?.text).toBe('{}');
  });
});

describe('the output of the reader', () => {
  it('is refused when it is no JSON object of the protocol', () => {
    expect(parseVolumeReading('')).toBeUndefined();
    expect(parseVolumeReading('[]')).toBeUndefined();
    expect(parseVolumeReading('{"reader":2}')).toBeUndefined();
    expect(parseVolumeReading('{"reader":1}')).toEqual({ stopped: false, unreadable: 0, tooLong: false });
  });

  it('leaves out each entry that does not fit, and marks a size that it cannot trust as incomplete', () => {
    const reading = parseVolumeReading(
      JSON.stringify({
        reader: 1,
        stopped: true,
        unreadable: 2,
        monitor: {
          files: [
            { path: 'runs.json', bytes: 2, modifiedAt: 5, text: '{}' },
            { path: '../etc/passwd', bytes: 2 },
            { path: 'heartbeats/../../x', bytes: 2 },
            { path: 'other/x.json', bytes: 2 },
            { path: 'cleanup.json', bytes: -1 },
            { path: 'registry-digests.json', bytes: 9, omitted: 'size' },
            { path: 'images.json', bytes: 1, omitted: 'bogus' },
            'nonsense',
          ],
          cut: true,
        },
        vscode: {
          servers: [{ quality: 'stable', platform: 'linux-x64', commit: COMMIT, version: 7, node: 'yes', script: true, usage: { bytes: 'many', files: 1 } }, { quality: 'stable' }],
          used: [{ name: 'x', at: -5 }, { at: 3 }],
          extensions: [{ folder: 'universal', name: 'a.b-1.0.0', bytes: 3 }, { folder: 'universal', name: 'c.d-1.0.0' }],
          locks: 'many',
        },
        workerCache: { entries: [{ name: 'a', kind: 'socket', usage: {} }, { name: 'b', kind: 'file', usage: { bytes: 1, files: 1 } }], more: 3 },
      }),
    );
    expect(reading).toEqual({
      stopped: true,
      unreadable: 2,
      tooLong: false,
      monitor: {
        files: [
          { path: 'runs.json', bytes: 2, modifiedAt: 5, text: '{}' },
          { path: 'registry-digests.json', bytes: 9, omitted: 'size' },
          { path: 'images.json', bytes: 1 },
        ],
        cut: true,
        textsDropped: false,
      },
      vscode: {
        servers: [{ quality: 'stable', platform: 'linux-x64', commit: COMMIT, node: false, script: true, usage: { bytes: 0, files: 1, cut: true } }],
        used: [{ name: 'x' }],
        extensions: [{ folder: 'universal', name: 'a.b-1.0.0', bytes: 3 }],
        temporary: { bytes: 0, files: 0, cut: true },
        extensionTemporary: { bytes: 0, files: 0, cut: true },
        locks: 0,
        cut: false,
      },
      workerCache: { entries: [{ name: 'b', kind: 'file', usage: { bytes: 1, files: 1, cut: false } }], more: 3 },
    });
  });
});

describe('the call of the reader', () => {
  const name = 'devspaces-reader-0a1b2c3d';

  it('runs the script on the volumes that exist, read-only, without network, without a pull and without a log', () => {
    const args = volumeReaderArgs(HELPER, { monitor: 'devspaces-monitor', vscode: 'devspaces-vscode' }, name);
    expect(args).toEqual([
      'run',
      '--rm',
      '--name',
      name,
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
      `type=volume,source=devspaces-vscode,target=${READER_ROOT}/vscode,readonly`,
      '--mount',
      `type=volume,source=devspaces-monitor,target=${READER_ROOT}/monitor,readonly`,
      '--entrypoint',
      'node',
      HELPER,
      '-e',
      VOLUME_READER_CODE,
      READER_ROOT,
    ]);
    expect(isVolumeReaderCall(args)).toBe(true);
    expect(newReaderName()).toMatch(/^devspaces-reader-[0-9a-f]{8}$/);
  });

  it('refuses a name, an image or a volume that the call cannot carry', () => {
    expect(() => volumeReaderArgs(HELPER, {}, 'other')).toThrow();
    expect(() => volumeReaderArgs('-v', {}, name)).toThrow();
    expect(() => volumeReaderArgs('a b', {}, name)).toThrow();
    expect(() => volumeReaderArgs(HELPER, { vscode: 'a,readonly=false' }, name)).toThrow();
    expect(() => volumeReaderArgs(HELPER, { vscode: '/' }, name)).toThrow();
  });

  it('is recognized only exactly: any other flag, mount, code or root is another call', () => {
    const args = volumeReaderArgs(HELPER, { 'worker-cache': 'devspaces-worker-cache' }, name);
    const changed = (index: number, value: string): string[] => args.map((arg, i) => (i === index ? value : arg));
    const mount = args.indexOf('--mount') + 1;
    expect(isVolumeReaderCall(changed(mount, 'type=volume,source=devspaces-worker-cache,target=/devspaces/worker-cache'))).toBe(false);
    expect(isVolumeReaderCall(changed(mount, 'type=bind,source=/,target=/devspaces/worker-cache,readonly'))).toBe(false);
    expect(isVolumeReaderCall(changed(args.indexOf('none'), 'host'))).toBe(false);
    expect(isVolumeReaderCall(changed(args.length - 2, 'process.exit(0)'))).toBe(false);
    expect(isVolumeReaderCall(changed(args.length - 1, '/'))).toBe(false);
    expect(isVolumeReaderCall([...args.slice(0, mount + 1), '--mount', args[mount], ...args.slice(mount + 1)])).toBe(false);
    expect(isVolumeReaderCall([...args.slice(0, 2), '--privileged', ...args.slice(2)])).toBe(false);
    expect(isVolumeReaderCall([...args, 'more'])).toBe(false);
    expect(isVolumeReaderCall(['run', 'x'])).toBe(false);
    expect(isVolumeReaderCall([])).toBe(false);
  });
});

describe('the images of the reader', () => {
  it('takes the helper tag of this version first, then other helper and Monitor images of the host, one tag per image, at most 3', () => {
    const tags = ['nginx:1.27', 'devspaces-worker:111111111111', 'devspaces-monitor:0123456789ab', HELPER, 'devspaces-monitor:333333333333', 'devspaces-worker:222222222222'];
    // devspaces-monitor:0123456789ab is the image of HELPER under the tag of the Monitor.
    expect(readerImages(tags, HELPER)).toEqual([HELPER, 'devspaces-worker:111111111111', 'devspaces-monitor:333333333333']);
    expect(readerImages(tags, 'devspaces-worker:999999999999')).toEqual(['devspaces-worker:111111111111', 'devspaces-monitor:0123456789ab', 'devspaces-monitor:333333333333']);
    expect(readerImages(['nginx:1.27'], HELPER)).toEqual([]);
  });
});

describe('a read of the shared volumes', () => {
  const output = JSON.stringify({ reader: 1, stopped: false, monitor: { files: [{ path: 'runs.json', bytes: 2, text: '{}' }] } });
  const result = (overrides: Partial<RunResult>): RunResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...overrides });

  function fakeDocker(results: RunResult[]): { run: (args: readonly string[], options?: RunOptions) => Promise<RunResult>; calls: { args: readonly string[]; options?: RunOptions }[] } {
    const calls: { args: readonly string[]; options?: RunOptions }[] = [];
    return {
      calls,
      run: async (args, options) => {
        calls.push({ args, ...(options !== undefined ? { options } : {}) });
        const next = results.shift();
        if (next === undefined) throw new Error('No more results.');
        return next;
      },
    };
  }

  const input = { images: [HELPER, 'devspaces-worker:111111111111'], volumes: { monitor: 'devspaces-monitor' }, name: () => 'devspaces-reader-0a1b2c3d' };

  it('reads with the first image, through the call that the shared shell carries', async () => {
    const docker = fakeDocker([result({ stdout: output })]);
    expect(await readSharedVolumes(docker, input)).toEqual({ kind: 'read', image: HELPER, reading: { stopped: false, unreadable: 0, tooLong: false, monitor: { files: [{ path: 'runs.json', bytes: 2, text: '{}' }], cut: false, textsDropped: false } } });
    expect(docker.calls).toHaveLength(1);
    expect(isVolumeReaderCall(docker.calls[0].args)).toBe(true);
    expect(docker.calls[0].options?.timeoutMs).toBeGreaterThan(0);
  });

  it('takes the next image when Docker no longer has one, and says when none is there', async () => {
    const missing = result({ exitCode: 125, stderr: 'Error response from daemon: No such image: devspaces-worker:0123456789ab' });
    const docker = fakeDocker([missing, result({ stdout: output })]);
    expect(await readSharedVolumes(docker, input)).toMatchObject({ kind: 'read', image: 'devspaces-worker:111111111111' });
    expect(await readSharedVolumes(fakeDocker([missing, missing]), input)).toEqual({ kind: 'noImage' });
    expect(await readSharedVolumes(fakeDocker([]), { ...input, images: [] })).toEqual({ kind: 'noImage' });
  });

  it('runs nothing without a volume to read', async () => {
    const docker = fakeDocker([]);
    expect(await readSharedVolumes(docker, { ...input, volumes: {} })).toEqual({ kind: 'noVolume' });
    expect(docker.calls).toHaveLength(0);
  });

  it('says why it failed: the error of Docker, the exit code, the time limit, or an output that it cannot read', async () => {
    expect(await readSharedVolumes(fakeDocker([result({ exitCode: 125, stderr: 'unknown flag: --pull\nSee docker run --help.\n' })]), input)).toEqual({ kind: 'failed', detail: OLD_CLI_DETAIL });
    expect(await readSharedVolumes(fakeDocker([result({ exitCode: 125, stderr: 'docker: Error response from daemon: invalid mount config.\n' })]), input)).toEqual({
      kind: 'failed',
      detail: 'docker: Error response from daemon: invalid mount config.',
    });
    expect(await readSharedVolumes(fakeDocker([result({ exitCode: 1 })]), input)).toEqual({ kind: 'failed', detail: 'The reader ended with exit code 1.' });
    expect(await readSharedVolumes(fakeDocker([result({ exitCode: null, timedOut: true })]), input)).toMatchObject({ kind: 'failed', detail: expect.stringContaining('did not end') });
    expect(await readSharedVolumes(fakeDocker([result({ stdout: 'garbage' })]), input)).toEqual({ kind: 'failed', detail: 'The output of the reader could not be read.' });
  });

  it('gives a failure of the Docker CLI as a failure in the safe form, but an abort as an abort', async () => {
    const failing = { run: async (): Promise<RunResult> => Promise.reject(new Error('Docker is not installed')) };
    expect(await readSharedVolumesSafely(failing, input)).toEqual({ kind: 'failed', detail: 'Docker is not installed' });
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const aborting = { run: async (): Promise<RunResult> => Promise.reject(abort) };
    await expect(readSharedVolumesSafely(aborting, input)).rejects.toBe(abort);
  });
});
