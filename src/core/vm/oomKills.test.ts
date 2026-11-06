// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { OomWatch, parseOomKills, readOomKills, vmstatOomKills } from './oomKills';

const BOOT = '0b5c2d7e-1f3a-4c6b-9d8e-7a6b5c4d3e2f';
const OTHER_BOOT = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';

describe('the processes that the kernel ended because the memory ran out', () => {
  it('reads the counter oom_kill of /proc/vmstat and the boot id of the kernel; undefined when they cannot be read', () => {
    expect(vmstatOomKills('nr_free_pages 123\noom_kill 4\nnr_unstable 0\n')).toBe(4);
    expect(vmstatOomKills('nr_free_pages 123\n')).toBeUndefined();
    const files: Record<string, string> = { '/proc/sys/kernel/random/boot_id': `${BOOT}\n`, '/proc/vmstat': 'pgfault 9\noom_kill 0\n' };
    const read = (path: string): string => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    };
    expect(readOomKills(read)).toEqual({ boot: BOOT, count: 0 });
    files['/proc/vmstat'] = 'pgfault 9\n';
    expect(readOomKills(read)).toBeUndefined();
    delete files['/proc/sys/kernel/random/boot_id'];
    expect(readOomKills(read)).toBeUndefined();
    // On this Linux, the real files.
    if (process.platform === 'linux') expect(readOomKills()).toEqual({ boot: expect.stringMatching(/^[0-9a-f-]{36}$/), count: expect.any(Number) });
  });

  it('checks the value strictly', () => {
    expect(parseOomKills({ boot: BOOT, count: 0 })).toEqual({ boot: BOOT, count: 0 });
    for (const odd of [null, {}, { boot: BOOT }, { boot: BOOT, count: 1.5 }, { boot: BOOT, count: -1 }, { boot: BOOT.toUpperCase(), count: 1 }, { boot: BOOT, count: 1, extra: true }, { boot: 7, count: 1 }]) {
      expect(parseOomKills(odd), JSON.stringify(odd)).toBeUndefined();
    }
  });

  it('logs each increase on an engine and warns at the first one of each start of its kernel; the first counter is only kept', () => {
    const logged: [string, number][] = [];
    const warned: [string, number][] = [];
    const watch = new OomWatch({ log: (host, added) => logged.push([host, added]), warn: (host, added) => warned.push([host, added]) });
    watch.seen('lima:devspaces', { boot: BOOT, count: 2 });
    watch.seen('lima:devspaces', { boot: BOOT, count: 2 });
    expect([logged, warned]).toEqual([[], []]);
    watch.seen('lima:devspaces', { boot: BOOT, count: 3 });
    expect([logged, warned]).toEqual([[['lima:devspaces', 1]], [['lima:devspaces', 1]]]);
    // Later ones of the same start only go to the log: more memory counts only after the next start of the VM.
    watch.seen('lima:devspaces', { boot: BOOT, count: 5 });
    expect([logged, warned]).toEqual([[['lima:devspaces', 1], ['lima:devspaces', 2]], [['lima:devspaces', 1]]]);
    // A new start of the kernel: its counter started at 0, so all of them are new.
    watch.seen('lima:devspaces', { boot: OTHER_BOOT, count: 1 });
    expect(warned).toEqual([['lima:devspaces', 1], ['lima:devspaces', 1]]);
    watch.seen('lima:devspaces', { boot: BOOT, count: 0 });
    // Each engine by itself.
    watch.seen('', { boot: OTHER_BOOT, count: 7 });
    watch.seen('', { boot: OTHER_BOOT, count: 8 });
    expect(warned).toEqual([['lima:devspaces', 1], ['lima:devspaces', 1], ['', 1]]);
  });
});
