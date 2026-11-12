// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The worker's script in the volume of the Monitor (the Monitor triggers the prepare), so that the
// monitor runs the headless prepare (the worker operation `prepare`) with the worker of the same extension version,
// without a computer. The worker that ensures the monitor stores its own script (storeWorkerScript) at
// `<volume>/worker-scripts/<sha256>.js` and gives the monitor container that it creates the hash in
// MONITOR_WORKER_HASH_ENV; the monitor reads exactly that file (readWorkerScript: a plain file whose sha256 is that
// hash) and starts it with the pipe loader, which checks the hash again. So a monitor runs only the worker script of
// the worker that created it. The worker script is also the script of the Monitor (one bundle), so the worker stores
// beside it `<sha256>.json` with the version of Devspaces of the script and the helper tag of that worker
// (WorkerScriptRecord), and a monitor of an earlier version moves itself to the script of the newest version
// (readWorkerScriptRecords; src/remoteMonitor/selfUpgrade.ts; docs/requirements.md R-DS-011). The folder holds nothing
// else of value: the monitor removes the scripts and records of other hashes after a day (removeOtherWorkerScripts),
// and a worker of that version stores its own again at its next ensure. Like every file of the volume, it is no defence
// against someone who already has the Docker socket of the engine. No `vscode`.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isHelperImageTag } from '../helper/helperState';
import { isDevspacesVersion } from '../http';
import { MAX_BUNDLE_LINE_LENGTH, bundleHash } from '../loader/pipeLoader';
import { isRecord } from '../valueChecks';

/** The variable of the monitor container with the sha256 of the worker script that its prepares run (64 hex digits). */
export const MONITOR_WORKER_HASH_ENV = 'DEVSPACE_WORKER_HASH';
/** The folder of the worker scripts in the volume of the Monitor (0700). */
export const WORKER_SCRIPT_FOLDER = 'worker-scripts';
/** The largest worker script that is stored or read (the pipe loader takes no longer line either). */
export const MAX_WORKER_SCRIPT_BYTES = MAX_BUNDLE_LINE_LENGTH;
/** A script of another hash whose file is older than this is removed by the monitor (removeOtherWorkerScripts). */
export const WORKER_SCRIPT_MAX_AGE_MS = 24 * 60 * 60_000;

/** The largest record of a worker script that is read (a version and a helper tag). */
const MAX_RECORD_BYTES = 4096;

const HASH = /^[0-9a-f]{64}$/;
const SCRIPT_NAME = /^([0-9a-f]{64})\.(?:js|json)$/;
const RECORD_NAME = /^([0-9a-f]{64})\.json$/;
const TEMPORARY_NAME = /^[0-9a-f]{64}\.(?:js|json)\.[0-9a-f]{12}\.tmp$/;

/**
 * The record of a worker script (`<sha256>.json` beside it): the version of Devspaces of the script (x.y.z) and the
 * helper tag of the worker that stored it (`devspaces-worker:<12 hex digits>`, the image that a monitor of that script
 * runs from).
 */
export interface WorkerScriptRecord {
  version: string;
  helperTag: string;
}

/** A record of a worker script in the volume (readWorkerScriptRecords): its hash, and the time of its file. */
export interface StoredWorkerScriptRecord extends WorkerScriptRecord {
  hash: string;
  mtimeMs: number;
}

/** The record of a JSON text (WorkerScriptRecord); keys that it does not know are left out; undefined for anything else. */
export function parseWorkerScriptRecord(text: string): WorkerScriptRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isDevspacesVersion(value.version) || typeof value.helperTag !== 'string' || !isHelperImageTag(value.helperTag)) return undefined;
  return { version: value.version, helperTag: value.helperTag };
}

/** Whether `value` is the hash of a worker script (64 lower-case hex digits). */
export function isWorkerScriptHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}

/** The file of the worker script with the hash `hash` under the volume folder `stateDir`. */
export function workerScriptPath(stateDir: string, hash: string): string {
  if (!isWorkerScriptHash(hash)) throw new Error('The hash of the worker script is invalid.');
  return path.posix.join(stateDir, WORKER_SCRIPT_FOLDER, `${hash}.js`);
}

/** The folder of the worker scripts: created with 0700 when it is missing, never a symbolic link. */
function scriptFolder(stateDir: string): string {
  const folder = path.posix.join(stateDir, WORKER_SCRIPT_FOLDER);
  try {
    fs.mkdirSync(folder, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory()) throw new Error(`${folder} is not a folder.`);
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(folder, 0o700);
  return folder;
}

/**
 * The text of the plain file `file` (never through a link: O_NOFOLLOW), when it is at most `maxBytes`; undefined for
 * anything else. Never throws.
 */
function readPlain(file: string, maxBytes = MAX_WORKER_SCRIPT_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The files (`<stateDir>\0<hash>`) that this process stored or found current already. */
const stored = new Set<string>();

/**
 * Worker side: stores `script` (the worker's own) under its hash, unless the file is there with that content already
 * (checked once per process); written atomically (a temporary file of its own, then a rename), 0600. With `record`, its
 * record `<hash>.json` too, after the script, in the same way (WorkerScriptRecord: the version of Devspaces and the
 * helper tag of the worker; R-DS-011). Returns the hash. Throws when it cannot store them.
 */
export function storeWorkerScript(stateDir: string, script: string, record?: WorkerScriptRecord): string {
  if (record !== undefined && (!isDevspacesVersion(record.version) || !isHelperImageTag(record.helperTag))) throw new Error('The record of the worker script is invalid.');
  const hash = bundleHash(script);
  const bytes = Buffer.byteLength(script, 'utf8');
  if (bytes > MAX_WORKER_SCRIPT_BYTES) throw new Error(`The worker script is too long (${bytes} bytes).`);
  const file = workerScriptPath(stateDir, hash);
  const key = `${stateDir}\0${hash}`;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && stat.size === bytes && (stored.has(key) || readPlain(file) === script)) {
      stored.add(key);
      if (record !== undefined) storeRecord(stateDir, hash, record);
      return hash;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  scriptFolder(stateDir);
  writeAtomically(file, script);
  stored.add(key);
  if (record !== undefined) storeRecord(stateDir, hash, record);
  return hash;
}

/** The records (`<stateDir>\0<hash>\0<record JSON>`) that this process stored or found current already. */
const storedRecords = new Set<string>();

/** Stores the record of the worker script `hash` (see storeWorkerScript), unless the file has that content already. */
function storeRecord(stateDir: string, hash: string, record: WorkerScriptRecord): void {
  const text = JSON.stringify({ version: record.version, helperTag: record.helperTag });
  const file = path.posix.join(stateDir, WORKER_SCRIPT_FOLDER, `${hash}.json`);
  const key = `${stateDir}\0${hash}\0${text}`;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && (storedRecords.has(key) || readPlain(file, MAX_RECORD_BYTES) === text)) {
      storedRecords.add(key);
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  scriptFolder(stateDir);
  writeAtomically(file, text);
  storedRecords.add(key);
}

/** Writes `text` to `file` atomically: a temporary file of its own (0600, never through a link), then a rename. */
function writeAtomically(file: string, text: string): void {
  // A name of its own (two workers of other containers may have the same process ID).
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fs.constants;
    const fd = fs.openSync(temporary, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, text, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Monitor side: the records of the worker scripts in the volume folder `stateDir` (`<sha256>.json`, plain files of at
 * most 4 KB, never through a link), each with its hash and the time of its file; invalid ones are left out. Whether the
 * script of a record is there is not checked here (readWorkerScript). Never throws.
 */
export function readWorkerScriptRecords(stateDir: string): StoredWorkerScriptRecord[] {
  const folder = path.posix.join(stateDir, WORKER_SCRIPT_FOLDER);
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const records: StoredWorkerScriptRecord[] = [];
  for (const name of names) {
    const match = RECORD_NAME.exec(name);
    if (match === null) continue;
    const file = path.posix.join(folder, name);
    const text = readPlain(file, MAX_RECORD_BYTES);
    const record = text === undefined ? undefined : parseWorkerScriptRecord(text);
    if (record === undefined) continue;
    try {
      records.push({ ...record, hash: match[1], mtimeMs: fs.lstatSync(file).mtimeMs });
    } catch {
      // Removed meanwhile.
    }
  }
  return records;
}

/**
 * Monitor side: the worker script with the hash `hash` from the volume folder `stateDir`: a plain file of at most
 * MAX_WORKER_SCRIPT_BYTES whose sha256 is `hash`; else why not (one sentence). Never throws.
 */
export function readWorkerScript(stateDir: string, hash: string): { script: string } | { reason: string } {
  if (!isWorkerScriptHash(hash)) return { reason: 'the hash of its worker script is invalid' };
  const script = readPlain(workerScriptPath(stateDir, hash));
  if (script === undefined) return { reason: `the worker script ${hash.slice(0, 12)} is not in the volume (the next open stores it)` };
  if (bundleHash(script) !== hash) return { reason: `the worker script ${hash.slice(0, 12)} in the volume does not match its hash (the next open stores it again)` };
  return { script };
}

/**
 * Monitor side: removes the worker scripts and their records of other hashes than `keep` whose files are older than
 * WORKER_SCRIPT_MAX_AGE_MS (another version of the extension stores its own again at its next ensure), and leftover
 * temporary files of a store older than that. Only plain files of those names, never a link; every failure is ignored.
 * Returns the names it removed.
 */
export function removeOtherWorkerScripts(stateDir: string, keep: string, now: number): string[] {
  const folder = path.posix.join(stateDir, WORKER_SCRIPT_FOLDER);
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return removed;
  }
  for (const name of names) {
    const script = SCRIPT_NAME.exec(name);
    if (script === null ? !TEMPORARY_NAME.test(name) : script[1] === keep) continue;
    const file = path.posix.join(folder, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || now - stat.mtimeMs <= WORKER_SCRIPT_MAX_AGE_MS) continue;
      fs.unlinkSync(file);
      removed.push(name);
    } catch {
      // Removed meanwhile, or not ours to remove.
    }
  }
  return removed;
}
