// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reader of the utilization stream of a host (docs/architecture.md "The utilization stream"): the output of
// USAGE_SCRIPT (usageScript.ts) as lines, from the marker line on. Each request gives one block from `#T <seq>` to
// `#E <seq>`; this reader turns it into a UsageBlock with every counter as a BigInt. The output of the host is not
// trusted: every line and every block has a bound, and above a bound the reader throws UsageStreamError, so the stream
// ends. A line that the reader does not know is left out, and so is a value that it cannot read: a missing value is no
// value, not an error. No `vscode`.
import { MAX_SHELL_COMMAND_OUTPUT } from '../relay/remoteShell';
import { USAGE_PROTOCOL } from './usageScript';

/** The most output before the marker line: the text of the login scripts of the host (as MAX_OUTPUT_BEFORE_MARKER). */
export const MAX_USAGE_LOGIN_TEXT = 64 * 1024;
/** The longest line, except a line `Z` of the sizes (bytes, without its line feed). */
export const MAX_USAGE_LINE = 4 * 1024;
/** The longest line `Z` (the output of `docker system df -v` is one line), as the limit of the shell before the relay. */
export const MAX_USAGE_SIZES_LINE = MAX_SHELL_COMMAND_OUTPUT;
/** The most bytes of the lines of one block, without its lines `Z`. */
export const MAX_USAGE_BLOCK = 512 * 1024;
/** The most bytes of the lines `Z` of one block. */
export const MAX_USAGE_SIZES = 2 * MAX_USAGE_SIZES_LINE;
/** The most containers of one block (lines `C`), and the most names (lines `N`). */
export const MAX_USAGE_CONTAINERS = 500;
/** The most CPUs (lines `cpuN`). */
export const MAX_USAGE_CPUS = 1024;
/** The most folders of the disks (lines `D`): the script names at most four. */
const MAX_USAGE_DISKS = 8;
/** The most images, networks and tags of the sizes (lines `Z dev`, `Z helper`, `Z net`, `Z tag`), each. */
const MAX_USAGE_SIZE_ITEMS = 100_000;

/** The output of the host broke a bound, or is not the output of USAGE_SCRIPT. The stream must end. */
export class UsageStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageStreamError';
  }
}

/** The line `#H` of the script: what the host is. */
export interface UsageHeader {
  /** The version of the cgroups: 2 (unified), else 1 (also the hybrid layout). */
  cgroup: 1 | 2;
  /** The user ID of the shell on the host. */
  uid?: number;
  /**
   * True: the host has `timeout` and `dd`, so each request is one byte, and the script ends after the time without a
   * byte. False: each request is a line, and the script ends only at the end of its input.
   */
  byteMode: boolean;
  /** /proc/sys/kernel/random/boot_id: a new value is a new start of the kernel. */
  bootId?: string;
  /** The age of process 1 in 1/100 s (USER_HZ 100): on WSL, the time since the distribution started. */
  pid1AgeCs?: number;
  /** /proc/sys/kernel/osrelease. */
  kernel?: string;
}

/**
 * The jiffies of a line `cpu` of /proc/stat: user, nice, system, idle, iowait, irq, softirq, steal (the columns of the
 * guests are in user and nice already, so they are left out). A missing column of an old kernel is 0.
 */
export type CpuTimes = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

/** The values of /proc/meminfo that the script sends, in kB. */
export type MemoryKey = 'MemTotal' | 'MemFree' | 'MemAvailable' | 'Buffers' | 'Cached' | 'SwapTotal' | 'SwapFree';
const MEMORY_KEYS = new Set<string>(['MemTotal', 'MemFree', 'MemAvailable', 'Buffers', 'Cached', 'SwapTotal', 'SwapFree']);

export type PressureKind = 'cpu' | 'memory' | 'io';
/** A line of /proc/pressure/<kind>: the share of the last 10 s in percent, and the total stall time in µs. */
export interface PressureLine {
  avg10: number;
  totalUs: bigint;
}

/** A line `D`: `stat -f` of a folder of the Docker data. */
export interface UsageDisk {
  /** The ID of the file system (hexadecimal): two folders with the same ID are on one file system. */
  fsid: string;
  blockSize: bigint;
  blocks: bigint;
  freeBlocks: bigint;
  /** The blocks that a user who is not root may use. */
  availableBlocks: bigint;
  files: bigint;
  freeFiles: bigint;
  path: string;
}

/**
 * The network counters of a container: the sum over its interfaces except `lo`; `host`: it uses the network of the host
 * (no own counters); `none`: no interface but `lo`; `unknown`: its first process or its /proc/<pid>/net/dev could not be
 * read.
 */
export type UsageNetwork = { kind: 'interfaces'; rxBytes: bigint; txBytes: bigint } | { kind: 'host' } | { kind: 'none' } | { kind: 'unknown' };

/** The memory.stat keys that the script sends: cgroup v2, and cgroup v1. */
export type MemoryStatKey = 'anon' | 'file' | 'inactive_file' | 'total_rss' | 'total_cache' | 'total_inactive_file';
const MEMORY_STAT_KEYS = new Set<string>(['anon', 'file', 'inactive_file', 'total_rss', 'total_cache', 'total_inactive_file']);

/** The counters of one container (a line `C` and the lines after it). */
export interface UsageContainer {
  /** The full ID (64 hexadecimal digits). */
  id: string;
  /** The CPU time in µs: `u` (cpu.stat usage_usec), or `U` (cpuacct.usage in ns, divided by 1000). */
  cpuUsec?: bigint;
  /** memory.current, or memory.usage_in_bytes. */
  memoryBytes?: bigint;
  /** memory.max, or memory.limit_in_bytes; undefined for `max`. */
  memoryLimitBytes?: bigint;
  memoryStat: Partial<Record<MemoryStatKey, bigint>>;
  oomKills?: bigint;
  /** The sum of the block I/O over the devices: rbytes and wbytes (v2), or Read and Write (v1). */
  readBytes?: bigint;
  writeBytes?: bigint;
  pids?: bigint;
  network?: UsageNetwork;
}

/** The names of the containers (`docker ps`): all of the engine, or the exit code of a failed `docker ps`. */
export type UsageNames = { complete: true; names: Map<string, string> } | { complete: false; exitCode: number };

/**
 * The sizes (request `s`): the reads of readHostInventory (hostObjects.ts) as they came, for buildInventory; or the step
 * that failed and why.
 */
export type UsageSizes =
  | { ok: true; df: Record<string, unknown>; devspaceImageIds: string[]; helperImageIds: string[]; networks: unknown[]; imageTags: unknown[] }
  | { ok: false; step: string; detail: string };

/** One block: the answer to one request. */
export interface UsageBlock {
  /** The number of the request, from 1. */
  seq: number;
  /** /proc/uptime at the start and at the end of the block, in 1/100 s. */
  startCs: bigint;
  endCs: bigint;
  /** The line `cpu`, and the lines `cpuN` in their order. */
  cpu?: CpuTimes;
  cpus: CpuTimes[];
  /** The load average of 1, 5 and 15 minutes. */
  load?: readonly [number, number, number];
  memoryKb: Partial<Record<MemoryKey, bigint>>;
  /** /proc/vmstat oom_kill: the processes that the kernel ended for lack of memory since its start. */
  oomKills?: bigint;
  pressure: Partial<Record<PressureKind, { some?: PressureLine; full?: PressureLine }>>;
  /** Only in the answer to `d` and `s`. */
  disks?: UsageDisk[];
  /** Only on WSL, in the answer to `d` and `s`: whether the idle script of a keeper runs. */
  idle?: boolean;
  containers: UsageContainer[];
  /** Only when the script ran `docker ps` (the set of containers changed). */
  names?: UsageNames;
  /** Only in the answer to `s`. */
  sizes?: UsageSizes;
  /** Lines of a known kind whose value could not be read; they are left out. */
  skipped: number;
}

/** A counter: 1 to 20 decimal digits. */
function counter(text: string | undefined): bigint | undefined {
  return text !== undefined && /^\d{1,20}$/.test(text) ? BigInt(text) : undefined;
}

/** /proc/uptime (`12345.67`) in 1/100 s. */
function uptimeCs(text: string | undefined): bigint | undefined {
  const match = text === undefined ? null : /^(\d{1,17})\.(\d{2})$/.exec(text);
  return match ? BigInt(match[1]) * 100n + BigInt(match[2]) : undefined;
}

/** A decimal of the kernel (`0.53`, `12.00`): 1 to 10 digits, then at most 2 after the point. */
function decimal(text: string | undefined): number | undefined {
  return text !== undefined && /^\d{1,10}(\.\d{1,2})?$/.test(text) ? Number(text) : undefined;
}

const CONTAINER_ID = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
/** The name of a container, as Docker allows it. */
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

function parseHeader(fields: string[]): UsageHeader {
  // #H <protocol> <cgroup> <uid|-> <byte mode> <boot id|-> <age of process 1|-> <kernel|->
  if (fields.length !== 8 || fields[1] !== String(USAGE_PROTOCOL)) throw new UsageStreamError('The host answered with an unknown version of the utilization stream.');
  const [, , cgroup, uid, byteMode, bootId, age, kernel] = fields;
  if ((cgroup !== '1' && cgroup !== '2') || (byteMode !== '0' && byteMode !== '1')) throw new UsageStreamError('The first line of the utilization stream is not valid.');
  const header: UsageHeader = { cgroup: cgroup === '2' ? 2 : 1, byteMode: byteMode === '1' };
  if (/^\d{1,10}$/.test(uid)) header.uid = Number(uid);
  if (/^[0-9a-f-]{36}$/.test(bootId)) header.bootId = bootId;
  if (/^-?\d{1,15}$/.test(age)) header.pid1AgeCs = Number(age);
  if (/^[\x21-\x7e]{1,256}$/.test(kernel) && kernel !== '-') header.kernel = kernel;
  return header;
}

/** A block while its lines come. */
class BlockBuilder {
  readonly block: UsageBlock;
  private container: UsageContainer | undefined;
  private names: Map<string, string> | undefined;
  private sizes: { df?: Record<string, unknown>; devspaceImageIds: string[]; helperImageIds: string[]; networks: unknown[]; imageTags: unknown[]; items: number } | undefined;
  private sizesDone = false;
  bytes = 0;
  sizesBytes = 0;

  constructor(seq: number, startCs: bigint) {
    this.block = { seq, startCs, endCs: startCs, cpus: [], memoryKb: {}, pressure: {}, containers: [], skipped: 0 };
  }

  line(text: string): void {
    const fields = text.split(' ');
    const kind = fields[0];
    if (/^cpu\d*$/.test(kind)) return this.cpu(kind, text);
    switch (kind) {
      case 'L':
        return this.load(fields);
      case 'M':
        return this.memory(fields);
      case 'O':
        return this.set(counter(fields[1]), (value) => (this.block.oomKills = value));
      case 'P':
        return this.pressure(fields);
      case 'D':
        return this.disk(fields);
      case 'I':
        if (fields[1] === '0' || fields[1] === '1') this.block.idle = fields[1] === '1';
        else this.block.skipped++;
        return;
      case 'C':
        return this.startContainer(fields);
      case 'N':
      case 'N.':
      case 'N!':
        return this.name(kind, fields);
      case 'Z':
      case 'Z.':
      case 'Z!':
        return this.size(kind, fields, text);
      default:
        if (/^[a-z]$/.test(kind) || kind === 'U') return this.containerLine(kind, fields);
        // A line of a newer script: left out.
        this.block.skipped++;
    }
  }

  private set<T>(value: T | undefined, apply: (value: T) => void): void {
    if (value === undefined) this.block.skipped++;
    else apply(value);
  }

  private cpu(kind: string, text: string): void {
    const columns = text.split(/ +/).slice(1, 9).map(counter);
    if (columns.length < 4 || columns.some((value) => value === undefined)) {
      this.block.skipped++;
      return;
    }
    const values = [...(columns as bigint[]), 0n, 0n, 0n, 0n].slice(0, 8) as unknown as CpuTimes;
    if (kind === 'cpu') {
      this.block.cpu = values;
      return;
    }
    if (this.block.cpus.length >= MAX_USAGE_CPUS) throw new UsageStreamError(`The host named more than ${MAX_USAGE_CPUS} CPUs.`);
    this.block.cpus.push(values);
  }

  private load(fields: string[]): void {
    const values = fields.slice(1, 4).map(decimal);
    if (values.length === 3 && values.every((value) => value !== undefined)) this.block.load = values as unknown as readonly [number, number, number];
    else this.block.skipped++;
  }

  private memory(fields: string[]): void {
    const key = fields[1]?.endsWith(':') ? fields[1].slice(0, -1) : undefined;
    const value = counter(fields[2]);
    if (key !== undefined && MEMORY_KEYS.has(key) && value !== undefined) this.block.memoryKb[key as MemoryKey] = value;
    else this.block.skipped++;
  }

  private pressure(fields: string[]): void {
    // P <cpu|memory|io> <some|full> avg10=<x> avg60=<x> avg300=<x> total=<µs>
    const [, kind, scope] = fields;
    const values = new Map(fields.slice(3).map((field) => [field.split('=')[0], field.split('=')[1]] as const));
    const avg10 = decimal(values.get('avg10'));
    const totalUs = counter(values.get('total'));
    if ((kind !== 'cpu' && kind !== 'memory' && kind !== 'io') || (scope !== 'some' && scope !== 'full') || avg10 === undefined || totalUs === undefined) {
      this.block.skipped++;
      return;
    }
    (this.block.pressure[kind] ??= {})[scope] = { avg10, totalUs };
  }

  private disk(fields: string[]): void {
    // D <fsid> <block size> <blocks> <free> <available> <files> <free files> <path…>
    const numbers = fields.slice(2, 8).map(counter);
    const path = fields.slice(8).join(' ');
    if (!/^[0-9a-f]{1,32}$/.test(fields[1] ?? '') || numbers.length !== 6 || numbers.some((value) => value === undefined) || !path.startsWith('/')) {
      this.block.skipped++;
      return;
    }
    const disks = (this.block.disks ??= []);
    if (disks.length >= MAX_USAGE_DISKS) throw new UsageStreamError(`The host named more than ${MAX_USAGE_DISKS} disks.`);
    const [blockSize, blocks, freeBlocks, availableBlocks, files, freeFiles] = numbers as bigint[];
    disks.push({ fsid: fields[1], blockSize, blocks, freeBlocks, availableBlocks, files, freeFiles, path });
  }

  private startContainer(fields: string[]): void {
    const id = fields[1];
    if (fields.length !== 2 || !CONTAINER_ID.test(id)) throw new UsageStreamError('The host named a container with an ID that is not valid.');
    if (this.block.containers.length >= MAX_USAGE_CONTAINERS) throw new UsageStreamError(`The host named more than ${MAX_USAGE_CONTAINERS} containers.`);
    this.container = { id, memoryStat: {} };
    this.block.containers.push(this.container);
  }

  private containerLine(kind: string, fields: string[]): void {
    const container = this.container;
    if (container === undefined) {
      this.block.skipped++;
      return;
    }
    const value = counter(fields[1]);
    switch (kind) {
      case 'u':
        return this.set(value, (usec) => (container.cpuUsec = usec));
      case 'U':
        return this.set(value, (ns) => (container.cpuUsec = ns / 1000n));
      case 'm':
        return this.set(value, (bytes) => (container.memoryBytes = bytes));
      case 'x':
        if (fields[1] === 'max') return;
        return this.set(value, (bytes) => (container.memoryLimitBytes = bytes));
      case 's': {
        const amount = counter(fields[2]);
        if (MEMORY_STAT_KEYS.has(fields[1] ?? '') && amount !== undefined) container.memoryStat[fields[1] as MemoryStatKey] = amount;
        else this.block.skipped++;
        return;
      }
      case 'k':
        return this.set(value, (count) => (container.oomKills = count));
      case 'i': {
        // i <maj:min> rbytes=<n> wbytes=<n> rios=<n> wios=<n> dbytes=<n> dios=<n>
        for (const field of fields.slice(2)) {
          const [key, text] = field.split('=');
          const amount = counter(text);
          if (amount === undefined) continue;
          if (key === 'rbytes') container.readBytes = (container.readBytes ?? 0n) + amount;
          if (key === 'wbytes') container.writeBytes = (container.writeBytes ?? 0n) + amount;
        }
        return;
      }
      case 'b': {
        // b <maj:min> Read|Write <bytes>
        const amount = counter(fields[3]);
        if (amount === undefined) this.block.skipped++;
        else if (fields[2] === 'Read') container.readBytes = (container.readBytes ?? 0n) + amount;
        else if (fields[2] === 'Write') container.writeBytes = (container.writeBytes ?? 0n) + amount;
        return;
      }
      case 'p':
        return this.set(value, (count) => (container.pids = count));
      case 'n':
        return this.network(container, fields);
      default:
        this.block.skipped++;
    }
  }

  private network(container: UsageContainer, fields: string[]): void {
    if (fields.length === 2) {
      const kind = fields[1] === 'host' ? 'host' : fields[1] === 'none' ? 'none' : fields[1] === '?' ? 'unknown' : undefined;
      if (kind === undefined || (container.network !== undefined && container.network.kind !== kind)) this.block.skipped++;
      else container.network = { kind };
      return;
    }
    const rxBytes = counter(fields[2]);
    const txBytes = counter(fields[3]);
    if (fields.length !== 4 || rxBytes === undefined || txBytes === undefined || (container.network !== undefined && container.network.kind !== 'interfaces')) {
      this.block.skipped++;
      return;
    }
    const sum = container.network ?? { kind: 'interfaces' as const, rxBytes: 0n, txBytes: 0n };
    container.network = { kind: 'interfaces', rxBytes: sum.rxBytes + rxBytes, txBytes: sum.txBytes + txBytes };
  }

  private name(kind: string, fields: string[]): void {
    if (this.block.names !== undefined) {
      this.block.skipped++;
      return;
    }
    if (kind === 'N!') {
      const code = /^\d{1,3}$/.test(fields[1] ?? '') ? Number(fields[1]) : -1;
      this.block.names = { complete: false, exitCode: code };
      return;
    }
    const names = (this.names ??= new Map());
    if (kind === 'N.') {
      this.block.names = { complete: true, names };
      return;
    }
    // N <id> <names>: `docker ps` joins the names of a container with commas (old links); the first is its own.
    const id = fields[1] ?? '';
    const name = (fields[2] ?? '').split(',')[0];
    if (fields.length !== 3 || !CONTAINER_ID.test(id) || !CONTAINER_NAME.test(name)) {
      this.block.skipped++;
      return;
    }
    if (names.size >= MAX_USAGE_CONTAINERS) throw new UsageStreamError(`The host named more than ${MAX_USAGE_CONTAINERS} containers.`);
    names.set(id, name);
  }

  private size(kind: string, fields: string[], text: string): void {
    if (this.sizesDone) {
      this.block.skipped++;
      return;
    }
    if (kind === 'Z!') {
      this.sizesDone = true;
      this.block.sizes = { ok: false, step: /^[a-z]{1,10}$/.test(fields[1] ?? '') ? fields[1] : 'sizes', detail: fields.slice(2).join(' ').slice(0, 100) };
      return;
    }
    const sizes = (this.sizes ??= { devspaceImageIds: [], helperImageIds: [], networks: [], imageTags: [], items: 0 });
    if (kind === 'Z.') {
      this.sizesDone = true;
      this.block.sizes =
        sizes.df === undefined
          ? { ok: false, step: 'df', detail: 'no output' }
          : { ok: true, df: sizes.df, devspaceImageIds: sizes.devspaceImageIds, helperImageIds: sizes.helperImageIds, networks: sizes.networks, imageTags: sizes.imageTags };
      return;
    }
    const step = fields[1];
    const rest = text.slice(`Z ${step} `.length);
    if (++sizes.items > 4 * MAX_USAGE_SIZE_ITEMS) throw new UsageStreamError('The host named too many objects in its sizes.');
    switch (step) {
      case 'df': {
        const value = json(rest);
        if (sizes.df === undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) sizes.df = value as Record<string, unknown>;
        else this.block.skipped++;
        return;
      }
      case 'dev':
      case 'helper':
        if (IMAGE_ID.test(rest)) (step === 'dev' ? sizes.devspaceImageIds : sizes.helperImageIds).push(rest);
        else this.block.skipped++;
        return;
      case 'net':
      case 'tag': {
        const value = json(rest);
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) (step === 'net' ? sizes.networks : sizes.imageTags).push(value);
        else this.block.skipped++;
        return;
      }
      default:
        this.block.skipped++;
    }
  }

  /** The block at its line `#E`. */
  finish(endCs: bigint): UsageBlock {
    this.block.endCs = endCs;
    // Lines `Z` without their end: the sizes read broke off.
    if (this.sizes !== undefined && !this.sizesDone) this.block.sizes = { ok: false, step: 'sizes', detail: 'incomplete' };
    return this.block;
  }
}

function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export interface UsageStreamHandlers {
  /** The line `#H`: the host runs the script. */
  header(header: UsageHeader): void;
  /** The line `#X noproc`: the host has no /proc (it is no Linux); the script ended. */
  notLinux(): void;
  /** A complete block. */
  block(block: UsageBlock): void;
  /** The login printed `bytes` before the marker line (its text is kept only with `keepLoginText`). */
  loginText?(bytes: number): void;
}

/**
 * Reads the standard output of the script (push, as it comes) for the marker `marker` (newUsageMarker). Calls the
 * handlers in the order of the lines; throws UsageStreamError (from push) above a bound or for output that is not of
 * the script; after that, the reader takes nothing more.
 */
export class UsageStreamReader {
  private stage: 'login' | 'header' | 'between' | 'block' | 'done' | 'failed' = 'login';
  private parts: Buffer[] = [];
  private partsLength = 0;
  private loginBytes = 0;
  private builder: BlockBuilder | undefined;
  private readonly markerLine: string;
  private readonly loginLines: Buffer[] | undefined;

  /**
   * `keepLoginText`: keep what came before the marker line (loginOutput), for a transport that writes its own errors
   * there (wsl.exe).
   */
  constructor(
    marker: string,
    private readonly handlers: UsageStreamHandlers,
    options: { keepLoginText?: boolean } = {},
  ) {
    this.markerLine = `@${marker}`;
    this.loginLines = options.keepLoginText === true ? [] : undefined;
  }

  /**
   * With `keepLoginText`: what came before the marker line (at most MAX_USAGE_LOGIN_TEXT), with the incomplete line at
   * its end; else empty.
   */
  loginOutput(): string {
    if (this.loginLines === undefined) return '';
    const pending = this.stage === 'login' ? this.parts : [];
    return Buffer.concat([...this.loginLines, ...pending]).toString('utf8');
  }

  /** After `#X`, or after an error: the reader takes nothing more. */
  private get finished(): boolean {
    return this.stage === 'done' || this.stage === 'failed';
  }

  push(chunk: Buffer): void {
    if (this.finished) return;
    try {
      let start = 0;
      while (start < chunk.length) {
        const end = chunk.indexOf(0x0a, start);
        this.addPart(chunk.subarray(start, end < 0 ? chunk.length : end));
        if (end < 0) return;
        const line = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.partsLength);
        this.parts = [];
        this.partsLength = 0;
        this.line(line);
        start = end + 1;
        if (this.finished) return;
      }
    } catch (error) {
      this.stage = 'failed';
      this.parts = [];
      throw error;
    }
  }

  private addPart(part: Buffer): void {
    if (part.length === 0) return;
    this.parts.push(part);
    this.partsLength += part.length;
    if (this.stage === 'login') {
      if (this.loginBytes + this.partsLength > MAX_USAGE_LOGIN_TEXT + this.markerLine.length) {
        throw new UsageStreamError(`The login printed more than ${MAX_USAGE_LOGIN_TEXT / 1024} KiB before the utilization stream started.`);
      }
      return;
    }
    if (this.partsLength <= MAX_USAGE_LINE) return;
    const first = this.parts[0].length >= 2 ? this.parts[0] : Buffer.concat(this.parts.slice(0, 2));
    const sizesLine = this.stage === 'block' && first[0] === 0x5a && first[1] === 0x20;
    if (!sizesLine) throw new UsageStreamError(`The host printed a line longer than ${MAX_USAGE_LINE / 1024} KiB.`);
    if (this.partsLength > MAX_USAGE_SIZES_LINE) throw new UsageStreamError(`The host printed a line of its sizes longer than ${MAX_USAGE_SIZES_LINE / (1024 * 1024)} MiB.`);
  }

  private line(bytes: Buffer): void {
    if (this.stage === 'login') {
      // The marker ends its line (a pseudo-terminal may add a carriage return). Login text without a final line feed
      // (for example a title escape sequence of a shell profile, or the NUL byte after a UTF-16 line of wsl.exe) may
      // stand before it on the same line: as RemoteShell, the stream starts there.
      const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length;
      const at = end - this.markerLine.length;
      if (at >= 0 && bytes.toString('latin1', at, end) === this.markerLine) {
        if (at > 0) {
          this.loginBytes += at;
          this.loginLines?.push(bytes.subarray(0, at));
        }
        this.stage = 'header';
        if (this.loginBytes > 0) this.handlers.loginText?.(this.loginBytes);
        return;
      }
      this.loginBytes += bytes.length + 1;
      this.loginLines?.push(bytes, Buffer.from('\n'));
      if (this.loginBytes > MAX_USAGE_LOGIN_TEXT) throw new UsageStreamError(`The login printed more than ${MAX_USAGE_LOGIN_TEXT / 1024} KiB before the utilization stream started.`);
      return;
    }
    const text = bytes.toString('utf8');
    const fields = text.split(' ');
    switch (this.stage) {
      case 'header':
        if (text === '#X noproc') {
          this.stage = 'done';
          this.handlers.notLinux();
          return;
        }
        if (fields[0] !== '#H') throw new UsageStreamError('The host did not start the utilization stream.');
        this.stage = 'between';
        this.handlers.header(parseHeader(fields));
        return;
      case 'between': {
        const seq = fields[0] === '#T' && fields.length === 3 && /^[1-9]\d{0,14}$/.test(fields[1]) ? Number(fields[1]) : undefined;
        const start = uptimeCs(fields[2]);
        if (seq === undefined || start === undefined) throw new UsageStreamError('The host printed a line outside of a block of values.');
        this.builder = new BlockBuilder(seq, start);
        this.stage = 'block';
        return;
      }
      case 'block': {
        const builder = this.builder as BlockBuilder;
        if (fields[0] === '#E') {
          const end = uptimeCs(fields[2]);
          if (fields.length !== 3 || fields[1] !== String(builder.block.seq) || end === undefined) throw new UsageStreamError('A block of values of the host has a wrong end.');
          this.builder = undefined;
          this.stage = 'between';
          this.handlers.block(builder.finish(end));
          return;
        }
        if (fields[0].startsWith('Z')) {
          builder.sizesBytes += bytes.length + 1;
          if (builder.sizesBytes > MAX_USAGE_SIZES) throw new UsageStreamError(`The sizes of the host are larger than ${MAX_USAGE_SIZES / (1024 * 1024)} MiB.`);
        } else {
          builder.bytes += bytes.length + 1;
          if (builder.bytes > MAX_USAGE_BLOCK) throw new UsageStreamError(`A block of values of the host is larger than ${MAX_USAGE_BLOCK / 1024} KiB.`);
        }
        builder.line(text);
        return;
      }
    }
  }
}
