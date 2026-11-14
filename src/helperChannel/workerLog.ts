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
/** The lock folder of a move of a log (WorkerLog.rotate). */
const LOCK_FOLDER = /^[0-9a-f]{12}\.log\.lock$/;
/** The bytes that a process writes before it reads the size of the log again (other processes of the container write to it too). */
const SIZE_CHECK_BYTES = 64 * 1024;
/** The age after which the lock of a move of the log counts as left by a process that ended during the move. */
const ROTATE_LOCK_STALE_MS = 60_000;

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
 * one write. Only one process at a time moves the log to its older part (the folder `<name>.lock` is the lock), and it
 * moves it only when no other process did it already.
 */
export class WorkerLog {
  private fd: number | undefined;
  private broken = false;
  /** The size of the file at its last read, and the bytes that this process wrote since. */
  private knownSize = 0;
  private writtenSince = 0;
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
      // The size is read again after SIZE_CHECK_BYTES of own writes, and whenever the log may be full.
      if (this.writtenSince + bytes >= SIZE_CHECK_BYTES || this.knownSize + this.writtenSince + bytes > this.maxBytes) {
        const own = fs.fstatSync(this.fd as number);
        this.knownSize = own.size;
        this.writtenSince = 0;
        if (own.size > 0 && own.size + bytes > this.maxBytes) this.rotate(own.ino);
      }
      fs.writeSync(this.fd as number, line);
      this.writtenSince += bytes;
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

  /**
   * Moves the log of the open file (inode `ino`) to its older part and opens a new log, under the lock of the move. When
   * another process holds the lock, it moves nothing now: the next entry tries again. When another process moved the
   * log already, this file is the older part, and only the new log is opened.
   */
  private rotate(ino: number): void {
    const lock = `${this.file}.lock`;
    if (!takeLock(lock)) return;
    try {
      let current = false;
      try {
        current = fs.lstatSync(this.file).ino === ino;
      } catch {
        // The log is gone: a new one is opened.
      }
      this.close();
      if (current) fs.renameSync(this.file, `${this.file}.1`);
      this.open();
    } finally {
      try {
        fs.rmdirSync(lock);
      } catch {
        // Taken over as stale meanwhile.
      }
    }
  }

  private open(): void {
    ensureFolder(this.options.folder);
    const fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error(`${this.file} is no regular file.`);
      this.knownSize = stat.size;
      this.writtenSince = 0;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
    this.fd = fd;
  }
}

/** Takes the lock folder `lock` (mkdir is atomic); a lock older than ROTATE_LOCK_STALE_MS is taken over. */
function takeLock(lock: string): boolean {
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  try {
    const stat = fs.lstatSync(lock);
    if (!stat.isDirectory() || Date.now() - stat.mtimeMs <= ROTATE_LOCK_STALE_MS) return false;
    fs.rmdirSync(lock);
    fs.mkdirSync(lock, { mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the logs of other workers in `folder` that nobody touched for `keepMs` (their workers ended; a worker touches
 * its log every WORKER_LOG_TOUCH_MS), never the log `own` and its older part, never the older part of a log that was
 * touched within `keepMs` (its worker still runs), and nothing that is no log of a worker (LOG_FILE) or no regular file.
 * It also removes the empty lock folders of moves (LOCK_FOLDER) that are older than `keepMs`: a process ended during its
 * move. Gives the number of the removed files and folders; never throws.
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
    if (LOCK_FOLDER.test(name) && name !== `${own}.lock`) {
      removed += removeStaleLock(path.join(folder, name), now, keepMs);
      continue;
    }
    if (!LOG_FILE.test(name) || name === own || name === `${own}.1`) continue;
    try {
      const file = path.join(folder, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || now - stat.mtimeMs <= keepMs) continue;
      if (name.endsWith('.1') && isFresh(path.join(folder, name.slice(0, -2)), now, keepMs)) continue;
      fs.unlinkSync(file);
      removed++;
    } catch {
      // Gone meanwhile, or removed by another worker.
    }
  }
  return removed;
}

/** Removes the lock folder `lock` when it is a folder older than `keepMs` (rmdir removes only an empty one); 1 when removed. */
function removeStaleLock(lock: string, now: number, keepMs: number): number {
  try {
    const stat = fs.lstatSync(lock);
    if (!stat.isDirectory() || now - stat.mtimeMs <= keepMs) return 0;
    fs.rmdirSync(lock);
    return 1;
  } catch {
    // Gone meanwhile, or not empty.
    return 0;
  }
}

/** Whether `file` is a regular file that was touched within `keepMs`. */
function isFresh(file: string, now: number, keepMs: number): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && now - stat.mtimeMs <= keepMs;
  } catch {
    return false;
  }
}
