// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// What the report page of a resource of the view Docker Hosts shows (docs/requirements.md R-ENG-010): the resource of a
// click on a row, the address of its report (one address per resource, read back exactly), the header with its buttons and the state of the read, the notes of a failed read and of a VM that
// does not run (Start the VM only for a stopped VM) and of a resource that the view does not show, the HTML of the webview, and the check of its messages.
import { describe, expect, it } from 'vitest';
import { LIMA_HOST } from '../core/docker/dockerHost';
import type { HostObject } from '../core/hosts/hostObjects';
import type { ReportClock, ReportContent } from '../core/hosts/reportModel';
import { ReportPageTexts, parseReportRequest, reportAddress, reportKeyOf, reportPageHtml, reportPageView, reportTargetOfArgument, type ReportTarget } from './reportPageModel';

const CLOCK: ReportClock = { now: Date.UTC(2026, 10, 12, 6, 52), timeZone: 'Europe/Vienna' };
const monitor: HostObject = { kind: 'container', id: 'm1', name: 'devspaces-monitor', purpose: 'monitor', state: 'running', active: true };
const target: ReportTarget = { host: LIMA_HOST, object: monitor };
const content: ReportContent = { summary: [{ text: '3 runs', tone: 'info' }], sections: [], notices: [], monitorLog: true };

describe('reportTargetOfArgument', () => {
  it('takes the host and the object of an object row of the view Docker Hosts', () => {
    expect(reportTargetOfArgument({ hostsNode: 'object', host: LIMA_HOST, object: monitor, devspaceId: 'x' })).toEqual({ host: LIMA_HOST, object: monitor });
  });

  it('takes nothing else: another row, no host, an object that is not complete, or no object at all', () => {
    for (const argument of [
      undefined,
      null,
      'devspaces-monitor',
      { hostsNode: 'host', host: LIMA_HOST },
      { hostsNode: 'object', host: '', object: monitor },
      { hostsNode: 'object', host: LIMA_HOST },
      { hostsNode: 'object', host: LIMA_HOST, object: { ...monitor, kind: 'plugin' } },
      { hostsNode: 'object', host: LIMA_HOST, object: { ...monitor, id: '' } },
      { hostsNode: 'object', host: LIMA_HOST, object: { kind: 'volume', id: 'v' } },
    ]) {
      expect(reportTargetOfArgument(argument)).toBeUndefined();
    }
  });
});

describe('reportAddress and reportKeyOf', () => {
  const image: HostObject = { kind: 'image', id: 'sha256:abc', name: 'ghcr.io/majikmate/devcontainer-base:2.0.35', purpose: 'baseImage' };

  it('gives the path /<host>/<kind>/<name> and the ID in the query, and reads them back', () => {
    const address = reportAddress({ host: LIMA_HOST, object: image });
    expect(address).toEqual({ path: `/${LIMA_HOST}/image/ghcr.io/majikmate/devcontainer-base:2.0.35`, query: 'id=sha256%3Aabc' });
    expect(reportKeyOf(address)).toEqual({ host: LIMA_HOST, kind: 'image', id: 'sha256:abc', name: 'ghcr.io/majikmate/devcontainer-base:2.0.35' });
    expect(reportKeyOf(reportAddress(target))).toEqual({ host: LIMA_HOST, kind: 'container', id: 'm1', name: 'devspaces-monitor' });
  });

  it('writes a / and a % in the host so that the host stays one part of the path', () => {
    const address = reportAddress({ host: 'me@box/a%b', object: monitor });
    expect(address.path).toBe('/me@box%2Fa%25b/container/devspaces-monitor');
    expect(reportKeyOf(address)?.host).toBe('me@box/a%b');
  });

  it('gives the same address for the same resource; another ID, host or kind is another address', () => {
    const key = (object: HostObject, host = LIMA_HOST) => JSON.stringify(reportAddress({ host, object }));
    expect(key({ ...monitor, state: 'exited', active: false })).toBe(key(monitor));
    expect(key({ ...monitor, id: 'm2' })).not.toBe(key(monitor));
    expect(key(monitor, 'lab')).not.toBe(key(monitor));
    expect(key({ ...monitor, kind: 'volume' })).not.toBe(key(monitor));
  });

  it('takes no other address: another kind, no ID, an empty host, another spelling, or a query with more', () => {
    const { path, query } = reportAddress(target);
    for (const address of [
      { path: `/${LIMA_HOST}/plugin/devspaces-monitor`, query },
      { path: `/${LIMA_HOST}/container`, query },
      { path: `/${LIMA_HOST}/container/`, query },
      { path: '//container/devspaces-monitor', query },
      { path, query: '' },
      { path, query: 'id=' },
      { path, query: 'id=m1&id=m2' },
      { path, query: 'id=m1&x=1' },
      { path: '/lima%3Adevspaces/container/devspaces-monitor', query },
      { path: '/me@box%2fa/container/devspaces-monitor', query },
      { path: '/me@box%41/container/devspaces-monitor', query },
      { path: 'container/devspaces-monitor', query },
    ]) {
      expect(reportKeyOf(address)).toBeUndefined();
    }
  });
});

describe('reportPageView', () => {
  it('shows the name, the kind line with the VM of Devspaces, the time of the read, and the buttons', () => {
    const view = reportPageView({ target, vm: true, phase: { kind: 'read', at: CLOCK.now }, content, clock: CLOCK });
    expect(view).toMatchObject({ title: 'devspaces-monitor', kind: 'container', kindLine: `Container · Monitor · Running · Local VM of Devspaces (${LIMA_HOST})`, tone: 'normal', status: 'Read today 07:52', busy: false, content });
    expect(view.buttons).toEqual([
      { action: 'showLog', label: 'Show Log of the Monitor' },
      { action: 'refresh', label: 'Refresh', primary: true },
    ]);
    expect(view.banner).toBeUndefined();
  });

  it('keeps the content while a Refresh reads, with Refresh disabled; Show Log only for the Monitor', () => {
    const view = reportPageView({ target, vm: false, phase: { kind: 'reading' }, content: { ...content, monitorLog: false }, clock: CLOCK });
    expect(view).toMatchObject({ status: 'Reading…', busy: true, kindLine: `Container · Monitor · Running · ${LIMA_HOST}` });
    expect(view.content).toBeDefined();
    expect(view.buttons).toEqual([{ action: 'refresh', label: 'Refresh', primary: true, disabled: true }]);
    expect(reportPageView({ target, vm: false, phase: { kind: 'reading' }, clock: CLOCK }).content).toBeUndefined();
  });

  it('colors the name as the view Docker Hosts does', () => {
    const image: HostObject = { kind: 'image', id: 'sha256:n', name: 'nginx:1.27', purpose: 'notDevspaces' };
    expect(reportPageView({ target: { host: 'lab', object: image }, vm: false, phase: { kind: 'reading' }, clock: CLOCK }).tone).toBe('notDevspacesInactive');
    expect(reportPageView({ target: { host: 'lab', object: { ...monitor, active: false, state: 'exited' } }, vm: false, phase: { kind: 'reading' }, clock: CLOCK })).toMatchObject({
      tone: 'inactive',
      kindLine: 'Container · Monitor · Stopped · lab',
    });
  });

  it('says why a read failed, and keeps the content of the read before', () => {
    const view = reportPageView({ target, vm: false, phase: { kind: 'failed', message: 'ssh: connect to host lab port 22: Connection refused' }, content, clock: CLOCK });
    expect(view.banner).toEqual({ message: ReportPageTexts.failed, detail: 'ssh: connect to host lab port 22: Connection refused', buttons: [] });
    expect(view.status).toBe('');
    expect(view.content).toBe(content);
  });

  it('shows a resource that the view does not show by its address: its name, its kind and its host, and why it reads nothing', () => {
    const view = reportPageView({ target: { host: LIMA_HOST, kind: 'image', id: 'sha256:abc', name: 'nginx:1.27' }, vm: true, phase: { kind: 'missing' }, clock: CLOCK });
    expect(view).toMatchObject({ title: 'nginx:1.27', kind: 'image', kindLine: `Image · Local VM of Devspaces (${LIMA_HOST})`, tone: 'normal', status: '', busy: false });
    expect(view.banner).toEqual({ message: ReportPageTexts.missing, detail: ReportPageTexts.missingDetail, buttons: [] });
    expect(view.buttons).toEqual([{ action: 'refresh', label: 'Refresh', primary: true }]);
  });

  it('reads nothing on a VM that does not run: Start the VM only for a stopped VM', () => {
    const banner = (state: Parameters<typeof reportPageView>[0]['phase'] & { kind: 'vm' }) => reportPageView({ target, vm: true, phase: state, clock: CLOCK }).banner;
    expect(banner({ kind: 'vm', state: { kind: 'stopped' } })).toEqual({
      message: ReportPageTexts.vmNotRunning,
      detail: ReportPageTexts.vmNotRunningDetail,
      buttons: [{ action: 'startVm', label: 'Start the VM', primary: true }],
    });
    expect(banner({ kind: 'vm', state: { kind: 'notSetUp' } })).toEqual({ message: 'The VM of Devspaces is not set up.', buttons: [] });
    expect(banner({ kind: 'vm', state: { kind: 'unknown', detail: 'limactl is missing' } })).toEqual({ message: 'The state of the VM of Devspaces is not known: limactl is missing', buttons: [] });
  });
});

describe('parseReportRequest', () => {
  it('takes only the messages of the page', () => {
    for (const type of ['ready', 'refresh', 'showLog', 'startVm']) expect(parseReportRequest({ type, extra: 1 })).toEqual({ type });
    for (const raw of [undefined, null, 'refresh', { type: 'run' }, { type: 'keepOpen' }, { type: 3 }, {}]) expect(parseReportRequest(raw)).toBeUndefined();
  });
});

describe('reportPageHtml', () => {
  it('loads only its own script with a nonce and its own style sheet, runs nothing inline, and escapes the name', () => {
    const html = reportPageHtml({ cspSource: 'vscode-webview://x', nonce: 'abc+/=', scriptUri: 'webview:page.js', styleUri: 'webview:page.css', title: 'a<b>&"c' });
    expect(html).toContain(`content="default-src 'none'; style-src vscode-webview://x; script-src 'nonce-abc+/='; img-src 'none'; base-uri 'none'; form-action 'none'"`);
    expect(html).not.toContain('unsafe-inline');
    expect(html).toContain('<script nonce="abc+/=" src="webview:page.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="webview:page.css">');
    expect(html).toContain('<title>a&lt;b&gt;&amp;"c</title>');
    expect(html).toContain('<h1 id="title">a&lt;b&gt;&amp;"c</h1>');
    for (const id of ['kind', 'status', 'buttons', 'summary', 'banner', 'banner-message', 'banner-detail', 'banner-buttons', 'notices', 'sections']) expect(html).toContain(`id="${id}"`);
    expect(html).not.toMatch(/ on[a-z]+=/);
  });
});
