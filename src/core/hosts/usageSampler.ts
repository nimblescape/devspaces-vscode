// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The utilization samples of one host (docs/architecture.md "The utilization samples"), paced by the extension: each
// sample is one run of USAGE_SCRIPT on the shared shell of the host (`run`, the shell that the view Docker Hosts uses),
// so the page of a host makes no connection of its own and leaves nothing on the host. The first sample is a `d`, then
// `t`, with a `d` every fifth sample. The next sample starts after the one before it ended, at the interval, or later
// when the host needs long for a sample. The names of the containers come from `docker ps` on the same shell (`docker`),
// at most every USAGE_NAMES_EVERY_MS while the set of running containers changes, and the data folder of Docker once
// from `docker info`, each between two samples and only while a container runs. Nothing retries a failed sample: each end is reported once. No `vscode`.
import { errorMessage } from '../errors';
import { readableStderr } from '../loader/pipeLoader';
import type { Logger, RunResult } from '../ports';
import { isUsableDockerRoot, newUsageMarker, usageScript, type UsageSampleKind } from './usageScript';
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
/** The time limit of each of these Docker calls. */
export const USAGE_DOCKER_TIMEOUT_MS = 10_000;
/** The arguments of these Docker calls (reads, so that the shared shell of the host runs them). */
export const USAGE_NAMES_ARGS: readonly string[] = ['ps', '--no-trunc', '--format', '{{.ID}} {{.Names}}'];
export const USAGE_ROOT_ARGS: readonly string[] = ['info', '--format', '{{.DockerRootDir}}'];
/** The interval is at least this many times the time the host needed for the last sample. */
const USAGE_SLOW_FACTOR = 4;
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
  /** A handler of the page (onHeader, onBlock) threw, or `run` rejected. */
  | { kind: 'failed'; detail: string }
  /** The host has no /proc: it is no Linux. */
  | { kind: 'notLinux' }
  /** A sample did not end within its time limit (the shell stopped it). */
  | { kind: 'noAnswer' }
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
   * WSL stops it; the samples end, so that they do not hold it (R-VM-004).
   */
  | { kind: 'vmIdle' };

/** The timers of the samples (the tests give fake ones). */
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

export interface UsageSamplerOptions {
  logger: Logger;
  /** Named in the log lines: the host. */
  name: string;
  /** The interval of the samples (VM_USAGE_INTERVAL_MS or SSH_USAGE_INTERVAL_MS). */
  intervalMs: number;
  /** The idle check of the WSL distribution of Devspaces (lines `I`, and the end `vmIdle`). */
  wslIdle?: boolean;
  /** Runs `sh -s` with `script` as its input on the shared shell of the host, within `timeoutMs`. */
  run(script: string, timeoutMs: number): Promise<UsageRun>;
  /**
   * `docker <args>` on the host (BootstrapDocker on its shared shell), with the same guard as `run`; without it, no
   * names and no data folder.
   */
  docker?(args: readonly string[], timeoutMs: number): Promise<UsageRun>;
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
  private nextNamesAt = 0;
  /** The data folder of Docker: undefined until `docker info` ran, then the folder ('' for /var/lib/docker). */
  private dockerRoot: string | undefined;
  private nextRootAt: number | undefined;
  private idleSeen = false;
  /** When the last sample started. */
  private lastStartedAt: number | undefined;

  private constructor(private readonly options: UsageSamplerOptions) {
    this.timers = options.timers ?? realTimers;
    this.interval = options.intervalMs;
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

  /** No more samples (the page is hidden): the sample that runs still ends and is reported. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.clearNext();
  }

  /**
   * Samples again: the next sample one interval after the start of the last one (at once after a longer pause), or after
   * the one that runs. No rate from the block before the pause: it would be the mean of the whole pause.
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.previous = undefined;
    if (this.lastStartedAt === undefined) this.sample();
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
    const script = usageScript({ marker, seq, kind, wslIdle: this.options.wslIdle ?? false, dockerRoot: this.dockerRoot || undefined });
    const timeoutMs = Math.max(3 * this.interval, MIN_USAGE_ANSWER_MS);
    const startedAt = this.timers.now();
    this.lastStartedAt = startedAt;
    this.busy = true;
    void (async () => {
      try {
        const run = await this.options.run(script, timeoutMs);
        if (this.stage === 'running' && this.take(run, marker, seq, timeoutMs)) await this.between();
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
  private take(run: UsageRun, marker: string, seq: number, timeoutMs: number): boolean {
    const { logger, name } = this.options;
    if (run.kind === 'notRun') {
      this.notRun(run.reason);
      return false;
    }
    const { result } = run;
    if (result.timedOut) {
      logger.warn(`${name} did not answer the utilization sample within ${timeoutMs / 1000} seconds.`);
      this.finish({ kind: 'noAnswer' });
      return false;
    }
    if (result.exitCode !== 0) {
      const detail = readableStderr(result.stderr.slice(-STDERR_TAIL_LENGTH), STDERR_TAIL_LENGTH);
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
    const restarted = this.headerValue !== undefined && this.headerValue.bootId !== header.bootId;
    if (restarted) this.previous = undefined;
    const first = this.headerValue === undefined;
    this.headerValue = header;
    const usage = usageOf(block, this.previous);
    this.previous = block;
    // A host that needs long for a sample gets more time between the samples, so they cost it little.
    this.interval = Math.max(this.options.intervalMs, USAGE_SLOW_FACTOR * Number(block.endCs - block.startCs) * 10);
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
    const docker = this.options.docker;
    if (docker === undefined) return;
    const now = this.timers.now();
    const ids = this.containerIds;
    if (ids !== this.namedIds && ids !== '' && now >= this.nextNamesAt) {
      this.nextNamesAt = now + USAGE_NAMES_EVERY_MS;
      const result = await this.dockerCall(docker, USAGE_NAMES_ARGS);
      if (this.stage !== 'running') return;
      if (result === undefined) {
        this.nextNamesAt = this.timers.now() + USAGE_NAMES_RETRY_MS;
        return;
      }
      try {
        this.names = parseUsageNames(result.stdout);
        this.namedIds = ids;
        this.nextRootAt ??= this.timers.now();
      } catch (error) {
        this.options.logger.warn(`The names of the containers of ${this.options.name} could not be read: ${errorMessage(error)}`);
        this.nextNamesAt = this.timers.now() + USAGE_NAMES_RETRY_MS;
      }
      return;
    }
    if (ids === '' || this.dockerRoot !== undefined || this.nextRootAt === undefined || now < this.nextRootAt) return;
    const result = await this.dockerCall(docker, USAGE_ROOT_ARGS);
    if (this.stage !== 'running') return;
    if (result === undefined) {
      this.nextRootAt = this.timers.now() + USAGE_ROOT_RETRY_MS;
      return;
    }
    const folder = result.stdout.trim().replace(/(.)\/+$/, '$1');
    this.dockerRoot = folder !== '/var/lib/docker' && isUsableDockerRoot(folder) ? folder : '';
  }

  /**
   * `docker <args>` within USAGE_DOCKER_TIMEOUT_MS: its result when it worked, else undefined (logged). A call that could
   * not run ends the samples (undefined too).
   */
  private async dockerCall(docker: NonNullable<UsageSamplerOptions['docker']>, args: readonly string[]): Promise<RunResult | undefined> {
    const { logger, name } = this.options;
    try {
      const run = await docker(args, USAGE_DOCKER_TIMEOUT_MS);
      if (this.stage !== 'running') return undefined;
      if (run.kind === 'notRun') {
        this.notRun(run.reason);
        return undefined;
      }
      const { result } = run;
      if (result.exitCode === 0 && !result.timedOut) return result;
      logger.info(`docker ${args[0]} for the utilization page of ${name} failed (${result.timedOut ? 'no answer' : `exit code ${result.exitCode ?? 'none'}`}); the page goes on without it.`);
    } catch (error) {
      logger.info(`docker ${args[0]} for the utilization page of ${name} failed: ${errorMessage(error)}`);
    }
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

  /** Reports `end` once. */
  private finish(end: UsageEnd): void {
    if (this.stage === 'ended') return;
    this.stage = 'ended';
    this.clearNext();
    this.options.onEnd(end);
  }
}
