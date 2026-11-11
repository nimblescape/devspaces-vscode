// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { MAX_USAGE_BLOCK, MAX_USAGE_CONTAINERS, MAX_USAGE_CPUS, MAX_USAGE_LINE, UsageSampleError, parseUsageNames, readUsageSample, type UsageBlock } from './usageSample';

const MARKER = '0123456789abcdef0123456789abcdef';
const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const HEADER = '#H 2 2 0 c979624d-e703-46d3-ae35-c4cb34a59e91 66722 6.18.44-test';

/** A block as the script prints it on a cgroup v2 host with one container. */
function blockText(seq: number, extra: string[] = []): string {
  return [
    `#T ${seq} 668.49`,
    'cpu  32524 0 6179 223645 3302 0 756 501 0 0',
    'cpu0 7595 0 1565 56590 659 0 302 117 0 0',
    'cpu1 8268 0 1570 55793 767 0 166 146 0 0',
    'L 0.10 0.53 0.38 6/169 15810',
    'M MemTotal: 16472084',
    'M MemFree: 15340340',
    'M MemAvailable: 15877104',
    'M Buffers: 49104',
    'M Cached: 701652',
    'M SwapTotal: 0',
    'M SwapFree: 0',
    'O 3',
    'P cpu some avg10=0.00 avg60=0.07 avg300=1.31 total=14261825',
    'P io full avg10=1.61 avg60=1.36 avg300=1.09 total=14193952',
    `C ${ID_A}`,
    'u 737678',
    'm 4448256',
    'x max',
    's anon 143360',
    's file 3342336',
    's inactive_file 3215360',
    'k 1',
    'i 8:0 rbytes=100 wbytes=200 rios=1 wios=2 dbytes=0 dios=0',
    'i 8:16 rbytes=1 wbytes=2 rios=1 wios=2 dbytes=0 dios=0',
    'p 7',
    'n eth0 10 84',
    'n eth1 5 6',
    ...extra,
    `#E ${seq} 668.77`,
    '',
  ].join('\n');
}

/** The block of `text` (the output of one sample), which must have one. */
function blockOf(text: string, seq = 1): UsageBlock {
  const output = readUsageSample(text, MARKER, seq);
  if (output.kind !== 'block') throw new Error('no block');
  return output.block;
}

describe('readUsageSample', () => {
  it('reads the header and the block with every counter as a BigInt', () => {
    const output = readUsageSample(`@${MARKER}\n${HEADER}\n${blockText(1)}`, MARKER, 1);
    expect(output.kind).toBe('block');
    if (output.kind !== 'block') return;
    expect(output.header).toEqual({ cgroup: 2, uid: 0, bootId: 'c979624d-e703-46d3-ae35-c4cb34a59e91', pid1AgeCs: 66722, kernel: '6.18.44-test' });
    const { block } = output;
    expect(block).toMatchObject({ seq: 1, startCs: 66849n, endCs: 66877n, skipped: 0 });
    expect(block.cpu).toEqual([32524n, 0n, 6179n, 223645n, 3302n, 0n, 756n, 501n]);
    expect(block.cpus).toHaveLength(2);
    expect(block.load).toEqual([0.1, 0.53, 0.38]);
    expect(block.memoryKb).toEqual({ MemTotal: 16472084n, MemFree: 15340340n, MemAvailable: 15877104n, Buffers: 49104n, Cached: 701652n, SwapTotal: 0n, SwapFree: 0n });
    expect(block.oomKills).toBe(3n);
    expect(block.pressure).toEqual({ cpu: { some: { avg10: 0, totalUs: 14261825n } }, io: { full: { avg10: 1.61, totalUs: 14193952n } } });
    expect(block.disks).toBeUndefined();
    expect(block.containers).toEqual([
      {
        id: ID_A,
        cpuUsec: 737678n,
        memoryBytes: 4448256n,
        memoryStat: { anon: 143360n, file: 3342336n, inactive_file: 3215360n },
        oomKills: 1n,
        readBytes: 101n,
        writeBytes: 202n,
        pids: 7n,
        network: { kind: 'interfaces', rxBytes: 15n, txBytes: 90n },
      },
    ]);
  });

  it('reads cgroup v1 lines, the disks, the idle check and the kinds of networks, and takes a carriage return', () => {
    const output = readUsageSample(
      [
        `@${MARKER}\r`,
        '#H 2 1 - - - -',
        '#T 4 100.00',
        'D a76db57b874706be 4096 100 40 30 1000 900 /var/lib/docker',
        'D a76db57b874706be 4096 100 40 30 1000 900 /home/a user/.local/share/docker',
        'I 1',
        `C ${ID_A}`,
        'U 5000999',
        'm 1000',
        'x 9223372036854771712',
        's total_rss 10',
        's total_inactive_file 20',
        'b 8:0 Read 30',
        'b 8:0 Write 40',
        'b 8:16 Read 1',
        'b 8:16 Sync 99',
        'n host',
        `C ${ID_B}`,
        'n none',
        '#E 4 100.05',
        '',
      ].join('\n'),
      MARKER,
      4,
    );
    expect(output.kind).toBe('block');
    if (output.kind !== 'block') return;
    expect(output.header).toEqual({ cgroup: 1 });
    const { block } = output;
    expect(block.disks).toEqual([
      { fsid: 'a76db57b874706be', blockSize: 4096n, blocks: 100n, freeBlocks: 40n, availableBlocks: 30n, files: 1000n, freeFiles: 900n, path: '/var/lib/docker' },
      { fsid: 'a76db57b874706be', blockSize: 4096n, blocks: 100n, freeBlocks: 40n, availableBlocks: 30n, files: 1000n, freeFiles: 900n, path: '/home/a user/.local/share/docker' },
    ]);
    expect(block.idle).toBe(true);
    expect(block.containers).toEqual([
      { id: ID_A, cpuUsec: 5000n, memoryBytes: 1000n, memoryLimitBytes: 9223372036854771712n, memoryStat: { total_rss: 10n, total_inactive_file: 20n }, readBytes: 31n, writeBytes: 40n, network: { kind: 'host' } },
      { id: ID_B, memoryStat: {}, network: { kind: 'none' } },
    ]);
  });

  it('reads an unknown network, and leaves out unknown lines and values it cannot read', () => {
    const block = blockOf(`@${MARKER}\n${HEADER}\n${blockText(1, ['n ?', 'q something new', 'm notanumber', 'x 12a', 'n eth2 1', 'N old line of names'])}`);
    // The network of the container is from its interfaces; the later `n ?` does not change it.
    expect(block.containers[0].network).toEqual({ kind: 'interfaces', rxBytes: 15n, txBytes: 90n });
    expect(block.containers[0].memoryBytes).toBe(4448256n);
    // q, m, x, `n ?`, `n eth2 1`, N.
    expect(block.skipped).toBe(6);
  });

  it('reads #X noproc as a host that is no Linux', () => {
    expect(readUsageSample(`@${MARKER}\n#X noproc\n`, MARKER, 1)).toEqual({ kind: 'notLinux' });
  });

  describe('bounds and output that is not of the script', () => {
    const cases: Array<[string, () => string]> = [
      ['no output', () => ''],
      ['text before the marker', () => `Welcome\n@${MARKER}\n${HEADER}\n${blockText(1)}`],
      ['another marker', () => `@${'f'.repeat(32)}\n${HEADER}\n${blockText(1)}`],
      ['text after the marker on its line', () => `@${MARKER} more\n${HEADER}\n${blockText(1)}`],
      ['the protocol of the old stream', () => `@${MARKER}\n#H 1 2 0 1 - - -\n${blockText(1)}`],
      ['a header with a field too few', () => `@${MARKER}\n#H 2 2 0 - -\n${blockText(1)}`],
      ['no header', () => `@${MARKER}\n${blockText(1)}`],
      ['a line outside of a block', () => `@${MARKER}\n${HEADER}\ncpu 1 2 3 4\n`],
      ['another sample number', () => `@${MARKER}\n${HEADER}\n${blockText(2)}`],
      ['an end with another number', () => `@${MARKER}\n${HEADER}\n#T 1 1.00\n#E 2 1.00\n`],
      ['a block without its end', () => `@${MARKER}\n${HEADER}\n#T 1 1.00\ncpu 1 2 3 4\n`],
      ['a second block', () => `@${MARKER}\n${HEADER}\n${blockText(1)}${blockText(1)}`],
      ['a line above 4 KiB', () => `@${MARKER}\n${HEADER}\n#T 1 1.00\nq ${'x'.repeat(MAX_USAGE_LINE)}\n#E 1 1.00\n`],
      ['a container ID that is not valid', () => `@${MARKER}\n${HEADER}\n#T 1 1.00\nC ${'A'.repeat(64)}\n#E 1 1.00\n`],
      ['more containers than the bound', () => `@${MARKER}\n${HEADER}\n#T 1 1.00\n${Array.from({ length: MAX_USAGE_CONTAINERS + 1 }, (_, i) => `C ${i.toString(16).padStart(64, '0')}`).join('\n')}\n#E 1 1.00\n`],
      ['more CPUs than the bound', () => `@${MARKER}\n${HEADER}\n#T 1 1.00\n${Array.from({ length: MAX_USAGE_CPUS + 1 }, (_, i) => `cpu${i} 1 1 1 1 1 1 1 1`).join('\n')}\n#E 1 1.00\n`],
      ['a block above its bound', () => `@${MARKER}\n${HEADER}\n#T 1 1.00\n${`q ${'x'.repeat(1000)}\n`.repeat(Math.ceil(MAX_USAGE_BLOCK / 1003) + 1)}#E 1 1.00\n`],
    ];
    it('throws for an output above the bound of one sample before it reads its lines', () => {
      expect(() => readUsageSample(`@${MARKER}\n${HEADER}\n${'x'.repeat(MAX_USAGE_BLOCK + 5 * MAX_USAGE_LINE)}`, MARKER, 1)).toThrow(/more than \d+ KiB for one utilization sample/);
    });
    for (const [name, output] of cases) {
      it(`throws for ${name}`, () => {
        expect(() => readUsageSample(output(), MARKER, 1)).toThrow(UsageSampleError);
      });
    }
  });
});

describe('parseUsageNames', () => {
  it('takes the first name of each container by its ID, and leaves out lines that are not valid', () => {
    const stdout = [`${ID_A} web,other/alias`, `${ID_B} db`, 'short web', `${'c'.repeat(64)} -bad`, `${'d'.repeat(64)} two words`, '', ''].join('\n');
    expect(parseUsageNames(stdout)).toEqual(new Map([[ID_A, 'web'], [ID_B, 'db']]));
  });

  it('throws above the bound of names', () => {
    const stdout = Array.from({ length: MAX_USAGE_CONTAINERS + 1 }, (_, i) => `${i.toString(16).padStart(64, '0')} c${i}`).join('\n');
    expect(() => parseUsageNames(stdout)).toThrow(UsageSampleError);
  });
});
