// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Show Log of a worker on the view Docker Hosts (docs/requirements.md R-ENG-008, R-ENG-010): Docker keeps no log of a
// worker (its log driver is `none`), so the worker writes a log of its own into the volume of the Monitor
// (src/core/helperChannel/protocol.ts "The log of a worker"). The read: the inspect of the worker's container (its image
// and the volume at LOCK_STATE_DIR), then one short-lived container of the worker's own image, which is on the host,
// with the same limits as the reader of the shared volumes (volumeReader.ts): never a pull, no network, the volume
// read-only, a read-only root file system, only the capability to read every file (DAC_READ_SEARCH), no log, removed at
// its end. It runs one fixed Node.js script (WORKER_LOG_READER_SCRIPT) with the short ID of the worker, which prints the
// last CONTAINER_LOG_LINES lines of `<ID>.log.1` and `<ID>.log`; the shared shell of the host carries exactly this call
// (isWorkerLogReaderCall). The read itself is readWorkerLog (workerLogRead.ts). No `vscode`.
import { WORKER_LOG_FOLDER } from '../helperChannel/protocol';
import { CONTAINER_LOG_LINES } from './monitorLog';
import { IMAGE_ID, READER_NAME, VOLUME_NAME, oneLineScript, readerRunArgs, regExpLiteral } from './volumeReader';

/** The folder of the container at which the volume of the Monitor is mounted (read-only). */
export const WORKER_LOG_READER_ROOT = '/devspaces/monitor';
/** The time limit of one run of the reader of a worker log. */
export const WORKER_LOG_READER_TIMEOUT_MS = 60_000;
/** The most bytes that the script reads of each file (a log becomes `.1` at 1 MiB; the last entry may go beyond). */
export const WORKER_LOG_READ_BYTES = 2 * 1024 * 1024;
/** The exit code of the script when the worker has no log (neither file). */
export const NO_WORKER_LOG_EXIT = 3;

/**
 * The script, for `node -e <code> <root> <short ID>`. Its text has a comment or one statement per line, uses only double
 * quotes and no template literal, so that WORKER_LOG_READER_CODE can join it to one line (a line of the shared shell
 * carries no line break). It opens each file with O_NOFOLLOW and O_NONBLOCK, reads at most WORKER_LOG_READ_BYTES of its
 * end, and prints the last lines of both files together (the older part first); without either file it exits with
 * NO_WORKER_LOG_EXIT.
 */
export const WORKER_LOG_READER_SCRIPT = String.raw`
"use strict";
const fs = require("fs");
const path = require("path");
const folder = path.join(process.argv[1], "${WORKER_LOG_FOLDER}");
const id = process.argv[2];
if (!/^[0-9a-f]{12}$/.test(id)) { process.exit(2); }
// The end of a regular file, at most the limit of bytes; undefined when it is missing, no regular file, or unreadable.
function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) { return undefined; }
    const length = Math.min(stat.size, ${WORKER_LOG_READ_BYTES});
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) { const n = fs.readSync(fd, buffer, done, length - done, stat.size - length + done); if (n === 0) { break; } done += n; }
    return buffer.toString("utf8", 0, done);
  } catch { return undefined; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}
const older = tail(path.join(folder, id + ".log.1"));
const current = tail(path.join(folder, id + ".log"));
if (older === undefined && current === undefined) { process.exit(${NO_WORKER_LOG_EXIT}); }
const lines = ((older === undefined ? "" : older) + (current === undefined ? "" : current)).split("\n");
if (lines[lines.length - 1] === "") { lines.pop(); }
process.stdout.write(lines.slice(-${CONTAINER_LOG_LINES}).join("\n"));
`;

/** WORKER_LOG_READER_SCRIPT on one line, without its comments: the argument of `node -e`. */
export const WORKER_LOG_READER_CODE = oneLineScript(WORKER_LOG_READER_SCRIPT);

/** The short ID of a container. */
const SHORT_ID = /^[0-9a-f]{12}$/;

/**
 * The arguments of `docker` for one run of the reader of the log of the worker `id` (its short ID), with the worker's
 * image `image` (its ID) on the volume of the Monitor `volume`, named `name` (newReaderName). Throws for a value that
 * the call cannot carry.
 */
export function workerLogReaderArgs(p: { image: string; volume: string; id: string; name: string }): string[] {
  if (!READER_NAME.test(p.name)) throw new Error(`${JSON.stringify(p.name)} is no name of a container of the reader.`);
  if (!IMAGE_ID.test(p.image)) throw new Error(`${JSON.stringify(p.image)} is no ID of an image.`);
  if (!VOLUME_NAME.test(p.volume)) throw new Error(`${JSON.stringify(p.volume)} is no name of a volume.`);
  if (!SHORT_ID.test(p.id)) throw new Error(`${JSON.stringify(p.id)} is no short ID of a container.`);
  return [
    ...readerRunArgs(p.name),
    '--mount',
    `type=volume,source=${p.volume},target=${WORKER_LOG_READER_ROOT},readonly`,
    '--entrypoint',
    'node',
    p.image,
    '-e',
    WORKER_LOG_READER_CODE,
    WORKER_LOG_READER_ROOT,
    p.id,
  ];
}

/** The value of the `--mount` of workerLogReaderArgs. */
const MOUNT_ARGUMENT = new RegExp(`^type=volume,source=([^,]*),target=${regExpLiteral(WORKER_LOG_READER_ROOT)},readonly$`);

/**
 * Whether `args` are a call of workerLogReaderArgs, exactly: the shared shell of a host runs it (isSharedShellCall), as
 * the other reads of the view Docker Hosts, because it needs nothing of this computer.
 */
export function isWorkerLogReaderCall(args: readonly string[]): boolean {
  if (args.length !== 26 || args[0] !== 'run' || args[2] !== '--name' || args[17] !== '--mount') return false;
  const volume = MOUNT_ARGUMENT.exec(args[18] ?? '')?.[1];
  if (volume === undefined) return false;
  try {
    const expected = workerLogReaderArgs({ image: args[21] ?? '', volume, id: args[25] ?? '', name: args[3] ?? '' });
    return expected.length === args.length && expected.every((arg, i) => arg === args[i]);
  } catch {
    return false;
  }
}

/** The worker has no log: an earlier version of Devspaces started it, or its log could not be written. */
export class NoWorkerLogError extends Error {
  constructor(container: string) {
    super(`The worker ${container} has no log in the volume of the Monitor.`);
    this.name = 'NoWorkerLogError';
  }
}
