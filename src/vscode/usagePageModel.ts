// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The utilization page of a Docker host (docs/requirements.md R-ENG-009): what the page shows, as texts and numbers,
// from the state of the page, the values of the last sample (src/core/hosts/usageRates.ts), the history of the CPU use,
// and the sizes of the last read of the sizes (readHostInventory); the HTML of the webview, and the check of its messages. The
// webview only shows these texts (resources/usagePage/page.js). No `vscode`: usagePage.ts is the glue.
import { formatSize, totalSize, type HostInventory, type HostObject } from '../core/hosts/hostObjects';
import type { UsageHeader } from '../core/hosts/usageSample';
import type { DiskValue, HostUsage } from '../core/hosts/usageRates';
import type { UsageEnd } from '../core/hosts/usageSampler';
import type { VmState } from '../core/vm/vmState';
import { DockerHostsTexts, isRunningContainer, objectColor } from './dockerHostsModel';

/**
 * The state of the page. `starting`: the checks and the first sample run. `paused`: the user must click Resume (Pause,
 * 2 minutes without the focus of the window, 30 minutes without a click or a key on the page, or Stop the VM…, Remove or
 * Reset of the VM: `vm`). `vm`: the VM of Devspaces does not run, or cannot be used, so the page reads nothing (`idle`:
 * it went to sleep while the page read it). `ended`: the samples ended for another reason (UsageEnd).
 */
export type UsagePhase =
  | { kind: 'starting' }
  | { kind: 'live' }
  | { kind: 'paused'; reason: 'button' | 'focus' | 'idle' | 'vm' }
  | { kind: 'vm'; state: VmState; idle?: boolean }
  | { kind: 'ended'; end: UsageEnd };

/** What a button of the page asks the extension. */
export type UsageAction = 'pause' | 'resume' | 'retry' | 'startVm' | 'readSizes' | 'showLog';

/** A message of the webview: `ready` (the page started, also after it was hidden), `activity` (a click or a key). */
export interface UsageRequest {
  type: 'ready' | 'activity' | UsageAction;
}

const REQUEST_TYPES: ReadonlySet<string> = new Set(['ready', 'activity', 'pause', 'resume', 'retry', 'startVm', 'readSizes', 'showLog']);

/** The message of the webview, else undefined (the webview is not trusted). */
export function parseUsageRequest(raw: unknown): UsageRequest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const type = (raw as { type?: unknown }).type;
  return typeof type === 'string' && REQUEST_TYPES.has(type) ? { type: type as UsageRequest['type'] } : undefined;
}

/** The color of a name: as in the view Docker Hosts (rowColors.ts); `normal` is the color of the theme. */
export type UsageTone = 'normal' | 'inactive' | 'notDevspaces' | 'notDevspacesInactive';

export interface UsageButton {
  action: UsageAction;
  label: string;
  primary?: boolean;
}

export interface UsageLine {
  label: string;
  value: string;
}

export interface UsageContainerRow {
  name: string;
  purpose: string;
  tone: UsageTone;
  cpu: string;
  /** The share of the whole host for the bar (0 to 100). */
  cpuBar: number;
  memory: string;
  network: string;
  disk: string;
  pids: string;
}

export interface UsageTableRow {
  name: string;
  purpose: string;
  tone: UsageTone;
  values: [string, string];
}

export interface UsageTable {
  title: string;
  summary: string;
  headers: [string, string, string, string];
  rows: UsageTableRow[];
  more?: string;
}

/** The kinds of the Docker disk use (the colors of the bar). */
export type UsageDiskKind = 'images' | 'containers' | 'volumes' | 'buildCache';

/** What the page shows: only texts and numbers, which the webview sets as text. */
export interface UsagePageView {
  title: string;
  description: string;
  status: { text: string; tone: 'live' | 'starting' | 'paused' | 'off' | 'error' };
  /** The button Pause or Resume in the header; none while the page cannot read. */
  pause?: { action: 'pause' | 'resume'; label: string };
  sizes: { label: string; disabled: boolean };
  banner?: { tone: 'info' | 'warning' | 'error'; message: string; detail?: string; buttons: UsageButton[] };
  /** The values are not live (paused, ended, stopped VM): the page shows them dimmed. */
  stale: boolean;
  cpu: {
    caption: string;
    value: string;
    unit: string;
    /** The CPU use of the last samples (0 to 100), the oldest first; null is a gap. */
    spark: Array<number | null>;
    cores: Array<{ label: string; percent: number; text: string; level: 'normal' | 'high' | 'full' }>;
    coresNote?: string;
    lines: string[];
  };
  memory: { caption: string; value: string; unit: string; percent?: number; lines: UsageLine[] };
  disk: { caption: string; value: string; unit: string; percent?: number; lines: UsageLine[] };
  docker: {
    caption: string;
    value: string;
    unit: string;
    segments: Array<{ kind: UsageDiskKind; percent: number }>;
    rows: Array<{ kind: UsageDiskKind; label: string; size: string; free: string }>;
    note: string;
  };
  containers: { summary: string; rows: UsageContainerRow[]; more?: string; empty?: string; notes: string[] };
  stopped?: { summary: string; rows: Array<{ name: string; purpose: string; tone: UsageTone }>; more?: string };
  tables: UsageTable[];
  footer: string[];
}

/** What the page knows, for usagePageView. */
export interface UsagePageInput {
  host: string;
  /** The VM of Devspaces (LIMA_HOST or WSL_HOST), and whether it is its WSL distribution. */
  vm: boolean;
  wsl: boolean;
  /** The interval of the samples (usageSampler.ts), for the texts before the first rate. */
  intervalMs: number;
  phase: UsagePhase;
  header?: UsageHeader;
  /** The values of the last sample, the uptime of the host at its start (1/100 s), and when it came (ms since 1970). */
  usage?: HostUsage;
  uptimeCs?: number;
  updatedAt?: number;
  names?: ReadonlyMap<string, string>;
  /** The file systems of the Docker data of the last sample `d` (undefined before the first one). */
  disks?: DiskValue[];
  /** The free space on this computer for the disk of the VM (VM only). */
  localDiskFree?: number;
  /** The CPU use of the history (UsageHistory, series `busy`). */
  busy: Array<number | null>;
  sizes?: { inventory: HostInventory; at: number };
  sizesReading: boolean;
  /** Why the last read of the sizes failed (its first line). */
  sizesError?: string;
}

/** The most CPUs with a bar of their own; with more, the busiest MANY_CPUS_SHOWN. */
const MAX_CPU_BARS = 16;
const MANY_CPUS_SHOWN = 8;
/** The most rows of the running containers, and of each table of the sizes. */
export const MAX_CONTAINER_ROWS = 100;
export const MAX_TABLE_ROWS = 10;

/** User-visible texts of the page (plain language). */
export const UsagePageTexts = {
  panelTitle: (host: string) => `Utilization: ${host}`,
  vmDescription: 'Local VM of Devspaces',
  remoteDescription: 'Remote Docker host',
  pause: 'Pause',
  resume: 'Resume',
  retry: 'Retry',
  startVm: 'Start the VM',
  showLog: 'Show Log',
  readSizes: 'Read Sizes',
  refreshSizes: 'Refresh Sizes',
  readingSizes: 'Reading Sizes…',
  starting: 'Starting',
  startingMessage: (host: string) => `Reading ${host}…`,
  startingDetail: (vm: boolean) =>
    vm
      ? 'The page uses the shell of Devspaces to the VM. It does not start the VM.'
      : 'The page uses the shell of Devspaces to the host. When none is open, it logs in once over SSH; a host that needs a password asks for it in VS Code.',
  live: (seconds: number, at: string | undefined) => `Live · every ${seconds} s${at !== undefined ? ` · updated ${at}` : ''}`,
  liveReadingSizes: ' · reading the sizes',
  secondReading: (seconds: number) => `Reading the CPU use: it needs two readings, ${seconds} seconds apart.`,
  secondReadingDetail: 'Memory and disk show at once. The sizes of Docker show when their read ends.',
  paused: (at: string | undefined) => (at !== undefined ? `Paused · values of ${at}` : 'Paused'),
  pausedMessage: {
    button: 'Paused: you clicked Pause. The page reads nothing while it is paused.',
    focus: 'Paused: the window did not have the focus for 2 minutes. The page reads nothing while it is paused.',
    idle: 'Paused: there was no click and no key on this page for 30 minutes. The page reads nothing while it is paused.',
    vm: 'Paused: the VM of Devspaces stops or is set up again (Stop the VM…, Remove or Reset). The page reads nothing until you click Resume.',
  },
  pausedDetail: (at: string | undefined, vm: boolean) =>
    `${at !== undefined ? `The values below are from ${at}.` : 'The page has no values yet.'}${vm ? ' While it is paused, the VM can go to sleep.' : ''}`,
  notReading: 'Not reading',
  stoppedReading: 'Stopped reading',
  vmStopped: 'The VM of Devspaces does not run, so this page shows no values. The page does not start the VM by itself.',
  vmIdle: 'The VM of Devspaces went to sleep, because nothing runs there. The page does not keep it running.',
  vmStoppedDetail: 'Click "Start the VM" to start it and read again. The VM goes to sleep again by itself when nothing uses it.',
  vmNotSetUp: 'The VM of Devspaces is not set up, so this page shows no values. The menu of its row in the view Docker Hosts sets it up.',
  vmUnusable: (state: VmState) =>
    `Devspaces cannot use the VM of Devspaces now (${state.kind === 'broken' ? 'it is broken' : 'its state is not known'}), so this page shows no values.`,
  ended: {
    noAnswer: (host: string) => `${host} did not answer the last reading in time, so the page stopped reading.`,
    exited: (host: string, exitCode: number | null) =>
      exitCode === 255
        ? `The connection to ${host} failed or broke, so the page stopped reading.`
        : exitCode === 127
          ? `${host} has no shell sh, so the page cannot read it.`
          : `The reading of ${host} ended with exit code ${exitCode ?? 'none'}, so the page stopped reading.`,
    notLinux: (host: string) => `${host} is no Linux (it has no /proc), so the page cannot read it.`,
    badOutput: (host: string) => `${host} sent output that the page cannot read, so the page stopped reading.`,
    noTransport: (vm: boolean) => `The program for the connection (${vm ? 'ssh or wsl.exe' : 'ssh'}) was not found on this computer, so the page cannot read the host.`,
    failed: 'The page failed, so it stopped reading.',
    retryAsks: 'A host that needs a password asks for it when you click Retry.',
    noDetail: 'The log of Devspaces says more.',
  },
  cpuCaption: (count: number | undefined) => (count === undefined ? 'CPU' : `CPU · ${count} CPU${count === 1 ? '' : 's'}`),
  busy: 'busy',
  afterSecond: 'after the second reading',
  notRead: 'not read',
  reading: 'reading',
  manyCpus: (shown: number, count: number) => `The ${shown} busiest of ${count} CPUs.`,
  load: (load: readonly [number, number, number]) => `Load ${load.map((value) => value.toFixed(2)).join(' · ')} (1, 5, 15 min)`,
  waits: (iowait: string, steal: string) => `Waiting for disk ${iowait} · taken by the hypervisor ${steal}`,
  pressure: (cpu: string, memory: string, io: string) => `Pressure: CPU ${cpu} · memory ${memory} · I/O ${io} (the time that tasks waited)`,
  noPressure: 'Pressure: not available in this kernel',
  memoryCaption: 'Memory',
  ofUsed: (total: string, percent: number) => `of ${total} used (${percent} %)`,
  available: 'Available',
  fileCache: 'File cache',
  swap: 'Swap',
  none: 'none',
  oomKills: 'Processes ended for lack of memory',
  diskCaption: 'Disk of the Docker data',
  free: 'Free',
  inodes: 'Files (inodes) used',
  folder: 'Folder',
  also: (paths: string) => `Also ${paths}`,
  diskNotRead: 'could not be read',
  localFree: 'This computer: free for the disk of the VM',
  dockerCaption: 'Docker disk use',
  canBeFreed: (size: string) => `${size} can be freed`,
  diskKinds: { images: 'Images', containers: 'Containers', volumes: 'Volumes', buildCache: 'Build cache' } as Record<UsageDiskKind, string>,
  sizesNotRead: 'The page reads them by itself with docker system df -v while it reads, and Read Sizes reads them now; it reads every volume and can take a minute.',
  sizesReadingNote: 'Reading the sizes with docker system df -v…',
  sizesAt: (at: string) => `Sizes read at ${at}. Refresh Sizes reads them again. Can be freed: what no container uses (an unused volume holds data), and the build cache that no build uses.`,
  sizesFailed: (detail: string) => `The sizes could not be read: ${detail}`,
  sizesVmStopped: 'the VM of Devspaces does not run, and the page does not start it.',
  sizesVmUnusable: (detail: string | undefined) => `Devspaces cannot use the VM of Devspaces now${detail !== undefined && detail !== '' ? ` (${detail})` : ''}.`,
  containersSummary: (count: number) => `${count} · CPU: 100 % = one CPU, as in docker stats`,
  noContainers: 'No container runs.',
  containersNotRead: 'Not read.',
  moreRows: (count: number) => `And ${count} more.`,
  moreObjects: (count: number) => `And ${count} more: the view Docker Hosts lists all of them.`,
  noNames: 'The names show when docker ps answers on the host. Without access to Docker there (a user who is not in the group docker), the page shows the short IDs.',
  purposeAfterSizes: 'The purpose of each container shows when the sizes are read.',
  hostNetwork: 'network of the host',
  noNetwork: 'no network',
  stopped: (count: number, names: string) => `Stopped containers · ${count}${names !== '' ? ` · ${names}` : ''}`,
  dockerNetwork: 'network of Docker',
  tables: { volumes: 'Volumes', images: 'Images', networks: 'Networks' },
  headers: {
    volumes: ['Name', 'Purpose', 'Size', 'Used by'] as [string, string, string, string],
    images: ['Name', 'Purpose', 'Size', 'Used by'] as [string, string, string, string],
    networks: ['Name', 'Purpose', 'Driver', 'Containers'] as [string, string, string, string],
  },
  footer: 'This page reads only while it is visible, and it pauses after 2 minutes without the focus of the window. It changes nothing on the host and leaves nothing there: each reading is one command on the one shell of Devspaces to the host, which reads only files of the system (/proc, the cgroups), the free space, and the names of the containers from Docker.',
  footerVm: 'The page never starts the VM and does not keep it running: the VM goes to sleep by itself when nothing runs there, also while this page is open.',
  footerWsl: 'WSL: all WSL distributions share one Linux kernel, so the totals of CPU and memory include the other distributions and Docker Desktop.',
};

/** A percentage: one decimal below 10, else whole. */
export function formatPercent(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return `${safe < 10 ? (Math.round(safe * 10) / 10).toFixed(1) : String(Math.round(safe))} %`;
}

/** Bytes per second. */
function formatRate(bytesPerSecond: number): string {
  return `${formatSize(bytesPerSecond)}/s`;
}

/** The time of day HH:MM:SS (local time) of `ms`. */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

/** The uptime `up 3 h 12 min`. */
export function formatUptime(centiseconds: number): string {
  const minutes = Math.floor(centiseconds / 6000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `up ${days} d ${hours} h`;
  if (hours > 0) return `up ${hours} h ${minutes % 60} min`;
  return `up ${minutes} min`;
}

function wholePercent(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.max(0, Math.round((part * 100) / whole))) : 0;
}

/** The color of an object as the view Docker Hosts shows it. */
function toneOf(object: HostObject | undefined): UsageTone {
  return object === undefined ? 'normal' : (objectColor(object) ?? 'normal');
}

/** The purpose of an object as the view Docker Hosts names it; a network of Docker itself as such. */
function purposeOf(object: HostObject): string {
  return object.builtIn === true ? UsagePageTexts.dockerNetwork : DockerHostsTexts.purpose(object);
}

/** The seconds between two samples: of the last two blocks, else the interval of the sampler. */
function intervalSeconds(input: UsagePageInput): number {
  const cs = input.usage?.intervalCs;
  return Math.max(1, Math.round(cs !== undefined ? cs / 100 : input.intervalMs / 1000));
}

function statusAndBanner(input: UsagePageInput): Pick<UsagePageView, 'status' | 'banner' | 'pause' | 'stale'> {
  const { phase, host, vm } = input;
  const at = input.updatedAt !== undefined ? formatClock(input.updatedAt) : undefined;
  const T = UsagePageTexts;
  switch (phase.kind) {
    case 'starting':
      return {
        status: { text: T.starting, tone: 'starting' },
        banner: { tone: 'info', message: T.startingMessage(host), detail: T.startingDetail(vm), buttons: [] },
        pause: { action: 'pause', label: T.pause },
        stale: input.usage !== undefined,
      };
    case 'live': {
      const seconds = intervalSeconds(input);
      const waiting = input.usage !== undefined && input.usage.cpu === undefined;
      return {
        status: { text: `${T.live(seconds, at)}${input.sizesReading ? T.liveReadingSizes : ''}`, tone: 'live' },
        ...(waiting ? { banner: { tone: 'info' as const, message: T.secondReading(seconds), detail: T.secondReadingDetail, buttons: [] } } : {}),
        pause: { action: 'pause', label: T.pause },
        stale: false,
      };
    }
    case 'paused':
      return {
        status: { text: T.paused(at), tone: 'paused' },
        banner: { tone: 'warning', message: T.pausedMessage[phase.reason], detail: T.pausedDetail(at, vm), buttons: [{ action: 'resume', label: T.resume, primary: true }] },
        pause: { action: 'resume', label: T.resume },
        stale: true,
      };
    case 'vm': {
      const { state } = phase;
      const banner: UsagePageView['banner'] =
        state.kind === 'stopped' || state.kind === 'running'
          ? { tone: 'info', message: phase.idle === true ? T.vmIdle : T.vmStopped, detail: T.vmStoppedDetail, buttons: [{ action: 'startVm', label: T.startVm, primary: true }] }
          : state.kind === 'notSetUp'
            ? { tone: 'info', message: T.vmNotSetUp, buttons: [] }
            : { tone: 'warning', message: T.vmUnusable(state), ...(state.detail !== undefined ? { detail: state.detail } : {}), buttons: [{ action: 'showLog', label: T.showLog }] };
      return { status: { text: T.notReading, tone: 'off' }, banner, stale: true };
    }
    case 'ended':
      return { status: { text: T.stoppedReading, tone: 'error' }, banner: endedBanner(input, phase.end), stale: true };
  }
}

function endedBanner(input: UsagePageInput, end: UsageEnd): NonNullable<UsagePageView['banner']> {
  const { host, vm } = input;
  const E = UsagePageTexts.ended;
  const retry: UsageButton = { action: 'retry', label: UsagePageTexts.retry, primary: true };
  const showLog: UsageButton = { action: 'showLog', label: UsagePageTexts.showLog };
  const withAsk = (detail: string) => (vm ? detail : `${detail} ${E.retryAsks}`);
  switch (end.kind) {
    case 'noAnswer':
      return { tone: 'error', message: E.noAnswer(host), detail: withAsk(end.detail || E.noDetail), buttons: [retry, showLog] };
    case 'exited':
      return {
        tone: 'error',
        message: E.exited(host, end.exitCode),
        detail: end.exitCode === 127 ? end.detail || E.noDetail : withAsk(end.detail || E.noDetail),
        buttons: end.exitCode === 127 ? [showLog] : [retry, showLog],
      };
    case 'notLinux':
      return { tone: 'error', message: E.notLinux(host), buttons: [showLog] };
    case 'badOutput':
      return { tone: 'error', message: E.badOutput(host), detail: end.detail, buttons: [retry, showLog] };
    case 'noTransport':
      return { tone: 'error', message: E.noTransport(vm), buttons: [showLog] };
    case 'failed':
      return { tone: 'error', message: E.failed, detail: end.detail, buttons: [retry, showLog] };
    default:
      // `stopped`, `vmStopped` and `vmIdle` have their own state of the page; this is only a fallback.
      return { tone: 'error', message: E.failed, buttons: [retry, showLog] };
  }
}

function description(input: UsagePageInput): string {
  const parts = [input.vm ? UsagePageTexts.vmDescription : UsagePageTexts.remoteDescription];
  if (input.header?.kernel !== undefined) parts.push(`Linux ${input.header.kernel}`);
  if (input.uptimeCs !== undefined) parts.push(formatUptime(input.uptimeCs));
  return parts.join(' · ');
}

function cpuPart(input: UsagePageInput): UsagePageView['cpu'] {
  const { usage } = input;
  const T = UsagePageTexts;
  const cpu = usage?.cpu;
  const lines: string[] = [];
  if (usage?.load !== undefined) lines.push(T.load(usage.load));
  if (cpu !== undefined) lines.push(T.waits(formatPercent(cpu.iowait), formatPercent(cpu.steal)));
  if (usage !== undefined) {
    const { pressure } = usage;
    const share = (kind: 'cpu' | 'memory' | 'io') => {
      const value = pressure[kind]?.some;
      return value === undefined ? '—' : formatPercent(value.share ?? value.avg10);
    };
    lines.push(pressure.cpu === undefined && pressure.memory === undefined && pressure.io === undefined ? T.noPressure : T.pressure(share('cpu'), share('memory'), share('io')));
  }
  const level = (percent: number) => (percent >= 90 ? 'full' : percent >= 75 ? 'high' : 'normal') as 'normal' | 'high' | 'full';
  let cores = (usage?.cpus ?? []).map((share, index) => ({ label: `CPU ${index + 1}`, percent: Math.min(100, Math.max(0, share.busy)), text: formatPercent(share.busy), level: level(share.busy) }));
  let coresNote: string | undefined;
  if (cores.length > MAX_CPU_BARS) {
    coresNote = T.manyCpus(MANY_CPUS_SHOWN, cores.length);
    cores = [...cores].sort((a, b) => b.percent - a.percent).slice(0, MANY_CPUS_SHOWN);
  }
  return {
    caption: T.cpuCaption(usage?.cpuCount),
    value: cpu !== undefined ? formatPercent(cpu.busy) : usage !== undefined ? '…' : '—',
    unit: cpu !== undefined ? T.busy : usage !== undefined ? T.afterSecond : T.notRead,
    spark: input.busy,
    cores,
    ...(coresNote !== undefined ? { coresNote } : {}),
    lines,
  };
}

function memoryPart(input: UsagePageInput): UsagePageView['memory'] {
  const T = UsagePageTexts;
  const memory = input.usage?.memory;
  if (memory === undefined) return { caption: T.memoryCaption, value: '—', unit: T.notRead, lines: [] };
  const percent = wholePercent(memory.usedBytes, memory.totalBytes);
  const lines: UsageLine[] = [{ label: T.available, value: formatSize(memory.availableBytes) }];
  if (memory.cacheBytes !== undefined) lines.push({ label: T.fileCache, value: formatSize(memory.cacheBytes) });
  if (memory.swapTotalBytes !== undefined) {
    lines.push({ label: T.swap, value: memory.swapTotalBytes > 0 ? `${formatSize(memory.swapUsedBytes ?? 0)} of ${formatSize(memory.swapTotalBytes)}` : T.none });
  }
  if (input.usage?.oomKills !== undefined) lines.push({ label: T.oomKills, value: String(input.usage.oomKills) });
  return { caption: T.memoryCaption, value: formatSize(memory.usedBytes), unit: T.ofUsed(formatSize(memory.totalBytes), percent), percent, lines };
}

function diskPart(input: UsagePageInput): UsagePageView['disk'] {
  const T = UsagePageTexts;
  const local: UsageLine[] = input.vm && input.localDiskFree !== undefined ? [{ label: T.localFree, value: formatSize(input.localDiskFree) }] : [];
  const disks = input.disks;
  if (disks === undefined) {
    const reading = input.phase.kind === 'live' || input.phase.kind === 'starting';
    return { caption: T.diskCaption, value: reading ? '…' : '—', unit: reading ? T.reading : T.notRead, lines: local };
  }
  const [first, ...others] = disks;
  if (first === undefined) return { caption: T.diskCaption, value: '—', unit: T.diskNotRead, lines: local };
  const percent = wholePercent(first.usedBytes, first.sizeBytes);
  const lines: UsageLine[] = [{ label: T.free, value: formatSize(first.freeBytes) }];
  if (first.files > 0) lines.push({ label: T.inodes, value: `${wholePercent(first.files - first.freeFiles, first.files)} %` });
  lines.push({ label: T.folder, value: first.paths.join(', ') });
  for (const other of others) lines.push({ label: T.also(other.paths.join(', ')), value: `${formatSize(other.usedBytes)} of ${formatSize(other.sizeBytes)}` });
  lines.push(...local);
  return { caption: T.diskCaption, value: formatSize(first.usedBytes), unit: T.ofUsed(formatSize(first.sizeBytes), percent), percent, lines };
}

/** The size of an object for a sum of a kind: an image counts the bytes that only it uses. */
function sizeOf(object: HostObject): number {
  return (object.kind === 'image' ? (object.uniqueBytes ?? object.sizeBytes) : object.sizeBytes) ?? 0;
}

/** Whether no container uses the object (images and volumes), or it does not run (containers). */
function unused(object: HostObject): boolean {
  if (object.kind === 'container') return !isRunningContainer(object);
  return object.usedBy !== undefined ? object.usedBy === 0 : object.active !== true;
}

function dockerPart(input: UsagePageInput): UsagePageView['docker'] {
  const T = UsagePageTexts;
  const { sizes } = input;
  const failed = input.sizesError !== undefined ? T.sizesFailed(input.sizesError) : undefined;
  if (sizes === undefined) {
    return {
      caption: T.dockerCaption,
      value: input.sizesReading ? '…' : '—',
      unit: input.sizesReading ? T.reading : T.notRead,
      segments: [],
      rows: [],
      note: input.sizesReading ? T.sizesReadingNote : (failed ?? T.sizesNotRead),
    };
  }
  const { inventory } = sizes;
  const sums = (objects: readonly HostObject[]) => ({
    size: totalSize(objects).bytes,
    free: objects.filter(unused).reduce((sum, object) => sum + sizeOf(object), 0),
  });
  const kinds: Array<{ kind: UsageDiskKind; size: number; free: number }> = [
    { kind: 'images', ...sums(inventory.images) },
    { kind: 'containers', ...sums(inventory.containers) },
    { kind: 'volumes', ...sums(inventory.volumes) },
    { kind: 'buildCache', size: inventory.buildCache.bytes, free: inventory.buildCache.unusedBytes },
  ];
  const total = kinds.reduce((sum, item) => sum + item.size, 0);
  const free = kinds.reduce((sum, item) => sum + item.free, 0);
  const at = T.sizesAt(formatClock(sizes.at));
  // Each kind that has a size gets at least 1 % of the bar, so that it can be seen; the widths together stay 100 %.
  const shown = total > 0 ? kinds.filter((item) => item.size > 0).map((item) => ({ kind: item.kind, width: Math.max(1, (item.size * 100) / total) })) : [];
  const widths = shown.reduce((sum, item) => sum + item.width, 0);
  return {
    caption: T.dockerCaption,
    value: formatSize(total),
    unit: T.canBeFreed(formatSize(free)),
    segments: shown.map((item) => ({ kind: item.kind, percent: (item.width * 100) / widths })),
    rows: kinds.map((item) => ({ kind: item.kind, label: T.diskKinds[item.kind], size: formatSize(item.size), free: formatSize(item.free) })),
    note: input.sizesReading ? `${T.sizesReadingNote} ${at}` : failed !== undefined ? `${failed} ${at}` : at,
  };
}

function containersPart(input: UsagePageInput): UsagePageView['containers'] {
  const T = UsagePageTexts;
  const { usage, names, sizes } = input;
  if (usage === undefined) return { summary: '', rows: [], empty: T.containersNotRead, notes: [] };
  const known = new Map((sizes?.inventory.containers ?? []).map((object) => [object.id, object]));
  const hostMemory = usage.memory?.totalBytes;
  const cpus = Math.max(1, usage.cpuCount);
  const sorted = [...usage.containers].sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1));
  const rows = sorted.slice(0, MAX_CONTAINER_ROWS).map((container): UsageContainerRow => {
    const object = known.get(container.id);
    const limit = container.memoryLimitBytes ?? hostMemory;
    let network = '—';
    if (container.network === 'host') network = T.hostNetwork;
    else if (container.network === 'none') network = T.noNetwork;
    else if (container.network === 'interfaces') {
      network = container.netRxRate !== undefined && container.netTxRate !== undefined ? `↓ ${formatRate(container.netRxRate)} · ↑ ${formatRate(container.netTxRate)}` : '…';
    }
    const disk =
      container.readRate !== undefined && container.writeRate !== undefined
        ? `${formatRate(container.readRate)} · ${formatRate(container.writeRate)}`
        : container.readBytes !== undefined || container.writeBytes !== undefined
          ? '…'
          : '—';
    return {
      name: names?.get(container.id) ?? container.id.slice(0, 12),
      purpose: object !== undefined ? purposeOf(object) : '',
      tone: toneOf(object),
      cpu: container.cpuPercent !== undefined ? formatPercent(container.cpuPercent) : '…',
      cpuBar: container.cpuPercent !== undefined ? Math.min(100, container.cpuPercent / cpus) : 0,
      memory: container.memoryBytes !== undefined ? (limit !== undefined ? `${formatSize(container.memoryBytes)} of ${formatSize(limit)}` : formatSize(container.memoryBytes)) : '—',
      network,
      disk,
      pids: container.pids !== undefined ? String(container.pids) : '—',
    };
  });
  const notes: string[] = [];
  if (usage.containers.length > 0 && names === undefined) notes.push(T.noNames);
  if (usage.containers.length > 0 && sizes === undefined) notes.push(T.purposeAfterSizes);
  return {
    summary: T.containersSummary(usage.containers.length),
    rows,
    ...(sorted.length > MAX_CONTAINER_ROWS ? { more: T.moreRows(sorted.length - MAX_CONTAINER_ROWS) } : {}),
    ...(usage.containers.length === 0 ? { empty: T.noContainers } : {}),
    notes,
  };
}

function stoppedPart(input: UsagePageInput): UsagePageView['stopped'] {
  const inventory = input.sizes?.inventory;
  if (inventory === undefined) return undefined;
  const stopped = inventory.containers.filter((object) => !isRunningContainer(object));
  if (stopped.length === 0) return undefined;
  const first = stopped
    .slice(0, 3)
    .map((object) => object.name)
    .join(', ');
  return {
    summary: UsagePageTexts.stopped(stopped.length, stopped.length > 3 ? `${first}, …` : first),
    rows: stopped.slice(0, MAX_CONTAINER_ROWS).map((object) => ({ name: object.name, purpose: purposeOf(object), tone: toneOf(object) })),
    ...(stopped.length > MAX_CONTAINER_ROWS ? { more: UsagePageTexts.moreObjects(stopped.length - MAX_CONTAINER_ROWS) } : {}),
  };
}

function table(title: string, headers: UsageTable['headers'], objects: readonly HostObject[], values: (object: HostObject) => [string, string], summary: string): UsageTable {
  const rows = objects.slice(0, MAX_TABLE_ROWS).map((object) => ({ name: object.name, purpose: purposeOf(object), tone: toneOf(object), values: values(object) }));
  return { title, summary, headers, rows, ...(objects.length > MAX_TABLE_ROWS ? { more: UsagePageTexts.moreObjects(objects.length - MAX_TABLE_ROWS) } : {}) };
}

function tablesPart(input: UsagePageInput): UsageTable[] {
  const inventory = input.sizes?.inventory;
  if (inventory === undefined) return [];
  const T = UsagePageTexts;
  const bySize = (objects: readonly HostObject[]) => [...objects].sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || a.name.localeCompare(b.name));
  const count = (value: number | undefined) => (value === undefined ? '—' : String(value));
  const size = (object: HostObject) => (object.sizeBytes === undefined ? '—' : formatSize(object.sizeBytes));
  const withTotal = (objects: readonly HostObject[]) => `${objects.length} · ${formatSize(totalSize(objects).bytes)}`;
  return [
    table(T.tables.volumes, T.headers.volumes, bySize(inventory.volumes), (object) => [size(object), count(object.usedBy)], withTotal(inventory.volumes)),
    table(T.tables.images, T.headers.images, bySize(inventory.images), (object) => [size(object), count(object.usedBy)], withTotal(inventory.images)),
    table(
      T.tables.networks,
      T.headers.networks,
      [...inventory.networks].sort((a, b) => (b.usedBy ?? 0) - (a.usedBy ?? 0) || a.name.localeCompare(b.name)),
      (object) => [object.driver ?? '—', count(object.usedBy)],
      String(inventory.networks.length),
    ),
  ];
}

/** What the page shows. */
export function usagePageView(input: UsagePageInput): UsagePageView {
  const T = UsagePageTexts;
  const footer = [T.footer];
  if (input.vm) footer.push(T.footerVm);
  if (input.wsl) footer.push(T.footerWsl);
  return {
    title: input.host,
    description: description(input),
    ...statusAndBanner(input),
    sizes: {
      label: input.sizesReading ? T.readingSizes : input.sizes !== undefined ? T.refreshSizes : T.readSizes,
      // Not while the VM stops or is set up again: a read would log in to it again.
      disabled: input.sizesReading || (input.phase.kind === 'paused' && input.phase.reason === 'vm'),
    },
    cpu: cpuPart(input),
    memory: memoryPart(input),
    disk: diskPart(input),
    docker: dockerPart(input),
    containers: containersPart(input),
    ...(input.sizes !== undefined ? { stopped: stoppedPart(input) } : {}),
    tables: tablesPart(input),
    footer,
  };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The HTML of the webview: a skeleton that page.js fills with the view. Scripts only with the nonce, styles only from
 * the style sheet of the extension (the script sets the widths of the bars through the style of the element, which
 * the CSP allows), no other source.
 */
export function usagePageHtml(options: { cspSource: string; nonce: string; scriptUri: string; styleUri: string; host: string }): string {
  const csp = ["default-src 'none'", `style-src ${options.cspSource}`, `script-src 'nonce-${options.nonce}'`, "img-src 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');
  const title = escapeText(UsagePageTexts.panelTitle(options.host));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttribute(options.styleUri)}">
<title>${title}</title>
</head>
<body>
<main>
<header class="head">
<div class="head-text">
<h1 id="title">${escapeText(options.host)}</h1>
<p id="description" class="muted"></p>
</div>
<div class="head-actions">
<span id="status" class="status" role="status" aria-live="polite"><span class="dot" aria-hidden="true"></span><span id="status-text"></span></span>
<button type="button" id="pause" class="secondary" hidden></button>
<button type="button" id="sizes" class="secondary"></button>
</div>
</header>
<section id="banner" class="banner" hidden>
<div class="banner-text">
<p id="banner-message"></p>
<p id="banner-detail" class="muted"></p>
</div>
<div id="banner-buttons" class="banner-buttons"></div>
</section>
<div id="values" class="values">
<div id="cards" class="cards"></div>
<section aria-labelledby="containers-heading">
<div class="section-head"><h2 id="containers-heading">Running containers</h2><span id="containers-summary" class="muted"></span></div>
<div class="table-box">
<table class="containers">
<thead><tr><th scope="col">Name</th><th scope="col">Purpose</th><th scope="col">CPU</th><th scope="col">Memory</th><th scope="col">Network in / out</th><th scope="col">Disk read / write</th><th scope="col" class="number">PIDs</th></tr></thead>
<tbody id="containers"></tbody>
</table>
</div>
<p id="containers-notes" class="muted small"></p>
<details id="stopped" hidden><summary id="stopped-summary"></summary><ul id="stopped-list" class="plain"></ul></details>
</section>
<div id="tables" class="tables"></div>
</div>
<footer id="footer" class="muted small"></footer>
</main>
<script nonce="${escapeAttribute(options.nonce)}" src="${escapeAttribute(options.scriptUri)}"></script>
</body>
</html>`;
}
