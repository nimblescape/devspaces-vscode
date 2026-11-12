// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The report page of a resource of the view Docker Hosts (R-ENG-010): one page follows the clicks, Keep Open keeps a
// page with its resource; the page reads when it opens, when it follows a click, and at Refresh, always as a flow of the
// user (a login may ask), never while it is hidden; on the VM of Devspaces it reads the state first and never starts the
// VM; a result of an older read is dropped; Show Log of the Monitor opens the log as a read-only document.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { LIMA_HOST } from '../core/docker/dockerHost';
import { CommandError } from '../core/errors';
import type { HostObject } from '../core/hosts/hostObjects';
import type { ReportClock, ReportContent } from '../core/hosts/reportModel';
import { sshPromptsAllowed, sshPromptSignal } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import { fakeVscode, resetFakeVscode, type FakeWebviewPanel } from './testing/fakeVscode';
import { MONITOR_LOG_SCHEME, ReportPages, type ReportPagesDeps } from './reportPage';
import { ReportPageTexts, type ReportPageView, type ReportTarget } from './reportPageModel';

const CLOCK: ReportClock = { now: Date.UTC(2026, 10, 12, 6, 52), timeZone: 'Europe/Vienna' };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
const monitor: HostObject = { kind: 'container', id: 'm1', name: 'devspaces-monitor', purpose: 'monitor', state: 'running', active: true };
const volume: HostObject = { kind: 'volume', id: 'devspaces-vscode', name: 'devspaces-vscode', purpose: 'sharedVolume' };
const nginx: HostObject = { kind: 'image', id: 'sha256:n', name: 'nginx:1.27', purpose: 'notDevspaces' };
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
  deps: ReportPagesDeps;
  reads: Array<{ target: ReportTarget; flow: boolean; signal: AbortSignal | undefined }>;
  vmReads: number;
  vmState: VmState;
  startVm: ReturnType<typeof vi.fn>;
  readMonitorLog: ReturnType<typeof vi.fn>;
  read: (target: ReportTarget) => Promise<ReportContent>;
}

function harness(overrides: Partial<ReportPagesDeps> = {}): Harness {
  const h = { reads: [], vmReads: 0, vmState: { kind: 'running' } } as unknown as Harness;
  h.read = async (target) => contentOf(target.object.name, target.object.purpose === 'monitor');
  h.startVm = vi.fn(async () => {
    h.vmState = { kind: 'running' };
  });
  h.readMonitorLog = vi.fn(async () => '2026-11-12T06:00:00.000000000Z run started');
  h.deps = {
    extensionUri: fakeVscode.Uri.file('/extension') as never,
    logger,
    vmHost: LIMA_HOST,
    vmState: async () => {
      h.vmReads++;
      return h.vmState;
    },
    startVm: h.startVm as never,
    read: (target) => {
      h.reads.push({ target, flow: sshPromptsAllowed(), signal: sshPromptSignal() });
      return h.read(target);
    },
    readMonitorLog: h.readMonitorLog as never,
    clock: () => CLOCK,
    ...overrides,
  };
  h.pages = new ReportPages(h.deps);
  return h;
}

const panels = (): FakeWebviewPanel[] => fakeVscode.webviewPanels;
const lastView = (panel: FakeWebviewPanel): ReportPageView => panel.posted.filter((message) => message.type === 'view').at(-1)?.view as ReportPageView;

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
});

describe('the report page', () => {
  it('opens in the active group without the focus, and reads the report once, as a flow of the user', async () => {
    const h = harness();
    h.pages.show(row('lab', monitor));
    await flush();
    expect(panels()).toHaveLength(1);
    const panel = panels()[0];
    expect(panel).toMatchObject({ viewType: 'devspaces.resourceReport', title: 'devspaces-monitor', column: { viewColumn: fakeVscode.ViewColumn.Active, preserveFocus: true } });
    expect(panel.options).toMatchObject({ enableScripts: true, enableCommandUris: false, retainContextWhenHidden: false });
    expect(panel.webview.html).toContain('<h1 id="title">devspaces-monitor</h1>');
    expect(h.reads).toEqual([{ target: { host: 'lab', object: monitor }, flow: true, signal: expect.any(AbortSignal) }]);
    expect(h.vmReads).toBe(0);
    expect(panel.posted.map((message) => (message.view as ReportPageView).status)).toEqual(['Reading…', 'Read today 07:52']);
    expect(lastView(panel).content).toEqual(contentOf('devspaces-monitor', true));
  });

  it('ignores an argument that is not an object row', async () => {
    const h = harness();
    h.pages.show({ hostsNode: 'host', host: 'lab' });
    h.pages.show(undefined);
    await flush();
    expect(panels()).toHaveLength(0);
    expect(h.reads).toHaveLength(0);
  });

  it('follows the clicks in one page; the same resource again is only shown', async () => {
    const h = harness();
    h.pages.show(row('lab', monitor));
    await flush();
    const panel = panels()[0];
    h.pages.show(row('lab', nginx));
    await flush();
    expect(panels()).toHaveLength(1);
    expect(panel.title).toBe('nginx:1.27');
    expect(lastView(panel)).toMatchObject({ title: 'nginx:1.27', content: contentOf('nginx:1.27') });
    expect(h.reads.map((read) => read.target.object.name)).toEqual(['devspaces-monitor', 'nginx:1.27']);
    panel.setVisible(false);
    h.pages.show(row('lab', { ...nginx, name: 'nginx:latest', active: true }));
    await flush();
    expect(h.reads).toHaveLength(2);
    expect(panel.visible).toBe(true);
    expect(panel.reveal).toHaveBeenLastCalledWith(undefined, true);
    // The name and the color of the newer row, without a read.
    expect(panel.title).toBe('nginx:latest');
    expect(lastView(panel)).toMatchObject({ title: 'nginx:latest', tone: 'notDevspaces', content: contentOf('nginx:1.27') });
  });

  it('drops the result of the read of the resource before', async () => {
    const h = harness();
    const first = deferred<ReportContent>();
    h.read = (target) => (target.object.id === monitor.id ? first.promise : Promise.resolve(contentOf(target.object.name)));
    h.pages.show(row('lab', monitor));
    await flush();
    h.pages.show(row('lab', nginx));
    await flush();
    first.resolve(contentOf('devspaces-monitor'));
    await flush();
    expect(lastView(panels()[0])).toMatchObject({ title: 'nginx:1.27', content: contentOf('nginx:1.27') });
  });

  it('keeps a page with its resource after Keep Open: the next click opens a new page, a click on the kept resource shows it', async () => {
    const h = harness();
    h.pages.show(row('lab', monitor));
    await flush();
    const kept = panels()[0];
    kept.receive({ type: 'keepOpen' });
    expect(lastView(kept).buttons.map((button) => button.action)).toEqual(['showLog', 'refresh']);
    h.pages.show(row('lab', nginx));
    await flush();
    expect(panels()).toHaveLength(2);
    const follow = panels()[1];
    expect(kept.title).toBe('devspaces-monitor');
    h.pages.show(row('lab', volume));
    await flush();
    expect(panels()).toHaveLength(2);
    expect(follow.title).toBe('devspaces-vscode');
    kept.setVisible(false);
    h.pages.show(row('lab', monitor));
    await flush();
    expect(kept.visible).toBe(true);
    expect(follow.title).toBe('devspaces-vscode');
    expect(h.reads.map((read) => read.target.object.name)).toEqual(['devspaces-monitor', 'nginx:1.27', 'devspaces-vscode']);
  });

  it('opens a new page after the page that follows the clicks was closed', async () => {
    const h = harness();
    h.pages.show(row('lab', monitor));
    await flush();
    panels()[0].dispose();
    h.pages.show(row('lab', nginx));
    await flush();
    expect(panels()).toHaveLength(2);
    expect(panels()[1].title).toBe('nginx:1.27');
  });

  it('reads again at Refresh, but not while a read runs', async () => {
    const h = harness();
    const slow = deferred<ReportContent>();
    h.pages.show(row('lab', nginx));
    await flush();
    const panel = panels()[0];
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
    h.pages.show(row('lab', nginx));
    await flush();
    const panel = panels()[0];
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
    h.pages.show(row('lab', nginx));
    await flush();
    const view = lastView(panels()[0]);
    expect(view.banner?.message).toBe(ReportPageTexts.failed);
    expect(view.banner?.detail).not.toContain('\n');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('The report of image nginx:1.27 on lab could not be read'));
  });

  it('ignores a message of the page that is not valid, and logs it', async () => {
    const h = harness();
    h.pages.show(row('lab', nginx));
    await flush();
    panels()[0].receive({ type: 'removeAll' });
    expect(logger.warn).toHaveBeenCalledWith('The report page sent a message that is not valid. It is ignored.');
    expect(h.reads).toHaveLength(1);
  });

  it('ends a password question of its read when it closes, and keeps nothing of the read', async () => {
    const h = harness();
    const slow = deferred<ReportContent>();
    h.read = () => slow.promise;
    h.pages.show(row('lab', nginx));
    await flush();
    const panel = panels()[0];
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
    h.pages.show(row(LIMA_HOST, monitor));
    await flush();
    const panel = panels()[0];
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
    h.pages.show(row(LIMA_HOST, monitor));
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

  it('never reads the state of the VM for another host', async () => {
    const h = harness();
    h.pages.show(row('lab', monitor));
    h.pages.vmChanged();
    await flush();
    expect(h.vmReads).toBe(0);
  });
});

describe('Show Log of the Monitor', () => {
  it('opens the last lines of the log as a read-only document, read as a flow of the user', async () => {
    const h = harness();
    let flow = false;
    h.readMonitorLog.mockImplementation(async () => {
      flow = sshPromptsAllowed();
      return '2026-11-12 07:00:00.000 2026-11-12 07:00:00.000 run started';
    });
    h.pages.show(row('lab', monitor));
    await flush();
    panels()[0].receive({ type: 'showLog' });
    await flush();
    expect(h.readMonitorLog).toHaveBeenCalledWith('lab', 'Europe/Vienna');
    expect(flow).toBe(true);
    const [document] = fakeVscode.window.showTextDocument.mock.calls[0] as [{ uri: { scheme: string; path: string }; languageId: string; getText(): string }, unknown];
    expect(document.uri).toMatchObject({ scheme: MONITOR_LOG_SCHEME, path: '/lab/devspaces-monitor.log' });
    expect(document.languageId).toBe('log');
    expect(document.getText()).toBe('2026-11-12 07:00:00.000 2026-11-12 07:00:00.000 run started\n');
    expect(fakeVscode.window.showTextDocument.mock.calls[0][1]).toEqual({ preview: false });
  });

  it('says that the Monitor wrote nothing yet, and registers its documents only once', async () => {
    const h = harness();
    h.readMonitorLog.mockResolvedValue('  \n');
    h.pages.show(row('lab', monitor));
    await flush();
    panels()[0].receive({ type: 'showLog' });
    await flush();
    panels()[0].receive({ type: 'showLog' });
    await flush();
    expect(fakeVscode.workspace.registerTextDocumentContentProvider).toHaveBeenCalledTimes(1);
    const [document] = fakeVscode.window.showTextDocument.mock.calls[1] as [{ getText(): string }];
    expect(document.getText()).toBe(ReportPageTexts.logEmpty);
    h.pages.dispose();
    expect(fakeVscode.contentProviders.size).toBe(0);
  });

  it('says why the log could not be read, and opens no document', async () => {
    const h = harness();
    h.readMonitorLog.mockRejectedValue(new CommandError('docker logs devspaces-monitor', 1, '', 'Error response from daemon: No such container: devspaces-monitor'));
    h.pages.show(row('lab', monitor));
    await flush();
    panels()[0].receive({ type: 'showLog' });
    await flush();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/^The log of the Monitor could not be read: /));
    expect(fakeVscode.window.showTextDocument).not.toHaveBeenCalled();
    expect(fakeVscode.workspace.registerTextDocumentContentProvider).not.toHaveBeenCalled();
  });
});

describe('the end of the report pages', () => {
  it('closes all pages', async () => {
    const h = harness();
    h.pages.show(row('lab', monitor));
    await flush();
    panels()[0].receive({ type: 'keepOpen' });
    h.pages.show(row('lab', nginx));
    await flush();
    h.pages.dispose();
    expect(panels().map((panel) => panel.disposed)).toEqual([true, true]);
  });
});
