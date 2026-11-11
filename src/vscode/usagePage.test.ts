// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The utilization page of a host (R-ENG-009): one page per host; its samples run on the shared shell of the host and
// never start the VM of Devspaces (R-VM-004); the pauses (hidden, focus, 30 minutes, Pause, Stop the VM…); the logins
// that may ask (open, Resume, Retry, Start the VM, Read Sizes) and those that do not (a new start after a hide).
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import type * as vscode from 'vscode';
import { LIMA_HOST, WSL_HOST } from '../core/docker/dockerHost';
import type { HostInventory } from '../core/hosts/hostObjects';
import { USAGE_NAMES_ARGS, USAGE_ROOT_ARGS, VM_USAGE_INTERVAL_MS, SSH_USAGE_INTERVAL_MS, type UsageTimers } from '../core/hosts/usageSampler';
import { usageDockerScript } from '../core/hosts/usageScript';
import type { RunResult } from '../core/ports';
import { sshPromptsAllowed } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import { fakeVscode, resetFakeVscode, type FakeWebviewPanel } from './testing/fakeVscode';
import { FOCUS_PAUSE_MS, HIDDEN_STOP_MS, IDLE_PAUSE_MS, UsagePages, type UsagePagesDeps } from './usagePage';
import { UsagePageTexts, type UsagePageView } from './usagePageModel';

const BOOT = 'c979624d-e703-46d3-ae35-c4cb34a59e91';
const ID_A = 'a'.repeat(64);
const OK = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const NAMES_SCRIPT = usageDockerScript(USAGE_NAMES_ARGS);
const ROOT_SCRIPT = usageDockerScript(USAGE_ROOT_ARGS);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };

/** Timers that run only when the test moves the clock. */
class FakeTimers implements UsageTimers {
  time = 1_000_000;
  private next = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  now(): number {
    return this.time;
  }

  get waiting(): number {
    return this.pending.size;
  }

  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.pending.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
      await flush();
    }
    this.time = end;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** The script of a command of the samples (usageShellCommand): printf %b of one shell word. */
function scriptOf(command: string): string {
  const match = /^\{ printf '%b' '(.*)' \| sh -s; \}$/s.exec(command);
  if (match === null) throw new Error(`not a command of the samples: ${command}`);
  return match[1].replace(/'\\''/g, "'").replace(/\\(\\|n)/g, (_, escaped: string) => (escaped === 'n' ? '\n' : '\\'));
}

/** The shared shells of the hosts, which answer each sample as the script would. */
class FakeShells {
  readonly open = new Set<string>();
  noTransport = false;
  readonly logins: Array<{ host: string; flow: boolean }> = [];
  readonly closed: string[] = [];
  readonly samples: Array<{ host: string; seq: number; kind: string; wslIdle: boolean }> = [];
  holds = 0;
  /** The age of process 1 and the uptime of the host at the clock 0 of the test, in 1/100 s. */
  pid1AgeCs = 500_000;
  uptimeCs = 1_000_000;
  /** The line `I` of a sample `d` with the idle check. */
  idle = true;
  containers: string[] = [];
  /** The next answer to a sample, instead of the output of the script. */
  next: RunResult | undefined;
  /** A login takes this long (it moves the clock). */
  loginMs = 0;

  constructor(private readonly timers: FakeTimers) {}

  run: Mock<UsagePagesDeps['shells']['run']> = vi.fn(async (host: string, command: string, options: { timeoutMs?: number; login?: boolean } = {}) => {
    if (options.login === false) {
      if (!this.open.has(host)) return undefined;
    } else {
      this.logins.push({ host, flow: sshPromptsAllowed() });
      if (this.noTransport) return undefined;
      this.timers.time += this.loginMs;
      this.open.add(host);
    }
    const script = scriptOf(command);
    if (script === NAMES_SCRIPT) return OK(this.containers.map((id, index) => `${id} name-${index}`).join('\n'));
    if (script === ROOT_SCRIPT) return OK('/var/lib/docker\n');
    const match = /^mk=([0-9a-f]{32}) seq=(\d+) c=([td]) wi=([01]) rd='([^']*)'$/m.exec(script);
    if (match === null) throw new Error('not the script');
    const [, marker, seq, kind, wi] = match;
    this.samples.push({ host, seq: Number(seq), kind, wslIdle: wi === '1' });
    const next = this.next;
    this.next = undefined;
    if (next !== undefined) return next;
    const elapsed = Math.floor(this.timers.time / 10);
    const start = this.uptimeCs + elapsed;
    const time = (cs: number) => `${Math.floor(cs / 100)}.${String(cs % 100).padStart(2, '0')}`;
    const lines = [
      `@${marker}`,
      `#H 2 2 0 ${BOOT} ${this.pid1AgeCs + elapsed} 6.12.48`,
      `#T ${seq} ${time(start)}`,
      `cpu  ${100 * Number(seq)} 0 0 ${900 * Number(seq)} 0 0 0 0`,
      'M MemTotal: 1000',
      'M MemAvailable: 400',
    ];
    if (kind === 'd') lines.push('D 801 4096 1000 500 400 100 90 /var/lib/docker');
    if (kind === 'd' && wi === '1') lines.push(`I ${this.idle ? 1 : 0}`);
    for (const id of this.containers) lines.push(`C ${id}`, 'm 10');
    lines.push(`#E ${seq} ${time(start + 1)}`, '');
    return OK(lines.join('\n'));
  });

  keep = vi.fn((_host: string) => {
    this.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
    };
  });

  close = vi.fn((host: string) => {
    this.closed.push(host);
    this.open.delete(host);
  });
}

let timers: FakeTimers;
let shells: FakeShells;
let vmState: VmState;
let stopping: boolean;
let startVm: Mock<UsagePagesDeps['startVm']>;
let readSizes: Mock<UsagePagesDeps['readSizes']>;
let showLog: Mock<() => void>;
let created: UsagePages[];

const emptyInventory = (): HostInventory => ({ containers: [], images: [], volumes: [], networks: [], buildCache: { records: 0, bytes: 0, unusedBytes: 0 } });

function pages(vmHost: string | undefined = LIMA_HOST, extra: Partial<UsagePagesDeps> = {}): UsagePages {
  const made = new UsagePages({
    extensionUri: fakeVscode.Uri.file('/ext') as unknown as vscode.Uri,
    logger,
    showLog,
    vmHost,
    shells,
    vmState: async () => vmState,
    vmStopping: () => stopping,
    startVm,
    readSizes,
    localDiskFree: async () => 210e9,
    timers,
    ...extra,
  });
  created.push(made);
  return made;
}

const hostRow = (host: string) => ({ hostsNode: 'host', host });

/** Opens the page of `host` and lets its first sample run. */
async function open(made: UsagePages, host: string): Promise<FakeWebviewPanel> {
  made.show(hostRow(host));
  await flush();
  const panel = fakeVscode.webviewPanels.at(-1);
  if (panel === undefined) throw new Error('no panel');
  return panel;
}

function lastView(panel: FakeWebviewPanel): UsagePageView {
  const views = panel.posted.filter((message) => message.type === 'view');
  const view = views.at(-1)?.view as UsagePageView | undefined;
  if (view === undefined) throw new Error('no view');
  return view;
}

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
  timers = new FakeTimers();
  shells = new FakeShells(timers);
  vmState = { kind: 'running' };
  stopping = false;
  startVm = vi.fn(async () => undefined);
  readSizes = vi.fn(async () => emptyInventory());
  showLog = vi.fn();
  for (const made of created ?? []) made.dispose();
  created = [];
});

describe('UsagePages', () => {
  it('opens one page per host in the editor, and a second Show Utilization shows it', async () => {
    shells.open.add(LIMA_HOST);
    const made = pages();
    const panel = await open(made, LIMA_HOST);
    expect(panel.viewType).toBe('devspaces.utilization');
    expect(panel.title).toBe('Utilization: lima:devspaces');
    expect(panel.options).toMatchObject({ enableScripts: true, enableCommandUris: false, retainContextWhenHidden: false });
    expect(panel.webview.html).toContain("script-src 'nonce-");
    made.show(hostRow(LIMA_HOST));
    expect(fakeVscode.webviewPanels).toHaveLength(1);
    expect(panel.reveal).toHaveBeenCalled();
    made.show({ hostsNode: 'object', host: LIMA_HOST });
    made.show(undefined);
    expect(fakeVscode.webviewPanels).toHaveLength(1);
  });

  it('samples on the open shell of the VM without a login, holds the shell, and shows the values', async () => {
    shells.open.add(LIMA_HOST);
    shells.containers = [ID_A];
    const panel = await open(pages(), LIMA_HOST);
    expect(shells.run).toHaveBeenCalledWith(LIMA_HOST, expect.stringMatching(/^\{ printf '%b' '/), { timeoutMs: 15_000, login: false });
    expect(shells.logins).toEqual([]);
    expect(shells.holds).toBe(1);
    expect(lastView(panel)).toMatchObject({ status: { tone: 'live' }, memory: { value: '614 kB' }, description: 'Local VM of Devspaces · Linux 6.12.48 · up 3 h 3 min' });
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(shells.samples.map((sample) => sample.kind)).toEqual(['d', 't']);
    expect(lastView(panel).cpu.value).toBe('10 %');
    // The free space of this computer for the disk of the VM, with the first sample `d`.
    expect(lastView(panel).disk).toMatchObject({ value: '2 MB', unit: 'of 4.1 MB used (50 %)' });
    expect(lastView(panel).disk.lines).toContainEqual({ label: 'This computer: free for the disk of the VM', value: '210 GB' });
    // The names of the running containers come on the same shell.
    expect(lastView(panel).containers.rows.map((row) => row.name)).toEqual(['name-0']);
  });

  it('never starts a stopped VM: no login, and Start the VM starts it and then the samples', async () => {
    vmState = { kind: 'stopped' };
    const made = pages();
    const panel = await open(made, LIMA_HOST);
    expect(shells.logins).toEqual([]);
    expect(shells.holds).toBe(0);
    expect(lastView(panel).banner).toMatchObject({ message: UsagePageTexts.vmStopped, buttons: [{ action: 'startVm' }] });
    startVm.mockImplementation(async () => {
      vmState = { kind: 'running' };
      // Its onDidChange: the page waits for the start, so it does not start twice.
      made.vmChanged();
    });
    panel.receive({ type: 'startVm' });
    await flush();
    expect(startVm).toHaveBeenCalledTimes(1);
    expect(shells.logins).toEqual([{ host: LIMA_HOST, flow: true }]);
    expect(lastView(panel).status.tone).toBe('live');
  });

  it('does not log in to a WSL distribution that stops now', async () => {
    stopping = true;
    const panel = await open(pages(WSL_HOST), WSL_HOST);
    expect(shells.logins).toEqual([]);
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.vmStopped);
  });

  it('logs in to a running VM, and ends its samples and its shell when the VM is younger than the check', async () => {
    const made = pages(WSL_HOST);
    let panel = await open(made, WSL_HOST);
    expect(shells.logins).toEqual([{ host: WSL_HOST, flow: true }]);
    expect(lastView(panel).status.tone).toBe('live');
    panel.dispose();
    // The distribution stopped between the check and the login, and wsl.exe started it again.
    shells.open.clear();
    shells.pid1AgeCs = -100_250;
    shells.loginMs = 3_000;
    panel = await open(made, WSL_HOST);
    expect(shells.closed).toEqual([WSL_HOST]);
    expect(shells.holds).toBe(0);
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.vmIdle);
    await timers.advance(VM_USAGE_INTERVAL_MS * 3);
    expect(shells.samples).toHaveLength(2);
  });

  it('ends the samples of WSL when its idle script ended, and closes the shell', async () => {
    shells.open.add(WSL_HOST);
    const panel = await open(pages(WSL_HOST), WSL_HOST);
    expect(shells.samples[0]).toMatchObject({ kind: 'd', wslIdle: true });
    shells.idle = false;
    await timers.advance(VM_USAGE_INTERVAL_MS * 5);
    expect(shells.closed).toEqual([WSL_HOST]);
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.vmIdle);
    expect(shells.holds).toBe(0);
  });

  it('asks at the first login of the open of a remote host only, and shows a failed login with Retry', async () => {
    const made = pages();
    const panel = await open(made, 'build-box');
    expect(shells.logins).toEqual([{ host: 'build-box', flow: true }]);
    shells.open.clear();
    shells.next = { exitCode: 255, stdout: '', stderr: 'Permission denied (password).', timedOut: false };
    await timers.advance(SSH_USAGE_INTERVAL_MS);
    expect(shells.logins).toEqual([
      { host: 'build-box', flow: true },
      { host: 'build-box', flow: false },
    ]);
    expect(lastView(panel).banner).toMatchObject({ tone: 'error', message: 'The connection to build-box failed or broke, so the page stopped reading.' });
    expect(shells.holds).toBe(0);
    shells.open.clear();
    panel.receive({ type: 'retry' });
    await flush();
    expect(shells.logins.at(-1)).toEqual({ host: 'build-box', flow: true });
    expect(lastView(panel).status.tone).toBe('live');
  });

  it('says when the program of the connection is missing', async () => {
    shells.noTransport = true;
    const panel = await open(pages(), 'build-box');
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.ended.noTransport(false));
  });

  it('shows a VM that went to sleep while the page read it', async () => {
    shells.open.add(LIMA_HOST);
    const panel = await open(pages(), LIMA_HOST);
    vmState = { kind: 'stopped' };
    shells.next = { exitCode: 255, stdout: '', stderr: 'Connection closed', timedOut: false };
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(lastView(panel).banner).toMatchObject({ message: UsagePageTexts.vmIdle, buttons: [{ action: 'startVm' }] });
  });

  it('reads nothing while hidden: a show within 15 seconds goes on, later it starts anew without questions', async () => {
    const made = pages();
    const panel = await open(made, 'build-box');
    expect(shells.samples).toHaveLength(1);
    panel.setVisible(false);
    await timers.advance(HIDDEN_STOP_MS - 1000);
    expect(shells.samples).toHaveLength(1);
    expect(shells.holds).toBe(1);
    panel.setVisible(true);
    await timers.advance(0);
    expect(shells.samples).toHaveLength(2);
    panel.setVisible(false);
    await timers.advance(HIDDEN_STOP_MS);
    expect(shells.holds).toBe(0);
    await timers.advance(60_000);
    expect(shells.samples).toHaveLength(2);
    const posted = panel.posted.length;
    shells.open.clear();
    panel.setVisible(true);
    await flush();
    expect(shells.samples).toHaveLength(3);
    expect(shells.logins.at(-1)).toEqual({ host: 'build-box', flow: false });
    // A hidden page got no view; the page that shows again asks for it.
    panel.receive({ type: 'ready' });
    expect(panel.posted.length).toBeGreaterThan(posted);
  });

  it('pauses after 2 minutes without the focus of the window, and Resume asks again', async () => {
    const made = pages();
    const panel = await open(made, 'build-box');
    fakeVscode.fireWindowState(false);
    await timers.advance(FOCUS_PAUSE_MS - 1000);
    fakeVscode.fireWindowState(true);
    await timers.advance(5000);
    expect(lastView(panel).status.tone).toBe('live');
    fakeVscode.fireWindowState(false);
    await timers.advance(FOCUS_PAUSE_MS);
    expect(lastView(panel).banner).toMatchObject({ message: UsagePageTexts.pausedMessage.focus, buttons: [{ action: 'resume' }] });
    expect(shells.holds).toBe(0);
    const count = shells.samples.length;
    await timers.advance(60_000);
    expect(shells.samples).toHaveLength(count);
    shells.open.clear();
    panel.receive({ type: 'resume' });
    await flush();
    expect(shells.logins.at(-1)).toEqual({ host: 'build-box', flow: true });
    expect(lastView(panel).status.tone).toBe('live');
  });

  it('pauses after 30 minutes without a click or a key on the page', async () => {
    const panel = await open(pages(), 'build-box');
    await timers.advance(IDLE_PAUSE_MS - 60_000);
    panel.receive({ type: 'activity' });
    await timers.advance(IDLE_PAUSE_MS - 60_000);
    expect(lastView(panel).status.tone).toBe('live');
    await timers.advance(60_000);
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.pausedMessage.idle);
  });

  it('pauses with Pause, and Stop the VM… pauses until Resume', async () => {
    shells.open.add(LIMA_HOST);
    const made = pages();
    const panel = await open(made, LIMA_HOST);
    panel.receive({ type: 'pause' });
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.pausedMessage.button);
    expect(shells.holds).toBe(0);
    panel.receive({ type: 'resume' });
    await flush();
    expect(lastView(panel).status.tone).toBe('live');
    made.vmClosing();
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.pausedMessage.vm);
    expect(shells.holds).toBe(0);
    made.vmChanged();
    await timers.advance(10_000);
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.pausedMessage.vm);
  });

  it('reads again when the VM it waits for starts from somewhere else', async () => {
    vmState = { kind: 'stopped' };
    const made = pages();
    const panel = await open(made, LIMA_HOST);
    vmState = { kind: 'running' };
    shells.open.add(LIMA_HOST);
    made.vmChanged();
    await flush();
    expect(lastView(panel).status.tone).toBe('live');
  });

  it('reads again at the next show when the VM it waits for started while the page was hidden', async () => {
    vmState = { kind: 'stopped' };
    const made = pages();
    const panel = await open(made, LIMA_HOST);
    panel.setVisible(false);
    // A show without a change of the VM reads nothing.
    panel.setVisible(true);
    await flush();
    expect(shells.samples).toHaveLength(0);
    panel.setVisible(false);
    vmState = { kind: 'running' };
    shells.open.add(LIMA_HOST);
    made.vmChanged();
    await flush();
    expect(shells.samples).toHaveLength(0);
    panel.setVisible(true);
    await flush();
    expect(shells.samples).toHaveLength(1);
    panel.receive({ type: 'ready' });
    expect(lastView(panel).status.tone).toBe('live');
  });

  it('reads the sizes on click in a flow, never on a stopped VM', async () => {
    shells.open.add(LIMA_HOST);
    const panel = await open(pages(), LIMA_HOST);
    let flow: boolean | undefined;
    readSizes.mockImplementation(async () => {
      flow = sshPromptsAllowed();
      return emptyInventory();
    });
    panel.receive({ type: 'readSizes' });
    expect(lastView(panel).sizes).toEqual({ label: 'Reading Sizes…', disabled: true });
    await flush();
    expect(readSizes).toHaveBeenCalledWith(LIMA_HOST, expect.any(AbortSignal));
    expect(flow).toBe(true);
    expect(lastView(panel).sizes).toEqual({ label: 'Refresh Sizes', disabled: false });
    vmState = { kind: 'stopped' };
    panel.receive({ type: 'readSizes' });
    await flush();
    expect(readSizes).toHaveBeenCalledTimes(1);
    expect(lastView(panel).docker.note).toContain(UsagePageTexts.sizesVmStopped);
    vmState = { kind: 'running' };
    readSizes.mockRejectedValueOnce(new Error('docker system df failed\nmore'));
    panel.receive({ type: 'readSizes' });
    await flush();
    expect(lastView(panel).docker.note).toContain('The sizes could not be read: docker system df failed Sizes read at');
  });

  it('ignores a message that is not valid, and opens the log', async () => {
    const panel = await open(pages(), 'build-box');
    panel.receive({ type: 'save' });
    expect(logger.warn).toHaveBeenCalledWith('The utilization page sent a message that is not valid. It is ignored.');
    panel.receive({ type: 'showLog' });
    expect(showLog).toHaveBeenCalledTimes(1);
  });

  it('ends the samples and the hold when the page closes, and the next Show opens a new page', async () => {
    const made = pages();
    const panel = await open(made, 'build-box');
    panel.dispose();
    expect(shells.holds).toBe(0);
    expect(timers.waiting).toBe(0);
    await timers.advance(60_000);
    expect(shells.samples).toHaveLength(1);
    await open(made, 'build-box');
    expect(fakeVscode.webviewPanels).toHaveLength(2);
    made.dispose();
    expect(fakeVscode.webviewPanels[1].disposed).toBe(true);
    expect(shells.holds).toBe(0);
  });
});
