// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reader of the shared volumes of Devspaces on a host, for the reports of the view Docker Hosts (docs/requirements.md
// R-ENG-008): what the store of VS Code (devspaces-vscode), the volume of the Monitor (devspaces-monitor) and the cache
// of the workers (devspaces-worker-cache) contain. One short-lived container reads them: a helper image that is already
// on the host (never a pull), no network, the volumes read-only, a read-only root file system, only the capability to
// read every file (DAC_READ_SEARCH), no log, and removed when it ends. It runs one fixed Node.js script
// (VOLUME_READER_SCRIPT) as an argument, so that the shared shell of the host carries it like the other calls of the
// view (isVolumeReaderCall). The script only reads, within limits of entries, time and output, and prints one JSON
// object, which parseVolumeReading checks. No `vscode`.
import { randomBytes } from 'crypto';
import type { BootstrapDocker } from '../docker/bootstrapDocker';
import { errorMessage } from '../errors';
import { readableStderr } from '../loader/pipeLoader';
import { isHelperImageTag, isMonitorImageTag } from '../helper/helperState';
import { isAbortError } from '../ports';
import { isRecord } from '../valueChecks';

/** The folder of the container under which the volumes are mounted (the argument of the script). */
export const READER_ROOT = '/devspaces';

/** The volumes that the reader reads, by their folder under READER_ROOT. */
export const READER_VOLUMES = ['vscode', 'monitor', 'worker-cache'] as const;
export type ReaderVolume = (typeof READER_VOLUMES)[number];

/** The names of the volumes to mount (only those that exist on the host: a mount would create a missing one). */
export type ReaderVolumeNames = Partial<Record<ReaderVolume, string>>;

/** The time limit of one run of the reader (its script stops after READER_TIME_MS). */
export const READER_TIMEOUT_MS = 2 * 60_000;
/**
 * The time after which the script takes no more steps (the sizes and lists are then marked as incomplete): short,
 * because the run waits on the shared shell of the host, where the other calls of the view and the takeover of the shell
 * by a connection of the relay wait behind it.
 */
export const READER_TIME_MS = 10_000;
/** The most steps of the script: a name read from a folder, an lstat, or a text. */
export const READER_MAX_STEPS = 1_000_000;
/** The largest file whose text the script prints. */
export const READER_MAX_FILE = 1024 * 1024;
/** The most text of files that the script prints. */
export const READER_MAX_TEXTS = 6 * 1024 * 1024;
/**
 * The most bytes of the output of the script; a longer one is printed without the texts of the files (the shared shell
 * takes at most MAX_SHELL_COMMAND_OUTPUT, 16 MiB).
 */
export const READER_MAX_OUTPUT = 12 * 1024 * 1024;
/** The most names of a folder in a list (servers, markers, extension files, files of the Monitor). */
export const READER_MAX_ROWS = 5000;
/** The most entries of the top level of the cache of the workers. */
export const READER_MAX_TOP = 500;

/** The protocol of the output, its field `reader`. */
export const READER_PROTOCOL = 1;

/**
 * The script of the reader, for `node -e <code> <root>`. Its text has a comment or one statement per line, uses only
 * double quotes and no template literal, so that VOLUME_READER_CODE can join it to one line (a line of the shared shell
 * carries no line break). It reads each folder of READER_VOLUMES under its root that exists, in this order: the Monitor
 * (small, and the most important), the store of VS Code, the cache of the workers:
 * - the Monitor: every file `*.json` at the top, in heartbeats/, extensions/ and extensions/wanted/ with its text (or
 *   why it was left out), and every file of worker-scripts/ (the texts of its records `*.json` only);
 * - the store of VS Code: the markers used/QUALITY-PLATFORM-COMMIT with their time and the files extensions/FOLDER/NAME first (they
 *   cost little), then each server folder server/QUALITY/PLATFORM/COMMIT with the version of its product.json, whether
 *   `node` and the script of its quality are there and its size; the sizes of tmp/ and extensions/tmp/ and the number of
 *   the locks;
 * - the cache of the workers: each entry of its top level with its kind, its time and its size.
 * It never follows a link: lstat, a folder is listed only when it is no link, and the texts are opened with O_NOFOLLOW
 * (and O_NONBLOCK, so that a FIFO cannot hold it). It reads a folder name by name (opendir), so that a huge folder
 * cannot hold it either. A size is the sum of the sizes of the files (as Docker counts the size of a volume: a file with
 * several hard links once); `cut` says that a list or a walk stopped at a limit or found an entry that it could not read
 * (a folder that it could not list, or a name that is no UTF-8), so the numbers are at least those. Each step (a name
 * read from a folder, an lstat, a text) counts against READER_MAX_STEPS and READER_TIME_MS; `stopped` says that one of
 * them was reached. `unreadable` counts the folders that could not be listed.
 */
export const VOLUME_READER_SCRIPT = String.raw`
"use strict";
const fs = require("fs");
const path = require("path");
const root = process.argv[1];
const LIMITS = { steps: ${READER_MAX_STEPS}, ms: ${READER_TIME_MS}, file: ${READER_MAX_FILE}, texts: ${READER_MAX_TEXTS}, output: ${READER_MAX_OUTPUT}, rows: ${READER_MAX_ROWS}, top: ${READER_MAX_TOP} };
const started = Date.now();
let steps = 0;
let texts = 0;
let unreadable = 0;
let stopped = false;
// One more step; false once a limit is reached (the time is read every 100 steps).
function spend() { if (stopped) { return false; } steps++; if (steps > LIMITS.steps || (steps % 100 === 0 && Date.now() - started > LIMITS.ms)) { stopped = true; } return !stopped; }
function lstat(file) { if (!spend()) { return undefined; } try { return fs.lstatSync(file); } catch { return undefined; } }
// The names in a folder, sorted, at most "max" of them, read name by name: "cut" when it stopped before the end or could
// not read the folder. None when it is no folder (also a link to one: no walk follows a link). "checked": the caller has
// seen with lstat that it is a folder.
function list(dir, checked, max) {
  const result = { names: [], cut: false };
  if (!checked) { const stat = lstat(dir); if (stat === undefined || !stat.isDirectory()) { result.cut = stopped; return result; } }
  let handle;
  try {
    handle = fs.opendirSync(dir);
    while (true) {
      if (!spend()) { result.cut = true; break; }
      const entry = handle.readSync();
      if (entry === null) { break; }
      if (result.names.length >= max) { result.cut = true; break; }
      result.names.push(entry.name);
    }
  } catch { unreadable++; result.cut = true; } finally { if (handle !== undefined) { try { handle.closeSync(); } catch {} } }
  result.names.sort();
  return result;
}
function isFile(file) { const stat = lstat(file); return stat !== undefined && stat.isFile(); }
// The size of a folder. A file with several hard links counts once in it (as Docker counts a volume; its device and
// inode as bigint, which a number cannot hold exactly); an entry that lstat cannot read (a name that is no UTF-8, or one
// that went meanwhile) makes the size incomplete.
function usage(dir) {
  const result = { bytes: 0, files: 0, cut: false };
  const linked = new Set();
  const stack = [[dir, false]];
  while (stack.length > 0) {
    if (stopped) { result.cut = true; break; }
    const [current, checked] = stack.pop();
    const listed = list(current, checked, Infinity);
    if (listed.cut) { result.cut = true; }
    for (const name of listed.names) {
      const file = path.join(current, name);
      const stat = lstat(file);
      if (stat === undefined) { result.cut = true; if (stopped) { break; } continue; }
      if (stat.isDirectory()) { stack.push([file, true]); continue; }
      if (stat.nlink > 1) { let key; try { const exact = fs.lstatSync(file, { bigint: true }); key = exact.dev + ":" + exact.ino; } catch { key = file; } if (linked.has(key)) { continue; } linked.add(key); }
      result.bytes += stat.size;
      result.files++;
    }
  }
  return result;
}
// The text of a regular file: { text }, or { omitted } with the reason: "size" (over LIMITS.file), "budget" (over the
// rest of LIMITS.texts, when "counted"), "time" (a limit was reached), "error" (it could not be read).
function text(file, counted) {
  if (!spend()) { return { omitted: "time" }; }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) { return { omitted: "error" }; }
    if (stat.size > LIMITS.file) { return { omitted: "size" }; }
    if (counted && texts + stat.size > LIMITS.texts) { return { omitted: "budget" }; }
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < stat.size) { const n = fs.readSync(fd, buffer, length, stat.size - length, length); if (n === 0) { break; } length += n; }
    if (counted) { texts += length; }
    return { text: buffer.toString("utf8", 0, length) };
  } catch { return { omitted: "error" }; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
function monitor(dir) {
  const files = [];
  let cut = false;
  function add(relative, read) {
    if (files.length >= LIMITS.rows) { cut = true; return; }
    const stat = lstat(path.join(dir, relative));
    if (stat === undefined) { cut = true; return; }
    if (!stat.isFile()) { return; }
    const entry = { path: relative, bytes: stat.size, modifiedAt: stat.mtimeMs };
    if (read) { const content = text(path.join(dir, relative), true); if (content.text !== undefined) { entry.text = content.text; } else { entry.omitted = content.omitted; } }
    files.push(entry);
  }
  function folder(relative, checked, read) {
    const listed = list(relative === "" ? dir : path.join(dir, relative), checked, LIMITS.rows);
    if (listed.cut) { cut = true; }
    for (const name of listed.names) { if (read(name)) { add(relative === "" ? name : relative + "/" + name, name.endsWith(".json")); } }
  }
  const isJson = (name) => name.endsWith(".json");
  folder("", true, isJson);
  folder("heartbeats", false, isJson);
  folder("extensions", false, isJson);
  folder("extensions/wanted", false, isJson);
  folder("worker-scripts", false, () => true);
  return { files, cut };
}
function vscode(dir) {
  let cut = false;
  const listed = (relative) => { const result = list(path.join(dir, relative), false, LIMITS.rows); if (result.cut) { cut = true; } return result.names; };
  const used = [];
  for (const name of listed("used")) {
    const stat = lstat(path.join(dir, "used", name));
    if (stat === undefined) { cut = true; continue; }
    if (stat.isFile()) { used.push({ name, at: stat.mtimeMs }); }
  }
  const extensions = [];
  for (const folder of ["universal", "linux-x64", "linux-arm64"]) {
    if (extensions.length >= LIMITS.rows || stopped) { cut = true; break; }
    for (const name of listed(path.join("extensions", folder))) {
      if (extensions.length >= LIMITS.rows) { cut = true; break; }
      const stat = lstat(path.join(dir, "extensions", folder, name));
      if (stat === undefined) { cut = true; continue; }
      if (stat.isFile()) { extensions.push({ folder, name, bytes: stat.size, modifiedAt: stat.mtimeMs }); }
    }
  }
  const servers = [];
  for (const quality of listed("server")) {
    if (servers.length >= LIMITS.rows || stopped) { cut = true; break; }
    for (const platform of listed(path.join("server", quality))) {
      if (servers.length >= LIMITS.rows || stopped) { cut = true; break; }
      for (const commit of listed(path.join("server", quality, platform))) {
        if (servers.length >= LIMITS.rows || stopped) { cut = true; break; }
        const folder = path.join(dir, "server", quality, platform, commit);
        const stat = lstat(folder);
        if (stat === undefined) { cut = true; continue; }
        if (!stat.isDirectory()) { continue; }
        let version;
        try { version = JSON.parse(text(path.join(folder, "product.json"), false).text).version; } catch {}
        const script = quality === "insider" ? "code-server-insiders" : "code-server";
        servers.push({ quality, platform, commit, version: typeof version === "string" ? version : undefined, modifiedAt: stat.mtimeMs, node: isFile(path.join(folder, "node")), script: isFile(path.join(folder, "bin", script)), usage: usage(folder) });
      }
    }
  }
  const locks = list(path.join(dir, "locks"), false, Infinity);
  return { servers, used, extensions, temporary: usage(path.join(dir, "tmp")), extensionTemporary: usage(path.join(dir, "extensions", "tmp")), locks: locks.names.length, cut: cut || locks.cut };
}
function cache(dir) {
  const listed = list(dir, true, LIMITS.top);
  const rows = [];
  let more = listed.cut;
  for (const name of listed.names) {
    const file = path.join(dir, name);
    const stat = lstat(file);
    if (stat === undefined) { more = true; continue; }
    const kind = stat.isDirectory() ? "folder" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "link" : "other";
    rows.push({ name, kind, modifiedAt: stat.mtimeMs, usage: kind === "folder" ? usage(file) : { bytes: stat.size, files: 1, cut: false } });
  }
  return { entries: rows, more };
}
// Whether a volume is mounted: not a step, so that a volume after a limit is still named (with its lists cut).
function isFolder(file) { try { return fs.lstatSync(file).isDirectory(); } catch { return false; } }
const out = { reader: ${READER_PROTOCOL} };
if (isFolder(path.join(root, "monitor"))) { out.monitor = monitor(path.join(root, "monitor")); }
if (isFolder(path.join(root, "vscode"))) { out.vscode = vscode(path.join(root, "vscode")); }
if (isFolder(path.join(root, "worker-cache"))) { out.workerCache = cache(path.join(root, "worker-cache")); }
out.stopped = stopped;
out.unreadable = unreadable;
let json = JSON.stringify(out);
if (Buffer.byteLength(json) > LIMITS.output && out.monitor !== undefined) { for (const file of out.monitor.files) { if (file.text !== undefined) { delete file.text; file.omitted = "output"; } } out.monitor.textsDropped = true; json = JSON.stringify(out); }
if (Buffer.byteLength(json) > LIMITS.output) { json = JSON.stringify({ reader: out.reader, stopped, unreadable, tooLong: true }); }
process.stdout.write(json);
`;

/** VOLUME_READER_SCRIPT on one line, without its comments: the argument of `node -e`. */
export const VOLUME_READER_CODE = VOLUME_READER_SCRIPT.split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('//'))
  .join(' ');

/** The name of a container of the reader: `devspaces-reader-` and 8 hexadecimal digits. */
const READER_NAME = /^devspaces-reader-[0-9a-f]{8}$/;

/** A new name for a container of the reader. */
export function newReaderName(): string {
  return `devspaces-reader-${randomBytes(4).toString('hex')}`;
}

/** A name of a volume as Docker accepts it (and that cannot hold a comma of the value of `--mount`). */
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** An image reference without a space, a comma or a leading `-`. */
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

/**
 * The arguments of `docker` for one run of the reader with `image` on `volumes`, named `name` (newReaderName). Throws
 * for a name, an image or a volume name that the call cannot carry.
 */
export function volumeReaderArgs(image: string, volumes: ReaderVolumeNames, name: string): string[] {
  if (!READER_NAME.test(name)) throw new Error(`${JSON.stringify(name)} is no name of a container of the reader.`);
  if (!IMAGE_REFERENCE.test(image)) throw new Error(`${JSON.stringify(image)} is no image reference that the reader can use.`);
  const mounts: string[] = [];
  for (const volume of READER_VOLUMES) {
    const source = volumes[volume];
    if (source === undefined) continue;
    if (!VOLUME_NAME.test(source)) throw new Error(`${JSON.stringify(source)} is no name of a volume.`);
    mounts.push('--mount', `type=volume,source=${source},target=${READER_ROOT}/${volume},readonly`);
  }
  return [
    'run',
    '--rm',
    '--name',
    name,
    '--pull',
    'never',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'DAC_READ_SEARCH',
    '--security-opt',
    'no-new-privileges',
    '--log-driver',
    'none',
    ...mounts,
    '--entrypoint',
    'node',
    image,
    '-e',
    VOLUME_READER_CODE,
    READER_ROOT,
  ];
}

/** The value of a `--mount` of volumeReaderArgs: the volume, and its folder under READER_ROOT. */
const MOUNT_ARGUMENT = new RegExp(`^type=volume,source=([^,]*),target=${READER_ROOT.replace(/[.*+?^$()|[\]\\/{}]/g, '\\$&')}/([a-z-]+),readonly$`);

/**
 * Whether `args` are a call of volumeReaderArgs, exactly: the shared shell of a host runs it (isSharedShellCall), as
 * the other calls of the view Docker Hosts, because it needs nothing of this computer (no file, no input).
 */
export function isVolumeReaderCall(args: readonly string[]): boolean {
  if (args[0] !== 'run' || args[2] !== '--name' || args[args.length - 1] !== READER_ROOT) return false;
  const name = args[3] ?? '';
  const image = args[args.indexOf('--entrypoint') + 2] ?? '';
  const volumes: ReaderVolumeNames = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '--mount') continue;
    const match = MOUNT_ARGUMENT.exec(args[i + 1]);
    const volume = READER_VOLUMES.find((candidate) => candidate === match?.[2]);
    if (match === null || volume === undefined || volumes[volume] !== undefined) return false;
    volumes[volume] = match[1];
  }
  try {
    const expected = volumeReaderArgs(image, volumes, name);
    return expected.length === args.length && expected.every((arg, i) => arg === args[i]);
  } catch {
    return false;
  }
}

/** The size of a folder: the sum of the sizes of its files; `cut` when the walk stopped at a limit (at least these). */
export interface TreeUsage {
  bytes: number;
  files: number;
  cut: boolean;
}

/** A server folder of the store of VS Code (server/QUALITY/PLATFORM/COMMIT). */
export interface StoredServer {
  quality: string;
  platform: string;
  commit: string;
  /** The version of its product.json (for example 1.141.0), when it could be read. */
  version?: string;
  /** The time of the folder (the end of its download: the download renames its folder into place). */
  modifiedAt?: number;
  /** Whether its `node` is there. */
  node: boolean;
  /** Whether the script of its quality is there (bin/code-server, for Insiders bin/code-server-insiders). */
  script: boolean;
  usage: TreeUsage;
}

/** A file of the extensions of the store (extensions/FOLDER/NAME). */
export interface StoredExtensionFile {
  folder: string;
  name: string;
  bytes: number;
  modifiedAt?: number;
}

/** What the store of VS Code (devspaces-vscode) contains. */
export interface VscodeStoreReading {
  servers: StoredServer[];
  /** The markers of the use of a server version by an open (used/QUALITY-PLATFORM-COMMIT, serverVersionName) and their time. */
  used: { name: string; at?: number }[];
  extensions: StoredExtensionFile[];
  /** The temporary folders of the downloads of servers (tmp/). */
  temporary: TreeUsage;
  /** The temporary files of the downloads of extensions (extensions/tmp/). */
  extensionTemporary: TreeUsage;
  /** The number of the lock files (locks/). */
  locks: number;
  /** A list stopped at READER_MAX_ROWS. */
  cut: boolean;
}

/** A file of the volume of the Monitor, by its path in the volume (for example `heartbeats/NAME.json`). */
export interface MonitorFile {
  path: string;
  bytes: number;
  modifiedAt?: number;
  /** Its text, when it is a record that the reader reads and it fits the limits. */
  text?: string;
  /** Why the text of a record is not there (MonitorTextOmitted). */
  omitted?: MonitorTextOmitted;
}

/**
 * Why the reader left out the text of a record: `size` larger than READER_MAX_FILE, `budget` over the rest of
 * READER_MAX_TEXTS, `time` a limit of the entries or of the time was reached, `output` the output would have been too
 * long, `error` it could not be read.
 */
export type MonitorTextOmitted = 'size' | 'budget' | 'time' | 'output' | 'error';
const TEXT_OMITTED: readonly MonitorTextOmitted[] = ['size', 'budget', 'time', 'output', 'error'];

/** What the volume of the Monitor (devspaces-monitor) contains. */
export interface MonitorStateReading {
  files: MonitorFile[];
  /** The list stopped at READER_MAX_ROWS. */
  cut: boolean;
  /** The output was too long, and the texts were left out. */
  textsDropped: boolean;
}

/** An entry of the top level of the cache of the workers. */
export interface CacheEntry {
  name: string;
  kind: 'folder' | 'file' | 'link' | 'other';
  modifiedAt?: number;
  usage: TreeUsage;
}

/** What the cache of the workers (devspaces-worker-cache) contains. */
export interface WorkerCacheReading {
  entries: CacheEntry[];
  /** It has more entries than these (more than READER_MAX_TOP, or the reader stopped at a limit). */
  more: boolean;
}

/** What the reader read: each volume that was mounted and could be read. */
export interface VolumeReading {
  monitor?: MonitorStateReading;
  vscode?: VscodeStoreReading;
  workerCache?: WorkerCacheReading;
  /** A limit of the entries or of the time was reached: some sizes and lists are incomplete. */
  stopped: boolean;
  /** The number of the folders that could not be listed. */
  unreadable: number;
  /** The output would have been too long even without the texts: it holds nothing of the volumes. */
  tooLong: boolean;
}

/** The longest name or path that the parse keeps. */
const MAX_NAME_LENGTH = 1024;

function nameOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= MAX_NAME_LENGTH ? value : undefined;
}

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, READER_MAX_ROWS) : [];
}

function parseUsage(value: unknown): TreeUsage {
  if (!isRecord(value)) return { bytes: 0, files: 0, cut: true };
  const bytes = countOf(value.bytes);
  const files = countOf(value.files);
  return { bytes: bytes ?? 0, files: files ?? 0, cut: value.cut === true || bytes === undefined || files === undefined };
}

/** A path of a file of the Monitor as the script names it: a name at the top, or in one of its folders, without `..`. */
const MONITOR_PATH = /^(?:(?:heartbeats|extensions|extensions\/wanted|worker-scripts)\/)?[^/]+$/;

function parseMonitor(value: unknown): MonitorStateReading | undefined {
  if (!isRecord(value)) return undefined;
  const files: MonitorFile[] = [];
  for (const entry of rows(value.files)) {
    if (!isRecord(entry)) continue;
    const path = nameOf(entry.path);
    const bytes = countOf(entry.bytes);
    if (path === undefined || !MONITOR_PATH.test(path) || path.split('/').includes('..') || bytes === undefined) continue;
    const modifiedAt = timeOf(entry.modifiedAt);
    const omitted = TEXT_OMITTED.find((reason) => reason === entry.omitted);
    files.push({
      path,
      bytes,
      ...(modifiedAt !== undefined ? { modifiedAt } : {}),
      ...(typeof entry.text === 'string' ? { text: entry.text } : omitted !== undefined ? { omitted } : {}),
    });
  }
  return { files, cut: value.cut === true, textsDropped: value.textsDropped === true };
}

function parseVscode(value: unknown): VscodeStoreReading | undefined {
  if (!isRecord(value)) return undefined;
  const servers: StoredServer[] = [];
  for (const entry of rows(value.servers)) {
    if (!isRecord(entry)) continue;
    const quality = nameOf(entry.quality);
    const platform = nameOf(entry.platform);
    const commit = nameOf(entry.commit);
    if (quality === undefined || platform === undefined || commit === undefined) continue;
    const version = typeof entry.version === 'string' && entry.version.length <= 64 ? entry.version : undefined;
    const modifiedAt = timeOf(entry.modifiedAt);
    servers.push({
      quality,
      platform,
      commit,
      ...(version !== undefined ? { version } : {}),
      ...(modifiedAt !== undefined ? { modifiedAt } : {}),
      node: entry.node === true,
      script: entry.script === true,
      usage: parseUsage(entry.usage),
    });
  }
  const used: VscodeStoreReading['used'] = [];
  for (const entry of rows(value.used)) {
    if (!isRecord(entry)) continue;
    const name = nameOf(entry.name);
    if (name === undefined) continue;
    const at = timeOf(entry.at);
    used.push({ name, ...(at !== undefined ? { at } : {}) });
  }
  const extensions: StoredExtensionFile[] = [];
  for (const entry of rows(value.extensions)) {
    if (!isRecord(entry)) continue;
    const folder = nameOf(entry.folder);
    const name = nameOf(entry.name);
    const bytes = countOf(entry.bytes);
    if (folder === undefined || name === undefined || bytes === undefined) continue;
    const modifiedAt = timeOf(entry.modifiedAt);
    extensions.push({ folder, name, bytes, ...(modifiedAt !== undefined ? { modifiedAt } : {}) });
  }
  return {
    servers,
    used,
    extensions,
    temporary: parseUsage(value.temporary),
    extensionTemporary: parseUsage(value.extensionTemporary),
    locks: countOf(value.locks) ?? 0,
    cut: value.cut === true,
  };
}

const CACHE_KINDS: readonly CacheEntry['kind'][] = ['folder', 'file', 'link', 'other'];

function parseWorkerCache(value: unknown): WorkerCacheReading | undefined {
  if (!isRecord(value)) return undefined;
  const entries: CacheEntry[] = [];
  for (const entry of rows(value.entries)) {
    if (!isRecord(entry)) continue;
    const name = nameOf(entry.name);
    const kind = CACHE_KINDS.find((candidate) => candidate === entry.kind);
    if (name === undefined || kind === undefined) continue;
    const modifiedAt = timeOf(entry.modifiedAt);
    entries.push({ name, kind, ...(modifiedAt !== undefined ? { modifiedAt } : {}), usage: parseUsage(entry.usage) });
  }
  return { entries, more: value.more === true };
}

/** The output of the script (VOLUME_READER_SCRIPT), checked; undefined for anything else (also another protocol). */
export function parseVolumeReading(text: string): VolumeReading | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.reader !== READER_PROTOCOL) return undefined;
  const monitor = parseMonitor(value.monitor);
  const vscode = parseVscode(value.vscode);
  const workerCache = parseWorkerCache(value.workerCache);
  return {
    ...(monitor !== undefined ? { monitor } : {}),
    ...(vscode !== undefined ? { vscode } : {}),
    ...(workerCache !== undefined ? { workerCache } : {}),
    stopped: value.stopped === true,
    unreadable: countOf(value.unreadable) ?? 0,
    tooLong: value.tooLong === true,
  };
}

/**
 * The images that may run the reader on a host, best first: `current` (the helper tag of this version of Devspaces)
 * when the host has it, then the other tags of helper images and of images of the Monitor there (each an image of the
 * Dockerfile of the helper, so with Node.js), one tag of each image (the tags of one hash), at most 3 in all. `tags` are
 * the tags of the images of the host.
 */
export function readerImages(tags: readonly string[], current: string | undefined): string[] {
  const usable = tags.filter((tag) => isHelperImageTag(tag) || isMonitorImageTag(tag));
  const ordered = current !== undefined && usable.includes(current) ? [current, ...usable.filter((tag) => tag !== current)] : usable;
  // The tags of one hash name one image (the Monitor runs from the helper image under a tag of its own).
  const hashes = new Set<string>();
  return ordered.filter((tag) => {
    const hash = tag.slice(tag.indexOf(':') + 1);
    if (hashes.has(hash)) return false;
    hashes.add(hash);
    return true;
  }).slice(0, 3);
}

/** The outcome of readSharedVolumes. */
export type VolumeReadOutcome =
  | { kind: 'read'; reading: VolumeReading; image: string }
  /** No image of `images` is on the host (anymore). */
  | { kind: 'noImage' }
  /** No volume to read. */
  | { kind: 'noVolume' }
  | { kind: 'failed'; detail: string };

export interface VolumeReadInput {
  /** The images to try in this order (readerImages). */
  images: readonly string[];
  /** The volumes to mount: only those that exist on the host. */
  volumes: ReaderVolumeNames;
  signal?: AbortSignal;
  /** Only for the tests: the name of the container. */
  name?: () => string;
}

/** The end of an error output that a failure keeps. */
const DETAIL_LENGTH = 2000;

/** The failure of a Docker CLI before 20.10 (on the host, or of this computer), which has no `--pull` (the reader never pulls). */
export const OLD_CLI_DETAIL = 'The Docker CLI that ran the reader is older than 20.10: it has no option --pull, which the reader needs so that it never pulls an image.';

/**
 * One read of the shared volumes on the host of the current operation (within an operation on that host, as the other
 * calls of the view Docker Hosts): the reader with the first image of `images` that the host has. An image that went
 * since the inventory (Docker: no such image) gives the next one. Throws only an AbortError (and the errors of a Docker
 * CLI that cannot run).
 */
export async function readSharedVolumes(docker: Pick<BootstrapDocker, 'run'>, input: VolumeReadInput): Promise<VolumeReadOutcome> {
  if (!READER_VOLUMES.some((volume) => input.volumes[volume] !== undefined)) return { kind: 'noVolume' };
  for (const image of input.images) {
    const args = volumeReaderArgs(image, input.volumes, (input.name ?? newReaderName)());
    const result = await docker.run(args, { timeoutMs: READER_TIMEOUT_MS, ...(input.signal !== undefined ? { signal: input.signal } : {}) });
    if (result.timedOut) return { kind: 'failed', detail: `The reader did not end within ${READER_TIMEOUT_MS / 1000} s.` };
    if (result.exitCode === 0) {
      const reading = parseVolumeReading(result.stdout);
      return reading !== undefined ? { kind: 'read', reading, image } : { kind: 'failed', detail: 'The output of the reader could not be read.' };
    }
    if (/no such image/i.test(result.stderr)) continue;
    if (/unknown flag: --pull/.test(result.stderr)) return { kind: 'failed', detail: OLD_CLI_DETAIL };
    const detail = readableStderr(result.stderr.slice(-DETAIL_LENGTH), DETAIL_LENGTH);
    return { kind: 'failed', detail: detail !== '' ? detail : `The reader ended with exit code ${String(result.exitCode)}.` };
  }
  return { kind: 'noImage' };
}

/** readSharedVolumes, with a failure of the call itself (not an AbortError) as `failed`. */
export async function readSharedVolumesSafely(docker: Pick<BootstrapDocker, 'run'>, input: VolumeReadInput): Promise<VolumeReadOutcome> {
  try {
    return await readSharedVolumes(docker, input);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { kind: 'failed', detail: errorMessage(error) };
  }
}
