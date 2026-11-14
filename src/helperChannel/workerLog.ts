// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The log of a worker in the volume of the Monitor (src/core/helperChannel/protocol.ts "The log of a worker"): one line
// per entry, `<time in UTC as toISOString> <text>`, the further lines of a text indented by four spaces. The writes are
// synchronous (an entry is short) and never fail the worker: after a failure, the log writes nothing more. The file is
// opened with O_NOFOLLOW and must be a regular file, its folder must be a folder (no link). Loading the module does no
// I/O (entries.test.ts).
import * as fs from 'fs';
import * as path from 'path';
import { WORKER_LOG_MAX_BYTES } from '../core/helperChannel/protocol';

/** The name of a log of a worker, or of its older part, in its folder. */
const LOG_FILE = /^[0-9a-f]{12}\.log(\.1)?$/;

/** One entry of the log: its time in UTC, its text, and the further lines of the text indented. */
export function workerLogLine(at: number, text: string): string {
  return `${new Date(at).toISOString()} ${text.replace(/\r\n?|\n/g, '\n    ')}\n`;
}

/** The folder of the logs, created when it is missing (0700); throws when it is a link or no folder. */
function ensureFolder(folder: string): void {
  try {
    fs.mkdirSync(folder, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!fs.lstatSync(folder).isDirectory()) throw new Error(`${folder} is no folder.`);
}

export interface WorkerLogOptions {
  /** The folder of the logs (LOCK_STATE_DIR/WORKER_LOG_FOLDER). */
  folder: string;
  /** The name of the log (workerLogName). */
  name: string;
  now?: () => number;
  /** Only for the tests: a smaller size at which the log becomes `<name>.1`. */
  maxBytes?: number;
}

/**
 * The log of one worker process: it appends to the log of its container (a worker that the relay starts again goes on).
 * Several processes of one container (the workers of the streams of a relay) append to the same file; each line is
 * one write, and before it moves the log to its older part, a process checks that no other process did it already.
 */
export class WorkerLog {
  private fd: number | undefined;
  private broken = false;
  private readonly now: () => number;
  private readonly maxBytes: number;
  readonly file: string;

  constructor(private readonly options: WorkerLogOptions) {
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? WORKER_LOG_MAX_BYTES;
    this.file = path.join(options.folder, options.name);
  }

  /** Appends an entry; at the size limit, the log becomes `<name>.1` first. Never throws. */
  write(text: string): void {
    if (this.broken) return;
    try {
      const line = workerLogLine(this.now(), text);
      const bytes = Buffer.byteLength(line);
      if (this.fd === undefined) this.open();
      const own = fs.fstatSync(this.fd as number);
      if (own.size > 0 && own.size + bytes > this.maxBytes) {
        // Another process of the container may have moved the log already: then this file is the older part.
        let current = false;
        try {
          current = fs.lstatSync(this.file).ino === own.ino;
        } catch {
          // The log is gone: a new one is opened.
        }
        this.close();
        if (current) fs.renameSync(this.file, `${this.file}.1`);
        this.open();
      }
      fs.writeSync(this.fd as number, line);
    } catch {
      this.broken = true;
      this.close();
    }
  }

  /** Sets the time of the log to now, so that the start of another worker keeps it (WORKER_LOG_KEEP_MS). Never throws. */
  touch(): void {
    if (this.broken || this.fd === undefined) return;
    try {
      const at = new Date(this.now());
      fs.futimesSync(this.fd, at, at);
    } catch {
      // The next entry sets the time too.
    }
  }

  /** Closes the file (the process ends). */
  close(): void {
    if (this.fd === undefined) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      // Nothing to do: the process ends.
    }
    this.fd = undefined;
  }

  private open(): void {
    ensureFolder(this.options.folder);
    const fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error(`${this.file} is no regular file.`);
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
    this.fd = fd;
  }
}

/**
 * Removes the logs of other workers in `folder` that nobody touched for `keepMs` (their workers ended; a worker touches
 * its log every WORKER_LOG_TOUCH_MS), never the log `own` and its older part, and nothing that is no log of a worker
 * (LOG_FILE) or no regular file. Gives the number of the removed files; never throws.
 */
export function sweepWorkerLogs(folder: string, own: string, now: number, keepMs: number): number {
  let names: string[];
  try {
    if (!fs.lstatSync(folder).isDirectory()) return 0;
    names = fs.readdirSync(folder);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!LOG_FILE.test(name) || name === own || name === `${own}.1`) continue;
    try {
      const file = path.join(folder, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || now - stat.mtimeMs <= keepMs) continue;
      fs.unlinkSync(file);
      removed++;
    } catch {
      // Gone meanwhile, or removed by another worker.
    }
  }
  return removed;
}
