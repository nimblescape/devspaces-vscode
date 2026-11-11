// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reader of the utilization samples of a host (docs/architecture.md "The utilization samples"): the output of one
// run of USAGE_SCRIPT (usageScript.ts) as lines, from the marker line on: the line `#H`, then one block from `#T <seq>`
// to `#E <seq>`, which this reader turns into a UsageBlock with every counter as a BigInt. The output of the host is not
// trusted: every line and every block has a bound, and above a bound the reader throws UsageSampleError, so the sample
// counts as failed. A line that the reader does not know is left out, and so is a value that it cannot read: a missing
// value is no value, not an error. Also the names of `docker ps` (parseUsageNames). No `vscode`.
import { USAGE_PROTOCOL } from './usageScript';

/** The longest line (bytes, without its line feed). */
export const MAX_USAGE_LINE = 4 * 1024;
/** The most bytes of the lines of one block. */
export const MAX_USAGE_BLOCK = 512 * 1024;
/** The most containers of one block (lines `C`), and the most names of `docker ps`. */
export const MAX_USAGE_CONTAINERS = 500;
/** The most CPUs (lines `cpuN`). */
export const MAX_USAGE_CPUS = 1024;
/** The most characters of the output of one sample: the marker line, the line `#H` and one block, with room. */
const MAX_USAGE_OUTPUT = MAX_USAGE_BLOCK + 4 * (MAX_USAGE_LINE + 2);
/** The most folders of the disks (lines `D`): the script names at most four. */
const MAX_USAGE_DISKS = 8;

/** The output of the host broke a bound, or is not the output of USAGE_SCRIPT. The sample failed. */
export class UsageSampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageSampleError';
  }
}

/** The line `#H` of the script: what the host is. */
export interface UsageHeader {
  /** The version of the cgroups: 2 (unified), else 1 (also the hybrid layout). */
  cgroup: 1 | 2;
  /** The user ID of the shell on the host. */
  uid?: number;
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

/** One block: the values of one sample. */
export interface UsageBlock {
  /** The number of the sample, from 1. */
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
  /** Only in a sample `d`. */
  disks?: UsageDisk[];
  /** Only on WSL, in a sample `d`: whether the idle script of a keeper runs. */
  idle?: boolean;
  containers: UsageContainer[];
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
/** The name of a container, as Docker allows it. */
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/**
 * The names of the containers from the output of `docker ps --no-trunc --format '{{.ID}} {{.Names}}'` (USAGE_NAMES_ARGS
 * of usageSampler.ts): by the ID, the first name of each (`docker ps` joins the names of a container with commas, for
 * old links). A line that is not valid is left out. Throws UsageSampleError above MAX_USAGE_CONTAINERS names.
 */
export function parseUsageNames(stdout: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(' ');
    const id = fields[0] ?? '';
    const name = (fields[1] ?? '').split(',')[0];
    if (fields.length !== 2 || !CONTAINER_ID.test(id) || !CONTAINER_NAME.test(name)) continue;
    if (names.size >= MAX_USAGE_CONTAINERS) throw new UsageSampleError(`The host named more than ${MAX_USAGE_CONTAINERS} containers.`);
    names.set(id, name);
  }
  return names;
}

function parseHeader(fields: string[]): UsageHeader {
  // #H <protocol> <cgroup> <uid|-> <boot id|-> <age of process 1|-> <kernel|->
  if (fields.length !== 7 || fields[1] !== String(USAGE_PROTOCOL)) throw new UsageSampleError('The host answered with an unknown version of the utilization sample.');
  const [, , cgroup, uid, bootId, age, kernel] = fields;
  if (cgroup !== '1' && cgroup !== '2') throw new UsageSampleError('The first line of the utilization sample is not valid.');
  const header: UsageHeader = { cgroup: cgroup === '2' ? 2 : 1 };
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
  bytes = 0;

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
    if (this.block.cpus.length >= MAX_USAGE_CPUS) throw new UsageSampleError(`The host named more than ${MAX_USAGE_CPUS} CPUs.`);
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
    if (disks.length >= MAX_USAGE_DISKS) throw new UsageSampleError(`The host named more than ${MAX_USAGE_DISKS} disks.`);
    const [blockSize, blocks, freeBlocks, availableBlocks, files, freeFiles] = numbers as bigint[];
    disks.push({ fsid: fields[1], blockSize, blocks, freeBlocks, availableBlocks, files, freeFiles, path });
  }

  private startContainer(fields: string[]): void {
    const id = fields[1];
    if (fields.length !== 2 || !CONTAINER_ID.test(id)) throw new UsageSampleError('The host named a container with an ID that is not valid.');
    if (this.block.containers.length >= MAX_USAGE_CONTAINERS) throw new UsageSampleError(`The host named more than ${MAX_USAGE_CONTAINERS} containers.`);
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

  /** The block at its line `#E`. */
  finish(endCs: bigint): UsageBlock {
    this.block.endCs = endCs;
    return this.block;
  }
}

/** The output of one sample: its line `#H` and its block, or `notLinux` (the line `#X noproc`: the host has no /proc). */
export type UsageSampleOutput = { kind: 'block'; header: UsageHeader; block: UsageBlock } | { kind: 'notLinux' };

/**
 * Reads the standard output of one run of USAGE_SCRIPT with the marker `marker` and the number `seq`: the marker line
 * `@<marker>` (a pseudo-terminal may add a carriage return), the line `#H`, and one block `#T <seq>` to `#E <seq>`.
 * Throws UsageSampleError above a bound, for output that is not of the script, and for a block that is not complete.
 */
export function readUsageSample(stdout: string, marker: string, seq: number): UsageSampleOutput {
  // At most the marker line, the line `#H` and one block (the shell allows much more): checked before the split.
  if (stdout.length > MAX_USAGE_OUTPUT) throw new UsageSampleError(`The host printed more than ${Math.round(MAX_USAGE_OUTPUT / 1024)} KiB for one utilization sample.`);
  const lines = stdout.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let stage: 'marker' | 'header' | 'between' | 'block' | 'done' = 'marker';
  let header: UsageHeader | undefined;
  let builder: BlockBuilder | undefined;
  let block: UsageBlock | undefined;
  for (const raw of lines) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_USAGE_LINE) throw new UsageSampleError(`The host printed a line longer than ${MAX_USAGE_LINE / 1024} KiB.`);
    const fields = text.split(' ');
    switch (stage) {
      case 'marker':
        if (text !== `@${marker}`) throw new UsageSampleError('The host did not run the utilization sample.');
        stage = 'header';
        break;
      case 'header':
        if (text === '#X noproc') return { kind: 'notLinux' };
        if (fields[0] !== '#H') throw new UsageSampleError('The host did not run the utilization sample.');
        header = parseHeader(fields);
        stage = 'between';
        break;
      case 'between': {
        const start = uptimeCs(fields[2]);
        if (fields[0] !== '#T' || fields.length !== 3 || fields[1] !== String(seq) || start === undefined) throw new UsageSampleError('The host printed a line outside of a block of values.');
        builder = new BlockBuilder(seq, start);
        stage = 'block';
        break;
      }
      case 'block': {
        const current = builder as BlockBuilder;
        if (fields[0] === '#E') {
          const end = uptimeCs(fields[2]);
          if (fields.length !== 3 || fields[1] !== String(seq) || end === undefined) throw new UsageSampleError('A block of values of the host has a wrong end.');
          block = current.finish(end);
          stage = 'done';
          break;
        }
        current.bytes += bytes + 1;
        if (current.bytes > MAX_USAGE_BLOCK) throw new UsageSampleError(`A block of values of the host is larger than ${MAX_USAGE_BLOCK / 1024} KiB.`);
        current.line(text);
        break;
      }
      case 'done':
        throw new UsageSampleError('The host printed a line after the block of values.');
    }
  }
  if (header === undefined || block === undefined) throw new UsageSampleError('The utilization sample of the host is not complete.');
  return { kind: 'block', header, block };
}
