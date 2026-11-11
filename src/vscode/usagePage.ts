// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The utilization page of a Docker host (docs/requirements.md R-ENG-009): "Show Utilization" on a host row of the view
// Docker Hosts opens a read-only page in the editor, one per host. Thin glue: the samples are UsageSampler
// (src/core/hosts/usageSampler.ts), each one command on the one shared shell of the host (RemoteShells), and what the page
// shows comes from usagePageModel.ts. The page reads only while it is visible: a hidden page pauses the samples at once
// and ends them 15 seconds later (a show within them goes on with them); after 2 minutes without the focus of the
// window, after 30 minutes without a click or a key on the page, and after Pause, it pauses until the user clicks Resume.
// It never starts the VM of Devspaces (R-VM-004): it samples on a shell to the VM that is open, and before a login of its
// own it reads the state of the VM without a start; Stop the VM…, Remove and Reset pause it first (R-VM-010). The open,
// Resume, Retry, Start the VM and Read Sizes are flows of the user, so their first login to a remote host may ask for a
// password; a new start after a hide asks nothing.
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { WSL_HOST } from '../core/docker/dockerHost';
import { errorMessage } from '../core/errors';
import type { HostInventory } from '../core/hosts/hostObjects';
import type { UsageHeader, UsageBlock } from '../core/hosts/usageSample';
import { UsageHistory, type DiskValue, type HostUsage } from '../core/hosts/usageRates';
import { SSH_USAGE_INTERVAL_MS, UsageSampler, VM_USAGE_INTERVAL_MS, realUsageTimers, usageSampleKind, type UsageEnd, type UsageRun, type UsageTimers } from '../core/hosts/usageSampler';
import { usageShellCommand } from '../core/hosts/usageScript';
import { isAbortError, type Logger } from '../core/ports';
import type { RemoteShells } from '../core/relay/remoteShells';
import { withSshPrompts } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import { hostOfArgument } from './dockerHostsModel';
import { UsagePageTexts, parseUsageRequest, usagePageHtml, usagePageView, type UsagePhase } from './usagePageModel';

const VIEW_TYPE = 'devspaces.utilization';
/** Folder of the style sheet and the script of the webview (package: resources/**). */
const ASSETS = ['resources', 'usagePage'];
/** A hidden page ends its samples this long after the hide (decision 2a of the plan). */
export const HIDDEN_STOP_MS = 15_000;
/** The page pauses after this long without the focus of the window, */
export const FOCUS_PAUSE_MS = 2 * 60_000;
/** and after this long without a click or a key on it. */
export const IDLE_PAUSE_MS = 30 * 60_000;
/** While the page shows a VM that does not run, visible and with the focus: how often it reads the state of the VM. */
export const VM_CHECK_MS = 30_000;
/**
 * The VM counts as started by the login of the page only when it is younger than the check by more than this: the
 * answer takes time on its way back, and the age has steps of 1/100 s.
 */
const VM_AGE_MARGIN_MS = 1_000;

export interface UsagePagesDeps {
  extensionUri: vscode.Uri;
  logger: Logger;
  showLog: () => void;
  /** The VM of Devspaces on this platform (LIMA_HOST or WSL_HOST), undefined where there is none. */
  vmHost: string | undefined;
  /** The shared shells of the hosts: the samples run on them, and the page holds its shell back from the relay. */
  shells: Pick<RemoteShells, 'run' | 'keep' | 'close'>;
  /** The state of the VM, read without a start (vmState.ts). */
  vmState: () => Promise<VmState>;
  /** The WSL distribution of Devspaces stops now: the idle script of the keeper of this window ended (WslKeeper.stopping). */
  vmStopping: () => boolean;
  /** "Start the VM" (VmCommands.start), which never throws. */
  startVm: () => Promise<void>;
  /** The objects of the host with their sizes (readHostInventory on the shared shell of the host). */
  readSizes: (host: string, signal: AbortSignal) => Promise<HostInventory>;
  /** The free space on this computer for the disk of the VM, where known. */
  localDiskFree?: () => Promise<number | undefined>;
  /** Only for the tests. */
  timers?: UsageTimers;
}

/** The pages of this window, one per host. */
export class UsagePages implements vscode.Disposable {
  private readonly pages = new Map<string, UsagePage>();
  private readonly windowListener: vscode.Disposable;

  constructor(private readonly deps: UsagePagesDeps) {
    this.windowListener = vscode.window.onDidChangeWindowState((state) => {
      for (const page of this.pages.values()) page.focusChanged(state.focused);
    });
  }

  /** "Show Utilization" of a host row: opens the page of the host, or shows the one that is open. */
  show(argument: unknown): void {
    const host = hostOfArgument(argument);
    if (host === undefined) return;
    const open = this.pages.get(host);
    if (open !== undefined) {
      open.reveal();
      return;
    }
    const page: UsagePage = new UsagePage(host, this.deps, () => {
      if (this.pages.get(host) === page) this.pages.delete(host);
    });
    this.pages.set(host, page);
  }

  /** Before Stop the VM…, Remove or Reset of the VM (R-VM-010): its page pauses until Resume. */
  vmClosing(): void {
    if (this.deps.vmHost !== undefined) this.pages.get(this.deps.vmHost)?.vmClosing();
  }

  /** The VM may have started or stopped (a command of the VM): its page reads again when it waits for the VM. */
  vmChanged(): void {
    if (this.deps.vmHost !== undefined) this.pages.get(this.deps.vmHost)?.vmChanged();
  }

  dispose(): void {
    this.windowListener.dispose();
    for (const page of [...this.pages.values()]) page.dispose();
    this.pages.clear();
  }
}

/** The page of one host. */
class UsagePage {
  private readonly panel: vscode.WebviewPanel;
  private readonly listeners: vscode.Disposable[];
  private readonly timers: UsageTimers;
  private readonly vm: boolean;
  private readonly wsl: boolean;
  private readonly intervalMs: number;
  private readonly history = new UsageHistory();
  /** Aborts the questions of a login and Read Sizes when the page closes. */
  private readonly abort = new AbortController();
  private phase: UsagePhase = { kind: 'starting' };
  private sampler: UsageSampler | undefined;
  /** Counts the starts and the pauses: the work of an earlier one (a check of the VM after an end) is dropped. */
  private generation = 0;
  private header: UsageHeader | undefined;
  private usage: HostUsage | undefined;
  private uptimeCs: number | undefined;
  private updatedAt: number | undefined;
  private names: ReadonlyMap<string, string> | undefined;
  private disks: DiskValue[] | undefined;
  private localDiskFree: number | undefined;
  private localDiskReading = false;
  private sizes: { inventory: HostInventory; at: number } | undefined;
  private sizesReading = false;
  private sizesError: string | undefined;
  private startingVm = false;
  /** The state of the VM that the last check before a login found (for the state of the page after the end). */
  private checkedState: VmState | undefined;
  /** When `run` checked the VM before a login of its own: the next block checks the age of the VM (onBlock). */
  private loginCheckedAt: number | undefined;
  /** The samples ended 15 seconds after a hide: a show starts new ones. */
  private stoppedByHide = false;
  /** The first sample of a start from a click did not run yet: a start again after a hide may still ask (start). */
  private flowPending = false;
  /** The history has a gap since its last point (one gap for each pause, hide or end). */
  private gapped = false;
  private hiddenTimer: unknown;
  private vmCheckTimer: unknown;
  private checkingVm = false;
  /** The visibility that visibilityChanged last saw. */
  private wasVisible = true;
  /** Ends the Read Sizes that runs (vmClosing). */
  private sizesAbort: AbortController | undefined;
  /** Raised at each new start of the host, so that a Read Sizes that ran across it keeps nothing. */
  private bootEpoch = 0;
  private focusTimer: unknown;
  private idleTimer: unknown;
  private disposed = false;

  constructor(
    readonly host: string,
    private readonly deps: UsagePagesDeps,
    private readonly onDisposed: () => void,
  ) {
    this.timers = deps.timers ?? realUsageTimers;
    this.vm = host === deps.vmHost;
    this.wsl = this.vm && host === WSL_HOST;
    this.intervalMs = this.vm ? VM_USAGE_INTERVAL_MS : SSH_USAGE_INTERVAL_MS;
    const assets = vscode.Uri.joinPath(deps.extensionUri, ...ASSETS);
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, UsagePageTexts.panelTitle(host), vscode.ViewColumn.Active, {
      enableScripts: true,
      enableCommandUris: false,
      enableForms: false,
      localResourceRoots: [assets],
      // A hidden page reads nothing, so it keeps no page: a show starts it again, and it asks for the view (`ready`).
      retainContextWhenHidden: false,
    });
    this.wasVisible = this.panel.visible;
    const webview = this.panel.webview;
    webview.html = usagePageHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString('base64'),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(assets, 'page.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(assets, 'page.css')).toString(),
      host,
    });
    this.listeners = [
      webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw)),
      this.panel.onDidChangeViewState(() => this.visibilityChanged()),
      this.panel.onDidDispose(() => this.dispose()),
    ];
    deps.logger.info(`The utilization page of ${host} opened.`);
    this.focusChanged(vscode.window.state.focused);
    // The click on Show Utilization: its first login may ask.
    this.start(true);
  }

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endSampler();
    for (const timer of [this.hiddenTimer, this.focusTimer, this.idleTimer, this.vmCheckTimer]) if (timer !== undefined) this.timers.clearTimeout(timer);
    this.abort.abort();
    for (const listener of this.listeners) listener.dispose();
    this.panel.dispose();
    this.deps.logger.info(`The utilization page of ${this.host} closed.`);
    this.onDisposed();
  }

  /** The window got or lost the focus: 2 minutes without it pause the page, while it reads and is visible. */
  focusChanged(focused: boolean): void {
    this.clearTimer('focusTimer');
    if (this.disposed) return;
    if (focused) {
      void this.checkVm();
      return;
    }
    this.focusTimer = this.timers.setTimeout(() => {
      this.focusTimer = undefined;
      if (this.panel.visible && this.reading()) this.pause('focus');
    }, FOCUS_PAUSE_MS);
  }

  vmClosing(): void {
    // Also a page that was paused already: its Read Sizes is off until Resume, and a Read Sizes that runs ends, because
    // its next Docker call would log in to the VM again.
    this.sizesAbort?.abort();
    this.pause('vm');
  }

  vmChanged(): void {
    // Only a page that waits for the VM: a page that Stop the VM… paused stays paused until Resume. A hidden page reads
    // nothing: it reads the state of the VM again at its next show (checkVm).
    if (this.phase.kind === 'vm' && this.panel.visible && !this.startingVm) this.start(false);
  }

  // -------------------------------------------------------------------------------------------------------------------

  private reading(): boolean {
    return this.phase.kind === 'live' || this.phase.kind === 'starting';
  }

  /** New samples. `flow`: a click of the user, so the first login may ask for a password. */
  private start(flow: boolean): void {
    this.endSampler();
    this.stoppedByHide = false;
    this.checkedState = undefined;
    this.loginCheckedAt = undefined;
    const generation = ++this.generation;
    this.markGap();
    this.setPhase({ kind: 'starting' });
    this.touch();
    this.flowPending = flow;
    // A window without the focus: the 2 minutes start now (the timer of the focus loss may have run out meanwhile).
    if (!vscode.window.state.focused) this.focusChanged(false);
    let first = flow;
    const sampler: UsageSampler = UsageSampler.start({
      logger: this.deps.logger,
      name: this.host,
      intervalMs: this.intervalMs,
      wslIdle: this.wsl,
      timers: this.timers,
      run: (script, timeoutMs) => {
        const inFlow = first;
        first = false;
        if (inFlow) this.flowPending = false;
        return this.run(script, timeoutMs, inFlow, generation);
      },
      hold: () => this.deps.shells.keep(this.host),
      onHeader: (header) => this.onHeader(sampler, header),
      onBlock: (block, usage, names) => this.onBlock(sampler, block, usage, names),
      onEnd: (end) => this.onEnd(sampler, end),
    });
    this.sampler = sampler;
    // Hidden at the start (for example a page that VS Code opened in the background): it waits for the show.
    if (!this.panel.visible) this.hidden();
  }

  /**
   * One command of the samples on the shell of the host: on the shell that is open (or logging in) without a login;
   * else, on the VM only after a check that it runs (the page never starts it, R-VM-004), a login of the shell.
   */
  private async run(script: string, timeoutMs: number, flow: boolean, generation: number): Promise<UsageRun> {
    const { shells } = this.deps;
    const command = usageShellCommand(script);
    const open = await shells.run(this.host, command, { timeoutMs, login: false });
    if (open !== undefined) return { kind: 'ran', result: open };
    // The samples of an older start (a pause, a hide or a close came meanwhile): no login, and nothing of the page
    // changes. Their sampler is gone and ignores the answer.
    const stale: UsageRun = { kind: 'notRun', reason: 'vmStopped' };
    if (generation !== this.generation) return stale;
    let checkedAt: number | undefined;
    if (this.vm) {
      const state = await this.vmStateNow();
      if (generation !== this.generation) return stale;
      this.checkedState = state;
      if (state.kind !== 'running') return { kind: 'notRun', reason: 'vmStopped' };
      checkedAt = this.timers.now();
    }
    const login = () => shells.run(this.host, command, { timeoutMs });
    const result = flow ? await withSshPrompts(login, this.abort.signal) : await login();
    if (result === undefined) return { kind: 'notRun', reason: 'noTransport' };
    if (checkedAt !== undefined && generation === this.generation) this.loginCheckedAt = checkedAt;
    return { kind: 'ran', result };
  }

  private onHeader(sampler: UsageSampler, header: UsageHeader): void {
    if (sampler !== this.sampler) return;
    // A new start of the kernel: the history of before is of another start.
    if (this.header?.bootId !== undefined && header.bootId !== undefined && header.bootId !== this.header.bootId) {
      this.history.clear();
      this.gapped = false;
      // The sizes are of the objects before the start: Read Sizes reads them again.
      this.bootEpoch += 1;
      this.sizes = undefined;
      this.sizesError = undefined;
    }
    this.header = header;
  }

  private onBlock(sampler: UsageSampler, block: UsageBlock, usage: HostUsage, names: ReadonlyMap<string, string> | undefined): void {
    if (sampler !== this.sampler) return;
    const header = sampler.header;
    if (header !== undefined) this.header = header;
    const checkedAt = this.loginCheckedAt;
    this.loginCheckedAt = undefined;
    // The login of the page started the VM: it stopped between the check and the login (wsl.exe starts a WSL
    // distribution). The VM is younger than the check. The page ends its samples, so that the VM can go to sleep again.
    // The shell stays for the view Docker Hosts, which may use it now: the idle script of the VM stops the VM also with
    // an open shell (Lima), and the end of the idle script of the keeper closes it (WSL).
    // The age is of the start of the sample: the time of the sample on the host (a sample `d` also reads the disks)
    // counts for the VM too.
    const ageMs = header?.pid1AgeCs !== undefined ? (header.pid1AgeCs + Number(block.endCs - block.startCs)) * 10 : undefined;
    if (checkedAt !== undefined && ageMs !== undefined && ageMs + VM_AGE_MARGIN_MS < this.timers.now() - checkedAt) {
      this.deps.logger.info(`The VM of Devspaces started after the utilization page found it running: the page ends its samples there, so that the VM can go to sleep again.`);
      this.endSampler();
      this.setPhase({ kind: 'vm', state: { kind: 'stopped' }, idle: true });
      return;
    }
    this.usage = usage;
    this.uptimeCs = Number(block.startCs);
    this.updatedAt = this.timers.now();
    this.names = names;
    // A sample `d` (the first one, then every USAGE_DISK_EVERY): without lines `D`, the disks could not be read.
    if (usageSampleKind(block.seq) === 'd') {
      this.disks = usage.disks ?? [];
      this.readLocalDisk();
    }
    this.history.add(usage);
    this.gapped = false;
    if (this.phase.kind === 'starting') this.phase = { kind: 'live' };
    this.post();
  }

  private onEnd(sampler: UsageSampler, end: UsageEnd): void {
    // An end that the page made itself (endSampler forgets the sampler first) needs nothing.
    if (sampler !== this.sampler) return;
    this.sampler = undefined;
    this.clearTimer('hiddenTimer');
    this.markGap();
    void this.afterEnd(end);
  }

  /** The state of the page after an end of the samples: on the VM, whether the VM still runs. */
  private async afterEnd(end: UsageEnd): Promise<void> {
    const generation = this.generation;
    if (end.kind === 'stopped') return;
    if (end.kind === 'vmIdle') {
      // Nothing runs in the WSL distribution: the open `wsl.exe` of the shell would hold it for 2 more minutes.
      this.deps.shells.close(this.host);
      this.setPhase({ kind: 'vm', state: { kind: 'stopped' }, idle: true });
      return;
    }
    if (end.kind === 'vmStopped') {
      const state = this.checkedState ?? (await this.vmStateNow());
      if (generation === this.generation && !this.disposed) this.setPhase({ kind: 'vm', state });
      return;
    }
    if (this.vm) {
      // The VM went to sleep (the connection broke), or it was stopped from somewhere else.
      const state = await this.vmStateNow();
      if (generation !== this.generation || this.disposed) return;
      if (state.kind !== 'running') {
        this.setPhase({ kind: 'vm', state, idle: this.usage !== undefined });
        return;
      }
    }
    this.setPhase({ kind: 'ended', end });
  }

  /** The state of the VM; a WSL distribution that stops now counts as stopped. */
  private async vmStateNow(): Promise<VmState> {
    try {
      const state = await this.deps.vmState();
      return state.kind === 'running' && this.deps.vmStopping() ? { kind: 'stopped' } : state;
    } catch (error) {
      return { kind: 'unknown', detail: errorMessage(error) };
    }
  }

  /** The tab was shown or hidden. */
  private visibilityChanged(): void {
    if (this.disposed) return;
    // VS Code also reports a move of the page into another group, or a change of the active editor: only a show or a
    // hide counts.
    const visible = this.panel.visible;
    if (visible === this.wasVisible) return;
    this.wasVisible = visible;
    if (!visible) {
      this.hidden();
      return;
    }
    this.clearTimer('hiddenTimer');
    // Showing the tab is a step of the user: the 30 minutes start again.
    this.touch();
    if (!vscode.window.state.focused) this.focusChanged(false);
    if (this.reading()) {
      if (this.sampler !== undefined) this.sampler.resume();
      // The click that opened or resumed the page may still ask, when its first sample did not run before the hide.
      else if (this.stoppedByHide) this.start(this.flowPending);
    } else {
      void this.checkVm();
    }
  }

  /** Nothing is read while the page is hidden: the samples pause at once and end 15 seconds later. */
  private hidden(): void {
    this.clearTimer('focusTimer');
    this.clearTimer('idleTimer');
    if (this.sampler === undefined) return;
    this.sampler.pause();
    this.clearTimer('hiddenTimer');
    this.hiddenTimer = this.timers.setTimeout(() => {
      this.hiddenTimer = undefined;
      if (this.sampler === undefined || this.panel.visible) return;
      this.deps.logger.info(`The utilization page of ${this.host} is hidden: its samples end.`);
      this.endSampler();
      this.stoppedByHide = true;
      this.markGap();
    }, HIDDEN_STOP_MS);
  }

  /** A click or a key on the page, a show, or a start: the 30 minutes without one start again. */
  private touch(): void {
    this.clearTimer('idleTimer');
    if (this.disposed) return;
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = undefined;
      if (this.panel.visible && this.reading()) this.pause('idle');
    }, IDLE_PAUSE_MS);
  }

  private pause(reason: 'button' | 'focus' | 'idle' | 'vm'): void {
    this.deps.logger.info(`The utilization page of ${this.host} pauses (${reason}).`);
    this.endSampler();
    this.stoppedByHide = false;
    this.markGap();
    this.setPhase({ kind: 'paused', reason });
  }

  /** Ends the samples of the page; their end is not reported (onEnd), and a sample that still runs logs in no more. */
  private endSampler(): void {
    this.generation += 1;
    const sampler = this.sampler;
    this.sampler = undefined;
    this.clearTimer('hiddenTimer');
    sampler?.stop();
  }

  private clearTimer(name: 'hiddenTimer' | 'focusTimer' | 'idleTimer' | 'vmCheckTimer'): void {
    const timer = this[name];
    if (timer !== undefined) this.timers.clearTimeout(timer);
    this[name] = undefined;
  }

  private onMessage(raw: unknown): void {
    if (this.disposed) return;
    const request = parseUsageRequest(raw);
    if (request === undefined) {
      this.deps.logger.warn('The utilization page sent a message that is not valid. It is ignored.');
      return;
    }
    if (request.type !== 'ready') this.touch();
    switch (request.type) {
      case 'ready':
        this.post();
        return;
      case 'activity':
        return;
      case 'pause':
        if (this.reading()) this.pause('button');
        return;
      case 'resume':
        if (this.phase.kind === 'paused') this.start(true);
        return;
      case 'retry':
        if (this.phase.kind === 'ended') this.start(true);
        return;
      case 'startVm':
        void this.startVm();
        return;
      case 'readSizes':
        void this.readSizes();
        return;
      case 'showLog':
        this.deps.showLog();
        return;
    }
  }

  /** "Start the VM" of the page: the command of the VM, then the samples. */
  private async startVm(): Promise<void> {
    if (this.phase.kind !== 'vm' || this.startingVm) return;
    this.startingVm = true;
    const generation = ++this.generation;
    try {
      await this.deps.startVm();
    } finally {
      this.startingVm = false;
    }
    if (generation === this.generation && !this.disposed) this.start(true);
  }

  /** "Read Sizes": the objects of the host with their sizes; never on a VM that does not run. */
  private async readSizes(): Promise<void> {
    // Not while the VM stops or is set up again (Stop the VM…, Remove, Reset): a read would log in to it again.
    if (this.sizesReading || this.disposed || (this.phase.kind === 'paused' && this.phase.reason === 'vm')) return;
    const epoch = this.bootEpoch;
    this.sizesReading = true;
    this.post();
    try {
      if (this.vm) {
        const state = await this.vmStateNow();
        if (state.kind !== 'running') {
          this.sizesError = state.kind === 'stopped' || state.kind === 'notSetUp' ? UsagePageTexts.sizesVmStopped : UsagePageTexts.sizesVmUnusable(state.detail);
          return;
        }
      }
      const controller = new AbortController();
      this.sizesAbort = controller;
      const signal = AbortSignal.any([this.abort.signal, controller.signal]);
      const inventory = await withSshPrompts(() => this.deps.readSizes(this.host, signal), signal);
      // The host started again meanwhile: the objects are of before.
      if (epoch !== this.bootEpoch) return;
      this.sizes = { inventory, at: this.timers.now() };
      this.sizesError = undefined;
    } catch (error) {
      if (isAbortError(error) || this.disposed) return;
      const detail = errorMessage(error);
      this.deps.logger.warn(`The sizes of ${this.host} could not be read: ${detail}`);
      this.sizesError = detail.split('\n')[0].slice(0, 300);
    } finally {
      this.sizesAbort = undefined;
      this.sizesReading = false;
      this.post();
    }
  }

  /** The free space for the disk of the VM on this computer, with each sample `d`. */
  private readLocalDisk(): void {
    const read = this.deps.localDiskFree;
    if (!this.vm || read === undefined || this.localDiskReading) return;
    this.localDiskReading = true;
    read()
      .then(
        (free) => {
          if (this.disposed) return;
          this.localDiskFree = free;
          this.post();
        },
        (error: unknown) => this.deps.logger.warn(`The free space for the disk of the VM could not be read: ${errorMessage(error)}`),
      )
      .finally(() => {
        this.localDiskReading = false;
      });
  }

  private setPhase(phase: UsagePhase): void {
    this.phase = phase;
    this.scheduleVmCheck();
    this.post();
  }

  /** One gap in the history after the last point, for a pause, a hide or an end. */
  private markGap(): void {
    if (this.usage === undefined || this.gapped) return;
    this.history.gap();
    this.gapped = true;
  }

  /**
   * While the page shows a VM that does not run: the VM can start from somewhere else (a Start of a devspace), which
   * calls no vmChanged. The page reads the state of the VM, which starts nothing, every VM_CHECK_MS while it is visible
   * and has the focus, and at a show and when the window gets the focus.
   */
  private scheduleVmCheck(): void {
    this.clearTimer('vmCheckTimer');
    if (this.disposed || this.phase.kind !== 'vm') return;
    this.vmCheckTimer = this.timers.setTimeout(() => {
      this.vmCheckTimer = undefined;
      void this.checkVm();
    }, VM_CHECK_MS);
  }

  private async checkVm(): Promise<void> {
    if (this.disposed || this.phase.kind !== 'vm' || this.startingVm || this.checkingVm) return;
    // A hidden page or a window without the focus waits for the show or the focus, which check again.
    if (!this.panel.visible || !vscode.window.state.focused) return;
    const generation = this.generation;
    this.checkingVm = true;
    let state: VmState;
    try {
      state = await this.vmStateNow();
    } finally {
      this.checkingVm = false;
    }
    if (generation !== this.generation || this.disposed || this.phase.kind !== 'vm' || this.startingVm) return;
    if (state.kind === 'running') this.start(false);
    else if (state.kind !== this.phase.state.kind || state.detail !== this.phase.state.detail) this.setPhase({ kind: 'vm', state });
    else this.scheduleVmCheck();
  }

  /** Sends the view to a visible page (a hidden one has no page; it asks with `ready` when it shows again). */
  private post(): void {
    if (this.disposed || !this.panel.visible) return;
    const view = usagePageView({
      host: this.host,
      vm: this.vm,
      wsl: this.wsl,
      intervalMs: this.intervalMs,
      phase: this.phase,
      ...(this.header !== undefined ? { header: this.header } : {}),
      ...(this.usage !== undefined ? { usage: this.usage } : {}),
      ...(this.uptimeCs !== undefined ? { uptimeCs: this.uptimeCs } : {}),
      ...(this.updatedAt !== undefined ? { updatedAt: this.updatedAt } : {}),
      ...(this.names !== undefined ? { names: this.names } : {}),
      ...(this.disks !== undefined ? { disks: this.disks } : {}),
      ...(this.localDiskFree !== undefined ? { localDiskFree: this.localDiskFree } : {}),
      busy: this.history.seriesPoints('busy'),
      ...(this.sizes !== undefined ? { sizes: this.sizes } : {}),
      sizesReading: this.sizesReading,
      ...(this.sizesError !== undefined ? { sizesError: this.sizesError } : {}),
    });
    this.panel.webview.postMessage({ type: 'view', view }).then(undefined, (error: unknown) => {
      this.deps.logger.warn(`The utilization page of ${this.host} could not be updated: ${errorMessage(error)}`);
    });
  }
}
