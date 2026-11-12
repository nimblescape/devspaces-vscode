// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The pure rules of the cleanup of the engine by the Monitor (cleanupRules.ts, docs/requirements.md R-DS-007).
import { describe, expect, it } from 'vitest';
import {
  HELPER_TAG_UNUSED_MS,
  MAX_CLEANUP_ENTRIES,
  cleanupStateText,
  directBaseIds,
  helperTagOfMonitorTag,
  isBuiltOn,
  observedHelperTags,
  parseCleanupState,
  staleMonitorTags,
  unusedHelperTags,
} from './cleanupRules';

const TAG_A = 'devspaces-worker:aaaaaaaaaaaa';
const TAG_B = 'devspaces-worker:bbbbbbbbbbbb';
const MONITOR_A = 'devspaces-monitor:aaaaaaaaaaaa';
const MONITOR_B = 'devspaces-monitor:bbbbbbbbbbbb';
const id = (c: string): string => `sha256:${c.repeat(64)}`;
const NOW = Date.parse('2026-11-12T08:00:00.000Z');
const DAY = 24 * 60 * 60_000;

describe('the record of the cleanup', () => {
  it('reads what it wrote', () => {
    const state = { helperTags: { [TAG_A]: NOW }, helperBases: { [id('1')]: NOW - DAY } };
    expect(parseCleanupState(cleanupStateText(state))).toEqual(state);
  });

  it('gives an empty record for a missing, invalid or foreign text', () => {
    for (const text of [undefined, '', 'not json', 'null', '[]', '42', '{"helperTags":[1]}']) {
      expect(parseCleanupState(text), String(text)).toEqual({ helperTags: {}, helperBases: {} });
    }
  });

  it('leaves out entries that are not valid', () => {
    const text = JSON.stringify({
      helperTags: { [TAG_A]: NOW, 'devspaces-worker:short': NOW, 'node:24': NOW, [TAG_B]: -1 },
      helperBases: { [id('1')]: NOW, 'sha256:abc': NOW, [id('2')]: 1.5, [id('3')]: '1', [id('4')]: Number.MAX_SAFE_INTEGER + 2 },
    }).replace('"helperTags":{', '"helperTags":{"__proto__":1,');
    expect(parseCleanupState(text)).toEqual({ helperTags: { [TAG_A]: NOW }, helperBases: { [id('1')]: NOW } });
  });

  it(`keeps the ${MAX_CLEANUP_ENTRIES} newest entries of each map`, () => {
    const helperBases: Record<string, number> = {};
    for (let i = 0; i < MAX_CLEANUP_ENTRIES + 10; i++) helperBases[`sha256:${i.toString(16).padStart(64, '0')}`] = i;
    const kept = parseCleanupState(cleanupStateText({ helperTags: {}, helperBases })).helperBases;
    expect(Object.keys(kept)).toHaveLength(MAX_CLEANUP_ENTRIES);
    expect(Math.min(...Object.values(kept))).toBe(10);
  });
});

describe('observedHelperTags', () => {
  it('gives now to a used tag and to a new tag, keeps the time of an unused known tag, and drops a tag on no image', () => {
    const recorded = { [TAG_A]: NOW - 3 * DAY, [TAG_B]: NOW - 3 * DAY, 'devspaces-worker:cccccccccccc': NOW - DAY };
    const images = [
      { id: id('1'), tags: [TAG_A, MONITOR_A] },
      { id: id('2'), tags: [TAG_B] },
      { id: id('3'), tags: ['devspaces-worker:dddddddddddd'] },
      // An earlier build without a tag, and a tag that is not a helper tag.
      { id: id('4'), tags: [] },
      { id: id('5'), tags: ['node:24-trixie-slim'] },
    ];
    expect(observedHelperTags(recorded, images, new Set([id('1')]), NOW)).toEqual({
      [TAG_A]: NOW,
      [TAG_B]: NOW - 3 * DAY,
      'devspaces-worker:dddddddddddd': NOW,
    });
  });

  it('gives now to a recorded time later than now (the clock went back)', () => {
    expect(observedHelperTags({ [TAG_A]: NOW + DAY }, [{ id: id('1'), tags: [TAG_A] }], new Set(), NOW)).toEqual({ [TAG_A]: NOW });
  });
});

describe('unusedHelperTags', () => {
  it('names the tags that no running container used for 7 days, never the own tag', () => {
    const times = { [TAG_A]: NOW - HELPER_TAG_UNUSED_MS, [TAG_B]: NOW - HELPER_TAG_UNUSED_MS - 1, 'devspaces-worker:cccccccccccc': NOW - HELPER_TAG_UNUSED_MS + 1 };
    expect(unusedHelperTags(times, TAG_A, NOW)).toEqual([TAG_B]);
    expect(unusedHelperTags(times, undefined, NOW)).toEqual([TAG_A, TAG_B]);
  });
});

describe('monitor tags', () => {
  it('helperTagOfMonitorTag', () => {
    expect(helperTagOfMonitorTag(MONITOR_A)).toBe(TAG_A);
  });

  it('a monitor tag is stale when its helper tag is not on the same image', () => {
    const images = [
      { id: id('1'), tags: [TAG_A, MONITOR_A] },
      // A rebuild moved the helper tag B to image 3.
      { id: id('2'), tags: [MONITOR_B] },
      { id: id('3'), tags: [TAG_B] },
      // Its helper tag was removed.
      { id: id('4'), tags: ['devspaces-monitor:cccccccccccc'] },
    ];
    expect(staleMonitorTags(images)).toEqual([MONITOR_B, 'devspaces-monitor:cccccccccccc']);
  });
});

describe('base images', () => {
  const layers = new Map<string, string[]>([
    [id('d'), ['l1']],
    [id('n'), ['l1', 'l2']],
    [id('h'), ['l1', 'l2', 'l3']],
    [id('o'), ['l9']],
    [id('e'), []],
  ]);

  it('the direct base of a helper image is the image with the most layers that its layers start with', () => {
    // debian (d) is under node (n): not a direct base. The image without layers is no base of anything.
    expect(directBaseIds(layers, new Set([id('h')]))).toEqual(new Set([id('n')]));
  });

  it('an image with the same layers as another one is no base of it, and a helper image is no base of another one', () => {
    const twins = new Map<string, string[]>([
      [id('n'), ['l1', 'l2']],
      [id('h'), ['l1', 'l2']],
      [id('g'), ['l1', 'l2', 'l3']],
    ]);
    expect(directBaseIds(twins, new Set([id('h'), id('g')]))).toEqual(new Set([id('n')]));
  });

  it('two images with the same layers under a helper image are both its direct base', () => {
    const pair = new Map<string, string[]>([
      [id('n'), ['l1']],
      [id('m'), ['l1']],
      [id('h'), ['l1', 'l2']],
    ]);
    expect(directBaseIds(pair, new Set([id('h')]))).toEqual(new Set([id('n'), id('m')]));
  });

  it('a helper image that is not in the map has no base', () => {
    expect(directBaseIds(layers, new Set([id('x')]))).toEqual(new Set());
  });

  it('isBuiltOn: another image starts with all layers of the image and has more', () => {
    expect(isBuiltOn(id('n'), layers)).toBe(true);
    expect(isBuiltOn(id('d'), layers)).toBe(true);
    expect(isBuiltOn(id('h'), layers)).toBe(false);
    expect(isBuiltOn(id('o'), layers)).toBe(false);
    expect(isBuiltOn(id('x'), layers)).toBe(false);
  });
});
