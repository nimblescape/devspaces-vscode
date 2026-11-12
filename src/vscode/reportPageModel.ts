// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The report page of a resource of the view Docker Hosts (docs/requirements.md R-ENG-010): the resource of a click on a
// row, what the page shows (its header, its buttons, its state, and the content of the report from
// src/core/hosts/resourceReport.ts), the HTML of the webview, and the check of its messages. The webview only shows these
// texts (resources/reportPage/page.js). No `vscode`: reportPage.ts is the glue.
import type { HostObject, HostObjectKind } from '../core/hosts/hostObjects';
import { timeText, type ReportClock, type ReportContent } from '../core/hosts/reportModel';
import type { VmState } from '../core/vm/vmState';
import { DockerHostsTexts, objectColor } from './dockerHostsModel';

const OBJECT_KINDS: readonly HostObjectKind[] = ['container', 'image', 'volume', 'network'];

/** The resource of a report: an object row of the view Docker Hosts. */
export interface ReportTarget {
  host: string;
  object: HostObject;
}

/** The resource of a command argument that is an object row of the view (`{ hostsNode: 'object', host, object }`), else undefined. */
export function reportTargetOfArgument(argument: unknown): ReportTarget | undefined {
  if (typeof argument !== 'object' || argument === null) return undefined;
  const value = argument as { hostsNode?: unknown; host?: unknown; object?: unknown };
  if (value.hostsNode !== 'object' || typeof value.host !== 'string' || value.host === '') return undefined;
  const object = value.object as Partial<HostObject> | null | undefined;
  if (typeof object !== 'object' || object === null) return undefined;
  if (!(OBJECT_KINDS as readonly unknown[]).includes(object.kind) || typeof object.id !== 'string' || object.id === '' || typeof object.name !== 'string' || typeof object.purpose !== 'string') return undefined;
  return { host: value.host, object: object as HostObject };
}

/** Whether two targets name the same resource. */
export function sameTarget(a: ReportTarget, b: ReportTarget): boolean {
  return a.host === b.host && a.object.kind === b.object.kind && a.object.id === b.object.id;
}

/**
 * The state of the page. `reading`: the read runs. `read`: the content is from the read at `at`. `failed`: the read
 * failed (`message`). `vm`: the VM of Devspaces does not run, so the page reads nothing (it never starts the VM).
 */
export type ReportPhase = { kind: 'reading' } | { kind: 'read'; at: number } | { kind: 'failed'; message: string } | { kind: 'vm'; state: VmState };

/** What a button of the page asks the extension. */
export type ReportAction = 'refresh' | 'keepOpen' | 'showLog' | 'startVm';

/** A message of the webview: `ready` (the page started, also after it was hidden), or a button. */
export interface ReportRequest {
  type: 'ready' | ReportAction;
}

const REQUEST_TYPES: ReadonlySet<string> = new Set(['ready', 'refresh', 'keepOpen', 'showLog', 'startVm']);

/** The message of the webview, else undefined (the webview is not trusted). */
export function parseReportRequest(raw: unknown): ReportRequest | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const type = (raw as { type?: unknown }).type;
  return typeof type === 'string' && REQUEST_TYPES.has(type) ? { type: type as ReportRequest['type'] } : undefined;
}

/** The color of the name: as in the view Docker Hosts (rowColors.ts); `normal` is the color of the theme. */
export type ReportTone = 'normal' | 'inactive' | 'notDevspaces' | 'notDevspacesInactive';

export interface ReportButton {
  action: ReportAction;
  label: string;
  primary?: boolean;
  disabled?: boolean;
}

/** What the webview shows. */
export interface ReportPageView {
  title: string;
  kind: HostObject['kind'];
  /** The kind, the purpose, the state and the host of the resource. */
  kindLine: string;
  tone: ReportTone;
  /** The state of the read: `Reading…`, `Read today 07:52`. */
  status: string;
  busy: boolean;
  buttons: ReportButton[];
  /** A note above the content: a failed read, a VM that does not run. */
  banner?: { message: string; detail?: string; buttons: ReportButton[] };
  /** The content of the last read (also while a Refresh reads again); undefined before the first read. */
  content?: ReportContent;
}

/** User-visible texts of the page (plain language). */
export const ReportPageTexts = {
  panelTitle: (object: Pick<HostObject, 'name'>) => object.name,
  kindName: (kind: HostObject['kind']) => ({ container: 'Container', image: 'Image', volume: 'Volume', network: 'Network' })[kind],
  hostName: (host: string, vm: boolean) => (vm ? `${DockerHostsTexts.vmName} (${host})` : host),
  reading: 'Reading…',
  read: (at: string) => `Read ${at}`,
  refresh: 'Refresh',
  keepOpen: 'Keep Open',
  showLog: 'Show Log of the Monitor',
  startVm: 'Start the VM',
  failed: 'The report could not be read.',
  vmNotRunning: 'The VM of Devspaces does not run.',
  vmNotRunningDetail: 'The report reads nothing while the VM is stopped: a read would start it. Start the VM, or start a devspace, and click Refresh.',
  vmNotSetUp: 'The VM of Devspaces is not set up.',
  vmUnknown: (detail: string | undefined) => `The state of the VM of Devspaces is not known${detail !== undefined ? `: ${detail}` : '.'}`,
  log: (host: string) => `Log of the Monitor on ${host}`,
  logEmpty: 'The Monitor wrote nothing to its log yet.',
  logFailed: (detail: string) => `The log of the Monitor could not be read: ${detail}`,
};

/** The line under the name: `Volume · shared volume · lima:devspaces`. */
function kindLine(target: ReportTarget, vm: boolean): string {
  const { object } = target;
  const parts = [ReportPageTexts.kindName(object.kind), DockerHostsTexts.purpose(object)];
  const state = DockerHostsTexts.containerState(object.state);
  if (state !== undefined) parts.push(state);
  parts.push(ReportPageTexts.hostName(target.host, vm));
  return parts.join(' · ');
}

/** What the page shows for `target` in `phase`, with the content of the last read. `kept`: Keep Open was clicked. */
export function reportPageView(input: { target: ReportTarget; vm: boolean; phase: ReportPhase; content?: ReportContent; kept: boolean; clock: ReportClock }): ReportPageView {
  const { target, phase, content } = input;
  const busy = phase.kind === 'reading';
  const buttons: ReportButton[] = [];
  if (content?.monitorLog === true) buttons.push({ action: 'showLog', label: ReportPageTexts.showLog });
  if (!input.kept) buttons.push({ action: 'keepOpen', label: ReportPageTexts.keepOpen });
  buttons.push({ action: 'refresh', label: ReportPageTexts.refresh, primary: true, ...(busy ? { disabled: true } : {}) });
  const status = phase.kind === 'reading' ? ReportPageTexts.reading : phase.kind === 'read' ? ReportPageTexts.read(timeText(phase.at, input.clock)) : '';
  const color = objectColor(target.object);
  const view: ReportPageView = {
    title: target.object.name,
    kind: target.object.kind,
    kindLine: kindLine(target, input.vm),
    tone: color ?? 'normal',
    status,
    busy,
    buttons,
    ...(content !== undefined ? { content } : {}),
  };
  if (phase.kind === 'failed') view.banner = { message: ReportPageTexts.failed, detail: phase.message, buttons: [] };
  if (phase.kind === 'vm') view.banner = vmBanner(phase.state);
  return view;
}

function vmBanner(state: VmState): NonNullable<ReportPageView['banner']> {
  switch (state.kind) {
    case 'notSetUp':
      return { message: ReportPageTexts.vmNotSetUp, buttons: [] };
    case 'stopped':
      return { message: ReportPageTexts.vmNotRunning, detail: ReportPageTexts.vmNotRunningDetail, buttons: [{ action: 'startVm', label: ReportPageTexts.startVm, primary: true }] };
    default:
      return { message: ReportPageTexts.vmUnknown(state.detail), buttons: [] };
  }
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/** The HTML of the webview: a frame that page.js fills from the view (a message `view`), and nothing it runs inline. */
export function reportPageHtml(options: { cspSource: string; nonce: string; scriptUri: string; styleUri: string; title: string }): string {
  const csp = ["default-src 'none'", `style-src ${options.cspSource}`, `script-src 'nonce-${options.nonce}'`, "img-src 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeAttribute(options.styleUri)}">
<title>${escapeText(options.title)}</title>
</head>
<body>
<main>
<header class="head">
<div class="head-text">
<h1 id="title">${escapeText(options.title)}</h1>
<p id="kind" class="muted"></p>
</div>
<div class="head-actions">
<span id="status" class="status muted" role="status" aria-live="polite"></span>
<span id="buttons" class="buttons"></span>
</div>
</header>
<p id="summary" class="summary"></p>
<section id="banner" class="banner" hidden>
<div class="banner-text">
<p id="banner-message"></p>
<p id="banner-detail" class="muted"></p>
</div>
<div id="banner-buttons" class="buttons"></div>
</section>
<ul id="notices" class="notices" hidden></ul>
<div id="sections"></div>
</main>
<script nonce="${escapeAttribute(options.nonce)}" src="${escapeAttribute(options.scriptUri)}"></script>
</body>
</html>`;
}
