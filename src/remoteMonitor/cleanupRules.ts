// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The pure rules of the cleanup of the Docker engine by the Monitor (engineCleanup.ts does the I/O;
// docs/requirements.md R-DS-007): its record in the volume (CLEANUP_FILE: when a running container last used each helper
// tag, and which images were the base image of a helper image), which helper tags are unused, which monitor tags lost
// their helper tag, which images are the direct base image of a helper image, and whether another image is built on an
// image. Pure; no I/O.
import { isHelperImageTag, isMonitorImageTag } from '../core/helper/helperState';
import { isRecord } from '../core/valueChecks';

/** The record of the cleanup in the volume of the Monitor. */
export const CLEANUP_FILE = 'cleanup.json';
/** A helper tag that no running container used for this long is removed (not the helper tag of the Monitor). */
export const HELPER_TAG_UNUSED_MS = 7 * 24 * 60 * 60_000;
/**
 * The Monitor looks this often which helper tags a running container uses. A worker lives at least 10 minutes after its
 * last operation (CHANNEL_IDLE_CLOSE_MS), so every worker is seen while the Monitor runs.
 */
export const HELPER_USE_OBSERVE_MS = 5 * 60_000;
/**
 * The filter of the prune of the build cache on the VM of Devspaces: records that no build used for 7 days (Docker
 * passes `until` to BuildKit as the time to keep a record after its last use).
 */
export const BUILD_CACHE_UNUSED_FILTER = '168h';
/** The most entries of each map of the record; a longer map is cut (the newest times stay). */
export const MAX_CLEANUP_ENTRIES = 500;

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** The record of the cleanup (CLEANUP_FILE). Times in ms on the clock of the engine's host. */
export interface CleanupState {
  /**
   * Helper tag (`devspaces-worker:<hash>`) → the last time that a running container used its image, or the time when the
   * Monitor first saw the tag (a grace period for a tag of another version).
   */
  helperTags: Record<string, number>;
  /** Image ID → the last time that it was the direct base image of a helper image (directBaseIds). */
  helperBases: Record<string, number>;
}

/** The record in `text`; an empty record for a missing, invalid or foreign text. Entries that are not valid are left out. */
export function parseCleanupState(text: string | undefined): CleanupState {
  let value: unknown;
  try {
    value = text === undefined ? undefined : JSON.parse(text);
  } catch {
    value = undefined;
  }
  const record = isRecord(value) ? value : {};
  return {
    helperTags: timesOf(record.helperTags, isHelperImageTag),
    helperBases: timesOf(record.helperBases, (key) => IMAGE_ID.test(key)),
  };
}

/** The text of the record (JSON), each map cut at MAX_CLEANUP_ENTRIES. */
export function cleanupStateText(state: CleanupState): string {
  return JSON.stringify({ helperTags: newest(state.helperTags), helperBases: newest(state.helperBases) });
}

function timesOf(value: unknown, validKey: (key: string) => boolean): Record<string, number> {
  const times: Record<string, number> = {};
  if (!isRecord(value)) return times;
  for (const [key, time] of Object.entries(value)) {
    if (validKey(key) && typeof time === 'number' && Number.isSafeInteger(time) && time >= 0) times[key] = time;
  }
  return newest(times);
}

/** The MAX_CLEANUP_ENTRIES entries with the newest times. */
function newest(times: Record<string, number>): Record<string, number> {
  const entries = Object.entries(times);
  if (entries.length <= MAX_CLEANUP_ENTRIES) return { ...times };
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_CLEANUP_ENTRIES));
}

/** An image of the engine as the cleanup reads it: its ID and its tags `repository:tag`. */
export interface TaggedImage {
  id: string;
  tags: readonly string[];
}

/**
 * The times of the helper tags after a look at the engine: a tag of an image that a running container uses (`usedIds`)
 * gets `now`; a tag that the record does not know gets `now` (its grace period starts); a recorded time later than `now`
 * (the clock went back) becomes `now`. A tag that is on no image anymore leaves the record.
 */
export function observedHelperTags(recorded: Readonly<Record<string, number>>, helperImages: readonly TaggedImage[], usedIds: ReadonlySet<string>, now: number): Record<string, number> {
  const times: Record<string, number> = {};
  for (const image of helperImages) {
    for (const tag of image.tags.filter(isHelperImageTag)) {
      const before = recorded[tag];
      times[tag] = usedIds.has(image.id) || before === undefined || before > now ? now : before;
    }
  }
  return times;
}

/** The helper tags that no running container used for HELPER_TAG_UNUSED_MS, never `ownTag` (the helper tag of the Monitor). */
export function unusedHelperTags(times: Readonly<Record<string, number>>, ownTag: string | undefined, now: number): string[] {
  return Object.entries(times)
    .filter(([tag, time]) => tag !== ownTag && now - time >= HELPER_TAG_UNUSED_MS)
    .map(([tag]) => tag)
    .sort();
}

/** The helper tag of a monitor tag (`devspaces-monitor:<hash>` → `devspaces-worker:<hash>`). */
export function helperTagOfMonitorTag(monitorTag: string): string {
  return `devspaces-worker:${monitorTag.slice('devspaces-monitor:'.length)}`;
}

/**
 * The monitor tags whose helper tag is not on the same image: a rebuild moved the helper tag to its new build, or the
 * helper tag was removed. A monitor tag is only the name of the image of the Monitor container.
 */
export function staleMonitorTags(images: readonly TaggedImage[]): string[] {
  const stale: string[] = [];
  for (const image of images) {
    for (const tag of image.tags.filter(isMonitorImageTag)) {
      if (!image.tags.includes(helperTagOfMonitorTag(tag))) stale.push(tag);
    }
  }
  return stale.sort();
}

/** True when `layers` starts with all of `base` and has more layers. */
function startsWith(layers: readonly string[], base: readonly string[]): boolean {
  return layers.length > base.length && base.every((layer, index) => layers[index] === layer);
}

/**
 * The IDs of the direct base images of the helper images: for each helper image, the images (not helper images) with
 * the most layers whose layers its layers start with. An image that a helper image is built on through another one
 * (`debian` under `node`) is not a direct base.
 */
export function directBaseIds(layersById: ReadonlyMap<string, readonly string[]>, helperIds: ReadonlySet<string>): Set<string> {
  const bases = new Set<string>();
  for (const helperId of helperIds) {
    const helper = layersById.get(helperId);
    if (helper === undefined) continue;
    let longest = 0;
    let found: string[] = [];
    for (const [id, layers] of layersById) {
      if (helperIds.has(id) || layers.length === 0 || !startsWith(helper, layers)) continue;
      if (layers.length > longest) {
        longest = layers.length;
        found = [id];
      } else if (layers.length === longest) {
        found.push(id);
      }
    }
    for (const id of found) bases.add(id);
  }
  return bases;
}

/** True when another image of `layersById` is built on the image `id` (its layers start with all layers of `id`). */
export function isBuiltOn(id: string, layersById: ReadonlyMap<string, readonly string[]>): boolean {
  const own = layersById.get(id);
  if (own === undefined) return false;
  for (const [other, layers] of layersById) {
    if (other !== id && startsWith(layers, own)) return true;
  }
  return false;
}
