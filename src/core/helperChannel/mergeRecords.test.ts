// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The records of the devspaces whose devspace image the Monitor moved to a shared image (mergeRecords.ts), on a real
// folder.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockFolder } from './protocol';
import { MERGE_RECORD_SUFFIX, isMergeRecord, mergeRecordPath, mergeRecords, type MergeRecord } from './mergeRecords';

const DEVSPACE = 'b3f1c2d4-1111-4222-8333-444455556666';
const OTHER = 'c3f1c2d4-1111-4222-8333-444455556666';
const KEY = `sha256:${'a'.repeat(64)}`;
const SHARED = `sha256:${'c'.repeat(64)}`;

function merge(overrides: Partial<MergeRecord['record']> = {}): MergeRecord {
  return {
    ownerId: '4242',
    record: {
      builtAt: '2026-11-12T08:00:00.000Z',
      devspaceImage: 'devspaces-acme-api-brave-noether:3',
      buildNumber: 3,
      configPath: '.devcontainer/devcontainer.json',
      configHash: `sha256:${'d'.repeat(64)}`,
      images: { 'node:24': `sha256:${'e'.repeat(64)}` },
      features: {},
      imageId: SHARED,
      imageKey: KEY,
      ...overrides,
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-merge-records-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('mergeRecords', () => {
  it('writes the record of a devspace into its own file of the lock folder (0600, the folder 0700) and reads it back', () => {
    const records = mergeRecords(dir);
    expect(records.read(DEVSPACE)).toBeUndefined();
    records.write(DEVSPACE, merge());
    const file = mergeRecordPath(DEVSPACE, dir);
    expect(file).toBe(`${lockFolder(dir)}/${DEVSPACE}${MERGE_RECORD_SUFFIX}`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(lockFolder(dir)).mode & 0o777).toBe(0o700);
    expect(records.read(DEVSPACE)).toEqual(merge());
    expect(records.read(OTHER)).toBeUndefined();
    // A new record replaces the old one; no file of the write stays.
    records.write(DEVSPACE, merge({ buildNumber: 4, devspaceImage: 'devspaces-acme-api-brave-noether:4' }));
    expect(records.read(DEVSPACE)?.record.buildNumber).toBe(4);
    expect(fs.readdirSync(lockFolder(dir))).toEqual([path.basename(file)]);
  });

  it('refuses a devspace ID or a record of another form, and reads no record through a link or of another form', () => {
    const records = mergeRecords(dir);
    expect(() => records.write('../x', merge())).toThrow('The devspace ID of the merge record is invalid.');
    expect(() => records.write(DEVSPACE, merge({ imageId: 'sha256:x' }))).toThrow('The merge record is invalid.');
    expect(() => records.write(DEVSPACE, { ...merge(), ownerId: '../x' })).toThrow('The merge record is invalid.');
    expect(() => records.write(DEVSPACE, merge({ devspaceImage: 'x'.repeat(10_000) }))).toThrow('The merge record is invalid.');
    expect(records.read('../x')).toBeUndefined();
    fs.mkdirSync(lockFolder(dir), { recursive: true });
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, JSON.stringify(merge()));
    fs.symlinkSync(target, mergeRecordPath(DEVSPACE, dir));
    expect(records.read(DEVSPACE)).toBeUndefined();
    fs.writeFileSync(mergeRecordPath(OTHER, dir), 'no JSON\n');
    expect(records.read(OTHER)).toBeUndefined();
    fs.rmSync(mergeRecordPath(OTHER, dir));
    fs.writeFileSync(mergeRecordPath(OTHER, dir), JSON.stringify({ ownerId: '4242', record: { ...merge().record, imageKey: undefined } }));
    expect(records.read(OTHER)).toBeUndefined();
  });

  it('lists the devspace of every record file and removes one; a folder that cannot be read lists none', () => {
    const records = mergeRecords(dir);
    expect(records.list()).toEqual([]);
    records.write(DEVSPACE, merge());
    records.write(OTHER, merge());
    // Other files of the lock folder are no records.
    fs.writeFileSync(path.join(lockFolder(dir), `${DEVSPACE}.lock`), '');
    fs.writeFileSync(path.join(lockFolder(dir), `${DEVSPACE}${MERGE_RECORD_SUFFIX}.tmp`), '');
    expect(records.list().sort()).toEqual([DEVSPACE, OTHER].sort());
    records.remove(DEVSPACE);
    records.remove('../x');
    expect(records.list()).toEqual([OTHER]);
    expect(fs.existsSync(path.join(lockFolder(dir), `${DEVSPACE}${MERGE_RECORD_SUFFIX}.tmp`))).toBe(false);
  });

  it('isMergeRecord needs an owner ID, a build record, an image ID and an image key', () => {
    expect(isMergeRecord(merge())).toBe(true);
    expect(isMergeRecord({ record: merge().record })).toBe(false);
    expect(isMergeRecord({ ownerId: '4242', record: { ...merge().record, imageId: undefined } })).toBe(false);
    expect(isMergeRecord({ ownerId: '4242', record: { ...merge().record, imageKey: 'sha256:x' } })).toBe(false);
    expect(isMergeRecord({ ownerId: '4242', record: { ...merge().record, buildNumber: -1 } })).toBe(false);
  });
});
