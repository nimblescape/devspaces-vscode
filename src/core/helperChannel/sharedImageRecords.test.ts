// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The records of the shared images that a prepare built (sharedImageRecords.ts), on a real folder.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockFolder } from './protocol';
import { SHARED_IMAGE_RECORD_SUFFIX, sharedImageRecordPath, sharedImageRecords } from './sharedImageRecords';

const KEY = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const ID = `sha256:${'c'.repeat(64)}`;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-records-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sharedImageRecords', () => {
  it('writes the image ID of a key into its own file of the lock folder (0600, the folder 0700) and reads it back', () => {
    const records = sharedImageRecords(dir);
    expect(records.read(KEY)).toBeUndefined();
    records.write(KEY, ID.toUpperCase().replace('SHA256', 'sha256'));
    const file = sharedImageRecordPath(KEY, dir);
    expect(file).toBe(`${lockFolder(dir)}/${'a'.repeat(64)}${SHARED_IMAGE_RECORD_SUFFIX}`);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${ID}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(lockFolder(dir)).mode & 0o777).toBe(0o700);
    expect(records.read(KEY)).toBe(ID);
    expect(records.read(OTHER)).toBeUndefined();
    // A new record replaces the old one; no file of the write stays.
    records.write(KEY, `sha256:${'d'.repeat(64)}`);
    expect(records.read(KEY)).toBe(`sha256:${'d'.repeat(64)}`);
    expect(fs.readdirSync(lockFolder(dir))).toEqual([path.basename(file)]);
  });

  it('refuses a key or an image ID of another form, and reads no record through a link or of another form', () => {
    const records = sharedImageRecords(dir);
    expect(() => records.write('sha256:../x', ID)).toThrow('The image key of the record is invalid.');
    expect(() => records.write(KEY, 'sha256:x')).toThrow('The image ID of the record is invalid.');
    expect(records.read('../x')).toBeUndefined();
    fs.mkdirSync(lockFolder(dir), { recursive: true });
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, `${ID}\n`);
    fs.symlinkSync(target, sharedImageRecordPath(KEY, dir));
    expect(records.read(KEY)).toBeUndefined();
    fs.writeFileSync(sharedImageRecordPath(OTHER, dir), 'no image ID\n');
    expect(records.read(OTHER)).toBeUndefined();
  });

  it('lists every record (an unreadable one without its image ID) and removes one', () => {
    const records = sharedImageRecords(dir);
    expect(records.list()).toEqual([]);
    records.write(KEY, ID);
    fs.writeFileSync(sharedImageRecordPath(OTHER, dir), 'x');
    // Other files of the lock folder are no records.
    fs.writeFileSync(path.join(lockFolder(dir), 'abc.lock'), '');
    fs.writeFileSync(path.join(lockFolder(dir), `${'e'.repeat(63)}${SHARED_IMAGE_RECORD_SUFFIX}`), ID);
    expect(records.list().sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: KEY, imageId: ID },
      { key: OTHER, imageId: undefined },
    ]);
    records.remove(OTHER);
    records.remove('not a key');
    expect(records.list()).toEqual([{ key: KEY, imageId: ID }]);
  });
});
