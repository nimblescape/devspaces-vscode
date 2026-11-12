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
import { CommandError } from '../core/errors';
import type { HostInventory } from '../core/hosts/hostObjects';
import { USAGE_NAMES_ARGS, USAGE_ROOT_ARGS, VM_USAGE_INTERVAL_MS, SSH_USAGE_INTERVAL_MS, type UsageTimers } from '../core/hosts/usageSampler';
import { usageDockerScript } from '../core/hosts/usageScript';
import type { RunResult } from '../core/ports';
import { sshPromptsAllowed } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import { fakeVscode, resetFakeVscode, type FakeWebviewPanel } from './testing/fakeVscode';
import { FOCUS_PAUSE_MS, HIDDEN_STOP_MS, IDLE_PAUSE_MS, SIZES_EVERY_MS, SIZES_FRESH_MS, SIZES_RETRY_MS, UsagePages, VM_CHECK_MS, type UsagePagesDeps } from './usagePage';
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
  /** The boot ID of the line `#H`. */
  boot = BOOT;
  /** How long a sample takes on the host, from `#T` to `#E` (1/100 s). */
  sampleCs = 1;
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
      `#H 2 2 0 ${this.boot} ${this.pid1AgeCs + elapsed} 6.12.48`,
      `#T ${seq} ${time(start)}`,
      `cpu  ${100 * Number(seq)} 0 0 ${900 * Number(seq)} 0 0 0 0`,
      'M MemTotal: 1000',
      'M MemAvailable: 400',
    ];
    if (kind === 'd') lines.push('D 801 4096 1000 500 400 100 90 /var/lib/docker');
    if (kind === 'd' && wi === '1') lines.push(`I ${this.idle ? 1 : 0}`);
    for (const id of this.containers) lines.push(`C ${id}`, 'm 10');
    lines.push(`#E ${seq} ${time(start + this.sampleCs)}`, '');
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

/**
 * After a start (Resume, a show): lets its first sample end at the time of the start, then lets the second sample come,
 * with the first rate of the CPU of the start.
 */
async function secondSample(host: string): Promise<void> {
  await flush();
  await timers.advance(intervalOf(host));
}

/** The time between two samples on `host`. */
function intervalOf(host: string): number {
  return host === LIMA_HOST || host === WSL_HOST ? VM_USAGE_INTERVAL_MS : SSH_USAGE_INTERVAL_MS;
}

/** Opens the page and lets the second sample come: with the first rate of the CPU, the page reads the sizes by itself. */
async function openRead(made: UsagePages, host: string): Promise<FakeWebviewPanel> {
  const panel = await open(made, host);
  await timers.advance(intervalOf(host));
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
    // The free space of this computer comes after the first sample, and the page shows it at once.
    expect(lastView(panel).disk.lines).toContainEqual({ label: 'This computer: free for the disk of the VM', value: '210 GB' });
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(shells.samples.map((sample) => sample.kind)).toEqual(['d', 't']);
    expect(lastView(panel).cpu.value).toBe('10 %');
    // The free space of this computer for the disk of the VM, with the first sample `d`.
    expect(lastView(panel).disk).toMatchObject({ value: '2 MB', unit: 'of 4.1 MB used (50 %)' });
    expect(lastView(panel).disk.lines).toContainEqual({ label: 'This computer: free for the disk of the VM', value: '210 GB' });
    // The names of the running containers come on the same shell.
    expect(lastView(panel).containers.rows.map((row) => row.name)).toEqual(['name-0']);
  });

  it('logs in to a running VM with no second login after a closed shell, and to a remote host with one', async () => {
    await open(pages(), LIMA_HOST);
    const optionsOf = (host: string) => shells.run.mock.calls.filter((call) => call[0] === host).map((call) => call[2]);
    expect(optionsOf(LIMA_HOST)).toEqual([
      { timeoutMs: 15_000, login: false },
      { timeoutMs: 15_000, relogin: false },
    ]);
    await open(pages(), 'build-box');
    expect(optionsOf('build-box')).toEqual([
      { timeoutMs: 15_000, login: false },
      { timeoutMs: 15_000, relogin: true },
    ]);
    expect(shells.logins.map((login) => login.host)).toEqual([LIMA_HOST, 'build-box']);
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

  it('logs in to a running VM, and ends its samples when the VM is younger than the check', async () => {
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
    // The shell stays for the view Docker Hosts; the end of the idle script of the keeper closes it.
    expect(shells.closed).toEqual([]);
    expect(shells.holds).toBe(0);
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.vmIdle);
    await timers.advance(VM_USAGE_INTERVAL_MS * 3);
    expect(shells.samples).toHaveLength(2);
    // The checks of the VM let it go to sleep: no reading while it still runs, for 5 minutes.
    await timers.advance(VM_CHECK_MS * 9);
    expect(shells.samples).toHaveLength(2);
    await timers.advance(VM_CHECK_MS * 2);
    expect(shells.samples.length).toBeGreaterThan(2);
  });

  it('counts the VM as started by its login only when it is younger than the check by more than 1 second', async () => {
    // The login takes 3 seconds, and the VM is 2.5 seconds old at the first sample: it started before the check, and
    // the answer took its time on the way back.
    shells.loginMs = 3_000;
    shells.pid1AgeCs = 250 - Math.floor((timers.time + 3_000) / 10);
    const panel = await open(pages(WSL_HOST), WSL_HOST);
    expect(shells.closed).toEqual([]);
    expect(lastView(panel).status.tone).toBe('live');
  });

  it('starts no login for a sample that the end 15 seconds after a hide stopped', async () => {
    let release: (state: VmState) => void = () => {};
    const made = pages(LIMA_HOST, { vmState: () => new Promise<VmState>((resolve) => (release = resolve)) });
    made.show(hostRow(LIMA_HOST));
    await flush();
    const panel = fakeVscode.webviewPanels.at(-1)!;
    panel.setVisible(false);
    await timers.advance(HIDDEN_STOP_MS);
    release({ kind: 'running' });
    await flush();
    expect(shells.logins).toEqual([]);
  });

  it('lets the start again after a hide ask, when the click that opened the page did not log in yet', async () => {
    const made = pages();
    made.show(hostRow('build-box'));
    // VS Code hides the new page before its first sample.
    const panel = fakeVscode.webviewPanels.at(-1)!;
    panel.setVisible(false);
    await flush();
    expect(shells.samples).toHaveLength(0);
    await timers.advance(HIDDEN_STOP_MS);
    panel.setVisible(true);
    await flush();
    expect(shells.logins).toEqual([{ host: 'build-box', flow: true }]);
  });

  it('lets the start again after a hide ask, when the end of the samples overtook the first login of the click', async () => {
    const real = shells.run.getMockImplementation()!;
    let gated = true;
    shells.run.mockImplementation(async (host, command, options) => {
      if (options?.login !== false && gated) {
        gated = false;
        // The password question stays open until the samples end.
        await new Promise<void>(() => {});
      }
      return real(host, command, options);
    });
    const made = pages();
    made.show(hostRow('build-box'));
    await flush();
    const panel = fakeVscode.webviewPanels.at(-1)!;
    panel.setVisible(false);
    await timers.advance(HIDDEN_STOP_MS);
    panel.setVisible(true);
    await flush();
    expect(shells.logins).toEqual([{ host: 'build-box', flow: true }]);
  });

  it('forgets the sizes of before a new start of the host, and reads them again after the next sample', async () => {
    shells.open.add(LIMA_HOST);
    const panel = await openRead(pages(), LIMA_HOST);
    expect(lastView(panel).sizes.label).toBe('Refresh Sizes');
    readSizes.mockImplementationOnce(() => new Promise<HostInventory>(() => {}));
    shells.boot = 'd2f0b1a4-2c39-4b41-9d0e-8a7f1c3e5b6d';
    // The sample with the new boot ID has no rate of the CPU yet; the read comes with the next one.
    await timers.advance(VM_USAGE_INTERVAL_MS * 2);
    expect(readSizes).toHaveBeenCalledTimes(2);
    // The sizes of before are gone while the new read runs.
    expect(lastView(panel).docker.value).toBe('…');
  });

  it('sees a new start of the host also after a sample without a boot ID', async () => {
    shells.open.add(LIMA_HOST);
    await openRead(pages(), LIMA_HOST);
    shells.boot = 'unreadable';
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(1);
    shells.boot = 'd2f0b1a4-2c39-4b41-9d0e-8a7f1c3e5b6d';
    await timers.advance(VM_USAGE_INTERVAL_MS * 2);
    expect(readSizes).toHaveBeenCalledTimes(2);
  });

  it('sees a new start of the host after a first sample of a resume without a boot ID', async () => {
    shells.open.add(LIMA_HOST);
    const panel = await openRead(pages(), LIMA_HOST);
    panel.receive({ type: 'pause' });
    await timers.advance(SIZES_FRESH_MS);
    shells.boot = 'unreadable';
    panel.receive({ type: 'resume' });
    await secondSample(LIMA_HOST);
    // Each start reads the sizes after its first values (here more than a minute after the last read).
    expect(readSizes).toHaveBeenCalledTimes(2);
    // The sampler of the resume saw no boot ID before: the page compares with the boot ID of before the pause.
    shells.boot = 'd2f0b1a4-2c39-4b41-9d0e-8a7f1c3e5b6d';
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(3);
  });

  it('keeps nothing of a read of the sizes that ran across a new start of the host, and reads again', async () => {
    shells.open.add(LIMA_HOST);
    let release: (inventory: HostInventory) => void = () => {};
    readSizes.mockImplementationOnce(() => new Promise<HostInventory>((resolve) => (release = resolve)));
    const panel = await openRead(pages(), LIMA_HOST);
    shells.boot = 'd2f0b1a4-2c39-4b41-9d0e-8a7f1c3e5b6d';
    await timers.advance(VM_USAGE_INTERVAL_MS);
    release(emptyInventory());
    await flush();
    expect(lastView(panel).sizes).toEqual({ label: 'Read Sizes', disabled: false });
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(2);
    expect(lastView(panel).sizes.label).toBe('Refresh Sizes');
  });

  it('counts the time of the sample on the host for the age of the VM', async () => {
    // The VM is 1 second old at the line `#H`, and the first sample (a `d`) takes 1.5 seconds on the host.
    shells.loginMs = 3_000;
    shells.sampleCs = 150;
    shells.pid1AgeCs = 100 - Math.floor((timers.time + 3_000) / 10);
    const panel = await open(pages(WSL_HOST), WSL_HOST);
    expect(lastView(panel).status.tone).toBe('live');
  });

  it('starts no login on a remote host for a sample that waited on the shell during a pause', async () => {
    let release: () => void = () => {};
    const run = shells.run.getMockImplementation()!;
    shells.run.mockImplementationOnce(async (host, command, options) => {
      await new Promise<void>((resolve) => (release = resolve));
      return run(host, command, options);
    });
    const made = pages();
    made.show(hostRow('build-box'));
    await flush();
    const panel = fakeVscode.webviewPanels.at(-1)!;
    panel.receive({ type: 'pause' });
    release();
    await flush();
    expect(shells.logins).toEqual([]);
  });

  it('starts no login for the samples of an older start', async () => {
    let release: (state: VmState) => void = () => {};
    const made = pages(LIMA_HOST, { vmState: () => new Promise<VmState>((resolve) => (release = resolve)) });
    made.show(hostRow(LIMA_HOST));
    await flush();
    const panel = fakeVscode.webviewPanels.at(-1)!;
    // Pause while the first sample still reads the state of the VM.
    panel.receive({ type: 'pause' });
    release({ kind: 'running' });
    await flush();
    expect(shells.logins).toEqual([]);
    expect(lastView(panel).status.tone).toBe('paused');
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

  it('ends a Read Sizes that runs before it closes the shell of WSL at the end of its idle script', async () => {
    shells.open.add(WSL_HOST);
    const closedAtAbort: string[][] = [];
    readSizes.mockImplementation(
      (_host, signal) =>
        new Promise<HostInventory>((_resolve, reject) =>
          signal.addEventListener('abort', () => {
            closedAtAbort.push([...shells.closed]);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }),
        ),
    );
    const panel = await open(pages(WSL_HOST), WSL_HOST);
    panel.receive({ type: 'readSizes' });
    await flush();
    shells.idle = false;
    await timers.advance(VM_USAGE_INTERVAL_MS * 5);
    expect(closedAtAbort).toEqual([[]]);
    expect(shells.closed).toEqual([WSL_HOST]);
    expect(lastView(panel).sizes).toEqual({ label: 'Read Sizes', disabled: false });
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

  it('counts the 30 minutes from the last step of the user also over a start of the VM from somewhere else', async () => {
    vmState = { kind: 'stopped' };
    const panel = await open(pages(), LIMA_HOST);
    await timers.advance(IDLE_PAUSE_MS - 10 * 60_000);
    vmState = { kind: 'running' };
    await timers.advance(VM_CHECK_MS);
    expect(lastView(panel).status.tone).toBe('live');
    await timers.advance(10 * 60_000 - VM_CHECK_MS);
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.pausedMessage.idle);
  });

  it('pauses without a login when it finds the VM running after 30 minutes without a step of the user', async () => {
    vmState = { kind: 'stopped' };
    const panel = await open(pages(), LIMA_HOST);
    await timers.advance(IDLE_PAUSE_MS);
    vmState = { kind: 'running' };
    await timers.advance(VM_CHECK_MS);
    expect(shells.logins).toEqual([]);
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.pausedMessage.idle);
  });

  it('checks the state of the VM once more when its shell closed before the first sample started on it', async () => {
    const real = shells.run.getMockImplementation()!;
    let closed = false;
    shells.run.mockImplementation(async (host, command, options) => {
      if (options?.login !== false && !closed) {
        closed = true;
        // The shell of the login closed before the sample started on it (relogin false: no second login).
        return undefined;
      }
      return real(host, command, options);
    });
    const panel = await open(pages(), LIMA_HOST);
    expect(lastView(panel).status.tone).toBe('live');
    expect(shells.logins).toEqual([{ host: LIMA_HOST, flow: true }]);
  });

  it('starts no Read Sizes when the page closes while it reads the state of the VM', async () => {
    shells.open.add(LIMA_HOST);
    let release: (state: VmState) => void = () => {};
    const made = pages(LIMA_HOST, { vmState: () => new Promise<VmState>((resolve) => (release = resolve)) });
    const panel = await open(made, LIMA_HOST);
    panel.receive({ type: 'readSizes' });
    await flush();
    panel.dispose();
    release({ kind: 'running' });
    await flush();
    expect(readSizes).not.toHaveBeenCalled();
  });

  it('puts one gap into the line of the CPU use for a pause and its Resume', async () => {
    shells.open.add(LIMA_HOST);
    const panel = await open(pages(), LIMA_HOST);
    await timers.advance(VM_USAGE_INTERVAL_MS);
    const before = lastView(panel).cpu.spark.length;
    panel.receive({ type: 'pause' });
    panel.receive({ type: 'resume' });
    await flush();
    // The gap and the first sample of the new start.
    expect(lastView(panel).cpu.spark).toHaveLength(before + 2);
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

  it('reads the state of a VM that does not run every 30 seconds while it is visible with the focus, and starts nothing', async () => {
    vmState = { kind: 'stopped' };
    const panel = await open(pages(), LIMA_HOST);
    await timers.advance(VM_CHECK_MS);
    expect(shells.logins).toEqual([]);
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.vmStopped);
    // A Start of a devspace started the VM, which calls no vmChanged.
    vmState = { kind: 'running' };
    shells.open.add(LIMA_HOST);
    fakeVscode.fireWindowState(false);
    await timers.advance(VM_CHECK_MS * 2);
    expect(shells.samples).toHaveLength(0);
    fakeVscode.fireWindowState(true);
    await flush();
    expect(shells.samples).toHaveLength(1);
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

  it('reads no sizes while the VM stops or is set up again, also on a page that was paused already', async () => {
    shells.open.add(LIMA_HOST);
    const made = pages();
    const panel = await open(made, LIMA_HOST);
    panel.receive({ type: 'pause' });
    made.vmClosing();
    expect(lastView(panel).sizes.disabled).toBe(true);
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.pausedMessage.vm);
    panel.receive({ type: 'readSizes' });
    await flush();
    // (The page paused before its second sample, so it read no sizes by itself either.)
    expect(readSizes).not.toHaveBeenCalled();
  });

  it('starts no Read Sizes when the VM stops while it reads the state of the VM', async () => {
    shells.open.add(LIMA_HOST);
    let release: (state: VmState) => void = () => {};
    const made = pages(LIMA_HOST, { vmState: () => new Promise<VmState>((resolve) => (release = resolve)) });
    const panel = await open(made, LIMA_HOST);
    panel.receive({ type: 'readSizes' });
    await flush();
    made.vmClosing();
    release({ kind: 'running' });
    await flush();
    expect(readSizes).not.toHaveBeenCalled();
  });

  it('ends a Read Sizes that runs when the VM stops, and shows no error of its end', async () => {
    shells.open.add(LIMA_HOST);
    let aborted = false;
    readSizes.mockImplementation(
      (_host, signal) =>
        new Promise<HostInventory>((_resolve, reject) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            // The stop of the shell ends the Docker call with an error of its own.
            reject(new Error('The shell on lima is closed.'));
          }),
        ),
    );
    const made = pages();
    const panel = await open(made, LIMA_HOST);
    panel.receive({ type: 'readSizes' });
    await flush();
    made.vmClosing();
    await flush();
    expect(aborted).toBe(true);
    expect(lastView(panel).sizes).toEqual({ label: 'Read Sizes', disabled: true });
    expect(lastView(panel).docker.note).toBe(UsagePageTexts.sizesNotRead);
  });

  it('pauses 2 minutes after a start from a VM change in a window without the focus', async () => {
    vmState = { kind: 'stopped' };
    const made = pages();
    const panel = await open(made, LIMA_HOST);
    fakeVscode.fireWindowState(false);
    await timers.advance(FOCUS_PAUSE_MS * 2);
    vmState = { kind: 'running' };
    shells.open.add(LIMA_HOST);
    made.vmChanged();
    await flush();
    expect(lastView(panel).status.tone).toBe('live');
    await timers.advance(FOCUS_PAUSE_MS);
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.pausedMessage.focus);
  });

  it('counts only a show as a step of the user, not a move of the page into another group', async () => {
    shells.open.add(LIMA_HOST);
    const panel = await open(pages(), LIMA_HOST);
    await timers.advance(IDLE_PAUSE_MS - 60_000);
    panel.setActive(false);
    panel.setActive(true);
    await timers.advance(60_000);
    expect(lastView(panel).banner?.message).toBe(UsagePageTexts.pausedMessage.idle);
  });

  it('reads the sizes in the background after the first values, without a question and on an open login only, then every 10 minutes', async () => {
    const flows: boolean[] = [];
    readSizes.mockImplementation(async () => {
      flows.push(sshPromptsAllowed());
      return emptyInventory();
    });
    const panel = await openRead(pages(), 'build-box');
    expect(readSizes).toHaveBeenCalledWith('build-box', expect.any(AbortSignal), { openLoginOnly: true });
    expect(flows).toEqual([false]);
    expect(lastView(panel).sizes.label).toBe('Refresh Sizes');
    await timers.advance(SIZES_EVERY_MS - SSH_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(1);
    await timers.advance(SSH_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(2);
    expect(flows).toEqual([false, false]);
    // Refresh Sizes reads at once, in a flow, and the next read in the background comes 10 minutes after it.
    panel.receive({ type: 'readSizes' });
    await flush();
    expect(flows).toEqual([false, false, true]);
    await timers.advance(SIZES_EVERY_MS - SSH_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(3);
  });

  it('reads no sizes in the background while paused or hidden, and again after Resume and after a show that follows the end of the samples', async () => {
    const panel = await openRead(pages(), 'build-box');
    expect(readSizes).toHaveBeenCalledTimes(1);
    panel.receive({ type: 'pause' });
    await timers.advance(SIZES_EVERY_MS * 2);
    expect(readSizes).toHaveBeenCalledTimes(1);
    panel.receive({ type: 'resume' });
    await secondSample('build-box');
    expect(readSizes).toHaveBeenCalledTimes(2);
    // A show within the 15 seconds goes on with the same samples: no new read.
    panel.setVisible(false);
    await timers.advance(HIDDEN_STOP_MS / 3);
    panel.setVisible(true);
    await flush();
    expect(readSizes).toHaveBeenCalledTimes(2);
    panel.setVisible(false);
    await timers.advance(SIZES_EVERY_MS * 2);
    expect(readSizes).toHaveBeenCalledTimes(2);
    panel.setVisible(true);
    await secondSample('build-box');
    expect(readSizes).toHaveBeenCalledTimes(3);
    // A switch back within a minute of the last read does not read again; a pause and Resume after a minute does.
    panel.receive({ type: 'pause' });
    panel.receive({ type: 'resume' });
    await secondSample('build-box');
    expect(readSizes).toHaveBeenCalledTimes(3);
    panel.receive({ type: 'pause' });
    await timers.advance(SIZES_FRESH_MS);
    panel.receive({ type: 'resume' });
    await secondSample('build-box');
    expect(readSizes).toHaveBeenCalledTimes(4);
  });

  it('shows the error of a read in the background, and nothing when it found no open login', async () => {
    readSizes.mockRejectedValueOnce(Object.assign(new Error('The operation was cancelled.'), { name: 'AbortError' }));
    const first = await openRead(pages(), 'build-box');
    expect(lastView(first).docker.note).toBe(UsagePageTexts.sizesNotRead);
    readSizes.mockRejectedValueOnce(new Error('docker system df failed\nmore'));
    const second = await openRead(pages(), 'other-box');
    expect(lastView(second).docker.note).toBe(UsagePageTexts.sizesFailed('docker system df failed'));
  });

  it('tries a failed read in the background again after 10 minutes, and shows its error meanwhile', async () => {
    readSizes.mockRejectedValueOnce(new Error('permission denied'));
    const panel = await openRead(pages(), 'build-box');
    expect(lastView(panel).docker.note).toBe(UsagePageTexts.sizesFailed('permission denied'));
    // A Resume within a minute of the failed read does not read again.
    panel.receive({ type: 'pause' });
    panel.receive({ type: 'resume' });
    await secondSample('build-box');
    await timers.advance(SIZES_EVERY_MS - 3 * SSH_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(1);
    await timers.advance(2 * SSH_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(2);
    expect(lastView(panel).sizes.label).toBe('Refresh Sizes');
    // A command that failed without an exit code, but not at its time limit (for example an output that is too large).
    readSizes.mockRejectedValueOnce(new CommandError('docker system df -v', null, '', 'The output is too large.'));
    await timers.advance(SIZES_EVERY_MS);
    expect(readSizes).toHaveBeenCalledTimes(3);
    // A key on the page, so that it does not pause after 30 minutes.
    panel.receive({ type: 'activity' });
    await timers.advance(SIZES_EVERY_MS);
    expect(readSizes).toHaveBeenCalledTimes(4);
  });


  it('reads no sizes in the background on a VM that does not run, and says nothing', async () => {
    shells.open.add(LIMA_HOST);
    vmState = { kind: 'stopped' };
    const panel = await openRead(pages(), LIMA_HOST);
    expect(readSizes).not.toHaveBeenCalled();
    expect(lastView(panel).docker.note).toBe(UsagePageTexts.sizesNotRead);
  });

  it('reads the sizes by itself no more after a read longer than its time limit, until a Refresh Sizes that worked', async () => {
    const tooLong = () => new CommandError('docker system df -v', null, '', 'The command did not end within the time limit.', true);
    readSizes.mockRejectedValueOnce(tooLong());
    const panel = await openRead(pages(), 'build-box');
    expect(lastView(panel).docker.note).toMatch(/did not end within the time limit/);
    await timers.advance(SIZES_EVERY_MS * 2);
    expect(readSizes).toHaveBeenCalledTimes(1);
    // A Resume does not read by itself again either.
    panel.receive({ type: 'pause' });
    panel.receive({ type: 'resume' });
    await secondSample('build-box');
    expect(readSizes).toHaveBeenCalledTimes(1);
    // A Refresh Sizes longer than its time limit keeps the reads by itself off; one that works turns them on again.
    readSizes.mockRejectedValueOnce(tooLong());
    panel.receive({ type: 'readSizes' });
    await flush();
    expect(readSizes).toHaveBeenCalledTimes(2);
    await timers.advance(SIZES_EVERY_MS + SSH_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(2);
    panel.receive({ type: 'readSizes' });
    await flush();
    expect(readSizes).toHaveBeenCalledTimes(3);
    await timers.advance(SIZES_EVERY_MS + SSH_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(4);
  });


  it('reads by itself again after a new start of the host that follows a read at its time limit', async () => {
    shells.open.add(LIMA_HOST);
    readSizes.mockRejectedValueOnce(new CommandError('docker system df -v', null, '', 'The command did not end within the time limit.', true));
    await openRead(pages(), LIMA_HOST);
    await timers.advance(SIZES_EVERY_MS + VM_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(1);
    shells.boot = 'd2f0b1a4-2c39-4b41-9d0e-8a7f1c3e5b6d';
    await timers.advance(VM_USAGE_INTERVAL_MS * 2);
    expect(readSizes).toHaveBeenCalledTimes(2);
  });

  it('reads by itself again after a Refresh Sizes that worked across a new start of the host', async () => {
    shells.open.add(LIMA_HOST);
    readSizes.mockRejectedValueOnce(new CommandError('docker system df -v', null, '', 'The command did not end within the time limit.', true));
    const panel = await openRead(pages(), LIMA_HOST);
    let release: (inventory: HostInventory) => void = () => {};
    readSizes.mockImplementationOnce(() => new Promise<HostInventory>((resolve) => (release = resolve)));
    panel.receive({ type: 'readSizes' });
    await flush();
    expect(readSizes).toHaveBeenCalledTimes(2);
    shells.boot = 'd2f0b1a4-2c39-4b41-9d0e-8a7f1c3e5b6d';
    await timers.advance(VM_USAGE_INTERVAL_MS);
    release(emptyInventory());
    await flush();
    // The new start of the host reads at its next values.
    await timers.advance(VM_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(3);
  });

  it('keeps the reads by itself after a Refresh Sizes that ended at its time limit (for example the time limit of its login)', async () => {
    const panel = await openRead(pages(), 'build-box');
    readSizes.mockRejectedValueOnce(new CommandError('ssh build-box', null, '', 'The login did not end within the time limit.', true));
    panel.receive({ type: 'readSizes' });
    await flush();
    expect(readSizes).toHaveBeenCalledTimes(2);
    await timers.advance(SIZES_EVERY_MS + SSH_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(3);
  });


  it('shows no error of a failed read in the background when the VM stops while the page reads its state', async () => {
    shells.open.add(LIMA_HOST);
    let hold = false;
    let release: (state: VmState) => void = () => {};
    const made = pages(LIMA_HOST, { vmState: () => (hold ? new Promise<VmState>((resolve) => (release = resolve)) : Promise.resolve<VmState>({ kind: 'running' })) });
    readSizes.mockImplementationOnce(async () => {
      hold = true;
      throw new Error('Cannot connect to the Docker daemon');
    });
    const panel = await openRead(made, LIMA_HOST);
    expect(readSizes).toHaveBeenCalledTimes(1);
    made.vmClosing();
    release({ kind: 'running' });
    await flush();
    expect(lastView(panel).docker.note).not.toMatch(/could not be read/);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('could not be read'));
  });

  it('shows no error of a read in the background that ended because the VM went to sleep, and tries again after a minute', async () => {
    shells.open.add(LIMA_HOST);
    readSizes.mockImplementationOnce(async () => {
      vmState = { kind: 'stopped' };
      throw new Error('Cannot connect to the Docker daemon');
    });
    const panel = await openRead(pages(), LIMA_HOST);
    expect(readSizes).toHaveBeenCalledTimes(1);
    expect(lastView(panel).docker.note).toBe(UsagePageTexts.sizesNotRead);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('could not be read'));
    // The VM runs again (a start from somewhere else): the reads by itself stay on.
    vmState = { kind: 'running' };
    await timers.advance(SIZES_RETRY_MS);
    expect(readSizes).toHaveBeenCalledTimes(2);
    expect(lastView(panel).sizes.label).toBe('Refresh Sizes');
  });

  it('reads at the next start when a read in the background did not reach the host', async () => {
    readSizes.mockRejectedValueOnce(Object.assign(new Error('The operation was cancelled.'), { name: 'AbortError' }));
    const panel = await openRead(pages(), 'build-box');
    expect(readSizes).toHaveBeenCalledTimes(1);
    // Within a minute: no sizes were read, so the start reads.
    panel.receive({ type: 'pause' });
    panel.receive({ type: 'resume' });
    await secondSample('build-box');
    expect(readSizes).toHaveBeenCalledTimes(2);
    expect(lastView(panel).sizes.label).toBe('Refresh Sizes');
  });

  it('tries again a minute after a read in the background that did not reach the host', async () => {
    readSizes.mockRejectedValueOnce(Object.assign(new Error('The operation was cancelled.'), { name: 'AbortError' }));
    const panel = await openRead(pages(), 'build-box');
    await timers.advance(SIZES_RETRY_MS - SSH_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(1);
    await timers.advance(SSH_USAGE_INTERVAL_MS);
    expect(readSizes).toHaveBeenCalledTimes(2);
    expect(lastView(panel).sizes.label).toBe('Refresh Sizes');
  });

  it('says in the header that it reads the sizes, and does not end a read in the background at a close', async () => {
    let signal: AbortSignal | undefined;
    readSizes.mockImplementation((_host, readSignal) => {
      signal = readSignal;
      return new Promise<HostInventory>(() => {});
    });
    const panel = await openRead(pages(), 'build-box');
    expect(lastView(panel).status.text).toMatch(/^Live · every 5 s · updated .* · reading the sizes$/);
    panel.dispose();
    expect(signal?.aborted).toBe(false);
  });

  it('reads the sizes on click in a flow, never on a stopped VM', async () => {
    shells.open.add(LIMA_HOST);
    const panel = await openRead(pages(), LIMA_HOST);
    let flow: boolean | undefined;
    readSizes.mockImplementation(async () => {
      flow = sshPromptsAllowed();
      return emptyInventory();
    });
    panel.receive({ type: 'readSizes' });
    expect(lastView(panel).sizes).toEqual({ label: 'Reading Sizes…', disabled: true });
    await flush();
    expect(readSizes).toHaveBeenLastCalledWith(LIMA_HOST, expect.any(AbortSignal));
    expect(flow).toBe(true);
    expect(lastView(panel).sizes).toEqual({ label: 'Refresh Sizes', disabled: false });
    vmState = { kind: 'stopped' };
    panel.receive({ type: 'readSizes' });
    await flush();
    expect(readSizes).toHaveBeenCalledTimes(2);
    expect(lastView(panel).docker.note).toContain(UsagePageTexts.sizesVmStopped);
    vmState = { kind: 'unknown', detail: 'limactl failed' };
    panel.receive({ type: 'readSizes' });
    await flush();
    expect(lastView(panel).docker.note).toContain('The sizes could not be read: Devspaces cannot use the VM of Devspaces now (limactl failed).');
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
