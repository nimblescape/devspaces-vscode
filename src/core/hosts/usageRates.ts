// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The values of the utilization page from the blocks of the utilization samples (usageSample.ts), and their history
// (docs/architecture.md "The utilization samples"). A rate (CPU, network, disk I/O) comes from the blocks of two
// samples in a row of one sampler and one start of the kernel: the difference of the counters, as BigInt, divided by
// the difference of the uptime of the host at the start of each block. So a slow transport does not change a rate. No rate when a counter went down (a container
// started again). No `vscode`.
import type { CpuTimes, PressureKind, UsageBlock, UsageContainer, UsageNetwork } from './usageSample';

/** The share of CPU time in percent (0 to 100): busy (all but idle and iowait), iowait, and steal. */
export interface CpuShare {
  busy: number;
  iowait: number;
  steal: number;
}

/** A value of /proc/pressure: avg10 of the kernel, and the exact share since the last block (0 to 100). */
export interface PressureValue {
  avg10: number;
  share?: number;
}

/** A file system of the Docker data (the folders on one file system once). */
export interface DiskValue {
  /** The folders on it, in the order of the script. */
  paths: string[];
  sizeBytes: number;
  usedBytes: number;
  /** What a user who is not root may still use. */
  freeBytes: number;
  files: number;
  freeFiles: number;
}

/** The values of one container. Rates are per second; undefined in the first block and after a reset. */
export interface ContainerUsage {
  id: string;
  /** 100 = one CPU. */
  cpuPercent?: number;
  /** The memory as `docker stats` shows it: the usage without the inactive file cache. */
  memoryBytes?: number;
  memoryLimitBytes?: number;
  oomKills?: number;
  pids?: number;
  /** `interfaces`: the counters below; `host`, `unknown`: no own counters; `none`: only `lo`. */
  network?: UsageNetwork['kind'];
  netRxBytes?: number;
  netTxBytes?: number;
  netRxRate?: number;
  netTxRate?: number;
  readBytes?: number;
  writeBytes?: number;
  readRate?: number;
  writeRate?: number;
}

/** The values of the host from one block. */
export interface HostUsage {
  seq: number;
  /** The time since the previous block in 1/100 s, when the rates come from it. */
  intervalCs?: number;
  cpu?: CpuShare;
  cpus?: CpuShare[];
  /** The number of CPUs (lines `cpuN`). */
  cpuCount: number;
  load?: readonly [number, number, number];
  memory?: { totalBytes: number; usedBytes: number; availableBytes: number; cacheBytes?: number; swapTotalBytes?: number; swapUsedBytes?: number };
  pressure: Partial<Record<PressureKind, { some?: PressureValue; full?: PressureValue }>>;
  /** The processes that the kernel ended for lack of memory, since its start. */
  oomKills?: number;
  /** Only from the answer to `d` and `s`. */
  disks?: DiskValue[];
  containers: ContainerUsage[];
}

/** A memory limit from this value on is no limit (cgroup v1 writes about 2^63 for none). */
const NO_LIMIT = 2n ** 62n;

/** a - b, or undefined when b is larger (the counter started again). */
function delta(a: bigint | undefined, b: bigint | undefined): bigint | undefined {
  return a === undefined || b === undefined || a < b ? undefined : a - b;
}

/** `amount` per second over `intervalCs`. */
function perSecond(amount: bigint | undefined, intervalCs: bigint | undefined): number | undefined {
  return amount === undefined || intervalCs === undefined ? undefined : (Number(amount) * 100) / Number(intervalCs);
}

function percent(part: bigint, whole: bigint): number {
  return whole <= 0n ? 0 : Math.min(100, Math.max(0, (Number(part) * 100) / Number(whole)));
}

/** The CPU shares between two lines `cpu`. Each column that went down counts as 0. */
export function cpuShare(previous: CpuTimes, current: CpuTimes): CpuShare | undefined {
  const d = current.map((value, index) => (value >= previous[index] ? value - previous[index] : 0n));
  const total = d.reduce((sum, value) => sum + value, 0n);
  if (total <= 0n) return undefined;
  const [, , , idle, iowait, , , steal] = d;
  return { busy: percent(total - idle - iowait, total), iowait: percent(iowait, total), steal: percent(steal, total) };
}

function containerUsage(current: UsageContainer, previous: UsageContainer | undefined, intervalCs: bigint | undefined): ContainerUsage {
  const usage: ContainerUsage = { id: current.id };
  if (previous !== undefined && intervalCs !== undefined) {
    const cpu = delta(current.cpuUsec, previous.cpuUsec);
    // µs per 1/100 s: Δµs / (Δcs × 10 000) is the share of one CPU; × 100 is percent.
    if (cpu !== undefined) usage.cpuPercent = Number(cpu) / (Number(intervalCs) * 100);
  }
  if (current.memoryBytes !== undefined) {
    const stat = current.memoryStat;
    const inactive = stat.inactive_file ?? stat.total_inactive_file ?? 0n;
    usage.memoryBytes = Number(current.memoryBytes > inactive ? current.memoryBytes - inactive : 0n);
  }
  if (current.memoryLimitBytes !== undefined && current.memoryLimitBytes < NO_LIMIT) usage.memoryLimitBytes = Number(current.memoryLimitBytes);
  if (current.oomKills !== undefined) usage.oomKills = Number(current.oomKills);
  if (current.pids !== undefined) usage.pids = Number(current.pids);
  const network = current.network;
  if (network !== undefined) usage.network = network.kind;
  if (network?.kind === 'interfaces') {
    usage.netRxBytes = Number(network.rxBytes);
    usage.netTxBytes = Number(network.txBytes);
    const before = previous?.network?.kind === 'interfaces' ? previous.network : undefined;
    const rx = perSecond(delta(network.rxBytes, before?.rxBytes), intervalCs);
    const tx = perSecond(delta(network.txBytes, before?.txBytes), intervalCs);
    if (rx !== undefined) usage.netRxRate = rx;
    if (tx !== undefined) usage.netTxRate = tx;
  }
  if (current.readBytes !== undefined) usage.readBytes = Number(current.readBytes);
  if (current.writeBytes !== undefined) usage.writeBytes = Number(current.writeBytes);
  const read = perSecond(delta(current.readBytes, previous?.readBytes), intervalCs);
  const write = perSecond(delta(current.writeBytes, previous?.writeBytes), intervalCs);
  if (read !== undefined) usage.readRate = read;
  if (write !== undefined) usage.writeRate = write;
  return usage;
}

/**
 * The values of `current`, with the rates from `previous` when it is the block of the sample before it (its `seq` is
 * one less, and the uptime went up; the sampler gives no `previous` of another start of the kernel). Memory, load, disks and the counts come from `current` alone.
 */
export function usageOf(current: UsageBlock, previous?: UsageBlock): HostUsage {
  const intervalCs = previous !== undefined && previous.seq + 1 === current.seq && current.startCs > previous.startCs ? current.startCs - previous.startCs : undefined;
  const before = intervalCs === undefined ? undefined : previous;
  const usage: HostUsage = { seq: current.seq, cpuCount: current.cpus.length, pressure: {}, containers: [] };
  if (intervalCs !== undefined) usage.intervalCs = Number(intervalCs);
  if (before?.cpu !== undefined && current.cpu !== undefined) {
    const share = cpuShare(before.cpu, current.cpu);
    if (share !== undefined) usage.cpu = share;
  }
  if (before !== undefined && before.cpus.length === current.cpus.length && current.cpus.length > 0) {
    usage.cpus = current.cpus.map((times, index) => cpuShare(before.cpus[index], times) ?? { busy: 0, iowait: 0, steal: 0 });
  }
  if (current.load !== undefined) usage.load = current.load;
  const memory = current.memoryKb;
  if (memory.MemTotal !== undefined && memory.MemAvailable !== undefined) {
    const kib = (value: bigint) => Number(value) * 1024;
    const total = memory.MemTotal;
    const available = memory.MemAvailable < total ? memory.MemAvailable : total;
    usage.memory = { totalBytes: kib(total), usedBytes: kib(total - available), availableBytes: kib(available) };
    if (memory.Buffers !== undefined && memory.Cached !== undefined) usage.memory.cacheBytes = kib(memory.Buffers + memory.Cached);
    if (memory.SwapTotal !== undefined && memory.SwapFree !== undefined) {
      usage.memory.swapTotalBytes = kib(memory.SwapTotal);
      usage.memory.swapUsedBytes = kib(memory.SwapTotal > memory.SwapFree ? memory.SwapTotal - memory.SwapFree : 0n);
    }
  }
  for (const kind of ['cpu', 'memory', 'io'] as const) {
    const lines = current.pressure[kind];
    if (lines === undefined) continue;
    const values: { some?: PressureValue; full?: PressureValue } = {};
    for (const scope of ['some', 'full'] as const) {
      const line = lines[scope];
      if (line === undefined) continue;
      const value: PressureValue = { avg10: line.avg10 };
      const stalled = delta(line.totalUs, before?.pressure[kind]?.[scope]?.totalUs);
      // The stall time in µs over the interval in 1/100 s (10 000 µs each).
      if (stalled !== undefined && intervalCs !== undefined) value.share = Math.min(100, (Number(stalled) * 100) / (Number(intervalCs) * 10_000));
      values[scope] = value;
    }
    usage.pressure[kind] = values;
  }
  if (current.oomKills !== undefined) usage.oomKills = Number(current.oomKills);
  if (current.disks !== undefined) {
    const byFs = new Map<string, DiskValue>();
    for (const disk of current.disks) {
      // One file system once; a file system without an ID (0: FUSE, an older tmpfs) by its numbers too.
      const key = /^0+$/.test(disk.fsid) ? `0:${disk.blockSize}:${disk.blocks}:${disk.files}` : disk.fsid;
      const known = byFs.get(key);
      if (known !== undefined) {
        known.paths.push(disk.path);
        continue;
      }
      const used = disk.blocks > disk.freeBlocks ? disk.blocks - disk.freeBlocks : 0n;
      byFs.set(key, {
        paths: [disk.path],
        sizeBytes: Number(disk.blocks * disk.blockSize),
        usedBytes: Number(used * disk.blockSize),
        freeBytes: Number(disk.availableBlocks * disk.blockSize),
        files: Number(disk.files),
        freeFiles: Number(disk.freeFiles),
      });
    }
    usage.disks = [...byFs.values()];
  }
  const earlier = new Map((before?.containers ?? []).map((container) => [container.id, container]));
  usage.containers = current.containers.map((container) => containerUsage(container, earlier.get(container.id), intervalCs));
  return usage;
}

/** The series of the host in the history. */
export type HostSeries = 'busy' | 'iowait' | 'steal' | 'load1' | 'memoryUsed' | 'swapUsed' | 'cpuPressure' | 'memoryPressure' | 'ioPressure' | 'diskFree';
export const HOST_SERIES: readonly HostSeries[] = ['busy', 'iowait', 'steal', 'load1', 'memoryUsed', 'swapUsed', 'cpuPressure', 'memoryPressure', 'ioPressure', 'diskFree'];

/** The points of each series of the host (at 2 s, 10 minutes). */
export const USAGE_HISTORY_POINTS = 300;
/** The points of each series of a container. */
export const CONTAINER_HISTORY_POINTS = 60;
/** The containers with a history: the busiest by CPU of the last block. */
export const MAX_CONTAINER_HISTORIES = 200;

/** A ring of numbers; NaN is a gap (shown as null). */
class Ring {
  private readonly values: Float64Array;
  private next = 0;
  private size = 0;

  constructor(capacity: number) {
    this.values = new Float64Array(capacity).fill(Number.NaN);
  }

  push(value: number | undefined): void {
    this.values[this.next] = value ?? Number.NaN;
    this.next = (this.next + 1) % this.values.length;
    this.size = Math.min(this.size + 1, this.values.length);
  }

  /** The points, the oldest first; a gap is null (JSON has no NaN). */
  points(): Array<number | null> {
    const points: Array<number | null> = [];
    const start = (this.next - this.size + this.values.length) % this.values.length;
    for (let i = 0; i < this.size; i++) {
      const value = this.values[(start + i) % this.values.length];
      points.push(Number.isNaN(value) ? null : value);
    }
    return points;
  }

  get empty(): boolean {
    return this.points().every((value) => value === null);
  }
}

/** The history of the page of a host: what a page that opens again (its context is not kept while hidden) draws first. */
export interface UsageHistorySnapshot {
  host: Record<HostSeries, Array<number | null>>;
  containers: Record<string, { cpu: Array<number | null>; memory: Array<number | null> }>;
}

/**
 * The history of the values of a host: a ring per series (USAGE_HISTORY_POINTS), and for the busiest containers
 * (MAX_CONTAINER_HISTORIES) a ring of CPU and of memory (CONTAINER_HISTORY_POINTS). `gap` marks a pause or new
 * samples after an end; `clear` forgets everything (a new start of the kernel).
 */
export class UsageHistory {
  private host = new Map<HostSeries, Ring>();
  private containers = new Map<string, { cpu: Ring; memory: Ring }>();
  /** The last free space of the disks: the disks come only in every fifth block. */
  private diskFree: number | undefined;

  constructor(
    private readonly hostPoints: number = USAGE_HISTORY_POINTS,
    private readonly containerPoints: number = CONTAINER_HISTORY_POINTS,
    private readonly maxContainers: number = MAX_CONTAINER_HISTORIES,
  ) {
    this.clear();
  }

  clear(): void {
    this.host = new Map(HOST_SERIES.map((series) => [series, new Ring(this.hostPoints)]));
    this.containers = new Map();
    this.diskFree = undefined;
  }

  /** A gap in every series: the time between an end of the samples and new samples, or a pause. */
  gap(): void {
    for (const ring of this.host.values()) ring.push(undefined);
    for (const rings of this.containers.values()) {
      rings.cpu.push(undefined);
      rings.memory.push(undefined);
    }
    this.diskFree = undefined;
  }

  add(usage: HostUsage): void {
    if (usage.disks !== undefined) this.diskFree = usage.disks.reduce((sum, disk) => sum + disk.freeBytes, 0);
    const values: Record<HostSeries, number | undefined> = {
      busy: usage.cpu?.busy,
      iowait: usage.cpu?.iowait,
      steal: usage.cpu?.steal,
      load1: usage.load?.[0],
      memoryUsed: usage.memory?.usedBytes,
      swapUsed: usage.memory?.swapUsedBytes,
      cpuPressure: usage.pressure.cpu?.some?.avg10,
      memoryPressure: usage.pressure.memory?.some?.avg10,
      ioPressure: usage.pressure.io?.some?.avg10,
      diskFree: this.diskFree,
    };
    for (const series of HOST_SERIES) this.host.get(series)?.push(values[series]);
    // The busiest containers keep their history; one that leaves this set starts anew when it comes back.
    const busiest = [...usage.containers].sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1)).slice(0, this.maxContainers);
    const next = new Map<string, { cpu: Ring; memory: Ring }>();
    for (const container of busiest) {
      const rings = this.containers.get(container.id) ?? { cpu: new Ring(this.containerPoints), memory: new Ring(this.containerPoints) };
      rings.cpu.push(container.cpuPercent);
      rings.memory.push(container.memoryBytes);
      next.set(container.id, rings);
    }
    this.containers = next;
  }

  snapshot(): UsageHistorySnapshot {
    const host = Object.fromEntries(HOST_SERIES.map((series) => [series, this.host.get(series)?.points() ?? []])) as Record<HostSeries, Array<number | null>>;
    const containers: UsageHistorySnapshot['containers'] = {};
    for (const [id, rings] of this.containers) {
      if (rings.cpu.empty && rings.memory.empty) continue;
      containers[id] = { cpu: rings.cpu.points(), memory: rings.memory.points() };
    }
    return { host, containers };
  }
}
