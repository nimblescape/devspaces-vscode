// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The two small files of a prepare next to its prepare lock in the volume of the Monitor (the lock folder,
// 0700, which no dev container mounts): the stop request of a Delete (prepareStopFilePath, empty) and the hash of the
// prepare that the time limit stopped or whose build failed (prepareStoppedFilePath). Each is a plain file of its own
// (never through a link: O_NOFOLLOW), 0600, named by a storage ID only (isStorageId). Worker only.
import * as fs from 'fs';
import { prepareStopFilePath, prepareStoppedFilePath } from '../core/helperChannel/protocol';
import { readPlain, writePlain } from '../core/helperChannel/lockFile';
import { isStorageId } from '../core/storage/paths';

/** The files of a prepare (see the module comment), a seam for the tests (LockDeps.prepareFiles). */
export interface PrepareFiles {
  /** Writes the stop request of `devspaceId` (a Delete). Throws when it cannot. */
  requestStop(stateDir: string, devspaceId: string): void;
  /** Whether a stop request of `devspaceId` is there (a plain file). Never throws (false). */
  stopRequested(stateDir: string, devspaceId: string): boolean;
  /** Removes the stop request of `devspaceId`, if any. Never throws. */
  removeStop(stateDir: string, devspaceId: string): void;
  /**
   * The hash that the time limit stopped (or whose build failed) for `devspaceId`, if any (prepareKeyHash). Never
   * throws.
   */
  readStopped(stateDir: string, devspaceId: string): string | undefined;
  /** Records `hash` as stopped by the time limit for `devspaceId`. Throws when it cannot. */
  writeStopped(stateDir: string, devspaceId: string, hash: string): void;
}

/** The form of a hash of prepareKeyHash. */
const KEY_HASH = /^sha256:[0-9a-f]{64}$/;

function checkedId(devspaceId: string): string {
  if (!isStorageId(devspaceId)) throw new Error('The devspace ID of the prepare is invalid.');
  return devspaceId;
}

/** The files of a prepare in the lock folder (see the module comment). */
export const PREPARE_FILES: PrepareFiles = {
  requestStop: (stateDir, devspaceId) => writePlain(stateDir, prepareStopFilePath(checkedId(devspaceId), stateDir), ''),
  stopRequested: (stateDir, devspaceId) => {
    try {
      return fs.lstatSync(prepareStopFilePath(checkedId(devspaceId), stateDir)).isFile();
    } catch {
      return false;
    }
  },
  removeStop: (stateDir, devspaceId) => {
    try {
      fs.rmSync(prepareStopFilePath(checkedId(devspaceId), stateDir), { force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  },
  readStopped: (stateDir, devspaceId) => {
    if (!isStorageId(devspaceId)) return undefined;
    const text = readPlain(prepareStoppedFilePath(devspaceId, stateDir), 128)?.trim();
    return text !== undefined && KEY_HASH.test(text) ? text : undefined;
  },
  writeStopped: (stateDir, devspaceId, hash) => {
    if (!KEY_HASH.test(hash)) throw new Error('The hash of the prepare is invalid.');
    writePlain(stateDir, prepareStoppedFilePath(checkedId(devspaceId), stateDir), `${hash}\n`);
  },
};
