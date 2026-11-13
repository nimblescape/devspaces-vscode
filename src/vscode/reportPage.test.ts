// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The report page of a resource of the view Docker Hosts (R-ENG-010): a custom editor of the report address of the
// resource, so that VS Code opens it as a preview tab or a kept tab; Show Report opens the address as a click does; the
// page reads when it opens and at Refresh, always as a flow of the user (a login may ask), never while it is hidden; a
// tab that VS Code opened again at its start reads nothing until Refresh; on the VM of Devspaces it reads the state first
// and never starts the VM; a result of an older read is dropped; Show Log of the Monitor, and Show Log of any other
// container, open the log as a read-only document (containerLogs.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { LIMA_HOST } from '../core/docker/dockerHost';
import { CommandError } from '../core/errors';
import type { HostObject } from '../core/hosts/hostObjects';
import type { ReportClock, ReportContent } from '../core/hosts/reportModel';
import { sshPromptsAllowed, sshPromptSignal } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import { fakeVscode, openFakeCustomEditor, resetFakeVscode, type FakeWebviewPanel } from './testing/fakeVscode';
import { CONTAINER_LOG_SCHEME, ContainerLogTexts, ContainerLogs, monitorLogOf } from './containerLogs';
import { REPORT_VIEW_TYPE, ReportPages, reportUri, type ReportPagesDeps } from './reportPage';
import { REPORT_SCHEME, ReportPageTexts, type ReportPageView, type ReportTarget } from './reportPageModel';

const CLOCK: ReportClock = { now: Date.UTC(2026, 10, 12, 6, 52), timeZone: 'Europe/Vienna' };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
const monitor: HostObject = { kind: 'container', id: 'm1', name: 'devspaces-monitor', purpose: 'monitor', state: 'running', active: true };
const nginx: HostObject = { kind: 'image', id: 'sha256:n', name: 'nginx:1.27', purpose: 'notDevspaces' };
const WEB_ID = '0123456789abcdef'.repeat(4);
const web: HostObject = { kind: 'container', id: WEB_ID, name: 'shop-web-1', purpose: 'notDevspaces', state: 'running', active: true };
const row = (host: string, object: HostObject) => ({ hostsNode: 'object', host, object });
const contentOf = (name: string, monitorLog = false): ReportContent => ({ summary: [{ text: name, tone: 'info' }], sections: [], notices: [], monitorLog });

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  pages: ReportPages;
  /** The objects that the view Docker Hosts shows now (objectOf). */
  shown: ReportTarget[];
  deps: ReportPagesDeps;
  reads: Array<{ target: ReportTarget; flow: boolean; signal: AbortSignal | undefined }>;
  vmReads: number;
  vmState: VmState;
  startVm: ReturnType<typeof vi.fn>;
  /** The read of a log (ContainerLogs, as extension.ts wires it to the pages). */
  readLog: ReturnType<typeof vi.fn>;
  logs: ContainerLogs;
  read: (target: ReportTarget) => Promise<ReportContent>;
}

function harness(overrides: Partial<ReportPagesDeps> = {}): Harness {
  const h = { reads: [], shown: [], vmReads: 0, vmState: { kind: 'running' } } as unknown as Harness;
  h.read = async (target) => ({
    ...contentOf(target.object.name, target.object.purpose === 'monitor'),
    ...(target.object.kind === 'container' && target.object.purpose !== 'monitor' ? { containerLog: target.object.id } : {}),
  });
  h.startVm = vi.fn(async () => {
    h.vmState = { kind: 'running' };
  });
  h.readLog = vi.fn(async () => '2026-11-12T06:00:00.000000000Z run started');
  h.deps = {
    extensionUri: fakeVscode.Uri.file('/extension') as never,
    logger,
    vmHost: LIMA_HOST,
    vmState: async () => {
      h.vmReads++;
      return h.vmState;
    },
    startVm: h.startVm as never,
    objectOf: (host, kind, id) => h.shown.find((entry) => entry.host === host && entry.object.kind === kind && entry.object.id === id)?.object,
    read: (target) => {
      h.reads.push({ target, flow: sshPromptsAllowed(), signal: sshPromptSignal() });
      return h.read(target);
    },
    showLog: (log) => h.logs.show(log),
    clock: () => CLOCK,
    allowed: () => ({ actions: true, logs: true }),
    ...overrides,
  };
  h.logs = new ContainerLogs({ logger, allowed: () => h.deps.allowed().logs, vmHost: LIMA_HOST, vmState: h.deps.vmState, read: h.readLog as never, timeZone: () => CLOCK.timeZone });
  h.pages = new ReportPages(h.deps);
  return h;
}

const panels = (): FakeWebviewPanel[] => fakeVscode.webviewPanels;

/** A click on the row of `object` of `host`: the view shows it, and VS Code opens its report address in a tab. */
function open(h: Harness, host: string, object: HostObject): Promise<FakeWebviewPanel> {
  h.shown.push({ host, object });
  return openFakeCustomEditor(REPORT_VIEW_TYPE, reportUri({ host, object }));
}
const lastView = (panel: FakeWebviewPanel): ReportPageView => panel.posted.filter((message) => message.type === 'view').at(-1)?.view as ReportPageView;

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
});

describe('the report page', () => {
  it('is the custom editor of the report addresses, and reads the report once when it opens, as a flow of the user', async () => {
    const h = harness();
    expect(fakeVscode.customEditors.get(REPORT_VIEW_TYPE)?.options).toEqual({ supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: false } });
    const panel = await open(h, 'lab', monitor);
    await flush();
    expect(panel.webview.options).toMatchObject({ enableScripts: true, enableCommandUris: false, enableForms: false });
    expect(panel.webview.html).toContain('<h1 id="title">devspaces-monitor</h1>');
    expect(h.reads).toEqual([{ target: { host: 'lab', object: monitor }, flow: true, signal: expect.any(AbortSignal) }]);
    expect(h.vmReads).toBe(0);
    expect(panel.posted.map((message) => (message.view as ReportPageView).status)).toEqual(['Reading…', 'Read today 07:52']);
    expect(lastView(panel).content).toEqual(contentOf('devspaces-monitor', true));
    expect(lastView(panel).buttons.map((button) => button.action)).toEqual(['showLog', 'refresh']);
  });

  it('opens the report address with vscode.open at Show Report, as a click on the row does; another argument opens nothing', async () => {
    const h = harness();
    h.pages.show(row('lab', nginx));
    h.pages.show({ hostsNode: 'host', host: 'lab' });
    h.pages.show(undefined);
    await flush();
    const calls = fakeVscode.commands.executeCommand.mock.calls.map(([command, uri]) => [command, String(uri)]);
    expect(calls).toEqual([['vscode.open', 'devspaces-report:/lab/image/nginx:1.27?id=sha256%3An']]);
    expect(h.reads).toHaveLength(0);
  });

  it('reads nothing in a tab that VS Code opened again at its start, until the view shows the resource and Refresh is clicked', async () => {
    const h = harness();
    const panel = await openFakeCustomEditor(REPORT_VIEW_TYPE, reportUri({ host: 'lab', object: monitor }));
    await flush();
    expect(h.reads).toHaveLength(0);
    expect(lastView(panel)).toMatchObject({ title: 'devspaces-monitor', kind: 'container', kindLine: 'Container · lab', tone: 'normal', status: '' });
    expect(lastView(panel).banner).toEqual({ message: ReportPageTexts.missing, detail: ReportPageTexts.missingDetail, buttons: [] });
    panel.receive({ type: 'refresh' });
    await flush();
    expect(h.reads).toHaveLength(0);
    h.shown.push({ host: 'lab', object: monitor });
    panel.receive({ type: 'refresh' });
    await flush();
    expect(h.reads.map((read) => read.target)).toEqual([{ host: 'lab', object: monitor }]);
    expect(lastView(panel).banner).toBeUndefined();
    expect(lastView(panel)).toMatchObject({ status: 'Read today 07:52', kindLine: expect.stringContaining('Monitor') });
  });

  it('shows the name and the state of the newer row when the page shows again, without a read', async () => {
    const h = harness();
    const panel = await open(h, 'lab', nginx);
    await flush();
    panel.setVisible(false);
    h.shown[0] = { host: 'lab', object: { ...nginx, name: 'nginx:latest', active: true } };
    panel.setVisible(true);
    panel.receive({ type: 'ready' });
    expect(lastView(panel)).toMatchObject({ title: 'nginx:latest', tone: 'notDevspaces', content: contentOf('nginx:1.27') });
    expect(h.reads).toHaveLength(1);
  });

  it('reads at Refresh the resource as the view shows it now, and keeps the last one when the view does not show it', async () => {
    const h = harness();
    const panel = await open(h, 'lab', nginx);
    await flush();
    h.shown.length = 0;
    panel.receive({ type: 'refresh' });
    await flush();
    expect(lastView(panel).banner).toBeUndefined();
    expect(h.reads.map((read) => read.target.object.name)).toEqual(['nginx:1.27', 'nginx:1.27']);
  });

  it('gives an address that is not of a report a short text, without a script and without a read', async () => {
    const h = harness();
    const panel = await openFakeCustomEditor(REPORT_VIEW_TYPE, fakeVscode.Uri.from({ scheme: REPORT_SCHEME, path: '/lab/disk/x' }));
    await flush();
    expect(panel.webview.options).toEqual({ enableScripts: false });
    expect(panel.webview.html).toContain(ReportPageTexts.notAReport);
    expect(panel.webview.html).not.toContain('<script');
    expect(h.reads).toHaveLength(0);
  });

  it('reads each resource in its own page: the result of one page never goes to another', async () => {
    const h = harness();
    const first = deferred<ReportContent>();
    h.read = (target) => (target.object.id === monitor.id ? first.promise : Promise.resolve(contentOf(target.object.name)));
    const monitorPage = await open(h, 'lab', monitor);
    const nginxPage = await open(h, 'lab', nginx);
    await flush();
    first.resolve(contentOf('devspaces-monitor'));
    await flush();
    expect(lastView(monitorPage)).toMatchObject({ title: 'devspaces-monitor', content: contentOf('devspaces-monitor') });
    expect(lastView(nginxPage)).toMatchObject({ title: 'nginx:1.27', content: contentOf('nginx:1.27') });
  });

  it('reads again at Refresh, but not while a read runs', async () => {
    const h = harness();
    const slow = deferred<ReportContent>();
    const panel = await open(h, 'lab', nginx);
    await flush();
    h.read = () => slow.promise;
    panel.receive({ type: 'refresh' });
    await flush();
    expect(lastView(panel)).toMatchObject({ busy: true, content: contentOf('nginx:1.27') });
    panel.receive({ type: 'refresh' });
    await flush();
    expect(h.reads).toHaveLength(2);
    slow.resolve(contentOf('new'));
    await flush();
    expect(lastView(panel)).toMatchObject({ busy: false, content: contentOf('new') });
  });

  it('sends nothing to a hidden page and reads nothing when it shows again: it sends the view when the page asks', async () => {
    const h = harness();
    const slow = deferred<ReportContent>();
    h.read = () => slow.promise;
    const panel = await open(h, 'lab', nginx);
    await flush();
    panel.setVisible(false);
    const posted = panel.posted.length;
    slow.resolve(contentOf('nginx:1.27'));
    await flush();
    expect(panel.posted).toHaveLength(posted);
    panel.setVisible(true);
    panel.receive({ type: 'ready' });
    expect(lastView(panel)).toMatchObject({ status: 'Read today 07:52', content: contentOf('nginx:1.27') });
    expect(h.reads).toHaveLength(1);
  });

  it('says why a read failed, with the first line of the error, and logs it', async () => {
    const h = harness();
    h.read = () => Promise.reject(new CommandError('ssh lab', 255, '', 'ssh: connect to host lab port 22: Connection refused\nmore'));
    await open(h, 'lab', nginx);
    await flush();
    const view = lastView(panels()[0]);
    expect(view.banner?.message).toBe(ReportPageTexts.failed);
    expect(view.banner?.detail).not.toContain('\n');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('The report of image nginx:1.27 on lab could not be read'));
  });

  it('ignores a message of the page that is not valid, and logs it', async () => {
    const h = harness();
    await open(h, 'lab', nginx);
    await flush();
    panels()[0].receive({ type: 'removeAll' });
    expect(logger.warn).toHaveBeenCalledWith('The report page sent a message that is not valid. It is ignored.');
    expect(h.reads).toHaveLength(1);
  });

  it('ends a password question of its read when it closes, and keeps nothing of the read', async () => {
    const h = harness();
    const slow = deferred<ReportContent>();
    h.read = () => slow.promise;
    const panel = await open(h, 'lab', nginx);
    await flush();
    const signal = h.reads[0].signal;
    panel.dispose();
    expect(signal?.aborted).toBe(true);
    const posted = panel.posted.length;
    slow.resolve(contentOf('late'));
    await flush();
    expect(panel.posted).toHaveLength(posted);
  });
});

describe('the report page on the VM of Devspaces', () => {
  it('reads the state of the VM first and reads nothing while it is stopped: Start the VM starts it, then the page reads', async () => {
    const h = harness();
    h.vmState = { kind: 'stopped' };
    const panel = await open(h, LIMA_HOST, monitor);
    await flush();
    expect(h.vmReads).toBe(1);
    expect(h.reads).toHaveLength(0);
    expect(lastView(panel).banner?.buttons).toEqual([{ action: 'startVm', label: 'Start the VM', primary: true }]);
    expect(lastView(panel).kindLine).toContain(`Local VM of Devspaces (${LIMA_HOST})`);
    panel.receive({ type: 'startVm' });
    await flush();
    expect(h.startVm).toHaveBeenCalledTimes(1);
    expect(h.reads).toHaveLength(1);
    expect(lastView(panel)).toMatchObject({ status: 'Read today 07:52' });
    expect(lastView(panel).banner).toBeUndefined();
  });

  it('reads again when the VM changed while the page waits for it, and only then', async () => {
    const h = harness();
    h.vmState = { kind: 'stopped' };
    await open(h, LIMA_HOST, monitor);
    await flush();
    h.vmState = { kind: 'running' };
    h.pages.vmChanged();
    await flush();
    expect(h.reads).toHaveLength(1);
    h.pages.vmChanged();
    await flush();
    expect(h.reads).toHaveLength(1);
    expect(h.vmReads).toBe(2);
  });

  // The setting devspaces.dockerHostsActions (R-ENG-008): while the view is read only, the page offers no Start the VM,
  // and a message of an old page that asks for it starts nothing.
  it('offers no Start the VM while the view is read only, starts nothing for an old message, and shows it again after the change', async () => {
    let allowed = { actions: false, logs: false };
    const h = harness({ allowed: () => allowed });
    h.vmState = { kind: 'stopped' };
    const panel = await open(h, LIMA_HOST, monitor);
    await flush();
    expect(lastView(panel).banner).toEqual({ message: ReportPageTexts.vmNotRunning, detail: ReportPageTexts.vmNotRunningReadOnly, buttons: [] });
    panel.receive({ type: 'startVm' });
    await flush();
    expect(h.startVm).not.toHaveBeenCalled();
    allowed = { actions: true, logs: false };
    h.pages.settingsChanged();
    expect(lastView(panel).banner?.buttons).toEqual([{ action: 'startVm', label: 'Start the VM', primary: true }]);
    expect(h.reads).toHaveLength(0);
  });

  it('never reads the state of the VM for another host', async () => {
    const h = harness();
    await open(h, 'lab', monitor);
    h.pages.vmChanged();
    await flush();
    expect(h.vmReads).toBe(0);
  });
});

describe('Show Log of the Monitor', () => {
  it('opens the last lines of the log as a read-only document, read as a flow of the user', async () => {
    const h = harness();
    let flow = false;
    h.readLog.mockImplementation(async () => {
      flow = sshPromptsAllowed();
      return '2026-11-12 07:00:00.000 2026-11-12 07:00:00.000 run started';
    });
    const panel = await open(h, 'lab', monitor);
    await flush();
    expect(lastView(panel).buttons[0]).toEqual({ action: 'showLog', label: ReportPageTexts.showMonitorLog });
    panel.receive({ type: 'showLog' });
    await flush();
    expect(h.readLog).toHaveBeenCalledWith('lab', 'devspaces-monitor', 'Europe/Vienna');
    expect(flow).toBe(true);
    const [document] = fakeVscode.window.showTextDocument.mock.calls[0] as [{ uri: { scheme: string; path: string }; languageId: string; getText(): string }, unknown];
    expect(document.uri).toMatchObject({ scheme: CONTAINER_LOG_SCHEME, path: '/lab/devspaces-monitor.log' });
    expect(document.languageId).toBe('log');
    expect(document.getText()).toBe('2026-11-12 07:00:00.000 2026-11-12 07:00:00.000 run started\n');
    expect(fakeVscode.window.showTextDocument.mock.calls[0][1]).toEqual({ preview: false });
  });

  it('says that the Monitor wrote nothing yet, and registers its documents only once', async () => {
    const h = harness();
    h.readLog.mockResolvedValue('  \n');
    await open(h, 'lab', monitor);
    await flush();
    panels()[0].receive({ type: 'showLog' });
    await flush();
    panels()[0].receive({ type: 'showLog' });
    await flush();
    expect(fakeVscode.workspace.registerTextDocumentContentProvider).toHaveBeenCalledTimes(1);
    const [document] = fakeVscode.window.showTextDocument.mock.calls[1] as [{ getText(): string }];
    expect(document.getText()).toBe(ContainerLogTexts.empty(monitorLogOf('lab')));
    h.logs.dispose();
    expect(fakeVscode.contentProviders.size).toBe(0);
  });

  it('says why the log could not be read, and opens no document', async () => {
    const h = harness();
    h.readLog.mockRejectedValue(new CommandError('docker logs devspaces-monitor', 1, '', 'Error response from daemon: No such container: devspaces-monitor'));
    await open(h, 'lab', monitor);
    await flush();
    panels()[0].receive({ type: 'showLog' });
    await flush();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/^The log of the Monitor could not be read: /));
    expect(fakeVscode.window.showTextDocument).not.toHaveBeenCalled();
    expect(fakeVscode.workspace.registerTextDocumentContentProvider).not.toHaveBeenCalled();
  });
});

describe('Show Log of any other container', () => {
  it('shows Show Log on the report of a container whose report offers it, and reads its log by its full ID', async () => {
    const h = harness();
    const panel = await open(h, 'lab', web);
    await flush();
    expect(lastView(panel).buttons.map((button) => [button.action, button.label])).toEqual([
      ['showLog', ReportPageTexts.showLog],
      ['refresh', ReportPageTexts.refresh],
    ]);
    panel.receive({ type: 'showLog' });
    await flush();
    expect(h.readLog).toHaveBeenCalledWith('lab', WEB_ID, 'Europe/Vienna');
    const [document] = fakeVscode.window.showTextDocument.mock.calls[0] as [{ uri: { scheme: string; path: string } }];
    expect(document.uri).toMatchObject({ scheme: CONTAINER_LOG_SCHEME, path: '/lab/shop-web-1.log' });
  });

  it('shows no Show Log on a report that offers no log (an image, or a container whose log driver is none)', async () => {
    const h = harness();
    h.read = async (target) => contentOf(target.object.name);
    const image = await open(h, 'lab', nginx);
    const container = await open(h, 'lab', web);
    await flush();
    expect(lastView(image).buttons.map((button) => button.action)).toEqual(['refresh']);
    expect(lastView(container).buttons.map((button) => button.action)).toEqual(['refresh']);
    // An old message of the page reads nothing.
    container.receive({ type: 'showLog' });
    await flush();
    expect(h.readLog).not.toHaveBeenCalled();
  });
});

describe('the setting devspaces.allowContainerLogs', () => {
  it('shows no Show Log while the logs are off, reads no log for an old message, and shows the button after the change', async () => {
    let allowed = { actions: true, logs: false };
    const h = harness({ allowed: () => allowed });
    const panel = await open(h, 'lab', monitor);
    await flush();
    expect(lastView(panel).buttons.map((button) => button.action)).toEqual(['refresh']);
    panel.receive({ type: 'showLog' });
    await flush();
    expect(h.readLog).not.toHaveBeenCalled();
    expect(fakeVscode.window.showTextDocument).not.toHaveBeenCalled();
    allowed = { actions: true, logs: true };
    h.pages.settingsChanged();
    expect(lastView(panel).buttons.map((button) => button.action)).toEqual(['showLog', 'refresh']);
    // The change sends the view again without a new read.
    expect(h.reads).toHaveLength(1);
  });
});

describe('the end of the report pages', () => {
  it('closes all pages and ends the custom editor', async () => {
    const h = harness();
    await open(h, 'lab', monitor);
    await open(h, 'lab', nginx);
    await flush();
    h.pages.dispose();
    expect(panels().map((panel) => panel.disposed)).toEqual([true, true]);
    expect(fakeVscode.customEditors.size).toBe(0);
  });
});
