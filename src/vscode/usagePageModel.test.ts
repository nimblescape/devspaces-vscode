// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// What the utilization page shows (R-ENG-009): the texts of each state with its buttons, the values of the cards, the
// running containers with their names and purposes, the sizes of Read Sizes, the check of the messages of the webview,
// and the CSP of its HTML.
import { describe, expect, it } from 'vitest';
import { LIMA_HOST, WSL_HOST } from '../core/docker/dockerHost';
import type { HostInventory, HostObject } from '../core/hosts/hostObjects';
import type { ContainerUsage, HostUsage } from '../core/hosts/usageRates';
import {
  MAX_CONTAINER_ROWS,
  MAX_TABLE_ROWS,
  UsagePageTexts,
  formatClock,
  formatPercent,
  formatUptime,
  parseUsageRequest,
  usagePageHtml,
  usagePageView,
  type UsagePageInput,
} from './usagePageModel';

const GB = 1_000_000_000;
const id = (n: number) => n.toString(16).padStart(64, '0');

function hostUsage(extra: Partial<HostUsage> = {}): HostUsage {
  return {
    seq: 2,
    intervalCs: 200,
    cpu: { busy: 37.2, iowait: 2, steal: 0 },
    cpus: [44, 39, 35, 30].map((busy) => ({ busy, iowait: 0, steal: 0 })),
    cpuCount: 4,
    load: [1.62, 1.35, 0.98],
    memory: { totalBytes: 7.8 * GB, usedBytes: 2.3 * GB, availableBytes: 5.5 * GB, cacheBytes: 1.2 * GB, swapTotalBytes: GB, swapUsedBytes: 0 },
    pressure: { cpu: { some: { avg10: 1.5, share: 1.2 } }, memory: { some: { avg10: 0 } }, io: { some: { avg10: 0.5, share: 0.4 } } },
    oomKills: 0,
    containers: [],
    ...extra,
  };
}

function input(extra: Partial<UsagePageInput> = {}): UsagePageInput {
  return { host: LIMA_HOST, vm: true, wsl: false, intervalMs: 2000, phase: { kind: 'live' }, busy: [], sizesReading: false, ...extra };
}

const object = (kind: HostObject['kind'], name: string, extra: Partial<HostObject> = {}): HostObject => ({ kind, id: name, name, purpose: 'notDevspaces', ...extra });

describe('parseUsageRequest', () => {
  it('takes only the messages of the page', () => {
    for (const type of ['ready', 'activity', 'pause', 'resume', 'retry', 'startVm', 'readSizes', 'showLog']) expect(parseUsageRequest({ type, other: 1 })).toEqual({ type });
    for (const raw of [undefined, null, 'pause', {}, { type: 'save' }, { type: 3 }, { type: 'toString' }]) expect(parseUsageRequest(raw)).toBeUndefined();
  });
});

describe('formats', () => {
  it('writes percentages with one decimal below 10, the uptime, and the time of day', () => {
    expect([formatPercent(0), formatPercent(9.96), formatPercent(9.94), formatPercent(37.4), formatPercent(-3), formatPercent(Number.NaN)]).toEqual(['0.0 %', '10.0 %', '9.9 %', '37 %', '0.0 %', '0.0 %']);
    expect([formatUptime(59 * 100), formatUptime(12 * 6000), formatUptime(192 * 6000), formatUptime((2 * 1440 + 185) * 6000)]).toEqual(['up 0 min', 'up 12 min', 'up 3 h 12 min', 'up 2 d 3 h']);
    expect(formatClock(new Date(2026, 10, 11, 9, 5, 7).getTime())).toBe('09:05:07');
  });
});

describe('usagePageView', () => {
  it('shows the live values of the VM with the state, the cards and the notes of the VM', () => {
    const at = new Date(2026, 10, 11, 10, 41, 5).getTime();
    const view = usagePageView(
      input({
        header: { cgroup: 2, kernel: '6.12.48-cloud-amd64' },
        usage: hostUsage(),
        uptimeCs: 192 * 6000,
        updatedAt: at,
        busy: [null, 20, 30],
        disks: [
          { paths: ['/var/lib/docker'], sizeBytes: 98 * GB, usedBytes: 9.4 * GB, freeBytes: 88.6 * GB, files: 100, freeFiles: 97 },
          { paths: ['/var/lib/containerd'], sizeBytes: 10 * GB, usedBytes: 2 * GB, freeBytes: 8 * GB, files: 0, freeFiles: 0 },
        ],
        localDiskFree: 210 * GB,
      }),
    );
    expect(view.title).toBe(LIMA_HOST);
    expect(view.description).toBe('Local VM of Devspaces · Linux 6.12.48-cloud-amd64 · up 3 h 12 min');
    expect(view.status).toEqual({ text: 'Live · every 2 s · updated 10:41:05', tone: 'live' });
    // While the sizes are read (the values may wait behind the read on the same login), the header says so.
    expect(usagePageView(input({ usage: hostUsage(), updatedAt: at, sizesReading: true })).status.text).toBe('Live · every 2 s · updated 10:41:05 · reading the sizes');
    expect(view.pause).toEqual({ action: 'pause', label: 'Pause' });
    expect(view.banner).toBeUndefined();
    expect(view.stale).toBe(false);
    expect(view.cpu).toMatchObject({ caption: 'CPU · 4 CPUs', value: '37 %', unit: 'busy', spark: [null, 20, 30] });
    expect(view.cpu.cores.map((core) => [core.label, core.text, core.level])).toEqual([
      ['CPU 1', '44 %', 'normal'],
      ['CPU 2', '39 %', 'normal'],
      ['CPU 3', '35 %', 'normal'],
      ['CPU 4', '30 %', 'normal'],
    ]);
    expect(view.cpu.lines).toEqual([
      'Load 1.62 · 1.35 · 0.98 (1, 5, 15 min)',
      'Waiting for disk 2.0 % · taken by the hypervisor 0.0 %',
      'Pressure: CPU 1.2 % · memory 0.0 % · I/O 0.4 % (the time that tasks waited)',
    ]);
    expect(view.memory).toMatchObject({ value: '2.3 GB', unit: 'of 7.8 GB used (29 %)', percent: 29 });
    expect(view.memory.lines).toEqual([
      { label: 'Available', value: '5.5 GB' },
      { label: 'File cache', value: '1.2 GB' },
      { label: 'Swap', value: '0 B of 1 GB' },
      { label: 'Processes ended for lack of memory', value: '0' },
    ]);
    expect(view.disk).toMatchObject({ value: '9.4 GB', unit: 'of 98 GB used (10 %)', percent: 10 });
    expect(view.disk.lines).toEqual([
      { label: 'Free', value: '88.6 GB' },
      { label: 'Files (inodes) used', value: '3 %' },
      { label: 'Folder', value: '/var/lib/docker' },
      { label: 'Also /var/lib/containerd', value: '2 GB of 10 GB' },
      { label: 'This computer: free for the disk of the VM', value: '210 GB' },
    ]);
    expect(view.docker).toMatchObject({ value: '—', unit: 'not read', note: UsagePageTexts.sizesNotRead, rows: [] });
    expect(view.sizes).toEqual({ label: 'Read Sizes', disabled: false });
    expect(view.containers).toMatchObject({ rows: [], empty: 'No container runs.', notes: [] });
    expect(view.footer).toEqual([UsagePageTexts.footer, UsagePageTexts.footerVm]);
  });

  it('says that the CPU needs a second reading, and that the kernel has no pressure', () => {
    const view = usagePageView(input({ usage: hostUsage({ cpu: undefined, cpus: undefined, intervalCs: undefined, pressure: {} }) }));
    expect(view.banner).toEqual({ tone: 'info', message: 'Reading the CPU use: it needs two readings, 2 seconds apart.', detail: UsagePageTexts.secondReadingDetail, buttons: [] });
    expect(view.cpu).toMatchObject({ value: '…', unit: 'after the second reading', cores: [] });
    expect(view.cpu.lines).toEqual(['Load 1.62 · 1.35 · 0.98 (1, 5, 15 min)', 'Pressure: not available in this kernel']);
    expect(view.disk).toMatchObject({ value: '…', unit: 'reading' });
  });

  it('names a remote host, the interval of the samples, and the note of WSL', () => {
    const remote = usagePageView(input({ host: 'build-box', vm: false, intervalMs: 5000, usage: hostUsage({ intervalCs: 520 }), localDiskFree: 3 * GB, disks: [] }));
    expect(remote.description).toBe('Remote Docker host');
    expect(remote.status.text).toBe('Live · every 5 s');
    expect(remote.disk).toMatchObject({ value: '—', unit: 'could not be read', lines: [] });
    expect(remote.footer).toEqual([UsagePageTexts.footer]);
    expect(usagePageView(input({ host: WSL_HOST, wsl: true })).footer).toEqual([UsagePageTexts.footer, UsagePageTexts.footerVm, UsagePageTexts.footerWsl]);
  });

  it('shows the 8 busiest of many CPUs', () => {
    const cpus = Array.from({ length: 32 }, (_, index) => ({ busy: index === 7 ? 95 : index === 20 ? 80 : index, iowait: 0, steal: 0 }));
    const view = usagePageView(input({ usage: hostUsage({ cpus, cpuCount: 32 }) }));
    expect(view.cpu.coresNote).toBe('The 8 busiest of 32 CPUs.');
    expect(view.cpu.cores.map((core) => [core.label, core.level])).toEqual([
      ['CPU 8', 'full'],
      ['CPU 21', 'high'],
      ['CPU 32', 'normal'],
      ['CPU 31', 'normal'],
      ['CPU 30', 'normal'],
      ['CPU 29', 'normal'],
      ['CPU 28', 'normal'],
      ['CPU 27', 'normal'],
    ]);
  });

  it('pauses with the reason, the time of the values and Resume', () => {
    const at = new Date(2026, 10, 11, 10, 41, 5).getTime();
    for (const reason of ['button', 'focus', 'idle', 'vm'] as const) {
      const view = usagePageView(input({ phase: { kind: 'paused', reason }, usage: hostUsage(), updatedAt: at }));
      expect(view.status).toEqual({ text: 'Paused · values of 10:41:05', tone: 'paused' });
      expect(view.banner).toEqual({
        tone: 'warning',
        message: UsagePageTexts.pausedMessage[reason],
        detail: 'The values below are from 10:41:05. While it is paused, the VM can go to sleep.',
        buttons: [{ action: 'resume', label: 'Resume', primary: true }],
      });
      expect(view.pause).toEqual({ action: 'resume', label: 'Resume' });
      expect(view.stale).toBe(true);
    }
    const remote = usagePageView(input({ host: 'build-box', vm: false, phase: { kind: 'paused', reason: 'button' } }));
    expect(remote.status.text).toBe('Paused');
    expect(remote.banner?.detail).toBe('The page has no values yet.');
  });

  it('offers Start the VM for a stopped VM, and says what else stops the page', () => {
    const stopped = usagePageView(input({ phase: { kind: 'vm', state: { kind: 'stopped' } } }));
    expect(stopped.status).toEqual({ text: 'Not reading', tone: 'off' });
    expect(stopped.banner).toEqual({ tone: 'info', message: UsagePageTexts.vmStopped, detail: UsagePageTexts.vmStoppedDetail, buttons: [{ action: 'startVm', label: 'Start the VM', primary: true }] });
    expect(stopped.pause).toBeUndefined();
    expect(usagePageView(input({ phase: { kind: 'vm', state: { kind: 'stopped' }, idle: true } })).banner?.message).toBe(UsagePageTexts.vmIdle);
    expect(usagePageView(input({ phase: { kind: 'vm', state: { kind: 'notSetUp' } } })).banner).toEqual({ tone: 'info', message: UsagePageTexts.vmNotSetUp, buttons: [] });
    expect(usagePageView(input({ phase: { kind: 'vm', state: { kind: 'broken', detail: 'Lima says broken.' } } })).banner).toEqual({
      tone: 'warning',
      message: 'Devspaces cannot use the VM of Devspaces now (it is broken), so this page shows no values.',
      detail: 'Lima says broken.',
      buttons: [{ action: 'showLog', label: 'Show Log' }],
    });
  });

  it('says why the samples ended, with Retry where it may help', () => {
    const remote = (end: Parameters<typeof usagePageView>[0]['phase']) => usagePageView(input({ host: 'build-box', vm: false, phase: end })).banner;
    const retry = { action: 'retry', label: 'Retry', primary: true };
    const log = { action: 'showLog', label: 'Show Log' };
    expect(remote({ kind: 'ended', end: { kind: 'exited', exitCode: 255, detail: 'Permission denied (password).' } })).toEqual({
      tone: 'error',
      message: 'The connection to build-box failed or broke, so the page stopped reading.',
      detail: `Permission denied (password). ${UsagePageTexts.ended.retryAsks}`,
      buttons: [retry, log],
    });
    expect(remote({ kind: 'ended', end: { kind: 'exited', exitCode: 127, detail: '' } })).toEqual({ tone: 'error', message: 'build-box has no shell sh, so the page cannot read it.', detail: UsagePageTexts.ended.noDetail, buttons: [log] });
    expect(remote({ kind: 'ended', end: { kind: 'notLinux' } })?.buttons).toEqual([log]);
    expect(remote({ kind: 'ended', end: { kind: 'noTransport' } })?.message).toContain('(ssh)');
    expect(remote({ kind: 'ended', end: { kind: 'noAnswer', detail: '' } })?.buttons).toEqual([retry, log]);
    expect(remote({ kind: 'ended', end: { kind: 'badOutput', detail: 'A line is too long.' } })?.detail).toBe('A line is too long.');
    expect(remote({ kind: 'ended', end: { kind: 'failed', detail: 'boom' } })?.detail).toBe('boom');
    const vm = usagePageView(input({ phase: { kind: 'ended', end: { kind: 'noAnswer', detail: 'slow' } } }));
    expect(vm.status).toEqual({ text: 'Stopped reading', tone: 'error' });
    expect(vm.banner?.detail).toBe('slow');
  });

  it('lists the running containers by CPU with their names, purposes, colors and rates', () => {
    const containers: ContainerUsage[] = [
      { id: id(1), cpuPercent: 2.1, memoryBytes: 38e6, pids: 11, network: 'interfaces', netRxRate: 0, netTxRate: 1000, readBytes: 0, writeBytes: 0, readRate: 0, writeRate: 0 },
      { id: id(2), cpuPercent: 124, memoryBytes: 1.6 * GB, memoryLimitBytes: 4 * GB, pids: 142, network: 'host', readBytes: 10 },
      { id: id(3), network: 'none' },
    ];
    const inventory: HostInventory = {
      containers: [object('container', 'my-postgres', { id: id(2), state: 'running', active: true }), object('container', 'worker', { id: id(1), purpose: 'worker', state: 'running', active: true })],
      images: [],
      volumes: [],
      networks: [],
      buildCache: { records: 0, bytes: 0, unusedBytes: 0 },
    };
    const names = new Map([
      [id(1), 'devspaces-web-worker1'],
      [id(2), 'my-postgres'],
    ]);
    const view = usagePageView(input({ usage: hostUsage({ containers }), names, sizes: { inventory, at: 0 } }));
    expect(view.containers.summary).toBe('3 · CPU: 100 % = one CPU, as in docker stats');
    expect(view.containers.notes).toEqual([]);
    expect(view.containers.rows).toEqual([
      { name: 'my-postgres', purpose: 'not of Devspaces', tone: 'notDevspaces', cpu: '124 %', cpuBar: 31, memory: '1.6 GB of 4 GB', network: 'network of the host', disk: '…', pids: '142' },
      { name: 'devspaces-web-worker1', purpose: 'worker', tone: 'normal', cpu: '2.1 %', cpuBar: 0.525, memory: '38 MB of 7.8 GB', network: '↓ 0 B/s · ↑ 1 kB/s', disk: '0 B/s · 0 B/s', pids: '11' },
      { name: id(3).slice(0, 12), purpose: '', tone: 'normal', cpu: '…', cpuBar: 0, memory: '—', network: 'no network', disk: '—', pids: '—' },
    ]);
  });

  it('says how the names and the purposes come, and cuts a long list', () => {
    const containers: ContainerUsage[] = Array.from({ length: MAX_CONTAINER_ROWS + 5 }, (_, index) => ({ id: id(index + 1), cpuPercent: index }));
    const view = usagePageView(input({ usage: hostUsage({ containers }) }));
    expect(view.containers.rows).toHaveLength(MAX_CONTAINER_ROWS);
    expect(view.containers.rows[0].cpu).toBe(`${MAX_CONTAINER_ROWS + 4} %`);
    expect(view.containers.more).toBe('And 5 more.');
    expect(view.containers.notes).toEqual([UsagePageTexts.noNames, UsagePageTexts.purposeAfterSizes]);
    expect(usagePageView(input()).containers).toEqual({ summary: '', rows: [], empty: 'Not read.', notes: [] });
  });

  it('shows the sizes of Read Sizes: the Docker disk use, the stopped containers and the tables', () => {
    const at = new Date(2026, 10, 11, 10, 40, 12).getTime();
    const volumes = Array.from({ length: MAX_TABLE_ROWS + 2 }, (_, index) => object('volume', `v${String(index).padStart(2, '0')}`, { sizeBytes: (index + 1) * 1e6, usedBy: index === 0 ? 0 : 1 }));
    const inventory: HostInventory = {
      containers: [
        object('container', 'web', { state: 'running', sizeBytes: 1e6, active: true, purpose: 'devspace', repository: 'majikmate/web', role: 'dev container' }),
        object('container', 'shop-db-1', { state: 'exited', sizeBytes: 4e5 }),
      ],
      images: [object('image', 'node:22', { sizeBytes: 1.1 * GB, uniqueBytes: GB, usedBy: 0 }), object('image', 'devspaces-worker:6b', { purpose: 'helperImage', sizeBytes: 4e8, uniqueBytes: 4e8, usedBy: 1, active: true })],
      volumes,
      networks: [object('network', 'bridge', { builtIn: true, driver: 'bridge', usedBy: 3, active: true }), object('network', 'shop_default', { driver: 'bridge', usedBy: 0 })],
      buildCache: { records: 4, bytes: 1.4 * GB, unusedBytes: 9e8 },
    };
    const view = usagePageView(input({ sizes: { inventory, at } }));
    expect(view.sizes).toEqual({ label: 'Refresh Sizes', disabled: false });
    expect(view.docker.value).toBe('2.9 GB');
    expect(view.docker.unit).toBe('1.9 GB can be freed');
    expect(view.docker.rows).toEqual([
      { kind: 'images', label: 'Images', size: '1.4 GB', free: '1 GB' },
      { kind: 'containers', label: 'Containers', size: '1.4 MB', free: '400 kB' },
      { kind: 'volumes', label: 'Volumes', size: '78 MB', free: '1 MB' },
      { kind: 'buildCache', label: 'Build cache', size: '1.4 GB', free: '900 MB' },
    ]);
    expect(view.docker.segments.map((segment) => segment.kind)).toEqual(['images', 'containers', 'volumes', 'buildCache']);
    // The containers (0.05 %) get the smallest width that can be seen, and the widths together stay 100 %.
    expect(view.docker.segments[1].percent).toBeCloseTo(0.99, 2);
    expect(view.docker.segments.reduce((sum, segment) => sum + segment.percent, 0)).toBeCloseTo(100, 9);
    expect(view.docker.note).toBe(UsagePageTexts.sizesAt('10:40:12'));
    expect(view.stopped).toEqual({ summary: 'Stopped containers · 1 · shop-db-1', rows: [{ name: 'shop-db-1', purpose: 'not of Devspaces', tone: 'notDevspacesInactive' }] });
    const [volumeTable, imageTable, networkTable] = view.tables;
    expect(volumeTable).toMatchObject({ title: 'Volumes', summary: '12 · 78 MB', more: 'And 2 more: the view Docker Hosts lists all of them.' });
    expect(volumeTable.rows).toHaveLength(MAX_TABLE_ROWS);
    expect(volumeTable.rows[0]).toEqual({ name: 'v11', purpose: 'not of Devspaces', tone: 'notDevspacesInactive', values: ['12 MB', '1'] });
    expect(imageTable.rows.map((row) => [row.name, row.purpose, row.values])).toEqual([
      ['node:22', 'not of Devspaces', ['1.1 GB', '0']],
      ['devspaces-worker:6b', 'helper image', ['400 MB', '1']],
    ]);
    expect(imageTable.more).toBeUndefined();
    expect(networkTable).toMatchObject({ summary: '2', headers: ['Name', 'Purpose', 'Driver', 'Containers'] });
    expect(networkTable.rows.map((row) => [row.name, row.purpose, row.tone, row.values])).toEqual([
      ['bridge', 'network of Docker', 'notDevspaces', ['bridge', '3']],
      ['shop_default', 'not of Devspaces', 'notDevspacesInactive', ['bridge', '0']],
    ]);
  });

  it('shows Read Sizes while it runs and when it failed', () => {
    expect(usagePageView(input({ sizesReading: true })).sizes).toEqual({ label: 'Reading Sizes…', disabled: true });
    expect(usagePageView(input({ sizesReading: true })).docker).toMatchObject({ value: '…', note: UsagePageTexts.sizesReadingNote });
    expect(usagePageView(input({ sizesError: 'Permission denied' })).docker.note).toBe('The sizes could not be read: Permission denied');
    const empty: HostInventory = { containers: [], images: [], volumes: [], networks: [], buildCache: { records: 0, bytes: 0, unusedBytes: 0 } };
    const failedAgain = usagePageView(input({ sizes: { inventory: empty, at: 0 }, sizesError: 'gone' }));
    expect(failedAgain.docker.note.startsWith('The sizes could not be read: gone Sizes read at')).toBe(true);
    expect(failedAgain.docker.segments).toEqual([]);
    expect(failedAgain.stopped).toBeUndefined();
  });
});

describe('usagePageHtml', () => {
  it('allows only the script with the nonce and the style sheet of the extension, and escapes the host', () => {
    const html = usagePageHtml({ cspSource: 'vscode-webview://x', nonce: 'abc+/=', scriptUri: 'webview:page.js', styleUri: 'webview:page.css', host: 'a<b>&"c' });
    expect(html).toContain(`content="default-src 'none'; style-src vscode-webview://x; script-src 'nonce-abc+/='; img-src 'none'; base-uri 'none'; form-action 'none'"`);
    expect(html).not.toContain('unsafe-inline');
    expect(html).toContain('<script nonce="abc+/=" src="webview:page.js"></script>');
    expect(html).toContain('<title>Utilization: a&lt;b&gt;&amp;"c</title>');
    expect(html).toContain('<h1 id="title">a&lt;b&gt;&amp;"c</h1>');
  });
});
