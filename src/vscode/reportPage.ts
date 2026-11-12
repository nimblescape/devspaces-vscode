// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The report page of a resource of the view Docker Hosts (docs/requirements.md R-ENG-010): a click on an object row
// opens its report in the editor, a read-only page. The page is a custom editor of the report address of the resource
// (reportAddress, scheme devspaces-report), so the editor of VS Code treats it like a file of the Explorer: a click opens a
// preview tab with an italic title, the next click replaces it, and a double click on the row (or on the tab, or Keep
// Open of VS Code) keeps it with a regular title; the setting workbench.editor.enablePreview applies. The page reads when
// it opens and at Refresh; never in the background and never with a start of the VM of Devspaces (R-VM-004): on the VM
// it reads its state first, and a stopped VM shows Start the VM. A tab that VS Code opens again at its start reads
// nothing until Refresh, because the view has not read the host then. Thin glue: the reads run on the shared shell of
// the host (readResourceReport, src/core/hosts/reportRead.ts), and what the page shows comes from reportPageModel.ts. A
// read is a flow of the user, so a first login to a remote host may ask for a password. Show Log of the Monitor opens the
// last lines of the log of the Monitor as a read-only document.
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { HostObject, HostObjectKind } from '../core/hosts/hostObjects';
import type { ReportClock, ReportContent } from '../core/hosts/reportModel';
import { isAbortError, type Logger } from '../core/ports';
import { withSshPrompts } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import { showWarningMessage } from './notifications';
import {
  REPORT_SCHEME,
  ReportPageTexts,
  parseReportRequest,
  reportAddress,
  reportKeyOf,
  reportPageHtml,
  reportPageView,
  reportTargetOfArgument,
  type ReportKey,
  type ReportPhase,
  type ReportTarget,
} from './reportPageModel';

/** The view type of the custom editor of the report page (package.json, `customEditors`). */
export const REPORT_VIEW_TYPE = 'devspaces.resourceReport';
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
  /** The object `kind` `id` of `host` as the view Docker Hosts shows it now (DockerHostsView.objectOf), else undefined. */
  objectOf: (host: string, kind: HostObjectKind, id: string) => HostObject | undefined;
  /** The report of `target`, read now on the shared shell of its host (readResourceReport). */
  read: (target: ReportTarget, clock: ReportClock) => Promise<ReportContent>;
  /** The last lines of the log of the Monitor of `host`, with times in `timeZone` (readMonitorLog on the shared shell of the host). */
  readMonitorLog: (host: string, timeZone: string) => Promise<string>;
  /** Now, and the time zone of this computer, in which the page gives times. */
  clock: () => ReportClock;
}

/** The address of the report of `target`. */
export function reportUri(target: ReportTarget): vscode.Uri {
  return vscode.Uri.from({ scheme: REPORT_SCHEME, ...reportAddress(target) });
}

/** The report pages of this window: the provider of the custom editor of the report addresses. */
export class ReportPages implements vscode.CustomReadonlyEditorProvider, vscode.Disposable {
  private readonly pages = new Set<ReportPage>();
  private readonly registration: vscode.Disposable;
  private readonly logs = new Map<string, string>();
  private readonly logChanged = new vscode.EventEmitter<vscode.Uri>();
  /** The provider of the documents of Show Log of the Monitor, registered at the first Show Log. */
  private logProvider: vscode.Disposable | undefined;
  private disposed = false;

  constructor(private readonly deps: ReportPagesDeps) {
    // A hidden page keeps its content here; a show asks for it again (`ready`) and reads nothing.
    this.registration = vscode.window.registerCustomEditorProvider(REPORT_VIEW_TYPE, this, { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: false } });
  }

  /** Show Report of the menu of an object row: its report, as a click on the row opens it. */
  show(argument: unknown): void {
    const target = reportTargetOfArgument(argument);
    if (target === undefined || this.disposed) return;
    vscode.commands.executeCommand('vscode.open', reportUri(target)).then(undefined, (error: unknown) => {
      this.deps.logger.warn(`The report of ${target.object.kind} ${target.object.name} on ${target.host} could not be opened: ${errorMessage(error)}`);
    });
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  /** The page of a report address in the tab that VS Code opened for it (a click on a row, or a tab of the last session). */
  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const key = reportKeyOf({ path: document.uri.path, query: document.uri.query });
    if (key === undefined || this.disposed) {
      panel.webview.options = { enableScripts: false };
      panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head><body><p>${ReportPageTexts.notAReport}</p></body></html>`;
      return;
    }
    const page: ReportPage = new ReportPage(panel, key, this.deps, {
      disposed: () => this.pages.delete(page),
      showLog: (host) => this.showLog(host),
    });
    this.pages.add(page);
  }

  /** The VM may have started or stopped (a command of the VM): its pages that wait for it read again. */
  vmChanged(): void {
    for (const page of this.pages) page.vmChanged();
  }

  /** Show Log of the Monitor: the last lines of its log on `host`, as a read-only document. */
  private async showLog(host: string): Promise<void> {
    let text: string;
    try {
      text = await withSshPrompts(() => this.deps.readMonitorLog(host, this.deps.clock().timeZone));
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
    this.registration.dispose();
    for (const page of [...this.pages]) page.dispose();
    this.pages.clear();
    this.logProvider?.dispose();
    this.logProvider = undefined;
    this.logChanged.dispose();
    this.logs.clear();
  }
}

/** The page of one report, in the tab of its address. */
class ReportPage {
  private readonly listeners: vscode.Disposable[];
  /** Ends a password question of a read when the page closes (never a command on the shared shell: that would end it). */
  private readonly abort = new AbortController();
  /** The resource as the view showed it last; undefined while the view does not show it (`missing`). */
  private target: ReportTarget | undefined;
  private phase: ReportPhase = { kind: 'reading' };
  private content: ReportContent | undefined;
  /** Counts the reads: the result of an earlier one (before a Refresh) is dropped. */
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly key: ReportKey,
    private readonly deps: ReportPagesDeps,
    private readonly events: { disposed: () => void; showLog: (host: string) => Promise<void> },
  ) {
    const assets = vscode.Uri.joinPath(deps.extensionUri, ...ASSETS);
    const webview = panel.webview;
    webview.options = { enableScripts: true, enableCommandUris: false, enableForms: false, localResourceRoots: [assets] };
    webview.html = reportPageHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString('base64'),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(assets, 'page.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(assets, 'page.css')).toString(),
      title: key.name,
    });
    this.listeners = [webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw)), panel.onDidDispose(() => this.dispose())];
    // A click on a row: the view shows the resource, so the page reads it. A tab that VS Code opened again at its start:
    // the view has not read the host, so the page reads nothing until Refresh.
    this.target = this.current();
    if (this.target !== undefined) {
      void this.read();
    } else {
      this.phase = { kind: 'missing' };
      this.post();
    }
  }

  /** The resource of the page as the view shows it now, else undefined. */
  private current(): ReportTarget | undefined {
    const object = this.deps.objectOf(this.key.host, this.key.kind, this.key.id);
    return object !== undefined ? { host: this.key.host, object } : undefined;
  }

  /** The VM may have started: a page on the VM that waits for it reads again. */
  vmChanged(): void {
    if (!this.disposed && this.phase.kind === 'vm' && this.key.host === this.deps.vmHost) void this.read();
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
        // The page shows again: with the name and the state of the newer row (the view may have read the host since).
        this.target = this.current() ?? this.target;
        this.post();
        return;
      case 'refresh':
        if (this.phase.kind === 'reading') return;
        this.target = this.current() ?? this.target;
        if (this.target !== undefined) {
          void this.read();
        } else {
          this.phase = { kind: 'missing' };
          this.post();
        }
        return;
      case 'showLog':
        void this.events.showLog(this.key.host);
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
    const target = this.target;
    if (target === undefined) return;
    const generation = ++this.generation;
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
      target: this.target ?? this.key,
      vm: this.key.host === this.deps.vmHost,
      phase: this.phase,
      ...(this.content !== undefined ? { content: this.content } : {}),
      clock: this.deps.clock(),
    });
    this.panel.webview.postMessage({ type: 'view', view }).then(undefined, (error: unknown) => {
      this.deps.logger.warn(`The report page of ${this.key.name} could not be updated: ${errorMessage(error)}`);
    });
  }
}
