// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The report page of a resource of the view Docker Hosts (docs/requirements.md R-ENG-010): the resource of a click on a
// row, the address of its report (the editor of VS Code opens it like a file, so a click gives a preview tab), what the
// page shows (its header, its buttons, its state, and the content of the report from src/core/hosts/resourceReport.ts),
// the HTML of the webview, and the check of its messages. The webview only shows these texts
// (resources/reportPage/page.js). No `vscode`: reportPage.ts is the glue.
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

/**
 * The scheme of the address of a report. The custom editor of the report page (package.json, `customEditors`) opens
 * every address of this scheme, so the editor of VS Code treats a report like a file: a click opens a preview tab with
 * an italic title, the next click replaces it, and a double click keeps it.
 */
export const REPORT_SCHEME = 'devspaces-report';

/** The resource of the address of a report: its host, its kind, its ID, and its name (the title of its tab). */
export interface ReportKey {
  host: string;
  kind: HostObjectKind;
  id: string;
  name: string;
}

/** The address of a report: the path and the query of a URI of the scheme REPORT_SCHEME. */
export interface ReportAddress {
  path: string;
  query: string;
}

/** `text` as one part of a path: `%` as `%25` and `/` as `%2F`. */
function pathPart(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('/', '%2F');
}

/**
 * The address of the report of `target`: the path `/<host>/<kind>/<name>` (a `/` in the host as `%2F`) and the query
 * `id=<ID>`. VS Code names the tab after the last part of the path, so it shows the name (of an image
 * `ghcr.io/owner/image:tag` the part after the last `/`), and shows the whole path as the title of the page. The same
 * resource always has the same address, so a click on the row of a kept report shows that tab.
 */
export function reportAddress(target: ReportTarget): ReportAddress {
  const { object } = target;
  return { path: `/${pathPart(target.host)}/${object.kind}/${object.name}`, query: new URLSearchParams({ id: object.id }).toString() };
}

/** The resource of a report address (reportAddress), else undefined. */
export function reportKeyOf(address: ReportAddress): ReportKey | undefined {
  const match = /^\/([^/]+)\/(container|image|volume|network)\/(.+)$/.exec(address.path);
  if (match === null) return undefined;
  const host = match[1].replaceAll('%2F', '/').replaceAll('%25', '%');
  const id = new URLSearchParams(address.query).get('id') ?? '';
  const key: ReportKey = { host, kind: match[2] as HostObjectKind, id, name: match[3] };
  if (host === '' || id === '') return undefined;
  // Only the address that reportAddress gives for the key (no other spelling of the same resource).
  const again = reportAddress({ host, object: { kind: key.kind, id, name: key.name, purpose: 'other' } });
  return again.path === address.path && again.query === address.query ? key : undefined;
}

/**
 * The state of the page. `reading`: the read runs. `read`: the content is from the read at `at`. `failed`: the read
 * failed (`message`). `vm`: the VM of Devspaces does not run, so the page reads nothing (it never starts the VM).
 * `missing`: the view Docker Hosts does not show the resource now (VS Code opened the tab again at its start, before the
 * view read the host, or the resource is gone), so the page reads nothing.
 */
export type ReportPhase = { kind: 'reading' } | { kind: 'read'; at: number } | { kind: 'failed'; message: string } | { kind: 'vm'; state: VmState } | { kind: 'missing' };

/** What a button of the page asks the extension. */
export type ReportAction = 'refresh' | 'showLog' | 'startVm';

/** What the settings allow on a report page now: Start the VM (dockerHostsActions), and Show Log (allowContainerLogs). */
export interface ReportPermissions {
  actions: boolean;
  logs: boolean;
}

/** A message of the webview: `ready` (the page started, also after it was hidden), or a button. */
export interface ReportRequest {
  type: 'ready' | ReportAction;
}

const REQUEST_TYPES: ReadonlySet<string> = new Set(['ready', 'refresh', 'showLog', 'startVm']);

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
  kindName: (kind: HostObject['kind']) => ({ container: 'Container', image: 'Image', volume: 'Volume', network: 'Network' })[kind],
  hostName: (host: string, vm: boolean) => (vm ? `${DockerHostsTexts.vmName} (${host})` : host),
  reading: 'Reading…',
  read: (at: string) => `Read ${at}`,
  refresh: 'Refresh',
  showLog: 'Show Log',
  showMonitorLog: 'Show Log of the Monitor',
  startVm: 'Start the VM',
  failed: 'The report could not be read.',
  missing: 'The view Docker Hosts does not show this resource now.',
  missingDetail: 'VS Code may have opened this tab again at its start, before the view read the host, or the resource is gone. Open its host in the view Docker Hosts, then click Refresh.',
  vmNotRunning: 'The VM of Devspaces does not run.',
  vmNotRunningDetail: 'The report reads nothing while the VM is stopped: a read would start it. Start the VM, or start a devspace, and click Refresh.',
  vmNotRunningReadOnly: 'The report reads nothing while the VM is stopped: a read would start it. Start a devspace, and click Refresh.',
  vmNotSetUp: 'The VM of Devspaces is not set up.',
  vmUnknown: (detail: string | undefined) => `The state of the VM of Devspaces is not known${detail !== undefined ? `: ${detail}` : '.'}`,
  notAReport: 'This address is not the address of a report of Devspaces.',
};

/**
 * The line under the name: `Volume · shared volume · lima:devspaces`; of a resource that the view does not show now
 * only its kind and its host.
 */
function kindLine(target: ReportTarget | ReportKey, vm: boolean): string {
  if (!('object' in target)) return [ReportPageTexts.kindName(target.kind), ReportPageTexts.hostName(target.host, vm)].join(' · ');
  const { object } = target;
  const parts = [ReportPageTexts.kindName(object.kind), DockerHostsTexts.purpose(object)];
  const state = DockerHostsTexts.containerState(object.state);
  if (state !== undefined) parts.push(state);
  parts.push(ReportPageTexts.hostName(target.host, vm));
  return parts.join(' · ');
}

/**
 * What the page shows for `target` in `phase`, with the content of the last read. `target` is the key of the address
 * while the view does not show the resource (`missing`).
 */
export function reportPageView(input: {
  target: ReportTarget | ReportKey;
  vm: boolean;
  phase: ReportPhase;
  content?: ReportContent;
  clock: ReportClock;
  /** What the settings allow now: the actions of the view (Start the VM), and the logs of containers (Show Log). */
  allowed: ReportPermissions;
}): ReportPageView {
  const { target, phase, content, allowed } = input;
  const busy = phase.kind === 'reading';
  const buttons: ReportButton[] = [];
  if (content?.monitorLog === true && allowed.logs) buttons.push({ action: 'showLog', label: ReportPageTexts.showMonitorLog });
  else if ((content?.containerLog !== undefined || content?.workerLog !== undefined) && allowed.logs) buttons.push({ action: 'showLog', label: ReportPageTexts.showLog });
  buttons.push({ action: 'refresh', label: ReportPageTexts.refresh, primary: true, ...(busy ? { disabled: true } : {}) });
  const status = phase.kind === 'reading' ? ReportPageTexts.reading : phase.kind === 'read' ? ReportPageTexts.read(timeText(phase.at, input.clock)) : '';
  const known = 'object' in target ? target.object : undefined;
  const view: ReportPageView = {
    title: known?.name ?? (target as ReportKey).name,
    kind: known?.kind ?? (target as ReportKey).kind,
    kindLine: kindLine(target, input.vm),
    tone: (known !== undefined ? objectColor(known) : undefined) ?? 'normal',
    status,
    busy,
    buttons,
    ...(content !== undefined ? { content } : {}),
  };
  if (phase.kind === 'failed') view.banner = { message: ReportPageTexts.failed, detail: phase.message, buttons: [] };
  if (phase.kind === 'vm') view.banner = vmBanner(phase.state, allowed.actions);
  if (phase.kind === 'missing') view.banner = { message: ReportPageTexts.missing, detail: ReportPageTexts.missingDetail, buttons: [] };
  return view;
}

function vmBanner(state: VmState, actions: boolean): NonNullable<ReportPageView['banner']> {
  switch (state.kind) {
    case 'notSetUp':
      return { message: ReportPageTexts.vmNotSetUp, buttons: [] };
    case 'stopped':
      // Start the VM is an action of the view: only while the setting dockerHostsActions allows them.
      return actions
        ? { message: ReportPageTexts.vmNotRunning, detail: ReportPageTexts.vmNotRunningDetail, buttons: [{ action: 'startVm', label: ReportPageTexts.startVm, primary: true }] }
        : { message: ReportPageTexts.vmNotRunning, detail: ReportPageTexts.vmNotRunningReadOnly, buttons: [] };
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
