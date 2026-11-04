// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The record of the check of the workspace helper image on an engine (docs/requirements.md R-DS-003): the Monitor
// checks the base image of its own helper tag in each background run and builds the tag again when the base image
// changed (src/remoteMonitor/helperRefresh.ts). It keeps the result in its volume (HELPER_CHECK_FILE). The worker reads
// it there for the answer of a heartbeat (HeartbeatValue.helperCheck), and the window takes it into its own state of
// the helper image (recordEngineHelperCheck), so that it does not check the base image itself while the Monitor did,
// and an open does not build the image again. The record is freshness data, not a security input: whoever can write
// the volume has the socket of the engine and its images anyway. It is still read strictly (its size, its shape, each
// field); anything else is no record. No `vscode`.
import * as fs from 'fs';
import * as path from 'path';
import { isHelperImageTag } from '../helper/helperState';
import { hasOnlyKeys, isRecord } from '../valueChecks';

/** The file of the record in the volume of the Monitor (REMOTE_MONITOR_STATE_DIR; LOCK_STATE_DIR in the worker). */
export const HELPER_CHECK_FILE = 'helper-image.json';
/** The largest file of the record, in bytes (a larger file is no record). */
export const MAX_HELPER_CHECK_FILE_BYTES = 4096;
/** The longest base image reference of a record (the Docker reference grammar allows 255 for the name, plus the tag). */
const MAX_BASE_IMAGE_LENGTH = 512;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
/** A reference of an image: printable ASCII without spaces. */
const REFERENCE = /^[\x21-\x7e]+$/;

/**
 * What the Monitor recorded about its helper tag. `checkedAt`: the last check that found the image of the tag built
 * from the current base image (`baseDigest`, the registry digest of `baseImage` at that time), either at once or after
 * the rebuild of that run. `attemptedAt`: the last run whose check got no digest, or whose rebuild failed (the image of
 * the tag stayed as it was). `builtAt`: the last rebuild of the Monitor. Times are ISO 8601.
 */
export interface EngineHelperRecord {
  tag: string;
  baseImage: string;
  baseDigest?: string;
  checkedAt?: string;
  attemptedAt?: string;
  builtAt?: string;
}

/**
 * The part of the record that a window takes (the answer of a heartbeat): a check that found the image of `tag` built
 * from the base image `baseImage` with the digest `baseDigest`, at `checkedAt`.
 */
export interface HelperCheck {
  tag: string;
  baseImage: string;
  baseDigest: string;
  checkedAt: string;
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function isBaseImage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_BASE_IMAGE_LENGTH && REFERENCE.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

/** The strict check of a record (the file of the Monitor): undefined for anything else. */
export function parseEngineHelperRecord(value: unknown): EngineHelperRecord | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tag', 'baseImage'], ['baseDigest', 'checkedAt', 'attemptedAt', 'builtAt'])) return undefined;
  const { tag, baseImage, baseDigest, checkedAt, attemptedAt, builtAt } = value;
  if (typeof tag !== 'string' || !isHelperImageTag(tag) || !isBaseImage(baseImage)) return undefined;
  if (baseDigest !== undefined && !isDigest(baseDigest)) return undefined;
  if (![checkedAt, attemptedAt, builtAt].every((time) => time === undefined || isTime(time))) return undefined;
  return {
    tag,
    baseImage,
    ...(baseDigest !== undefined ? { baseDigest } : {}),
    ...(checkedAt !== undefined ? { checkedAt: checkedAt as string } : {}),
    ...(attemptedAt !== undefined ? { attemptedAt: attemptedAt as string } : {}),
    ...(builtAt !== undefined ? { builtAt: builtAt as string } : {}),
  };
}

/** The strict check of a HelperCheck (both sides of the heartbeat): undefined for anything else. */
export function parseHelperCheck(value: unknown): HelperCheck | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tag', 'baseImage', 'baseDigest', 'checkedAt'])) return undefined;
  const { tag, baseImage, baseDigest, checkedAt } = value;
  if (typeof tag !== 'string' || !isHelperImageTag(tag) || !isBaseImage(baseImage) || !isDigest(baseDigest) || !isTime(checkedAt)) return undefined;
  return { tag, baseImage, baseDigest, checkedAt };
}

/** The check that a window takes from a record: only one that found the image current (with its digest). */
export function helperCheckOf(record: EngineHelperRecord | undefined): HelperCheck | undefined {
  if (record?.baseDigest === undefined || record.checkedAt === undefined) return undefined;
  return { tag: record.tag, baseImage: record.baseImage, baseDigest: record.baseDigest, checkedAt: record.checkedAt };
}

/** The record as the text of its file. */
export function engineHelperRecordText(record: EngineHelperRecord): string {
  return JSON.stringify(record);
}

/** The record of the text of its file; undefined for a text that is too long or not a valid record. */
export function parseEngineHelperRecordText(text: string): EngineHelperRecord | undefined {
  if (text.length > MAX_HELPER_CHECK_FILE_BYTES) return undefined;
  try {
    return parseEngineHelperRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * The record in the volume folder `stateDir` (the worker's LOCK_STATE_DIR): a plain file (never through a link:
 * O_NOFOLLOW) of at most MAX_HELPER_CHECK_FILE_BYTES. Undefined when there is none or it is not valid. Never throws.
 */
export function readEngineHelperRecord(stateDir: string): EngineHelperRecord | undefined {
  let fd: number | undefined;
  try {
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    fd = fs.openSync(path.posix.join(stateDir, HELPER_CHECK_FILE), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_HELPER_CHECK_FILE_BYTES) return undefined;
    return parseEngineHelperRecordText(fs.readFileSync(fd, 'utf8'));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
