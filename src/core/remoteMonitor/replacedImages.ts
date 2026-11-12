// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The records of the older image versions in the volume of the Monitor (docs/requirements.md R-DS-003): the IDs of the
// images that a pull replaced (REPLACED_IMAGES_FILE), and of those the IDs that the Monitor's own pull replaced
// (PULLED_OVER_IMAGES_FILE), each by repository. The Monitor writes them (src/remoteMonitor/images.ts); the reports of
// the view Docker Hosts read them (src/core/hosts/resourceReport.ts). Pure; no I/O.
import { isListedRepository } from './protocol';

/** The IDs of images that pulls replaced, in the volume. */
export const REPLACED_IMAGES_FILE = 'replaced-images.json';
/**
 * Of those, the IDs that the monitor's own pull replaced (ImageMaintenanceDeps.pulledOver of the Monitor), in the
 * volume, in the same form.
 */
export const PULLED_OVER_IMAGES_FILE = 'pulled-over-images.json';

/** Image IDs that a pull replaced, by repository. */
export type ReplacedImages = Record<string, string[]>;

/**
 * At most this many IDs are kept per repository; beyond it the IDs that are tagged now go first (the listing finds them
 * again), then the oldest untagged ones (trimReplaced of the Monitor).
 */
export const MAX_REPLACED_PER_REPOSITORY = 200;

const IMAGE_ID = /^[A-Za-z0-9:]{1,100}$/;

/** The stored replaced IDs; an empty record for anything invalid. */
export function parseReplacedImages(text: string): ReplacedImages {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const result: ReplacedImages = {};
    for (const [repository, ids] of Object.entries(value)) {
      // Any repository as the engine lists it (those of Docker Hub too, which a reference in use can name).
      if (isListedRepository(repository) && Array.isArray(ids)) result[repository] = ids.filter((id): id is string => typeof id === 'string' && IMAGE_ID.test(id)).slice(-MAX_REPLACED_PER_REPOSITORY);
    }
    return result;
  } catch {
    return {};
  }
}
