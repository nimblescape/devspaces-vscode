// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Show Files of a volume or an image of the view Docker Hosts (docs/requirements.md R-ENG-008, R-ENG-010): the tree of
// its folders and files, with their names, sizes and times, never the content of a file. Only while the setting
// devspaces.allowContentReads is on (default off), for every volume and image. One short-lived container reads it,
// with the limits of the reader of the shared volumes (volumeReader.ts): a helper image of Devspaces that is on the host,
// never a pull, no network, a read-only root file system, only the capability to read every file (DAC_READ_SEARCH), no
// log, removed at its end. The volume is mounted read-only; an image with `--mount type=image` (read-only; Docker Engine
// 28 or newer, and a Docker CLI that knows the type). It runs one fixed Node.js script (CONTENT_READER_SCRIPT), which
// walks the mount with lstat (it never follows a link and never opens a file) within its limits, and prints the tree
// as JSON. The shared shell of the host carries exactly this call (isContentReaderCall). The text of the document is
// contentTreeText. No `vscode`.
import { formatSize } from './hostObjects';
import { countText, dateAndTime } from './reportModel';
import { IMAGE_ID, READER_NAME, VOLUME_NAME, regExpLiteral } from './volumeReader';

/** The folder of the container at which the volume or the image is mounted (read-only). */
export const CONTENT_READER_ROOT = '/devspaces/content';
/** The time limit of one run of the reader. */
export const CONTENT_READER_TIMEOUT_MS = 90_000;
/**
 * The limits of the script: entries that it looks at, entries that it keeps for the tree, levels that the tree shows,
 * folders that it walks into, its time, and the bytes of its output for the kept entries (each counted with its name,
 * its link target and CONTENT_ENTRY_BYTES), so that the output stays far below the limit of the shared shell
 * (MAX_SHELL_COMMAND_OUTPUT, 16 MiB) also with long names.
 */
export const CONTENT_READER_LIMITS = { entries: 200_000, kept: 20_000, levels: 5, depth: 64, ms: 60_000, bytes: 8_000_000 } as const;
/** The bytes of the output of one kept entry besides its name and its link target (its other fields). */
const CONTENT_ENTRY_BYTES = 120;

/** What Show Files reads: a volume by its name, or an image by its ID. */
export type ContentTarget = { kind: 'volume'; name: string } | { kind: 'image'; id: string };

/**
 * The script, for `node -e <code> <root>`. Its text has a comment or one statement per line, uses only double quotes and
 * no template literal, so that CONTENT_READER_CODE can join it to one line (a line of the shared shell carries no line
 * break). One entry of its output: `n` its name, `t` its type (`d` folder, `f` file, `l` link, `o` other), `s` its bytes
 * (of a folder the sum of its files), `m` its time of the last change; a link also `l` its target; a folder also `f` its
 * files and `d` its folders (all levels), `c` its kept entries (up to the level limit), `x` the entries that are left out
 * of `c`, and `e` 1 when it could not be read, 2 when it is deeper than the walk goes.
 */
export const CONTENT_READER_SCRIPT = String.raw`
"use strict";
const fs = require("fs");
const path = require("path");
const root = process.argv[1];
const limits = { entries: ${CONTENT_READER_LIMITS.entries}, kept: ${CONTENT_READER_LIMITS.kept}, levels: ${CONTENT_READER_LIMITS.levels}, depth: ${CONTENT_READER_LIMITS.depth}, ms: ${CONTENT_READER_LIMITS.ms}, bytes: ${CONTENT_READER_LIMITS.bytes}, entry: ${CONTENT_ENTRY_BYTES} };
const started = Date.now();
let entries = 0;
let kept = 0;
let bytes = 0;
let stopped = false;
// One entry from its lstat: the link itself, never its target.
function entry(name, stat) {
  const type = stat.isDirectory() ? "d" : stat.isFile() ? "f" : stat.isSymbolicLink() ? "l" : "o";
  return { n: name, t: type, s: stat.isFile() ? stat.size : 0, m: Math.round(stat.mtimeMs) };
}
// The entries of the folder dir into node, its totals of all levels, and its kept entries up to the level limit.
function walk(dir, node, depth) {
  node.f = 0;
  node.d = 0;
  node.c = [];
  node.x = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { node.e = 1; return; }
  for (const name of names) {
    if (!stopped && (entries >= limits.entries || Date.now() - started > limits.ms)) { stopped = true; }
    if (stopped) { node.x += 1; continue; }
    entries += 1;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.lstatSync(full); } catch { node.x += 1; continue; }
    const child = entry(name, stat);
    if (child.t === "l") { try { child.l = fs.readlinkSync(full).slice(0, 300); } catch {} }
    // The bytes of the entry in the output: its name and its link target as JSON, and its other fields.
    const cost = JSON.stringify(name).length + (child.l === undefined ? 0 : JSON.stringify(child.l).length) + limits.entry;
    const keep = depth < limits.levels && kept < limits.kept && bytes + cost <= limits.bytes;
    if (keep) { kept += 1; bytes += cost; }
    if (child.t === "d") {
      if (depth < limits.depth) { walk(full, child, depth + 1); } else { child.f = 0; child.d = 0; child.e = 2; }
      node.d += 1 + child.d;
      node.f += child.f;
    } else if (child.t === "f") { node.f += 1; }
    node.s += child.s;
    if (keep) { node.c.push(child); } else { node.x += 1; }
  }
}
const tree = entry("", fs.lstatSync(root));
walk(root, tree, 0);
process.stdout.write(JSON.stringify({ reader: 1, stopped: stopped, entries: entries, tree: tree }));
`;

/** CONTENT_READER_SCRIPT on one line, without its comments: the argument of `node -e`. */
export const CONTENT_READER_CODE = CONTENT_READER_SCRIPT.split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('//'))
  .join(' ');

/** A helper image of Devspaces (readerImages). */
const HELPER_IMAGE = /^devspaces-(?:worker|monitor):[0-9a-f]{12}$/;

/** The value of the `--mount` of the target. */
function targetMount(target: ContentTarget): string {
  return target.kind === 'volume' ? `type=volume,source=${target.name},target=${CONTENT_READER_ROOT},readonly` : `type=image,source=${target.id},target=${CONTENT_READER_ROOT},readonly`;
}

/** The target of Show Files of a volume (by its name) or an image (by its full ID); undefined for any other object. */
export function contentTargetOf(object: { kind: string; id: string; name: string }): ContentTarget | undefined {
  const target: ContentTarget | undefined = object.kind === 'volume' ? { kind: 'volume', name: object.name } : object.kind === 'image' ? { kind: 'image', id: object.id } : undefined;
  return target !== undefined && isContentTarget(target) ? target : undefined;
}

/** Whether `target` is a value that the call can carry: a volume name, or the full ID of an image. */
export function isContentTarget(target: ContentTarget): boolean {
  return target.kind === 'volume' ? VOLUME_NAME.test(target.name) : IMAGE_ID.test(target.id);
}

/**
 * The arguments of `docker` for one run of the reader of `target`, with the helper image `image`, named `name`
 * (newReaderName). Throws for a value that the call cannot carry.
 */
export function contentReaderArgs(p: { image: string; target: ContentTarget; name: string }): string[] {
  if (!READER_NAME.test(p.name)) throw new Error(`${JSON.stringify(p.name)} is no name of a container of the reader.`);
  if (!HELPER_IMAGE.test(p.image)) throw new Error(`${JSON.stringify(p.image)} is no helper image of Devspaces.`);
  if (!isContentTarget(p.target)) throw new Error(`${JSON.stringify(p.target)} is no volume name or image ID that the reader can mount.`);
  return [
    'run',
    '--rm',
    '--name',
    p.name,
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
    '--mount',
    targetMount(p.target),
    '--entrypoint',
    'node',
    p.image,
    '-e',
    CONTENT_READER_CODE,
    CONTENT_READER_ROOT,
  ];
}

/** The target of a value of `--mount` of contentReaderArgs. */
const MOUNT_ARGUMENT = new RegExp(`^type=(volume|image),source=([^,]*),target=${regExpLiteral(CONTENT_READER_ROOT)},readonly$`);

/**
 * Whether `args` are a call of contentReaderArgs, exactly: the shared shell of a host runs it (isSharedShellCall), as the
 * other reads of the view Docker Hosts, because it needs nothing of this computer.
 */
export function isContentReaderCall(args: readonly string[]): boolean {
  if (args.length !== 25 || args[0] !== 'run' || args[2] !== '--name' || args[17] !== '--mount') return false;
  const mount = MOUNT_ARGUMENT.exec(args[18] ?? '');
  if (mount === null) return false;
  const target: ContentTarget = mount[1] === 'volume' ? { kind: 'volume', name: mount[2] } : { kind: 'image', id: mount[2] };
  try {
    const expected = contentReaderArgs({ image: args[21] ?? '', target, name: args[3] ?? '' });
    return expected.length === args.length && expected.every((arg, i) => arg === args[i]);
  } catch {
    return false;
  }
}

/** One entry of the tree (the output of the script, checked). */
export interface ContentEntry {
  name: string;
  type: 'folder' | 'file' | 'link' | 'other';
  /** Its bytes; of a folder the sum of the bytes of its files (all levels). */
  bytes: number;
  /** The time of its last change, in milliseconds. */
  modified: number;
  /** The target of a link. */
  link?: string;
  /** Of a folder: its files and folders of all levels. */
  files?: number;
  folders?: number;
  /** Of a folder: its kept entries (up to the level limit). */
  entries?: ContentEntry[];
  /** Of a folder: the entries that are left out of `entries`. */
  leftOut?: number;
  /** Of a folder: it could not be read (`unreadable`), or it is deeper than the walk goes (`deep`). */
  problem?: 'unreadable' | 'deep';
}

export interface ContentTree {
  /** The walk stopped at a limit: the totals are lower bounds. */
  stopped: boolean;
  /** The entries that the walk looked at. */
  seen: number;
  root: ContentEntry;
}

const TYPES: Record<string, ContentEntry['type']> = { d: 'folder', f: 'file', l: 'link', o: 'other' };

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** One entry of the output, or undefined when it does not have the form of the script. */
function parseEntry(value: unknown, depth: number): ContentEntry | undefined {
  if (typeof value !== 'object' || value === null || depth > CONTENT_READER_LIMITS.levels + 1) return undefined;
  const raw = value as Record<string, unknown>;
  const type = typeof raw.t === 'string' ? TYPES[raw.t] : undefined;
  const bytes = count(raw.s);
  const modified = typeof raw.m === 'number' && Number.isFinite(raw.m) ? raw.m : undefined;
  if (typeof raw.n !== 'string' || type === undefined || bytes === undefined || modified === undefined) return undefined;
  const entry: ContentEntry = { name: raw.n, type, bytes, modified };
  if (type === 'link' && typeof raw.l === 'string') entry.link = raw.l;
  if (type === 'folder') {
    const files = count(raw.f);
    const folders = count(raw.d);
    if (files !== undefined) entry.files = files;
    if (folders !== undefined) entry.folders = folders;
    const leftOut = count(raw.x);
    if (leftOut !== undefined && leftOut > 0) entry.leftOut = leftOut;
    if (raw.e === 1) entry.problem = 'unreadable';
    if (raw.e === 2) entry.problem = 'deep';
    if (Array.isArray(raw.c)) {
      const children: ContentEntry[] = [];
      for (const child of raw.c) {
        const parsed = parseEntry(child, depth + 1);
        if (parsed === undefined) return undefined;
        children.push(parsed);
      }
      entry.entries = children;
    }
  }
  return entry;
}

/** The tree of the output of the script, or undefined when the output does not have its form. */
export function parseContentTree(stdout: string): ContentTree | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const seen = count(raw.entries);
  if (raw.reader !== 1 || typeof raw.stopped !== 'boolean' || seen === undefined) return undefined;
  const root = parseEntry(raw.tree, 0);
  return root === undefined || root.type !== 'folder' ? undefined : { stopped: raw.stopped, seen, root };
}

/** A name as one line of text: control characters and the characters that turn the direction of a text become `?`. */
function shownName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '?');
}

/** The time of an entry as `2026-11-14 08:00` in `timeZone`. */
function shownTime(at: number, timeZone: string): string {
  const { date, time } = dateAndTime(at, timeZone);
  return `${date} ${time}`;
}

/** The order of the entries of a folder: the folders first, then the others, each by name. */
function ordered(entries: readonly ContentEntry[]): ContentEntry[] {
  const rank = (entry: ContentEntry) => (entry.type === 'folder' ? 0 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The line of one entry: its name (a folder with `/`, a link with its target), its size, its files, and its time. */
function entryLine(entry: ContentEntry, indent: string, timeZone: string, complete: boolean): string {
  const name = entry.type === 'folder' ? `${shownName(entry.name)}/` : entry.type === 'link' ? `${shownName(entry.name)} -> ${shownName(entry.link ?? '?')}` : shownName(entry.name);
  const parts = [`${indent}${name}`];
  if (entry.type === 'folder') {
    parts.push(`${complete ? '' : 'at least '}${formatSize(entry.bytes)}`, countText(entry.files ?? 0, 'file'));
    if (entry.problem === 'unreadable') parts.push('could not be read');
    if (entry.problem === 'deep') parts.push('too deep to read');
  } else if (entry.type === 'file') {
    parts.push(formatSize(entry.bytes));
  } else if (entry.type === 'other') {
    parts.push('a special file');
  }
  parts.push(shownTime(entry.modified, timeZone));
  return parts.join(' · ');
}

/** The lines of the entries of `folder` below its own line, `level` levels deep. */
function folderLines(folder: ContentEntry, level: number, timeZone: string, complete: boolean, lines: string[]): void {
  const indent = '  '.repeat(level);
  for (const entry of ordered(folder.entries ?? [])) {
    lines.push(entryLine(entry, indent, timeZone, complete));
    if (entry.type === 'folder') folderLines(entry, level + 1, timeZone, complete, lines);
  }
  // A folder at the level limit shows only its totals (its entries are at `level`, deeper than the levels of the
  // tree). Any other folder says how many of its entries are left out: at the limits of the entries or of the output,
  // which an earlier, larger folder can use up, also when it kept none of them.
  const atLevelLimit = level > CONTENT_READER_LIMITS.levels;
  if (folder.leftOut !== undefined && ((folder.entries?.length ?? 0) > 0 || !atLevelLimit)) lines.push(`${indent}… ${countText(folder.leftOut, 'more entry', 'more entries')}`);
}

export interface ContentTreeTextInput {
  /** `volume devspaces-vscode` or `image nginx:1.27`, as the header names it. */
  subject: string;
  host: string;
  /** When it was read. */
  at: number;
  timeZone: string;
}

/** The text of the document of Show Files: a header, then one line per entry, indented by its level. */
export function contentTreeText(tree: ContentTree, input: ContentTreeTextInput): string {
  const { root } = tree;
  const complete = !tree.stopped;
  const lines = [
    `Files of the ${input.subject} on ${input.host}`,
    `Read ${shownTime(input.at, input.timeZone)} · ${complete ? '' : 'at least '}${countText(root.files ?? 0, 'file')} in ${countText(root.folders ?? 0, 'folder')} · ${complete ? '' : 'at least '}${formatSize(root.bytes)} (the sizes of the files)`,
    `Only the names, sizes and times are read, never the content of a file. Folders deeper than ${CONTENT_READER_LIMITS.levels} levels show only their totals.`,
  ];
  if (tree.stopped) lines.push(`The read stopped at its limit (${CONTENT_READER_LIMITS.entries} entries or ${CONTENT_READER_LIMITS.ms / 1000} s): the totals are lower, and entries are left out.`);
  lines.push('', entryLine({ ...root, name: '' }, '', input.timeZone, complete));
  folderLines(root, 1, input.timeZone, complete, lines);
  return `${lines.join('\n')}\n`;
}
