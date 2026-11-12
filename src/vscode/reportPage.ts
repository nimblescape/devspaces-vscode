// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The report page of a resource of the view Docker Hosts (docs/requirements.md R-ENG-010): a click on an object row
// opens its report in the editor, a read-only page. One page follows the clicks (it shows the report of the last click);
// Keep Open keeps a page with its resource, and the next click opens a new page. The page reads when it opens, when it
// follows a click, and at Refresh; never in the background and never with a start of the VM of Devspaces (R-VM-004): on
// the VM it reads its state first, and a stopped VM shows Start the VM. Thin glue: the reads run on the shared shell of
// the host (readResourceReport, src/core/hosts/reportRead.ts), and what the page shows comes from reportPageModel.ts. A
// read is a flow of the user, so a first login to a remote host may ask for a password. Show Log of the Monitor opens the
// last lines of the log of the Monitor as a read-only document.
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { ReportClock, ReportContent } from '../core/hosts/reportModel';
import { isAbortError, type Logger } from '../core/ports';
import { withSshPrompts } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import { showWarningMessage } from './notifications';
import { ReportPageTexts, parseReportRequest, reportPageHtml, reportPageView, reportTargetOfArgument, sameTarget, type ReportPhase, type ReportTarget } from './reportPageModel';

const VIEW_TYPE = 'devspaces.resourceReport';
/** Folder of the style sheet and the script of the webview (package: resources/**). */
const ASSETS = ['resources', 'reportPage'];
/** The scheme of the read-only documents of Show Log of the Monitor. */
export const MONITOR_LOG_SCHEME = 'devspaces-monitor-log';

export interface ReportPagesDeps {
  extensionUri: vscode.Uri;
  logger: Logger;
  /** The VM of Devspaces on this platform (LIMA_HOST or WSL_HOST), undefined where there is none. */
  vmHost: string | undefined;
  /** The state of the VM, read without a start (vmState.ts). */
  vmState: () => Promise<VmState>;
  /** "Start the VM" (VmCommands.start), which never throws. */
  startVm: () => Promise<void>;
  /** The report of `target`, read now on the shared shell of its host (readResourceReport). */
  read: (target: ReportTarget, clock: ReportClock) => Promise<ReportContent>;
  /** The last lines of the log of the Monitor of `host` (readMonitorLog on the shared shell of the host). */
  readMonitorLog: (host: string) => Promise<string>;
  /** Now, and the time zone of this computer, in which the page gives times. */
  clock: () => ReportClock;
}

/** The report pages of this window. */
export class ReportPages implements vscode.Disposable {
  private readonly pages = new Set<ReportPage>();
  /** The page that follows the clicks: the newest page without Keep Open. */
  private follow: ReportPage | undefined;
  private readonly logs = new Map<string, string>();
  private readonly logChanged = new vscode.EventEmitter<vscode.Uri>();
  /** The provider of the documents of Show Log of the Monitor, registered at the first Show Log. */
  private logProvider: vscode.Disposable | undefined;
  private disposed = false;

  constructor(private readonly deps: ReportPagesDeps) {}

  /** The click on an object row (or Show Report of its menu): the page of its report. */
  show(argument: unknown): void {
    const target = reportTargetOfArgument(argument);
    if (target === undefined || this.disposed) return;
    // A page that is kept with this resource shows it; the page that follows the clicks shows it too.
    const kept = [...this.pages].find((page) => page.kept && sameTarget(page.target, target));
    if (kept !== undefined) {
      kept.showTarget(target);
      return;
    }
    if (this.follow !== undefined) {
      this.follow.showTarget(target);
      return;
    }
    const page: ReportPage = new ReportPage(target, this.deps, {
      disposed: () => {
        this.pages.delete(page);
        if (this.follow === page) this.follow = undefined;
      },
      kept: () => {
        if (this.follow === page) this.follow = undefined;
      },
      showLog: (host) => this.showLog(host),
    });
    this.pages.add(page);
    this.follow = page;
  }

  /** The VM may have started or stopped (a command of the VM): its pages that wait for it read again. */
  vmChanged(): void {
    for (const page of this.pages) page.vmChanged();
  }

  /** Show Log of the Monitor: the last lines of its log on `host`, as a read-only document. */
  private async showLog(host: string): Promise<void> {
    let text: string;
    try {
      text = await withSshPrompts(() => this.deps.readMonitorLog(host));
    } catch (error) {
      if (isAbortError(error)) return;
      const detail = errorMessage(error);
      this.deps.logger.warn(`The log of the Monitor on ${host} could not be read: ${detail}`);
      void showWarningMessage(ReportPageTexts.logFailed(detail.split('\n')[0].slice(0, 300)));
      return;
    }
    if (this.disposed) return;
    this.logProvider ??= vscode.workspace.registerTextDocumentContentProvider(MONITOR_LOG_SCHEME, {
      onDidChange: this.logChanged.event,
      provideTextDocumentContent: (uri) => this.logs.get(uri.toString()) ?? '',
    });
    const uri = vscode.Uri.from({ scheme: MONITOR_LOG_SCHEME, path: `/${host}/devspaces-monitor.log` });
    this.logs.set(uri.toString(), text.trim() === '' ? ReportPageTexts.logEmpty : `${text}\n`);
    this.logChanged.fire(uri);
    try {
      const opened = await vscode.workspace.openTextDocument(uri);
      // The colors of a log, where VS Code has the language `log`; without it the plain text.
      const document = await vscode.languages.setTextDocumentLanguage(opened, 'log').then(undefined, () => opened);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      this.deps.logger.warn(`The log of the Monitor on ${host} could not be opened: ${errorMessage(error)}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const page of [...this.pages]) page.dispose();
    this.pages.clear();
    this.follow = undefined;
    this.logProvider?.dispose();
    this.logProvider = undefined;
    this.logChanged.dispose();
    this.logs.clear();
  }
}

/** The page of one report. */
class ReportPage {
  private readonly panel: vscode.WebviewPanel;
  private readonly listeners: vscode.Disposable[];
  /** Ends a password question of a read when the page closes (never a command on the shared shell: that would end it). */
  private readonly abort = new AbortController();
  private phase: ReportPhase = { kind: 'reading' };
  private content: ReportContent | undefined;
  /** Counts the reads: the result of an earlier one (of another resource, or before a Refresh) is dropped. */
  private generation = 0;
  private disposed = false;
  kept = false;

  constructor(
    public target: ReportTarget,
    private readonly deps: ReportPagesDeps,
    private readonly events: { disposed: () => void; kept: () => void; showLog: (host: string) => Promise<void> },
  ) {
    const assets = vscode.Uri.joinPath(deps.extensionUri, ...ASSETS);
    // The focus stays in the view, so that the arrow keys go on to the next row and Enter opens its report.
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      ReportPageTexts.panelTitle(target.object),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
      {
        enableScripts: true,
        enableCommandUris: false,
        enableForms: false,
        localResourceRoots: [assets],
        // A hidden page keeps its content here; a show asks for it again (`ready`) and reads nothing.
        retainContextWhenHidden: false,
      },
    );
    const webview = this.panel.webview;
    webview.html = reportPageHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString('base64'),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(assets, 'page.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(assets, 'page.css')).toString(),
      title: ReportPageTexts.panelTitle(target.object),
    });
    this.listeners = [webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw)), this.panel.onDidDispose(() => this.dispose())];
    void this.read();
  }

  reveal(): void {
    this.panel.reveal(undefined, true);
  }

  /**
   * The page shows the report of `target`. The same resource again is only a show, with the name and the state of the
   * newer row (the view may have read the host again since); another resource (only on the page that follows the clicks)
   * is read.
   */
  showTarget(target: ReportTarget): void {
    if (sameTarget(target, this.target)) {
      this.target = target;
      this.panel.title = ReportPageTexts.panelTitle(target.object);
      this.reveal();
      this.post();
      return;
    }
    this.target = target;
    this.content = undefined;
    this.panel.title = ReportPageTexts.panelTitle(target.object);
    this.reveal();
    void this.read();
  }

  /** The VM may have started: a page on the VM that waits for it reads again. */
  vmChanged(): void {
    if (!this.disposed && this.phase.kind === 'vm' && this.target.host === this.deps.vmHost) void this.read();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    for (const listener of this.listeners) listener.dispose();
    this.panel.dispose();
    this.events.disposed();
  }

  private onMessage(raw: unknown): void {
    if (this.disposed) return;
    const request = parseReportRequest(raw);
    if (request === undefined) {
      this.deps.logger.warn('The report page sent a message that is not valid. It is ignored.');
      return;
    }
    switch (request.type) {
      case 'ready':
        this.post();
        return;
      case 'refresh':
        if (this.phase.kind !== 'reading') void this.read();
        return;
      case 'keepOpen':
        this.kept = true;
        this.events.kept();
        this.post();
        return;
      case 'showLog':
        void this.events.showLog(this.target.host);
        return;
      case 'startVm':
        void this.startVm();
        return;
    }
  }

  /** Start the VM of the banner: the start of the user, then the read. */
  private async startVm(): Promise<void> {
    await this.deps.startVm();
    if (!this.disposed) void this.read();
  }

  /**
   * Reads the report of the current resource: on the VM of Devspaces only while it runs (its state, read without a
   * start, first). A read that a newer one replaced keeps nothing. A read is never ended by the page: its commands run
   * on the shared shell of the host, which an end would stop.
   */
  private async read(): Promise<void> {
    const generation = ++this.generation;
    const target = this.target;
    this.phase = { kind: 'reading' };
    this.post();
    try {
      if (target.host === this.deps.vmHost) {
        const state = await this.deps.vmState();
        if (generation !== this.generation || this.disposed) return;
        if (state.kind !== 'running') {
          this.phase = { kind: 'vm', state };
          return;
        }
      }
      const content = await withSshPrompts(() => this.deps.read(target, this.deps.clock()), this.abort.signal);
      if (generation !== this.generation || this.disposed) return;
      this.content = content;
      this.phase = { kind: 'read', at: this.deps.clock().now };
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      const detail = isAbortError(error) ? 'The read was stopped.' : errorMessage(error);
      this.deps.logger.warn(`The report of ${target.object.kind} ${target.object.name} on ${target.host} could not be read: ${detail}`);
      this.phase = { kind: 'failed', message: detail.split('\n')[0].slice(0, 500) };
    } finally {
      if (generation === this.generation && !this.disposed) this.post();
    }
  }

  /** Sends the view to a visible page (a hidden one has no page; it asks with `ready` when it shows again). */
  private post(): void {
    if (this.disposed || !this.panel.visible) return;
    const view = reportPageView({
      target: this.target,
      vm: this.target.host === this.deps.vmHost,
      phase: this.phase,
      ...(this.content !== undefined ? { content: this.content } : {}),
      kept: this.kept,
      clock: this.deps.clock(),
    });
    this.panel.webview.postMessage({ type: 'view', view }).then(undefined, (error: unknown) => {
      this.deps.logger.warn(`The report page of ${this.target.object.name} could not be updated: ${errorMessage(error)}`);
    });
  }
}
