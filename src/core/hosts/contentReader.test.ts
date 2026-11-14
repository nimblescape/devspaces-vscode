// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reader of Show Files (R-ENG-010): its call of `docker run` with the limits of the reader of the shared volumes and
// the volume or the image mounted read-only, exactly that call on the shared shell, its script (run here with the
// Node.js of the tests on a folder: names, sizes and times, never the content of a file, never through a link), and the
// text of the document.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSharedShellCall } from '../docker/bootstrapDocker';
import {
  CONTENT_READER_CODE,
  CONTENT_READER_LIMITS,
  CONTENT_READER_ROOT,
  contentReaderArgs,
  contentTargetOf,
  contentTreeText,
  isContentReaderCall,
  parseContentTree,
  type ContentTarget,
  type ContentTree,
} from './contentReader';

const HELPER = 'devspaces-worker:0123456789ab';
const NAME = 'devspaces-reader-0a1b2c3d';
const IMAGE_ID = `sha256:${'ab'.repeat(32)}`;
const volume: ContentTarget = { kind: 'volume', name: 'shop_data' };
const image: ContentTarget = { kind: 'image', id: IMAGE_ID };

describe('the call of the reader of Show Files', () => {
  it('runs a helper image with the limits of the readers, and mounts the volume or the image read-only', () => {
    const args = contentReaderArgs({ image: HELPER, target: volume, name: NAME });
    expect(args).toEqual([
      'run',
      '--rm',
      '--name',
      NAME,
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
      `type=volume,source=shop_data,target=${CONTENT_READER_ROOT},readonly`,
      '--entrypoint',
      'node',
      HELPER,
      '-e',
      CONTENT_READER_CODE,
      CONTENT_READER_ROOT,
    ]);
    expect(contentReaderArgs({ image: HELPER, target: image, name: NAME })[18]).toBe(`type=image,source=${IMAGE_ID},target=${CONTENT_READER_ROOT},readonly`);
    for (const target of [volume, image]) expect(isContentReaderCall(contentReaderArgs({ image: HELPER, target, name: NAME }))).toBe(true);
  });

  it('refuses a name, a helper image or a target that the call cannot carry', () => {
    expect(() => contentReaderArgs({ image: HELPER, target: volume, name: 'other' })).toThrow();
    for (const helper of ['node:24', 'devspaces-worker:latest', '-v']) expect(() => contentReaderArgs({ image: helper, target: volume, name: NAME })).toThrow();
    for (const name of ['a,readonly=false', '/', '-v', '']) expect(() => contentReaderArgs({ image: HELPER, target: { kind: 'volume', name }, name: NAME })).toThrow();
    for (const id of ['nginx:1.27', 'sha256:abc', `${IMAGE_ID},readonly=false`]) expect(() => contentReaderArgs({ image: HELPER, target: { kind: 'image', id }, name: NAME })).toThrow();
  });

  it('runs on the shared shell of a host exactly as contentReaderArgs makes it, no other docker run', () => {
    const call = () => contentReaderArgs({ image: HELPER, target: volume, name: NAME });
    const changed = (index: number, value: string) => call().map((arg, i) => (i === index ? value : arg));
    for (const vm of [false, true]) {
      expect(isSharedShellCall(call(), vm)).toBe(true);
      expect(isSharedShellCall(contentReaderArgs({ image: HELPER, target: image, name: NAME }), vm)).toBe(true);
      expect(isSharedShellCall(changed(23, 'require("child_process").execSync("id")'), vm)).toBe(false);
      expect(isSharedShellCall(changed(18, `type=volume,source=shop_data,target=${CONTENT_READER_ROOT}`), vm)).toBe(false);
      expect(isSharedShellCall(changed(18, `type=bind,source=/,target=${CONTENT_READER_ROOT},readonly`), vm)).toBe(false);
      expect(isSharedShellCall(changed(7, 'bridge'), vm)).toBe(false);
      expect(isSharedShellCall(changed(21, 'alpine'), vm)).toBe(false);
      expect(isSharedShellCall([...call(), '/etc'], vm)).toBe(false);
    }
  });

  it('reads a volume by its name and an image by its full ID, nothing else', () => {
    expect(contentTargetOf({ kind: 'volume', id: 'shop_data', name: 'shop_data' })).toEqual(volume);
    expect(contentTargetOf({ kind: 'image', id: IMAGE_ID, name: 'nginx:1.27' })).toEqual(image);
    expect(contentTargetOf({ kind: 'image', id: 'sha256:abc', name: 'nginx:1.27' })).toBeUndefined();
    expect(contentTargetOf({ kind: 'container', id: 'c', name: 'web' })).toBeUndefined();
    expect(contentTargetOf({ kind: 'network', id: 'n', name: 'bridge' })).toBeUndefined();
  });
});

describe('the script of the reader of Show Files', () => {
  let root: string;
  const read = (code = CONTENT_READER_CODE) => execFileSync(process.execPath, ['-e', code, root], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-reader-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is one line for the shared shell: no line break, no single quote, no template literal, no comment', () => {
    expect(CONTENT_READER_CODE).not.toMatch(/[\n\r\0'`]/);
    expect(CONTENT_READER_CODE).not.toContain('//');
    expect(CONTENT_READER_CODE.length).toBeLessThan(4 * 1024);
  });

  it('gives the names, sizes, counts and times of the tree, never the content of a file, and never follows a link', () => {
    fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'secret content 12345');
    fs.writeFileSync(path.join(root, 'src', 'lib', 'util.ts'), 'abc');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=ghp_value');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'content-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'other.txt'), 'x'.repeat(1000));
      if (process.platform !== 'win32') fs.symlinkSync(outside, path.join(root, 'link'));
      const output = read();
      expect(output).not.toContain('secret content');
      expect(output).not.toContain('ghp_value');
      expect(output).not.toContain('other.txt');
      const tree = parseContentTree(output) as ContentTree;
      expect(tree.stopped).toBe(false);
      expect(tree.root).toMatchObject({ type: 'folder', bytes: 38, files: 3, folders: 2 });
      const names = (tree.root.entries ?? []).map((entry) => [entry.name, entry.type]).sort();
      expect(names).toEqual([['.env', 'file'], ...(process.platform !== 'win32' ? [['link', 'link']] : []), ['src', 'folder']]);
      const src = tree.root.entries?.find((entry) => entry.name === 'src');
      expect(src).toMatchObject({ bytes: 23, files: 2, folders: 1 });
      if (process.platform !== 'win32') expect(tree.root.entries?.find((entry) => entry.name === 'link')).toMatchObject({ link: outside, bytes: 0 });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps the entries of the first levels, and gives a deeper folder only its totals', () => {
    let folder = root;
    for (let level = 1; level <= CONTENT_READER_LIMITS.levels + 2; level++) {
      folder = path.join(folder, `level${level}`);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'file.txt'), 'x');
    }
    const tree = parseContentTree(read()) as ContentTree;
    expect(tree.root).toMatchObject({ files: CONTENT_READER_LIMITS.levels + 2, folders: CONTENT_READER_LIMITS.levels + 2 });
    let entry = tree.root;
    for (let level = 1; level <= CONTENT_READER_LIMITS.levels; level++) {
      const next = entry.entries?.find((child) => child.name === `level${level}`);
      expect(next, `level ${level}`).toBeDefined();
      entry = next as typeof entry;
    }
    // The folder of the last kept level has its totals, and no entries.
    expect(entry).toMatchObject({ files: 3, folders: 2, entries: [], leftOut: 2 });
  });

  it('stops at its limit of entries and says so', () => {
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, `file${i}`), 'x');
    const code = CONTENT_READER_CODE.replace(/entries: \d+,/, 'entries: 10,');
    expect(code).not.toBe(CONTENT_READER_CODE);
    const tree = parseContentTree(read(code)) as ContentTree;
    expect(tree.stopped).toBe(true);
    expect(tree.seen).toBe(10);
    expect(tree.root.files).toBe(10);
    expect(tree.root.leftOut).toBe(20);
  });

  it('keeps no more entries than its limit of output bytes allows, for long names too', () => {
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `${String(i).padStart(2, '0')}${'n'.repeat(200)}`), 'x');
    const code = CONTENT_READER_CODE.replace(/bytes: \d+,/, 'bytes: 2000,');
    expect(code).not.toBe(CONTENT_READER_CODE);
    const output = read(code);
    const tree = parseContentTree(output) as ContentTree;
    expect(tree.stopped).toBe(false);
    expect(tree.root.files).toBe(20);
    // Each entry counts its name as JSON (204 bytes with its quotes) and 120 more: 6 of them fit into 2000 bytes.
    expect(tree.root.entries).toHaveLength(6);
    expect(tree.root.leftOut).toBe(14);
    expect(output.length).toBeLessThan(2000 + 200);
  });

  it('spends no bytes on the entries of a folder that is not kept itself', () => {
    // The folder L… does not fit; its entry a would fit, and the file b fits only when a spent nothing.
    const long = `L${'n'.repeat(200)}`;
    fs.mkdirSync(path.join(root, long));
    fs.writeFileSync(path.join(root, long, 'a'), 'x');
    fs.writeFileSync(path.join(root, 'b'), 'x');
    // The names in sorted order: the folder L… before the file b.
    const code = CONTENT_READER_CODE.replace(/bytes: \d+,/, 'bytes: 200,').replace('fs.readdirSync(dir);', 'fs.readdirSync(dir).sort();');
    expect(code).not.toContain('bytes: 8000000');
    expect(code).toContain('.sort()');
    const tree = parseContentTree(read(code)) as ContentTree;
    expect(tree.root.entries?.map((entry) => entry.name)).toEqual(['b']);
    expect(tree.root).toMatchObject({ files: 2, folders: 1, leftOut: 1 });
  });

  it('says that its totals are lower when a folder is deeper than the walk goes', () => {
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'deep.txt'), 'x');
    const complete = parseContentTree(read()) as ContentTree;
    expect(complete.incomplete).toBeUndefined();
    expect(complete.root.files).toBe(1);
    const code = CONTENT_READER_CODE.replace(/depth: \d+,/, 'depth: 2,');
    expect(code).not.toBe(CONTENT_READER_CODE);
    const tree = parseContentTree(read(code)) as ContentTree;
    expect(tree.stopped).toBe(false);
    expect(tree.incomplete).toBe(true);
    expect(tree.root).toMatchObject({ files: 0, folders: 3 });
  });
});

describe('parseContentTree', () => {
  it('takes only the output of the script', () => {
    for (const text of ['', 'not json', '[]', '{"reader":2,"stopped":false,"entries":0,"tree":{"n":"","t":"d","s":0,"m":0}}', '{"reader":1,"stopped":false,"entries":0,"tree":{"n":"","t":"f","s":0,"m":0}}', '{"reader":1,"stopped":false,"entries":1,"tree":{"n":"","t":"d","s":0,"m":0,"c":[{"n":1}]}}']) {
      expect(parseContentTree(text), text).toBeUndefined();
    }
    expect(parseContentTree('{"reader":1,"stopped":false,"entries":0,"tree":{"n":"","t":"d","s":0,"m":0,"f":0,"d":0,"c":[],"x":0}}')).toEqual({
      stopped: false,
      seen: 0,
      root: { name: '', type: 'folder', bytes: 0, modified: 0, files: 0, folders: 0, entries: [] },
    });
    expect(parseContentTree('{"reader":1,"stopped":false,"incomplete":true,"entries":0,"tree":{"n":"","t":"d","s":0,"m":0,"f":0,"d":0,"c":[],"x":0}}')).toMatchObject({ incomplete: true });
    expect(parseContentTree('{"reader":1,"stopped":false,"incomplete":false,"entries":0,"tree":{"n":"","t":"d","s":0,"m":0,"f":0,"d":0,"c":[],"x":0}}')).not.toHaveProperty('incomplete');
  });
});

describe('contentTreeText', () => {
  const at = Date.parse('2026-11-14T07:00:00Z');
  it('gives a header and one line per entry, the folders first, with the names made safe for one line', () => {
    const tree: ContentTree = {
      stopped: false,
      seen: 5,
      root: {
        name: '',
        type: 'folder',
        bytes: 1_500_000,
        modified: at,
        files: 3,
        folders: 1,
        entries: [
          { name: 'z.txt', type: 'file', bytes: 500_000, modified: at },
          { name: 'bad\nname\u202e.txt', type: 'file', bytes: 1, modified: at },
          { name: 'current', type: 'link', bytes: 0, modified: at, link: '/data/v2' },
          { name: 'data', type: 'folder', bytes: 999_999, modified: at, files: 1, folders: 0, entries: [{ name: 'a.bin', type: 'file', bytes: 999_999, modified: at }], leftOut: 2 },
          { name: 'fifo', type: 'other', bytes: 0, modified: at },
        ],
      },
    };
    expect(contentTreeText(tree, { subject: 'volume shop_data', host: 'lab', at, timeZone: 'Europe/Vienna' }).split('\n')).toEqual([
      'Files of the volume shop_data on lab',
      'Read 2026-11-14 08:00 · 3 files in 1 folder · 1.5 MB (the sizes of the files)',
      `Only the names, sizes and times are read, never the content of a file. Folders deeper than ${CONTENT_READER_LIMITS.levels} levels show only their totals.`,
      '',
      '/ · 1.5 MB · 3 files · 2026-11-14 08:00',
      '  data/ · 1000 kB · 1 file · 2026-11-14 08:00',
      '    a.bin · 1000 kB · 2026-11-14 08:00',
      '    … 2 more entries',
      '  bad?name?.txt · 1 B · 2026-11-14 08:00',
      '  current -> /data/v2 · 2026-11-14 08:00',
      '  fifo · a special file · 2026-11-14 08:00',
      '  z.txt · 500 kB · 2026-11-14 08:00',
      '',
    ]);
  });

  it('says how many entries are left out of a folder that kept none at the limits, but not of a folder at the level limit', () => {
    const folder = (name: string, entries: ContentTree['root'][], leftOut?: number) => ({
      name,
      type: 'folder' as const,
      bytes: 0,
      modified: at,
      files: 0,
      folders: 0,
      entries,
      ...(leftOut !== undefined ? { leftOut } : {}),
    });
    // A folder of the first level whose entries an earlier folder used up (the limit of the kept entries).
    const early = contentTreeText({ stopped: false, seen: 4, root: folder('', [folder('big', [], 1), folder('src', [], 3)]) }, { subject: 'volume v', host: 'lab', at, timeZone: 'UTC' });
    expect(early).toContain('  src/ · 0 B · 0 files · 2026-11-14 07:00\n    … 3 more entries\n');
    // The folder of the last level of the tree shows only its totals.
    let deep = folder(`level${CONTENT_READER_LIMITS.levels}`, [], 2);
    for (let level = CONTENT_READER_LIMITS.levels - 1; level >= 1; level--) deep = folder(`level${level}`, [deep]);
    const text = contentTreeText({ stopped: false, seen: 7, root: folder('', [deep]) }, { subject: 'volume v', host: 'lab', at, timeZone: 'UTC' });
    expect(text).toMatch(new RegExp(`level${CONTENT_READER_LIMITS.levels}/ · 0 B · 0 files · 2026-11-14 07:00\\n$`));
    expect(text).not.toContain('more entries');
  });

  it('says when the read stopped at its limit, and gives the totals as lower bounds', () => {
    const tree: ContentTree = { stopped: true, seen: 200_000, root: { name: '', type: 'folder', bytes: 10, modified: at, files: 2, folders: 0, entries: [] } };
    const text = contentTreeText(tree, { subject: 'image nginx:1.27', host: 'lab', at, timeZone: 'UTC' });
    expect(text).toContain('Read 2026-11-14 07:00 · at least 2 files in 0 folders · at least 10 B');
    expect(text).toContain('The read stopped at its limit');
  });

  it('says when some entries could not be read, and gives the totals as lower bounds', () => {
    const tree: ContentTree = { stopped: false, incomplete: true, seen: 3, root: { name: '', type: 'folder', bytes: 10, modified: at, files: 2, folders: 1, entries: [] } };
    const text = contentTreeText(tree, { subject: 'volume v', host: 'lab', at, timeZone: 'UTC' });
    expect(text).toContain('Read 2026-11-14 07:00 · at least 2 files in 1 folder · at least 10 B');
    expect(text).toContain('Some entries could not be read, or are deeper than the read goes: the totals are lower.');
    expect(text).not.toContain('The read stopped at its limit');
  });
});
