// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HELPER_CHECK_FILE,
  MAX_HELPER_CHECK_FILE_BYTES,
  engineHelperRecordText,
  helperCheckOf,
  parseEngineHelperRecord,
  parseEngineHelperRecordText,
  parseHelperCheck,
  readEngineHelperRecord,
  type EngineHelperRecord,
} from './helperCheck';

const TAG = 'devspaces-worker:0123456789ab';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const RECORD: EngineHelperRecord = {
  tag: TAG,
  baseImage: 'node:24-trixie-slim',
  baseDigest: DIGEST,
  checkedAt: '2026-11-04T06:08:00.000Z',
  attemptedAt: '2026-11-03T06:08:00.000Z',
  builtAt: '2026-11-04T06:08:00.000Z',
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function volume(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-helper-check-'));
  dirs.push(dir);
  return dir;
}

describe('the record of the check of the helper image on the engine', () => {
  it('round-trips through the text of its file', () => {
    expect(parseEngineHelperRecordText(engineHelperRecordText(RECORD))).toEqual(RECORD);
    expect(parseEngineHelperRecord({ tag: TAG, baseImage: 'node:24-trixie-slim' })).toEqual({ tag: TAG, baseImage: 'node:24-trixie-slim' });
  });

  it('is read strictly: another key, an invalid tag, base image, digest or time is no record', () => {
    for (const change of [
      { other: 1 },
      { tag: 'devspaces-monitor:0123456789ab' },
      { tag: 'devspaces-worker:latest' },
      { baseImage: '' },
      { baseImage: 'node:24 trixie' },
      { baseImage: 'x'.repeat(513) },
      { baseDigest: 'sha256:abc' },
      { baseDigest: DIGEST.toUpperCase() },
      { checkedAt: 'yesterday' },
      { attemptedAt: 7 },
      { builtAt: null },
    ]) {
      expect(parseEngineHelperRecord({ ...RECORD, ...change }), JSON.stringify(change)).toBeUndefined();
    }
    expect(parseEngineHelperRecord([])).toBeUndefined();
    expect(parseEngineHelperRecordText('{')).toBeUndefined();
    expect(parseEngineHelperRecordText(`${engineHelperRecordText(RECORD)}${' '.repeat(MAX_HELPER_CHECK_FILE_BYTES)}`)).toBeUndefined();
  });

  it('gives a window only a check that found the image current, with its digest', () => {
    expect(helperCheckOf(RECORD)).toEqual({ tag: TAG, baseImage: 'node:24-trixie-slim', baseDigest: DIGEST, checkedAt: RECORD.checkedAt });
    const { checkedAt: _checked, ...attempted } = RECORD;
    expect(helperCheckOf(attempted)).toBeUndefined();
    const { baseDigest: _digest, ...noDigest } = RECORD;
    expect(helperCheckOf(noDigest)).toBeUndefined();
    expect(helperCheckOf(undefined)).toBeUndefined();
  });

  it('checks the check of a heartbeat strictly', () => {
    const check = helperCheckOf(RECORD)!;
    expect(parseHelperCheck(check)).toEqual(check);
    expect(parseHelperCheck({ ...check, builtAt: RECORD.builtAt })).toBeUndefined();
    const { baseDigest: _digest, ...noDigest } = check;
    expect(parseHelperCheck(noDigest)).toBeUndefined();
    expect(parseHelperCheck({ ...check, checkedAt: 'now' })).toBeUndefined();
  });

  it('is read from a plain file of the volume only, never through a link, and never throws', () => {
    const dir = volume();
    expect(readEngineHelperRecord(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, HELPER_CHECK_FILE), engineHelperRecordText(RECORD));
    expect(readEngineHelperRecord(dir)).toEqual(RECORD);
    // A link to a record elsewhere is no record.
    const other = volume();
    fs.renameSync(path.join(dir, HELPER_CHECK_FILE), path.join(other, 'record.json'));
    fs.symlinkSync(path.join(other, 'record.json'), path.join(dir, HELPER_CHECK_FILE));
    expect(readEngineHelperRecord(dir)).toBeUndefined();
    // A folder in its place, and a file that is too long, are none either.
    fs.rmSync(path.join(dir, HELPER_CHECK_FILE));
    fs.mkdirSync(path.join(dir, HELPER_CHECK_FILE));
    expect(readEngineHelperRecord(dir)).toBeUndefined();
    fs.rmdirSync(path.join(dir, HELPER_CHECK_FILE));
    fs.writeFileSync(path.join(dir, HELPER_CHECK_FILE), 'x'.repeat(MAX_HELPER_CHECK_FILE_BYTES + 1));
    expect(readEngineHelperRecord(dir)).toBeUndefined();
  });
});
