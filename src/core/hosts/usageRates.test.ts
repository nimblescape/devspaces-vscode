// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { HOST_SERIES, UsageHistory, cpuShare, usageOf, type HostUsage } from './usageRates';
import type { CpuTimes, UsageBlock, UsageContainer } from './usageStream';

const ID_A = 'a'.repeat(64);

function cpu(...values: number[]): CpuTimes {
  return values.map(BigInt) as unknown as CpuTimes;
}

function block(seq: number, startCs: number, parts: Partial<UsageBlock> = {}): UsageBlock {
  return { seq, startCs: BigInt(startCs), endCs: BigInt(startCs + 2), cpus: [], memoryKb: {}, pressure: {}, containers: [], skipped: 0, ...parts };
}

function container(parts: Partial<UsageContainer>): UsageContainer {
  return { id: ID_A, memoryStat: {}, ...parts };
}

describe('cpuShare', () => {
  it('gives busy, iowait and steal of the difference of two lines cpu', () => {
    // Δ: user 50, system 10, idle 30, iowait 5, steal 5 → total 100.
    expect(cpuShare(cpu(100, 0, 20, 1000, 10, 0, 0, 0), cpu(150, 0, 30, 1030, 15, 0, 0, 5))).toEqual({ busy: 65, iowait: 5, steal: 5 });
  });

  it('counts a column that went down as 0, and gives nothing without any difference', () => {
    expect(cpuShare(cpu(100, 0, 0, 100, 0, 0, 0, 0), cpu(90, 0, 0, 200, 0, 0, 0, 0))).toEqual({ busy: 0, iowait: 0, steal: 0 });
    expect(cpuShare(cpu(1, 1, 1, 1, 1, 1, 1, 1), cpu(1, 1, 1, 1, 1, 1, 1, 1))).toBeUndefined();
  });
});

describe('usageOf', () => {
  it('gives the rates of the host and of a container from the block before', () => {
    const first = block(1, 1000, {
      cpu: cpu(100, 0, 20, 1000, 10, 0, 0, 0),
      cpus: [cpu(50, 0, 10, 500, 5, 0, 0, 0), cpu(50, 0, 10, 500, 5, 0, 0, 0)],
      pressure: { io: { some: { avg10: 1.5, totalUs: 1_000_000n } } },
      containers: [container({ cpuUsec: 1_000_000n, network: { kind: 'interfaces', rxBytes: 1000n, txBytes: 0n }, readBytes: 0n, writeBytes: 100n })],
    });
    const second = block(2, 1200, {
      cpu: cpu(150, 0, 30, 1030, 15, 0, 0, 5),
      cpus: [cpu(100, 0, 10, 500, 5, 0, 0, 0), cpu(50, 0, 10, 600, 5, 0, 0, 0)],
      pressure: { io: { some: { avg10: 2, totalUs: 1_500_000n } } },
      // 2 s; 3 s of CPU time is 150 % (one and a half CPUs).
      containers: [container({ cpuUsec: 4_000_000n, network: { kind: 'interfaces', rxBytes: 3000n, txBytes: 0n }, readBytes: 400n, writeBytes: 100n })],
    });
    const usage = usageOf(second, first);
    expect(usage.intervalCs).toBe(200);
    expect(usage.cpu).toEqual({ busy: 65, iowait: 5, steal: 5 });
    expect(usage.cpus).toEqual([
      { busy: 100, iowait: 0, steal: 0 },
      { busy: 0, iowait: 0, steal: 0 },
    ]);
    expect(usage.cpuCount).toBe(2);
    // 0.5 s stalled in 2 s.
    expect(usage.pressure).toEqual({ io: { some: { avg10: 2, share: 25 } } });
    expect(usage.containers).toEqual([{ id: ID_A, cpuPercent: 150, network: 'interfaces', netRxBytes: 3000, netTxBytes: 0, netRxRate: 1000, netTxRate: 0, readBytes: 400, writeBytes: 100, readRate: 200, writeRate: 0 }]);
  });

  it('gives no rates in the first block, after a gap in the numbers, or when the uptime did not go up', () => {
    const first = block(1, 1000, { cpu: cpu(1, 0, 0, 1, 0, 0, 0, 0), containers: [container({ cpuUsec: 1n })] });
    const values = (usage: HostUsage) => [usage.intervalCs, usage.cpu, usage.containers[0]?.cpuPercent];
    expect(values(usageOf(first))).toEqual([undefined, undefined, undefined]);
    expect(values(usageOf(block(3, 1200, { cpu: cpu(2, 0, 0, 2, 0, 0, 0, 0), containers: [container({ cpuUsec: 2n })] }), first))).toEqual([undefined, undefined, undefined]);
    expect(values(usageOf(block(2, 1000, { cpu: cpu(2, 0, 0, 2, 0, 0, 0, 0), containers: [container({ cpuUsec: 2n })] }), first))).toEqual([undefined, undefined, undefined]);
  });

  it('gives no rate of a container whose counters went down (it started again)', () => {
    const first = block(1, 1000, { containers: [container({ cpuUsec: 5000n, network: { kind: 'interfaces', rxBytes: 500n, txBytes: 500n }, readBytes: 10n })] });
    const usage = usageOf(block(2, 1100, { containers: [container({ cpuUsec: 10n, network: { kind: 'interfaces', rxBytes: 1n, txBytes: 600n }, readBytes: 1n })] }), first);
    expect(usage.containers[0]).toEqual({ id: ID_A, network: 'interfaces', netRxBytes: 1, netTxBytes: 600, netTxRate: 100, readBytes: 1 });
  });

  it('gives the memory of a container as docker stats does, and no limit for about 2^63', () => {
    const usage = usageOf(
      block(1, 1000, {
        containers: [
          container({ memoryBytes: 1000n, memoryStat: { inactive_file: 300n }, memoryLimitBytes: 4096n, pids: 3n, oomKills: 1n }),
          container({ id: 'b'.repeat(64), memoryBytes: 1000n, memoryStat: { total_inactive_file: 2000n }, memoryLimitBytes: 9223372036854771712n, network: { kind: 'host' } }),
        ],
      }),
    );
    expect(usage.containers).toEqual([
      { id: ID_A, memoryBytes: 700, memoryLimitBytes: 4096, pids: 3, oomKills: 1 },
      { id: 'b'.repeat(64), memoryBytes: 0, network: 'host' },
    ]);
  });

  it('gives the memory, the load and the OOM count of the host from one block', () => {
    const usage = usageOf(
      block(1, 1000, {
        load: [0.1, 0.5, 1],
        oomKills: 2n,
        memoryKb: { MemTotal: 1000n, MemAvailable: 400n, Buffers: 10n, Cached: 90n, SwapTotal: 100n, SwapFree: 60n },
      }),
    );
    expect(usage.load).toEqual([0.1, 0.5, 1]);
    expect(usage.oomKills).toBe(2);
    expect(usage.memory).toEqual({ totalBytes: 1024000, usedBytes: 614400, availableBytes: 409600, cacheBytes: 102400, swapTotalBytes: 102400, swapUsedBytes: 40960 });
  });

  it('names a file system once with all its folders', () => {
    const disk = { fsid: 'ab', blockSize: 4096n, blocks: 100n, freeBlocks: 40n, availableBlocks: 30n, files: 1000n, freeFiles: 900n, path: '/var/lib/docker' };
    const usage = usageOf(block(1, 1000, { disks: [disk, { ...disk, path: '/var/lib/containerd' }, { ...disk, fsid: 'cd', path: '/data/docker' }] }));
    expect(usage.disks).toEqual([
      { paths: ['/var/lib/docker', '/var/lib/containerd'], sizeBytes: 409600, usedBytes: 245760, freeBytes: 122880, files: 1000, freeFiles: 900 },
      { paths: ['/data/docker'], sizeBytes: 409600, usedBytes: 245760, freeBytes: 122880, files: 1000, freeFiles: 900 },
    ]);
  });

  it('names file systems without an ID (0) apart unless their numbers are the same', () => {
    const disk = { fsid: '0', blockSize: 4096n, blocks: 100n, freeBlocks: 40n, availableBlocks: 30n, files: 1000n, freeFiles: 900n, path: '/a' };
    const usage = usageOf(block(1, 1000, { disks: [disk, { ...disk, blocks: 200n, path: '/b' }, { ...disk, path: '/c' }] }));
    expect(usage.disks?.map((value) => value.paths)).toEqual([['/a', '/c'], ['/b']]);
  });

  it('subtracts in BigInt, so counters above 2^53 give exact rates', () => {
    const big = 2n ** 60n;
    const usage = usageOf(block(2, 1100, { containers: [container({ cpuUsec: big + 2_000_000n })] }), block(1, 1000, { containers: [container({ cpuUsec: big })] }));
    expect(usage.containers[0].cpuPercent).toBe(200);
  });
});

function usage(seq: number, parts: Partial<HostUsage> = {}): HostUsage {
  return { seq, cpuCount: 1, pressure: {}, containers: [], ...parts };
}

describe('UsageHistory', () => {
  it('keeps the newest points of each series, with null for a gap and for a missing value', () => {
    const history = new UsageHistory(3, 2, 10);
    history.add(usage(1, { cpu: { busy: 10, iowait: 1, steal: 0 } }));
    history.gap();
    history.add(usage(2, { cpu: { busy: 20, iowait: 2, steal: 0 } }));
    history.add(usage(3, { load: [1, 2, 3] }));
    const host = history.snapshot().host;
    expect(Object.keys(host)).toEqual([...HOST_SERIES]);
    expect(host.busy).toEqual([null, 20, null]);
    expect(host.load1).toEqual([null, null, 1]);
  });

  it('keeps the last free space of the disks until the next gap (the disks come in every fifth block)', () => {
    const history = new UsageHistory(10, 2, 10);
    history.add(usage(1));
    history.add(usage(2, { disks: [{ paths: ['/a'], sizeBytes: 10, usedBytes: 5, freeBytes: 4, files: 1, freeFiles: 1 }, { paths: ['/b'], sizeBytes: 10, usedBytes: 5, freeBytes: 2, files: 1, freeFiles: 1 }] }));
    history.add(usage(3));
    history.gap();
    history.add(usage(4));
    expect(history.snapshot().host.diskFree).toEqual([null, 6, 6, null, null]);
  });

  it('keeps the history of the busiest containers only, and forgets everything on clear', () => {
    const history = new UsageHistory(10, 2, 2);
    const ids = ['1', '2', '3'].map((digit) => digit.repeat(64));
    history.add(usage(1, { containers: [{ id: ids[0], cpuPercent: 5 }, { id: ids[1], cpuPercent: 50 }, { id: ids[2], cpuPercent: 20, memoryBytes: 9 }] }));
    history.add(usage(2, { containers: [{ id: ids[1], cpuPercent: 60 }, { id: ids[2], cpuPercent: 30, memoryBytes: 10 }, { id: ids[0], cpuPercent: 1 }] }));
    history.add(usage(3, { containers: [{ id: ids[1], cpuPercent: 70 }, { id: ids[2], cpuPercent: 40, memoryBytes: 11 }] }));
    expect(history.snapshot().containers).toEqual({
      [ids[1]]: { cpu: [60, 70], memory: [null, null] },
      [ids[2]]: { cpu: [30, 40], memory: [10, 11] },
    });
    history.clear();
    expect(history.snapshot()).toEqual({ host: Object.fromEntries(HOST_SERIES.map((series) => [series, []])), containers: {} });
  });
});
