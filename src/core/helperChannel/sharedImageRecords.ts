// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The records of the shared images that a background prepare built (R-DS-010), shared by the worker (its prepare
// writes them, its opens and prepares read them) and the Monitor (it removes a record whose image is gone). One plain
// file per image key in the lock folder of the volume of the Monitor (lockFolder: 0700, which no dev container mounts,
// ensureLockFolder), named `<64 hexadecimal digits of the key>.shared-image`, that holds the ID of the image. Only the
// prepare writes one, after it built the image of the key from the approved configuration of a devspace (no
// Dockerfile, no Docker Compose: the extension computed the key from those inputs, it never takes a key from a label).
// So the record vouches for the image as a dev container with a build record of the key does (isSharedImage), before
// any container was created from it: the prepares of other devspaces with the same key tag it instead of a build. A
// prepare that tags a shared image for which only a dev container vouched records that image too, when the key has no
// record yet: Devspaces built it for the key as well, and the dev container may be gone by the open.
// Never through a link (O_NOFOLLOW); a record is written to a file of its own first (`<record>.tmp`; one prepare at a
// time per engine writes) and then renamed, so a reader never sees half of one. Only Node.js built-ins and pure
// modules.
import * as fs from 'fs';
import { isImageKey } from '../names';
import { lockFolder } from './protocol';
import { readPlain, writePlain } from './lockFile';

/** The end of the name of a record file. */
export const SHARED_IMAGE_RECORD_SUFFIX = '.shared-image';

/** The form of an image ID (`sha256:` and 64 hexadecimal digits). */
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** A record file name: the hexadecimal digits of the key and SHARED_IMAGE_RECORD_SUFFIX. */
const RECORD_NAME = new RegExp(`^([0-9a-f]{64})${SHARED_IMAGE_RECORD_SUFFIX.replace('.', '\\.')}$`);

/** The record file of the image key `key` (isImageKey) under `stateDir`. Throws for anything but a key. */
export function sharedImageRecordPath(key: string, stateDir: string): string {
  if (!isImageKey(key)) throw new Error('The image key of the record is invalid.');
  return `${lockFolder(stateDir)}/${key.slice('sha256:'.length)}${SHARED_IMAGE_RECORD_SUFFIX}`;
}

/** A record as the Monitor lists it: its key and the image ID it holds (`undefined` when its text is not one). */
export interface SharedImageRecord {
  key: string;
  imageId: string | undefined;
}

/** The records of the shared images that a prepare built (see the module comment), a seam for the tests. */
export interface SharedImageRecords {
  /** The ID of the image recorded for `key`, in lower case, or `undefined`. Never throws. */
  read(key: string): string | undefined;
  /** Records `imageId` as the image that a prepare built for `key`. Throws when it cannot. */
  write(key: string, imageId: string): void;
  /** Every record of the folder (by the names of its files). Never throws (none when the folder cannot be read). */
  list(): SharedImageRecord[];
  /** Removes the record of `key`, if any. Never throws. */
  remove(key: string): void;
}

/** The image ID of the text of a record, or `undefined`. */
function imageIdOf(text: string | undefined): string | undefined {
  const id = text?.trim().toLowerCase();
  return id !== undefined && IMAGE_ID.test(id) ? id : undefined;
}

/** The records of the shared images in the lock folder of `stateDir` (see the module comment). */
export function sharedImageRecords(stateDir: string): SharedImageRecords {
  return {
    read: (key) => {
      if (!isImageKey(key)) return undefined;
      return imageIdOf(readPlain(sharedImageRecordPath(key, stateDir), 128));
    },
    write: (key, imageId) => {
      const id = imageId.trim().toLowerCase();
      if (!IMAGE_ID.test(id)) throw new Error('The image ID of the record is invalid.');
      const file = sharedImageRecordPath(key, stateDir);
      // A file of its own (never through a link; one left by a write that ended early is written over), then renamed over
      // the record.
      const temporary = `${file}.tmp`;
      try {
        writePlain(stateDir, temporary, `${id}\n`);
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
      const records: SharedImageRecord[] = [];
      for (const name of names) {
        const match = RECORD_NAME.exec(name);
        if (match === null) continue;
        records.push({ key: `sha256:${match[1]}`, imageId: imageIdOf(readPlain(`${lockFolder(stateDir)}/${name}`, 128)) });
      }
      return records;
    },
    remove: (key) => {
      try {
        const file = sharedImageRecordPath(key, stateDir);
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}.tmp`, { force: true });
      } catch {
        // Gone already, or not a key.
      }
    },
  };
}
