// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The records of the devspaces whose devspace image the Monitor moved to a shared image (R-DS-010, imageMerge.ts of
// the Monitor), shared by the Monitor (it writes them, and removes those that no longer fit) and the worker (the open
// and the prepare read them). When the Monitor finds that the devspace image of a stopped devspace is really identical
// to a shared image, it removes the stopped dev container and the duplicate, and tags the shared image as the next
// devspace image of the devspace. A shared image carries no build record (only its key), and the dev container that
// carried the record is gone, so the Monitor writes the record here: the build record of the duplicate, for the new tag,
// with the ID of the shared image pinned and its key. The next open takes it (newestImageRecord) and creates the dev
// container from the shared image, without a build.
// One plain file per devspace in the lock folder of the volume of the Monitor (lockFolder: 0700, which no dev
// container mounts), named `<devspace ID>.merged-image`, that holds the JSON of a MergeRecord. Only the Monitor writes
// one, from the labels of the duplicate and of its devspace, under the lock of the devspace. Never through a link
// (O_NOFOLLOW); written to a file of its own first (`<record>.tmp`) and then renamed, so a reader never sees half of
// one. Only Node.js built-ins and pure modules.
import * as fs from 'fs';
import { MAX_BUILD_RECORD_LABEL_LENGTH } from '../names';
import { isBuildRecord } from '../storage/registry';
import { isStorageId } from '../storage/paths';
import type { BuildRecord } from '../types';
import { isRecord } from '../valueChecks';
import { lockFolder } from './protocol';
import { readPlain, writePlain } from './lockFile';

/** The end of the name of a merge record file. */
export const MERGE_RECORD_SUFFIX = '.merged-image';

/** The longest text of a merge record: a build record as long as its label may be, its owner and its pinned ID. */
const MAX_MERGE_RECORD_LENGTH = MAX_BUILD_RECORD_LABEL_LENGTH + 1024;

/** The form of an image ID (`sha256:` and 64 hexadecimal digits). */
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** A record of the move of a devspace image to a shared image (see the module comment). */
export interface MergeRecord {
  /** The GitHub user ID of the owner of the devspace (the label LABEL_OWNER_ID of the duplicate). */
  ownerId: string;
  /** The build record of the new devspace image: its tag, its build number, the pinned ID and the key of the shared image. */
  record: BuildRecord & { imageId: string; imageKey: string };
}

/** The records of the moves of devspace images to shared images (see the module comment), a seam for the tests. */
export interface MergeRecords {
  /** The record of the devspace `devspaceId`, or `undefined` (none, or not a valid one). Never throws. */
  read(devspaceId: string): MergeRecord | undefined;
  /** Writes the record of the devspace `devspaceId`. Throws when it cannot. */
  write(devspaceId: string, record: MergeRecord): void;
  /** The devspace IDs of every record of the folder (by the names of its files). Never throws (none when the folder cannot be read). */
  list(): string[];
  /** Removes the record of `devspaceId`, if any. Never throws. */
  remove(devspaceId: string): void;
}

/** The record file of the devspace `devspaceId` (isStorageId) under `stateDir`. Throws for anything but a storage ID. */
export function mergeRecordPath(devspaceId: string, stateDir: string): string {
  if (!isStorageId(devspaceId)) throw new Error('The devspace ID of the merge record is invalid.');
  return `${lockFolder(stateDir)}/${devspaceId}${MERGE_RECORD_SUFFIX}`;
}

/** Whether `value` is a MergeRecord: an owner ID, and a valid build record with an image ID and an image key. */
export function isMergeRecord(value: unknown): value is MergeRecord {
  if (!isRecord(value) || !isStorageId(value.ownerId)) return false;
  const record = value.record;
  return isBuildRecord(record) && typeof record.imageId === 'string' && IMAGE_ID.test(record.imageId) && record.imageKey !== undefined;
}

/** The records in the lock folder of `stateDir` (see the module comment). */
export function mergeRecords(stateDir: string): MergeRecords {
  return {
    read: (devspaceId) => {
      if (!isStorageId(devspaceId)) return undefined;
      const text = readPlain(mergeRecordPath(devspaceId, stateDir), MAX_MERGE_RECORD_LENGTH);
      if (text === undefined) return undefined;
      try {
        const value = JSON.parse(text) as unknown;
        return isMergeRecord(value) ? value : undefined;
      } catch {
        return undefined;
      }
    },
    write: (devspaceId, record) => {
      const text = `${JSON.stringify(record)}\n`;
      if (!isMergeRecord(record) || text.length > MAX_MERGE_RECORD_LENGTH) throw new Error('The merge record is invalid.');
      const file = mergeRecordPath(devspaceId, stateDir);
      // A file of its own (never through a link; one left by a write that ended early is written over), then renamed over
      // the record.
      const temporary = `${file}.tmp`;
      try {
        writePlain(stateDir, temporary, text);
        fs.renameSync(temporary, file);
      } catch (error) {
        try {
          fs.rmSync(temporary, { force: true });
        } catch {
          // The error of the write is the one to report.
        }
        throw error;
      }
    },
    list: () => {
      let names: string[];
      try {
        names = fs.readdirSync(lockFolder(stateDir));
      } catch {
        return [];
      }
      return names
        .filter((name) => name.endsWith(MERGE_RECORD_SUFFIX))
        .map((name) => name.slice(0, -MERGE_RECORD_SUFFIX.length))
        .filter((id) => isStorageId(id));
    },
    remove: (devspaceId) => {
      try {
        const file = mergeRecordPath(devspaceId, stateDir);
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}.tmp`, { force: true });
      } catch {
        // Gone already, or not a devspace ID.
      }
    },
  };
}
