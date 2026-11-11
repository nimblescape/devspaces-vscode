// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// One utilization stream of a host (docs/architecture.md "The utilization stream"): USAGE_SCRIPT on a started transport
// (`sh -s` through ssh, the ssh of Lima, or wsl.exe), paced by the extension. The session writes the script, waits for
// its marker line, and then asks for one block at a time: `d` first, then `t`, with `d` every fifth request and `s`
// when the page asks for the sizes. The next request goes out after the block came, at the interval, or later when the
// host needs long for a block. While the stream lives in byte mode, a request or a space goes out at least every
// USAGE_KEEP_ALIVE_MS, so the script does not end for a lack of bytes (in line mode the script has no time limit, and
// no space goes out). Nothing retries: each end is reported once.
// No `vscode`.
import { wslText } from '../docker/dockerHost';
import { readableStderr } from '../loader/pipeLoader';
import type { Logger, StartedByteProcess } from '../ports';
import type { SshLoginPrompts } from '../sshAskpass';
import { SHELL_LOGIN_TIMEOUT_MS } from '../relay/remoteShell';
import { USAGE_DOCKER_SECONDS, USAGE_HEARTBEAT_SECONDS, USAGE_SIZES_SECONDS, newUsageMarker, usageScript } from './usageScript';
import { UsageStreamError, UsageStreamReader, type UsageBlock, type UsageHeader } from './usageStream';
import { usageOf, type HostUsage } from './usageRates';

/** The interval of the requests to the VM of Devspaces, and to a host over SSH. */
export const VM_USAGE_INTERVAL_MS = 2_000;
export const SSH_USAGE_INTERVAL_MS = 5_000;
/** Every this many requests, one asks for the disks too (`d`); the first request is one. */
export const USAGE_DISK_EVERY = 5;
/**
 * A space (or a request) goes out at least this often while the stream lives in byte mode: at most a third of
 * MIN_USAGE_HEARTBEAT_SECONDS, so a late timer does not end the script.
 */
export const USAGE_KEEP_ALIVE_MS = 10_000;
/** The shortest time a block may take before the session gives up on the host: 3 times its one Docker call. */
export const MIN_USAGE_ANSWER_MS = 3 * USAGE_DOCKER_SECONDS * 1000;
/** The time that the answer to `s` may take: all calls of the sizes read, the Docker call of the block, and 25 s more. */
export const USAGE_SIZES_ANSWER_MS = (USAGE_SIZES_SECONDS + USAGE_DOCKER_SECONDS + 25) * 1000;
/** The interval is at least this many times the time the host needed for the last block. */
const USAGE_SLOW_FACTOR = 4;
/** After the end of its input, the process gets this long to end before it is stopped. */
const USAGE_CLOSE_KILL_MS = 5_000;
/** The end of the error output that is kept for the reason of an end. */
const STDERR_TAIL_LENGTH = 8 * 1024;

/** How a stream ended. */
export type UsageEnd =
  /** stop() ended it. */
  | { kind: 'stopped' }
  /** A handler of the page (onHeader, onBlock) threw; the process was stopped, and the error is thrown on. */
  | { kind: 'failed'; detail: string }
  /** The host has no /proc: it is no Linux. */
  | { kind: 'notLinux' }
  /** The login (`login`) or a block (`sample`) did not come in time; the process was stopped. */
  | { kind: 'noAnswer'; stage: 'login' | 'sample' }
  /** The output broke a bound of usageStream.ts, or is not the output of the script; the process was stopped. */
  | { kind: 'badOutput'; detail: string }
  /**
   * The process ended by itself: `beforeStart` when the script never started (the login failed, or no `sh`), with the
   * exit code of the transport (for example 255 of ssh) and the end of its error output.
   */
  | { kind: 'exited'; exitCode: number | null; beforeStart: boolean; detail: string };

/** The timers of a session (the tests give fake ones). */
export interface UsageTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const realTimers: UsageTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface UsageSessionOptions {
  logger: Logger;
  /** Named in the log lines: the host. */
  name: string;
  /** The interval of the requests (VM_USAGE_INTERVAL_MS or SSH_USAGE_INTERVAL_MS). */
  intervalMs: number;
  /** The time without a byte after which the script ends (seconds). */
  heartbeatSeconds?: number;
  /** The idle check of the WSL distribution of Devspaces (lines `I`). */
  wslIdle?: boolean;
  /** The program of the transport: `wsl.exe` writes its own errors to the standard output, before the marker line. */
  program?: 'ssh' | 'wsl.exe';
  /** The longest time from the start to the line `#H`; it stops while a question of the login is open. */
  loginTimeoutMs?: number;
  /** The questions of a login that may ask in VS Code (sshAskpass.ts). */
  prompts?: SshLoginPrompts;
  /** The line `#H`: the stream runs. */
  onHeader?(header: UsageHeader): void;
  /** Each block, with its values (the rates from the block before it). */
  onBlock(block: UsageBlock, usage: HostUsage): void;
  /** Once, when the stream ended. */
  onEnd(end: UsageEnd): void;
  /** Only for the tests. */
  timers?: UsageTimers;
  closeKillMs?: number;
  /** Only for the tests: the marker instead of a new one. */
  marker?: string;
}

/** One stream. Create it with UsageSession.start. */
export class UsageSession {
  private readonly timers: UsageTimers;
  private readonly reader: UsageStreamReader;
  private stage: 'login' | 'live' | 'ended' = 'login';
  private headerValue: UsageHeader | undefined;
  private previous: UsageBlock | undefined;
  /** The number of requests so far; the next block must have this number. */
  private requests = 0;
  /** The request that waits for its block, and when it went out. */
  private inFlight: { kind: 't' | 'd' | 's'; at: number } | undefined;
  private sizesWanted = false;
  private paused = false;
  private nextTimer: unknown;
  private answerTimer: unknown;
  private keepAliveTimer: unknown;
  private loginTimer: unknown;
  private stopPrompts: (() => void) | undefined;
  private stderrTail = '';
  private interval: number;
  private readonly exitedPromise: Promise<void>;

  private constructor(
    private readonly process: StartedByteProcess,
    private readonly options: UsageSessionOptions,
  ) {
    this.timers = options.timers ?? realTimers;
    this.interval = options.intervalMs;
    const marker = options.marker ?? newUsageMarker();
    let script: string;
    try {
      script = usageScript(marker, options.heartbeatSeconds ?? USAGE_HEARTBEAT_SECONDS, options.wslIdle ?? false);
    } catch (error) {
      // A value that the script refuses: the started transport must not run on without a session that stops it.
      process.end();
      process.kill();
      throw error;
    }
    this.reader = new UsageStreamReader(marker, {
      header: (header) => this.onHeader(header),
      notLinux: () => this.finish({ kind: 'notLinux' }, false),
      block: (block) => this.onBlock(block),
      loginText: (bytes) => options.logger.info(`The login on ${options.name} printed ${bytes} bytes before the utilization stream started; they are ignored.`),
    }, { keepLoginText: options.program === 'wsl.exe' });
    process.onStdout(
      (chunk) => this.onStdout(chunk),
      () => undefined,
    );
    process.onStderr((text) => {
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_LENGTH);
    });
    this.exitedPromise = process.exited.then(({ exitCode, error }) => this.onExit(exitCode, error));
    // The script is the whole input until its marker line came: dash and BusyBox read it in blocks.
    process.write(Buffer.from(script, 'utf8'));
    this.armLogin();
    this.stopPrompts = options.prompts?.onPrompt((open) => {
      if (this.stage !== 'login') return;
      if (open) this.clear('loginTimer');
      else this.armLogin();
    });
  }

  /** Starts the stream on `process` (the transport of the host, started and not yet written to). */
  static start(process: StartedByteProcess, options: UsageSessionOptions): UsageSession {
    return new UsageSession(process, options);
  }

  /** The line `#H`, once the stream runs. */
  get header(): UsageHeader | undefined {
    return this.headerValue;
  }

  get live(): boolean {
    return this.stage === 'live';
  }

  get ended(): boolean {
    return this.stage === 'ended';
  }

  /** True while the answer to `s` is awaited, or `s` waits for the block before it. */
  get readingSizes(): boolean {
    return this.sizesWanted || this.inFlight?.kind === 's';
  }

  /** Resolves when the process ended. */
  get exited(): Promise<void> {
    return this.exitedPromise;
  }

  /**
   * No more requests (the page is hidden): the block that is awaited still comes; spaces keep the stream. A sizes read
   * that waits for the block before it goes out only after resume.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.clear('nextTimer');
  }

  /** Requests again, the next at once. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.stage === 'live' && this.inFlight === undefined) this.request();
  }

  /**
   * Asks for the sizes with the next request (at once when none is awaited). False when the stream does not run, is
   * paused, or a sizes read runs already.
   */
  readSizes(): boolean {
    if (this.stage !== 'live' || this.paused || this.readingSizes) return false;
    this.sizesWanted = true;
    if (this.inFlight === undefined) {
      this.clear('nextTimer');
      this.request();
    }
    return true;
  }

  /** Ends the stream: its input closes, and the process is stopped when it did not end after USAGE_CLOSE_KILL_MS. */
  stop(): void {
    this.finish({ kind: 'stopped' }, true);
  }

  private onStdout(chunk: Buffer): void {
    if (this.stage === 'ended') return;
    try {
      this.reader.push(chunk);
    } catch (error) {
      if (!(error instanceof UsageStreamError)) {
        // A handler of the page threw: the reader takes nothing more, so the process must not run on.
        const detail = error instanceof Error ? error.message : String(error);
        this.options.logger.warn(`The utilization stream of ${this.options.name} ended: ${detail}`);
        this.finish({ kind: 'failed', detail }, true);
        throw error;
      }
      this.options.logger.warn(`The utilization stream of ${this.options.name} ended: ${error.message}`);
      this.finish({ kind: 'badOutput', detail: error.message }, true);
    }
  }

  private onHeader(header: UsageHeader): void {
    if (this.stage !== 'login') return;
    this.clear('loginTimer');
    this.stopPrompts?.();
    this.stopPrompts = undefined;
    this.stage = 'live';
    this.headerValue = header;
    if (!header.byteMode) this.options.logger.info(`${this.options.name} has no \`timeout\` or \`dd\`: the utilization stream asks by lines, and a broken connection ends it only when the connection closes.`);
    this.options.onHeader?.(header);
    // The handler may have asked already (readSizes, or pause and resume), or ended the stream.
    if (this.stage !== 'live' || this.inFlight !== undefined) return;
    // Hidden before the start: a space starts the keep-alive, so the script waits for the resume.
    if (this.paused) this.write(' ');
    else this.request();
  }

  private onBlock(block: UsageBlock): void {
    if (this.stage !== 'live') return;
    if (this.inFlight === undefined || block.seq !== this.requests) {
      this.finish({ kind: 'badOutput', detail: `The host answered with block ${block.seq}, but block ${this.requests} was asked for.` }, true);
      return;
    }
    const sent = this.inFlight;
    this.inFlight = undefined;
    this.clear('answerTimer');
    const usage = usageOf(block, this.previous);
    this.previous = block;
    // A host that needs long for a block gets more time between the requests, so the stream costs it little.
    const durationMs = Number(block.endCs - block.startCs) * 10;
    this.interval = Math.max(this.options.intervalMs, USAGE_SLOW_FACTOR * (sent.kind === 's' ? 0 : durationMs));
    this.options.onBlock(block, usage);
    // The handler may have asked already (readSizes, or pause and resume), or ended the stream.
    if (this.stage !== 'live' || this.paused || this.inFlight !== undefined) return;
    if (this.sizesWanted) {
      this.request();
      return;
    }
    const wait = Math.max(0, sent.at + this.interval - this.timers.now());
    this.clear('nextTimer');
    this.nextTimer = this.timers.setTimeout(() => {
      this.nextTimer = undefined;
      if (this.stage === 'live' && !this.paused && this.inFlight === undefined) this.request();
    }, wait);
  }

  private request(): void {
    let kind: 't' | 'd' | 's' = this.requests % USAGE_DISK_EVERY === 0 ? 'd' : 't';
    if (this.sizesWanted) {
      kind = 's';
      this.sizesWanted = false;
    }
    this.requests++;
    this.inFlight = { kind, at: this.timers.now() };
    this.write(kind);
    const answerMs = kind === 's' ? USAGE_SIZES_ANSWER_MS : Math.max(3 * this.interval, MIN_USAGE_ANSWER_MS);
    this.clear('answerTimer');
    this.answerTimer = this.timers.setTimeout(() => {
      this.answerTimer = undefined;
      this.options.logger.warn(`${this.options.name} did not answer the utilization stream within ${answerMs / 1000} seconds; it was stopped.`);
      this.finish({ kind: 'noAnswer', stage: 'sample' }, true);
    }, answerMs);
  }

  /** Writes a request or a space: one byte, or a line when the host has no `timeout` or `dd`. */
  private write(byte: 't' | 'd' | 's' | ' '): void {
    if (this.stage !== 'live') return;
    const byteMode = this.headerValue?.byteMode ?? false;
    if (!byteMode && byte === ' ') return;
    this.process.write(Buffer.from(byteMode ? byte : `${byte}\n`, 'latin1'));
    if (!byteMode) return;
    this.clear('keepAliveTimer');
    this.keepAliveTimer = this.timers.setTimeout(() => {
      this.keepAliveTimer = undefined;
      this.write(' ');
    }, USAGE_KEEP_ALIVE_MS);
  }

  private armLogin(): void {
    this.clear('loginTimer');
    const ms = this.options.loginTimeoutMs ?? SHELL_LOGIN_TIMEOUT_MS;
    this.loginTimer = this.timers.setTimeout(() => {
      this.loginTimer = undefined;
      this.options.logger.warn(`The utilization stream of ${this.options.name} did not start within ${ms / 1000} seconds; it was stopped.`);
      this.finish({ kind: 'noAnswer', stage: 'login' }, true);
    }, ms);
  }

  private clear(timer: 'nextTimer' | 'answerTimer' | 'keepAliveTimer' | 'loginTimer'): void {
    if (this[timer] !== undefined) this.timers.clearTimeout(this[timer]);
    this[timer] = undefined;
  }

  /** Reports `end` once; with `close`, the input closes and the process is stopped after USAGE_CLOSE_KILL_MS. */
  private finish(end: UsageEnd, close: boolean): void {
    if (this.stage === 'ended') return;
    this.stage = 'ended';
    this.inFlight = undefined;
    this.sizesWanted = false;
    for (const timer of ['nextTimer', 'answerTimer', 'keepAliveTimer', 'loginTimer'] as const) this.clear(timer);
    this.stopPrompts?.();
    this.stopPrompts = undefined;
    if (close) {
      this.process.end();
      const kill = this.timers.setTimeout(() => this.process.kill(), this.options.closeKillMs ?? USAGE_CLOSE_KILL_MS);
      void this.exitedPromise.then(() => this.timers.clearTimeout(kill));
    }
    this.options.onEnd(end);
  }

  private onExit(exitCode: number | null, error: Error | undefined): void {
    if (this.stage === 'ended') return;
    const beforeStart = this.stage === 'login';
    // wsl.exe writes its errors to the standard output (for example "Error code: Wsl/Service/CreateInstance/ERROR_TIMEOUT").
    const output = beforeStart && this.options.program === 'wsl.exe' ? readableStderr(wslText(this.reader.loginOutput()), STDERR_TAIL_LENGTH) : '';
    const detail = [readableStderr(this.stderrTail, STDERR_TAIL_LENGTH), output].filter((text) => text !== '').join('\n') || error?.message || '';
    this.options.logger.warn(`The utilization stream of ${this.options.name} ended with exit code ${exitCode ?? 'none'}${detail ? `: ${detail}` : '.'}`);
    this.finish({ kind: 'exited', exitCode, beforeStart, detail }, false);
  }
}
