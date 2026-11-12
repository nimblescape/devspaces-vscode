// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The input of the commands of the Monitor from windows of other versions (docs/requirements.md R-DS-011): with
// `ignoreUnknownKeys` (the commands of the Monitor), a key that this version does not know is left out, in the object
// and in each entry of a heartbeat; the keys that it knows keep their strict checks. Without it (between the extension
// and its worker, one version), a key that it does not know refuses the input as before.
import { describe, expect, it } from 'vitest';
import { parseHeartbeatInput, parseImageSettingsInput, parseImagesInput } from './protocol';

const SOURCE = '0123456789abcdef0123456789abcdef';
const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const LENIENT = { ignoreUnknownKeys: true };

describe('the input of the commands of the Monitor from a window of a newer version', () => {
  it('a heartbeat: keys that it does not know are left out, in the object and in each entry', () => {
    const text = JSON.stringify({ source: SOURCE, limitSeconds: 600, later: { a: 1 }, devspaces: [{ id: ID, keepRunning: true, seq: 3, laterEntry: 'x' }] });
    expect(parseHeartbeatInput(text)).toBeUndefined();
    expect(parseHeartbeatInput(text, LENIENT)).toEqual({ source: SOURCE, limitSeconds: 600, devspaces: [{ id: ID, keepRunning: true, seq: 3 }] });
  });

  it('a heartbeat: the keys that it knows keep their checks', () => {
    for (const value of [
      { source: SOURCE, limitSeconds: 600, devspaces: [{ id: ID, keepRunning: true, seq: 3, stopNow: true }], later: 1 },
      { source: SOURCE, limitSeconds: 600, devspaces: [{ id: ID, keepRunning: 'yes', seq: 3 }], later: 1 },
      { source: SOURCE, limitSeconds: 600, devspaces: [{ id: ID, keepRunning: false, seq: 3 }], release: false, later: 1 },
      { limitSeconds: 600, devspaces: [], later: 1 },
      { source: SOURCE, limitSeconds: 600, devspaces: ['not an entry'] },
    ]) {
      expect(parseHeartbeatInput(JSON.stringify(value), LENIENT), JSON.stringify(value)).toBeUndefined();
    }
  });

  it('the image list and the image settings: keys that it does not know are left out', () => {
    const images = JSON.stringify({ source: SOURCE, references: ['node:26'], later: [] });
    expect(parseImagesInput(images)).toBeUndefined();
    expect(parseImagesInput(images, LENIENT)).toEqual({ inUse: { source: SOURCE, references: ['node:26'] } });
    const settings = JSON.stringify({ schedule: '7 6 * * *', timeZone: 'UTC', later: true });
    expect(parseImageSettingsInput(settings)).toBeUndefined();
    expect(parseImageSettingsInput(settings, LENIENT)).toEqual({ schedule: '7 6 * * *', timeZone: 'UTC' });
    // The keys that it knows keep their checks.
    expect(parseImageSettingsInput(JSON.stringify({ schedule: 'never', timeZone: 'UTC', later: true }), LENIENT)).toBeUndefined();
    expect(parseImagesInput(JSON.stringify({ source: 'not a source', references: [], later: 1 }), LENIENT)).toBeUndefined();
  });
});
