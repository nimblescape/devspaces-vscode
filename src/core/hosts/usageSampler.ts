// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The utilization samples of one host (docs/architecture.md "The utilization samples"), paced by the extension: each
// sample is one run of USAGE_SCRIPT on the shared shell of the host (`run`, the shell that the view Docker Hosts uses),
// so the page of a host makes no connection of its own and leaves nothing on the host. The first sample is a `d`, then
// `t`, with a `d` every fifth sample. The next sample starts after the one before it ended, at the interval, or later
// when the host needs long for a sample. The names of the containers come from `docker ps` on the same shell
// (usageDockerScript, also with `run`), at most every USAGE_NAMES_EVERY_MS while the set of running containers changes,
// and the data folder of Docker once from `docker info`, each between two samples and only while a container runs. Nothing retries a failed sample: each end is reported once. No `vscode`.
import { errorMessage } from '../errors';
import { readableStderr } from '../loader/pipeLoader';
import { systemClock, type Clock, type Logger, type RunResult } from '../ports';
import { isUsableDockerRoot, newUsageMarker, usageDockerScript, usageScript, type UsageSampleKind } from './usageScript';
import { UsageSampleError, parseUsageNames, readUsageSample, type UsageBlock, type UsageHeader } from './usageSample';
import { usageOf, type HostUsage } from './usageRates';

/** The interval of the samples of the VM of Devspaces, and of a host over SSH. */
export const VM_USAGE_INTERVAL_MS = 2_000;
export const SSH_USAGE_INTERVAL_MS = 5_000;
/** Every this many samples, one reads the disks too (`d`); the first sample is one. */
export const USAGE_DISK_EVERY = 5;
/** The shortest time limit of one sample on the shell: the script only reads files, so this is long. */
export const MIN_USAGE_ANSWER_MS = 15_000;
/** `docker ps` for the names at most this often while the set of containers changes. */
export const USAGE_NAMES_EVERY_MS = 10_000;
/** After a failed `docker ps`, the next one after this time; after a failed `docker info`, after the second one. */
export const USAGE_NAMES_RETRY_MS = 60_000;
export const USAGE_ROOT_RETRY_MS = 300_000;
/**
 * The time limit of each of these Docker calls on the shell: longer than their time limit on the host
 * (USAGE_DOCKER_SECONDS), so that this one stops the shell only on a host without `timeout`, or that does not answer.
 */
export const USAGE_DOCKER_TIMEOUT_MS = 10_000;
/** The arguments of these Docker calls (reads, so that the shared shell of the host runs them). */
export const USAGE_NAMES_ARGS: readonly string[] = ['ps', '--no-trunc', '--format', '{{.ID}} {{.Names}}'];
export const USAGE_ROOT_ARGS: readonly string[] = ['info', '--format', '{{.DockerRootDir}}'];
/** The scripts of these Docker calls. */
const USAGE_NAMES_SCRIPT = usageDockerScript(USAGE_NAMES_ARGS);
const USAGE_ROOT_SCRIPT = usageDockerScript(USAGE_ROOT_ARGS);
/** The interval is at least this many times the time the host needed for the last sample, */
const USAGE_SLOW_FACTOR = 4;
/** but at most this long (the uptime of the host is not trusted: it jumps, for example, after a suspend). */
export const MAX_USAGE_INTERVAL_MS = 60_000;
/**
 * A rate only from two blocks at most this many intervals apart, by the uptime of the host, and at least
 * MIN_USAGE_ANSWER_MS: longer than a slow sample `d` or a Docker call between two samples (USAGE_DOCKER_TIMEOUT_MS).
 */
const USAGE_RATE_GAP_FACTOR = 3;
/** The end of the error output that is kept for the reason of an end. */
const STDERR_TAIL_LENGTH = 8 * 1024;

/**
 * The run of a command of the samples (a sample, or a Docker call between two): its result, or why it could not run:
 * `vmStopped`, the VM of Devspaces does not run and the page does not start it (R-VM-004); `noTransport`, the program
 * of the transport of the host is missing.
 */
export type UsageRun = { kind: 'ran'; result: RunResult } | { kind: 'notRun'; reason: 'vmStopped' | 'noTransport' };

/** How the samples ended. */
export type UsageEnd =
  /** stop() ended them. */
  | { kind: 'stopped' }
  /** A handler of the page (onHeader, onBlock) threw, or `run` rejected (for a sample or a Docker call). */
  | { kind: 'failed'; detail: string }
  /** The host has no /proc: it is no Linux. */
  | { kind: 'notLinux' }
  /**
   * A sample did not end within its time limit (the shell stopped it), or the login of the shell did not answer in
   * time. With the end of the error output.
   */
  | { kind: 'noAnswer'; detail: string }
  /** The output broke a bound of usageSample.ts, or is not the output of the script. */
  | { kind: 'badOutput'; detail: string }
  /**
   * The command of the sample ended with an exit code that is not 0: for example 255 when the login of the shell failed
   * or the connection broke, or 127 without `sh`. With the end of its error output.
   */
  | { kind: 'exited'; exitCode: number | null; detail: string }
  /** UsageRun `notRun`, of a sample or of a Docker call. */
  | { kind: 'vmStopped' }
  | { kind: 'noTransport' }
  /**
   * Only with `wslIdle`: the idle script of the WSL distribution of Devspaces ran and ended, so nothing runs there and
   * WSL stops it; the samples end, so that they do not hold it (R-VM-004). The page closes the shell then
   * (RemoteShells.close), whose open `wsl.exe` would hold the distribution until the shell closes when not used.
   */
  | { kind: 'vmIdle' };

/** The end of the error output of `result`, readable for the log. */
function stderrTail(result: RunResult): string {
  return readableStderr(result.stderr.slice(-STDERR_TAIL_LENGTH), STDERR_TAIL_LENGTH);
}

/** The timers of the samples (the tests give fake ones). */
export interface UsageTimers extends Clock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: UsageTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => systemClock.now(),
};

export interface UsageSamplerOptions {
  logger: Logger;
  /** Named in the log lines: the host. */
  name: string;
  /** The interval of the samples (VM_USAGE_INTERVAL_MS or SSH_USAGE_INTERVAL_MS). */
  intervalMs: number;
  /** The idle check of the WSL distribution of Devspaces (lines `I`, and the end `vmIdle`). */
  wslIdle?: boolean;
  /**
   * Runs `script` on the shared shell of the host as one line, usageShellCommand(script), within `timeoutMs`: a sample
   * (usageScript), or a Docker call between two samples (usageDockerScript).
   */
  run(script: string, timeoutMs: number): Promise<UsageRun>;
  /**
   * Takes a hold that ends with the samples (the returned function runs once, at the end): RemoteShells.keep of the
   * host, so that the relay does not take over the shell while the samples run on it.
   */
  hold?(): () => void;
  /** The line `#H` of the first sample, and again when the kernel of the host started anew. */
  onHeader?(header: UsageHeader): void;
  /**
   * Each block, with its values (the rates from the block before it, when it is of the same start of the kernel), and
   * the names of the containers by their ID as the last `docker ps` gave them (undefined before the first).
   */
  onBlock(block: UsageBlock, usage: HostUsage, names: ReadonlyMap<string, string> | undefined): void;
  /** Once, when the samples ended. */
  onEnd(end: UsageEnd): void;
  /** Only for the tests. */
  timers?: UsageTimers;
}

/** The samples of one host. Create them with UsageSampler.start. */
export class UsageSampler {
  private readonly timers: UsageTimers;
  private stage: 'running' | 'ended' = 'running';
  private headerValue: UsageHeader | undefined;
  /** The last boot ID that the host could read. */
  private bootId: string | undefined;
  private previous: UsageBlock | undefined;
  /** The number of samples so far. */
  private samples = 0;
  /** True while a sample or a Docker call between two samples runs. */
  private busy = false;
  private paused = false;
  private nextTimer: unknown;
  private interval: number;
  /** The IDs of the containers of the last block. */
  private containerIds = '';
  private names: ReadonlyMap<string, string> | undefined;
  /** The IDs of the containers at the last `docker ps` that worked, and when the next one may run. */
  private namedIds: string | undefined;
  /**
   * The set of containers whose last `docker ps` did not list each of them (one was starting): it runs once more for
   * this set, not again and again for a container that it cannot list (of the rootless Docker of another user).
   */
  private namesRetryFor: string | undefined;
  private nextNamesAt = 0;
  /** The data folder of Docker: undefined until `docker info` ran, then the folder ('' for /var/lib/docker). */
  private dockerRoot: string | undefined;
  private nextRootAt: number | undefined;
  private idleSeen = false;
  /** When the last sample started. */
  private lastStartedAt: number | undefined;
  /** The end of the hold of `hold`. */
  private release: (() => void) | undefined;

  private constructor(private readonly options: UsageSamplerOptions) {
    this.timers = options.timers ?? realTimers;
    this.interval = options.intervalMs;
    this.release = options.hold?.();
    // After start returned, so that an end (for example of a `run` that throws at once) never comes before it.
    queueMicrotask(() => this.sample());
  }

  /** Starts the samples: the first one at once (after start returned). */
  static start(options: UsageSamplerOptions): UsageSampler {
    return new UsageSampler(options);
  }

  /** The line `#H` of the last sample. */
  get header(): UsageHeader | undefined {
    return this.headerValue;
  }

  get ended(): boolean {
    return this.stage === 'ended';
  }

  /**
   * No more samples (the page is hidden): the sample that runs still ends and is reported, without a Docker call after
   * it. The hold of the shell stays, so that the relay does not take the shell for a short hide (the page stops the
   * samples 15 s after it is hidden; the shell itself still closes 2 minutes after its last command).
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.clearNext();
  }

  /**
   * Samples again: the next sample one interval after the start of the last one (at once after a longer pause), or after
   * the one that runs. After a long pause, its block has no rates (take).
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    // The first sample after resume returned, as after start (an end never comes within the call).
    if (this.lastStartedAt === undefined) queueMicrotask(() => this.sample());
    else this.schedule(this.lastStartedAt);
  }

  /** Ends the samples. A sample that runs ends on the shell and is not reported (the shell must not stop for it). */
  stop(): void {
    this.finish({ kind: 'stopped' });
  }

  private sample(): void {
    if (this.stage !== 'running' || this.paused || this.busy) return;
    this.clearNext();
    const kind: UsageSampleKind = this.samples % USAGE_DISK_EVERY === 0 ? 'd' : 't';
    const seq = ++this.samples;
    const marker = newUsageMarker();
    const timeoutMs = Math.max(3 * this.interval, MIN_USAGE_ANSWER_MS);
    const startedAt = this.timers.now();
    this.lastStartedAt = startedAt;
    this.busy = true;
    void (async () => {
      try {
        const script = usageScript({ marker, seq, kind, wslIdle: this.options.wslIdle ?? false, dockerRoot: this.dockerRoot || undefined });
        const run = await this.options.run(script, timeoutMs);
        // No Docker call after the page was hidden: no work for a page that nobody sees.
        if (this.stage === 'running' && this.take(run, marker, seq, kind, timeoutMs) && !this.paused) await this.between();
      } catch (error) {
        const detail = errorMessage(error);
        this.options.logger.warn(`The utilization sample of ${this.options.name} failed: ${detail}`);
        this.finish({ kind: 'failed', detail });
      } finally {
        this.busy = false;
        this.schedule(startedAt);
      }
    })();
  }

  /** The run of sample `seq`: its block to the page, or the end. False after an end. */
  private take(run: UsageRun, marker: string, seq: number, kind: UsageSampleKind, timeoutMs: number): boolean {
    const { logger, name } = this.options;
    if (run.kind === 'notRun') {
      this.notRun(run.reason);
      return false;
    }
    const { result } = run;
    if (result.timedOut) {
      // Also a login of the shell that did not answer in time: then its error output says so.
      const detail = stderrTail(result);
      logger.warn(`${name} did not answer the utilization sample in time: ${detail || `the sample took more than ${timeoutMs / 1000} seconds.`}`);
      this.finish({ kind: 'noAnswer', detail });
      return false;
    }
    if (result.exitCode !== 0) {
      const detail = stderrTail(result);
      logger.warn(`The utilization sample of ${name} ended with exit code ${result.exitCode ?? 'none'}${detail ? `: ${detail}` : '.'}`);
      this.finish({ kind: 'exited', exitCode: result.exitCode, detail });
      return false;
    }
    let output: ReturnType<typeof readUsageSample>;
    try {
      output = readUsageSample(result.stdout, marker, seq);
    } catch (error) {
      if (!(error instanceof UsageSampleError)) throw error;
      logger.warn(`The utilization sample of ${name} failed: ${error.message}`);
      this.finish({ kind: 'badOutput', detail: error.message });
      return false;
    }
    if (output.kind === 'notLinux') {
      this.finish({ kind: 'notLinux' });
      return false;
    }
    const { header, block } = output;
    // A new start of the kernel: its counters start at 0, so no rate from the block before it.
    // Only two boot IDs that were read: one that the host could not read once is no new start.
    const restarted = this.bootId !== undefined && header.bootId !== undefined && this.bootId !== header.bootId;
    this.bootId = header.bootId ?? this.bootId;
    if (restarted) {
      this.previous = undefined;
      // Docker may have another data folder now (a new data-root needs a new start of the Engine): read again.
      this.dockerRoot = undefined;
      this.nextRootAt = undefined;
      this.names = undefined;
      this.namedIds = undefined;
      this.namesRetryFor = undefined;
      this.nextNamesAt = 0;
    }
    const first = this.headerValue === undefined;
    this.headerValue = header;
    // No rate over a long gap (a pause, a sample that waited long on the shell, a suspend of the host): it would be the
    // mean of the whole gap, no live value.
    const gapMs = this.previous === undefined ? 0 : Number(block.startCs - this.previous.startCs) * 10;
    const usage = usageOf(block, gapMs <= Math.max(USAGE_RATE_GAP_FACTOR * this.interval, MIN_USAGE_ANSWER_MS) ? this.previous : undefined);
    this.previous = block;
    // A host that needs long for a sample gets more time between the samples, so they cost it little. Only by a sample
    // `t`: a `d` also reads the disks, which may be slow alone.
    if (kind === 't') this.interval = Math.max(this.options.intervalMs, Math.min(MAX_USAGE_INTERVAL_MS, USAGE_SLOW_FACTOR * Number(block.endCs - block.startCs) * 10));
    try {
      if (first || restarted) this.options.onHeader?.(header);
      if (this.stage === 'running') this.options.onBlock(block, usage, this.names);
    } catch (error) {
      const detail = errorMessage(error);
      logger.warn(`The utilization page of ${name} failed: ${detail}`);
      this.finish({ kind: 'failed', detail });
      return false;
    }
    if (this.stage !== 'running') return false;
    if (this.options.wslIdle === true && block.idle !== undefined) {
      if (block.idle) this.idleSeen = true;
      else if (this.idleSeen) {
        logger.info(`The idle script of ${name} ended: the utilization page lets the WSL distribution stop.`);
        this.finish({ kind: 'vmIdle' });
        return false;
      }
    }
    this.containerIds = block.containers.map((container) => container.id).join(' ');
    return true;
  }

  /**
   * Between two samples, at most one Docker call: `docker ps` when the set of containers changed since the last one
   * that worked (at most every USAGE_NAMES_EVERY_MS), else once `docker info` after the first names. Both only while a
   * container runs: then the Docker Engine runs, and a call cannot start one that systemd starts at its socket. A
   * failure is logged and tried again later; the samples go on without it. A call that could not run (the VM stopped)
   * ends the samples.
   */
  private async between(): Promise<void> {
    const now = this.timers.now();
    const ids = this.containerIds;
    if ((ids !== this.namedIds || this.namesRetryFor === ids) && ids !== '' && now >= this.nextNamesAt) {
      this.nextNamesAt = now + USAGE_NAMES_EVERY_MS;
      const retry = ids === this.namedIds;
      const result = await this.dockerCall('ps', USAGE_NAMES_SCRIPT);
      if (this.stage !== 'running') return;
      if (result === undefined) {
        this.nextNamesAt = this.timers.now() + USAGE_NAMES_RETRY_MS;
        return;
      }
      try {
        const names = parseUsageNames(result.stdout);
        this.names = names;
        this.namedIds = ids;
        this.namesRetryFor = !retry && ids.split(' ').some((id) => !names.has(id)) ? ids : undefined;
        this.nextRootAt ??= this.timers.now();
      } catch (error) {
        this.options.logger.warn(`The names of the containers of ${this.options.name} could not be read: ${errorMessage(error)}`);
        this.nextNamesAt = this.timers.now() + USAGE_NAMES_RETRY_MS;
      }
      return;
    }
    if (ids === '' || this.dockerRoot !== undefined || this.nextRootAt === undefined || now < this.nextRootAt) return;
    const result = await this.dockerCall('info', USAGE_ROOT_SCRIPT);
    if (this.stage !== 'running') return;
    const folder = result?.stdout.trim().replace(/(.)\/+$/, '$1') ?? '';
    // No answer, also an empty one (an Engine that starts): again later.
    if (folder === '') {
      this.nextRootAt = this.timers.now() + USAGE_ROOT_RETRY_MS;
      return;
    }
    this.dockerRoot = folder !== '/var/lib/docker' && isUsableDockerRoot(folder) ? folder : '';
  }

  /**
   * `docker <args>` within USAGE_DOCKER_TIMEOUT_MS: its result when it worked, else undefined (logged). A call that could
   * not run ends the samples (undefined too), and a `run` that rejects rejects here.
   */
  private async dockerCall(command: string, script: string): Promise<RunResult | undefined> {
    const { logger, name } = this.options;
    // A `run` that rejects ends the samples, as for a sample (the catch of `sample`).
    const run = await this.options.run(script, USAGE_DOCKER_TIMEOUT_MS);
    if (this.stage !== 'running') return undefined;
    if (run.kind === 'notRun') {
      this.notRun(run.reason);
      return undefined;
    }
    const { result } = run;
    if (result.exitCode === 0 && !result.timedOut) return result;
    // `timeout` on the host ended it: 124 (coreutils), or 143 (BusyBox, whose command gets TERM in its place).
    const why = result.timedOut || result.exitCode === 124 || result.exitCode === 143 ? 'no answer' : `exit code ${result.exitCode ?? 'none'}`;
    const detail = stderrTail(result);
    logger.info(`docker ${command} for the utilization page of ${name} failed (${why})${detail ? `: ${detail}` : ''}; the page goes on without it.`);
    return undefined;
  }

  /** The end of a command that could not run. */
  private notRun(reason: 'vmStopped' | 'noTransport'): void {
    const { logger, name } = this.options;
    logger.info(reason === 'vmStopped' ? `The VM of Devspaces does not run: the utilization page of ${name} does not start it.` : `The utilization page of ${name} found no program for its connection.`);
    this.finish({ kind: reason });
  }

  /** The next sample at `startedAt` plus the interval, unless the samples ended, wait, or one runs. */
  private schedule(startedAt: number): void {
    if (this.stage !== 'running' || this.paused || this.busy) return;
    const wait = Math.max(0, startedAt + this.interval - this.timers.now());
    this.clearNext();
    this.nextTimer = this.timers.setTimeout(() => {
      this.nextTimer = undefined;
      this.sample();
    }, wait);
  }

  private clearNext(): void {
    if (this.nextTimer !== undefined) this.timers.clearTimeout(this.nextTimer);
    this.nextTimer = undefined;
  }

  private endHold(): void {
    this.release?.();
    this.release = undefined;
  }

  /** Reports `end` once. */
  private finish(end: UsageEnd): void {
    if (this.stage === 'ended') return;
    this.stage = 'ended';
    this.clearNext();
    this.endHold();
    try {
      this.options.onEnd(end);
    } catch (error) {
      this.options.logger.warn(`The utilization page of ${this.options.name} failed at the end of its samples: ${errorMessage(error)}`);
    }
  }
}
