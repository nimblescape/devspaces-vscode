// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The build context as a tar archive (ustar) for `docker build -`: the regular files at the top of the folder, sorted,
// with the mode 0755 (as the Docker CLI on Windows sends them), the owner 0 and the time 0.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextTar } from './contextTar';
import { firstTarFile } from './tarFile';

/** A text field of a header: up to its first NUL. */
function text(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('latin1');
}

/** The entries of an archive: each header with its name, size and data, until the two empty blocks at its end. */
function entries(archive: Buffer): Array<{ header: Buffer; name: string; data: Buffer }> {
  const result: Array<{ header: Buffer; name: string; data: Buffer }> = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(text(header, 124, 12), 8);
    result.push({ header, name: text(header, 0, 100), data: archive.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}

describe('contextTar', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devspaces-context-tar-'));
  });

  afterEach(async () => {
    await fs.promises.rm(folder, { recursive: true, force: true });
  });

  it('packs the files at the top of the folder, sorted by name', async () => {
    await fs.promises.writeFile(path.join(folder, 'Dockerfile'), 'FROM debian:trixie-slim\nCOPY Dockerfile /Dockerfile\n');
    await fs.promises.writeFile(path.join(folder, '.dockerignore'), '*\n!Dockerfile\n');
    await fs.promises.writeFile(path.join(folder, 'empty'), '');
    await fs.promises.writeFile(path.join(folder, 'block'), Buffer.alloc(512, 0x61));
    const archive = await contextTar(folder);
    const packed = entries(archive);
    expect(packed.map((entry) => entry.name)).toEqual(['.dockerignore', 'Dockerfile', 'block', 'empty']);
    expect(packed.map((entry) => entry.data.toString('utf8'))).toEqual(['*\n!Dockerfile\n', 'FROM debian:trixie-slim\nCOPY Dockerfile /Dockerfile\n', 'a'.repeat(512), '']);
    // Each file is padded to whole blocks, and the archive ends with two empty blocks: four headers, three files of one
    // block each (the empty one has none), and the end.
    expect(archive.length).toBe(4 * 512 + 3 * 512 + 2 * 512);
    expect(archive.subarray(archive.length - 1024).every((byte) => byte === 0)).toBe(true);
    // The reader of the extension takes the first entry: its checksum and its fields are valid.
    expect(firstTarFile(archive, { name: '.dockerignore', maxBytes: 1024 })?.toString('utf8')).toBe('*\n!Dockerfile\n');
  });

  it('refuses a folder in the folder, which the archive does not hold', async () => {
    await fs.promises.writeFile(path.join(folder, 'Dockerfile'), 'FROM scratch\n');
    await fs.promises.mkdir(path.join(folder, 'sub'));
    await expect(contextTar(folder)).rejects.toThrow(/has sub, which is not a file/);
  });

  // Windows creates a link only with the right to create links (or the developer mode).
  it.skipIf(process.platform === 'win32')('packs a link to a file as that file, and refuses a link to a folder', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devspaces-context-target-'));
    try {
      await fs.promises.writeFile(path.join(outside, 'Dockerfile'), 'FROM scratch\n');
      await fs.promises.symlink(path.join(outside, 'Dockerfile'), path.join(folder, 'Dockerfile'));
      const [entry] = entries(await contextTar(folder));
      expect(entry.name).toBe('Dockerfile');
      expect(entry.data.toString('utf8')).toBe('FROM scratch\n');
      expect(text(entry.header, 156, 1)).toBe('0');
      await fs.promises.symlink(outside, path.join(folder, 'linked'));
      await expect(contextTar(folder)).rejects.toThrow(/has linked, which is not a file/);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('gives each file the mode 0755, the owner 0, the time 0, the kind of a regular file and the ustar mark', async () => {
    await fs.promises.writeFile(path.join(folder, 'Dockerfile'), 'FROM scratch\n');
    await fs.promises.chmod(path.join(folder, 'Dockerfile'), 0o600);
    const [entry] = entries(await contextTar(folder));
    expect(text(entry.header, 100, 8)).toBe('0000755');
    expect(text(entry.header, 108, 8)).toBe('0000000');
    expect(text(entry.header, 116, 8)).toBe('0000000');
    expect(text(entry.header, 124, 12)).toBe('00000000015');
    expect(text(entry.header, 136, 12)).toBe('00000000000');
    expect(text(entry.header, 156, 1)).toBe('0');
    expect(entry.header.subarray(257, 265).toString('latin1')).toBe('ustar\u000000');
    // The checksum: the sum of the bytes with its own field as spaces, in octal, then NUL and a space.
    const copy = Buffer.from(entry.header);
    copy.fill(0x20, 148, 156);
    const sum = copy.reduce((total, byte) => total + byte, 0);
    expect(entry.header.subarray(148, 156).toString('latin1')).toBe(`${sum.toString(8).padStart(6, '0')}\u0000 `);
  });

  it('gives the same archive for the same files, whatever their times', async () => {
    const file = path.join(folder, 'Dockerfile');
    await fs.promises.writeFile(file, 'FROM scratch\n');
    const first = await contextTar(folder);
    await fs.promises.utimes(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    expect((await contextTar(folder)).equals(first)).toBe(true);
  });

  it('refuses a name that a header cannot hold, and a context larger than 1 MiB', async () => {
    const long = path.join(folder, 'x'.repeat(101));
    await fs.promises.writeFile(long, '');
    await expect(contextTar(folder)).rejects.toThrow(/cannot hold/);
    await fs.promises.rm(long);
    const accent = path.join(folder, 'café');
    await fs.promises.writeFile(accent, '');
    await expect(contextTar(folder)).rejects.toThrow(/cannot hold/);
    await fs.promises.rm(accent);
    await fs.promises.writeFile(path.join(folder, 'big'), Buffer.alloc(1024 * 1024 + 1));
    await expect(contextTar(folder)).rejects.toThrow(/larger than 1048576 bytes/);
  });
});
