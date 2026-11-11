// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  MAX_USAGE_BLOCK,
  MAX_USAGE_CONTAINERS,
  MAX_USAGE_CPUS,
  MAX_USAGE_LINE,
  MAX_USAGE_LOGIN_TEXT,
  MAX_USAGE_SIZES_LINE,
  UsageStreamError,
  UsageStreamReader,
  type UsageBlock,
  type UsageHeader,
} from './usageStream';

const MARKER = '0123456789abcdef0123456789abcdef';
const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const HEADER = '#H 1 2 0 1 c979624d-e703-46d3-ae35-c4cb34a59e91 66722 6.18.44-test';

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

interface Read {
  reader: UsageStreamReader;
  headers: UsageHeader[];
  blocks: UsageBlock[];
  notLinux: number;
  login: number[];
}

function reader(options: { keepLoginText?: boolean } = {}): Read {
  const read: Read = { headers: [], blocks: [], notLinux: 0, login: [] } as unknown as Read;
  read.reader = new UsageStreamReader(
    MARKER,
    {
      header: (header) => read.headers.push(header),
      notLinux: () => read.notLinux++,
      block: (block) => read.blocks.push(block),
      loginText: (bytes) => read.login.push(bytes),
    },
    options,
  );
  return read;
}

function feed(read: Read, text: string | Buffer): void {
  read.reader.push(typeof text === 'string' ? Buffer.from(text, 'utf8') : text);
}

describe('UsageStreamReader', () => {
  it('skips the text of the login, reads the header and the blocks with every counter as a BigInt', () => {
    const read = reader();
    feed(read, `Welcome\nto the host\n@${MARKER}\n${HEADER}\n${blockText(1)}`);
    expect(read.login).toEqual([20]);
    expect(read.headers).toEqual([{ cgroup: 2, uid: 0, byteMode: true, bootId: 'c979624d-e703-46d3-ae35-c4cb34a59e91', pid1AgeCs: 66722, kernel: '6.18.44-test' }]);
    expect(read.blocks).toHaveLength(1);
    const [block] = read.blocks;
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

  it('reads the same when the output comes one byte at a time', () => {
    const whole = reader();
    const text = `@${MARKER}\n${HEADER}\n${blockText(1, ['D a76db57b874706be 4096 66053021 63582632 7608599 16777216 16517596 /var/lib/docker'])}${blockText(2)}`;
    feed(whole, text);
    const bytes = reader();
    for (const byte of Buffer.from(text)) feed(bytes, Buffer.from([byte]));
    expect(bytes.blocks).toEqual(whole.blocks);
    expect(bytes.blocks).toHaveLength(2);
  });

  it('reads cgroup v1 lines, the disks, the idle check, the kinds of networks and the names', () => {
    const read = reader();
    feed(
      read,
      [
        `@${MARKER}`,
        '#H 1 1 - 0 - - -',
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
        `N ${ID_A} web,other/alias`,
        `N ${ID_B} db`,
        'N.',
        '#E 4 100.05',
        '',
      ].join('\n'),
    );
    expect(read.headers).toEqual([{ cgroup: 1, byteMode: false }]);
    const [block] = read.blocks;
    expect(block.disks).toEqual([
      { fsid: 'a76db57b874706be', blockSize: 4096n, blocks: 100n, freeBlocks: 40n, availableBlocks: 30n, files: 1000n, freeFiles: 900n, path: '/var/lib/docker' },
      { fsid: 'a76db57b874706be', blockSize: 4096n, blocks: 100n, freeBlocks: 40n, availableBlocks: 30n, files: 1000n, freeFiles: 900n, path: '/home/a user/.local/share/docker' },
    ]);
    expect(block.idle).toBe(true);
    expect(block.containers).toEqual([
      { id: ID_A, cpuUsec: 5000n, memoryBytes: 1000n, memoryLimitBytes: 9223372036854771712n, memoryStat: { total_rss: 10n, total_inactive_file: 20n }, readBytes: 31n, writeBytes: 40n, network: { kind: 'host' } },
      { id: ID_B, memoryStat: {}, network: { kind: 'none' } },
    ]);
    expect(block.names).toEqual({ complete: true, names: new Map([[ID_A, 'web'], [ID_B, 'db']]) });
  });

  it('reads a failed docker ps, an unknown network, and leaves out unknown lines and values it cannot read', () => {
    const read = reader();
    feed(read, `@${MARKER}\n${HEADER}\n${blockText(1, ['n ?', 'q something new', 'm notanumber', 'x 12a', 'n eth2 1', 'N! 127', 'N.'])}`);
    const [block] = read.blocks;
    expect(block.names).toEqual({ complete: false, exitCode: 127 });
    // The network of the container is from its interfaces; the later `n ?` does not change it.
    expect(block.containers[0].network).toEqual({ kind: 'interfaces', rxBytes: 15n, txBytes: 90n });
    expect(block.containers[0].memoryBytes).toBe(4448256n);
    // q, m, x, `n ?`, `n eth2 1`, the second N.
    expect(block.skipped).toBe(6);
  });

  it('reads the sizes for buildInventory, a failed step, and a sizes read that broke off', () => {
    const df = { Images: [], Containers: [], Volumes: [], BuildCache: [] };
    const sizes = [
      `Z df ${JSON.stringify(df)}`,
      `Z dev sha256:${'1'.repeat(64)}`,
      `Z helper sha256:${'2'.repeat(64)}`,
      'Z helper not-an-id',
      `Z net ${JSON.stringify({ Name: 'bridge', Driver: 'bridge' })}`,
      `Z tag ${JSON.stringify({ ID: 'sha256:x', Repository: 'a', Tag: '1' })}`,
      'Z tag {broken',
      'Z.',
    ];
    const read = reader();
    feed(read, `@${MARKER}\n${HEADER}\n${blockText(1, sizes)}${blockText(2, ['Z! df 1'])}${blockText(3, [`Z df ${JSON.stringify(df)}`])}${blockText(4, ['Z! net 125 extra words'])}`);
    expect(read.blocks[0].sizes).toEqual({
      ok: true,
      df,
      devspaceImageIds: [`sha256:${'1'.repeat(64)}`],
      helperImageIds: [`sha256:${'2'.repeat(64)}`],
      networks: [{ Name: 'bridge', Driver: 'bridge' }],
      imageTags: [{ ID: 'sha256:x', Repository: 'a', Tag: '1' }],
    });
    expect(read.blocks[0].skipped).toBe(2);
    expect(read.blocks[1].sizes).toEqual({ ok: false, step: 'df', detail: '1' });
    expect(read.blocks[2].sizes).toEqual({ ok: false, step: 'sizes', detail: 'incomplete' });
    expect(read.blocks[3].sizes).toEqual({ ok: false, step: 'net', detail: '125 extra words' });
  });

  it('takes a line of the sizes longer than a normal line', () => {
    const read = reader();
    const df = { Images: [{ ID: 'x', Repository: 'r'.repeat(2 * MAX_USAGE_LINE) }] };
    feed(read, `@${MARKER}\n${HEADER}\n${blockText(1, [`Z df ${JSON.stringify(df)}`, 'Z.'])}`);
    expect(read.blocks[0].sizes).toMatchObject({ ok: true, df });
  });

  it('reads #X noproc as a host that is no Linux, and takes nothing after it', () => {
    const read = reader();
    feed(read, `@${MARKER}\n#X noproc\n${blockText(1)}`);
    expect(read.notLinux).toBe(1);
    expect(read.headers).toEqual([]);
    expect(read.blocks).toEqual([]);
  });

  it('starts at a marker after login text without a line feed, a NUL byte of wsl.exe, or with a carriage return', () => {
    for (const before of ['\x1b]0;user@host\x07', '\0', '']) {
      const read = reader({ keepLoginText: true });
      feed(read, `${before}@${MARKER}${before === '' ? '\r' : ''}\n${HEADER}\n`);
      expect(read.headers).toHaveLength(1);
      expect(read.login).toEqual(before === '' ? [] : [Buffer.byteLength(before)]);
      expect(read.reader.loginOutput()).toBe(before);
    }
    // Text after the marker on its line is not the marker line.
    const other = reader();
    feed(other, `@${MARKER} more\n`);
    expect(other.headers).toEqual([]);
  });

  it('keeps the text of the login only when asked (wsl.exe writes its errors there)', () => {
    const kept = reader({ keepLoginText: true });
    feed(kept, 'Error code: Wsl/Service/CreateInstance/ERROR_TIMEOUT\nincomplete');
    expect(kept.reader.loginOutput()).toBe('Error code: Wsl/Service/CreateInstance/ERROR_TIMEOUT\nincomplete');
    const dropped = reader();
    feed(dropped, 'secret greeting\n');
    expect(dropped.reader.loginOutput()).toBe('');
  });

  describe('bounds and output that is not of the script', () => {
    const cases: Array<[string, () => string | Buffer]> = [
      ['login text above the bound', () => `${'x'.repeat(100)}\n`.repeat(Math.ceil(MAX_USAGE_LOGIN_TEXT / 101) + 1)],
      ['login text without a line feed above the bound', () => 'x'.repeat(MAX_USAGE_LOGIN_TEXT + 100)],
      ['another protocol', () => `@${MARKER}\n#H 2 2 0 1 - - -\n`],
      ['a header with a field too few', () => `@${MARKER}\n#H 1 2 0 1 - -\n`],
      ['no header', () => `@${MARKER}\n#T 1 1.00\n`],
      ['a line outside of a block', () => `@${MARKER}\n${HEADER}\ncpu 1 2 3 4\n`],
      ['a block number that is not a number', () => `@${MARKER}\n${HEADER}\n#T x 1.00\n`],
      ['an end with another number', () => `@${MARKER}\n${HEADER}\n#T 1 1.00\n#E 2 1.00\n`],
      ['a line above 4 KiB', () => `@${MARKER}\n${HEADER}\n#T 1 1.00\nq ${'x'.repeat(MAX_USAGE_LINE)}\n`],
      ['a container ID that is not valid', () => `@${MARKER}\n${HEADER}\n#T 1 1.00\nC ${'A'.repeat(64)}\n`],
      ['more containers than the bound', () => `@${MARKER}\n${HEADER}\n#T 1 1.00\n${Array.from({ length: MAX_USAGE_CONTAINERS + 1 }, (_, i) => `C ${i.toString(16).padStart(64, '0')}`).join('\n')}\n`],
      ['more CPUs than the bound', () => `@${MARKER}\n${HEADER}\n#T 1 1.00\n${Array.from({ length: MAX_USAGE_CPUS + 1 }, (_, i) => `cpu${i} 1 1 1 1 1 1 1 1`).join('\n')}\n`],
      ['a block above its bound', () => `@${MARKER}\n${HEADER}\n#T 1 1.00\n${`q ${'x'.repeat(1000)}\n`.repeat(Math.ceil(MAX_USAGE_BLOCK / 1003) + 1)}`],
      ['a line of the sizes above its bound', () => Buffer.concat([Buffer.from(`@${MARKER}\n${HEADER}\n#T 1 1.00\nZ df `), Buffer.alloc(MAX_USAGE_SIZES_LINE, 0x61)])],
    ];
    for (const [name, output] of cases) {
      it(`throws for ${name}, and takes nothing after it`, () => {
        const read = reader();
        expect(() => feed(read, output())).toThrow(UsageStreamError);
        // After the error the reader takes nothing.
        feed(read, `@${MARKER}\n${HEADER}\n${blockText(1)}`);
        expect(read.blocks).toEqual([]);
      });
    }
  });
});
