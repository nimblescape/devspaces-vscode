// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// What the report page of a resource of the view Docker Hosts shows (docs/requirements.md R-ENG-010): the resource of a
// click on a row, the header with its buttons and the state of the read, the notes of a failed read and of a VM that
// does not run (Start the VM only for a stopped VM), the HTML of the webview, and the check of its messages.
import { describe, expect, it } from 'vitest';
import { LIMA_HOST } from '../core/docker/dockerHost';
import type { HostObject } from '../core/hosts/hostObjects';
import type { ReportClock, ReportContent } from '../core/hosts/reportModel';
import { ReportPageTexts, parseReportRequest, reportPageHtml, reportPageView, reportTargetOfArgument, sameTarget, type ReportTarget } from './reportPageModel';

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

describe('sameTarget', () => {
  it('compares the host, the kind and the ID; a new name of the same object is the same resource', () => {
    expect(sameTarget(target, { host: LIMA_HOST, object: { ...monitor, name: 'renamed' } })).toBe(true);
    expect(sameTarget(target, { host: 'lab', object: monitor })).toBe(false);
    expect(sameTarget(target, { host: LIMA_HOST, object: { ...monitor, id: 'm2' } })).toBe(false);
    expect(sameTarget(target, { host: LIMA_HOST, object: { ...monitor, kind: 'volume' } })).toBe(false);
  });
});

describe('reportPageView', () => {
  it('shows the name, the kind line with the VM of Devspaces, the time of the read, and the buttons', () => {
    const view = reportPageView({ target, vm: true, phase: { kind: 'read', at: CLOCK.now }, content, kept: false, clock: CLOCK });
    expect(view).toMatchObject({ title: 'devspaces-monitor', kind: 'container', kindLine: `Container · Monitor · Running · Local VM of Devspaces (${LIMA_HOST})`, tone: 'normal', status: 'Read today 07:52', busy: false, content });
    expect(view.buttons).toEqual([
      { action: 'showLog', label: 'Show Log of the Monitor' },
      { action: 'keepOpen', label: 'Keep Open' },
      { action: 'refresh', label: 'Refresh', primary: true },
    ]);
    expect(view.banner).toBeUndefined();
  });

  it('keeps the content while a Refresh reads, with Refresh disabled; a kept page has no Keep Open; Show Log only for the Monitor', () => {
    const view = reportPageView({ target, vm: false, phase: { kind: 'reading' }, content: { ...content, monitorLog: false }, kept: true, clock: CLOCK });
    expect(view).toMatchObject({ status: 'Reading…', busy: true, kindLine: `Container · Monitor · Running · ${LIMA_HOST}` });
    expect(view.content).toBeDefined();
    expect(view.buttons).toEqual([{ action: 'refresh', label: 'Refresh', primary: true, disabled: true }]);
    expect(reportPageView({ target, vm: false, phase: { kind: 'reading' }, kept: false, clock: CLOCK }).content).toBeUndefined();
  });

  it('colors the name as the view Docker Hosts does', () => {
    const image: HostObject = { kind: 'image', id: 'sha256:n', name: 'nginx:1.27', purpose: 'notDevspaces' };
    expect(reportPageView({ target: { host: 'lab', object: image }, vm: false, phase: { kind: 'reading' }, kept: false, clock: CLOCK }).tone).toBe('notDevspacesInactive');
    expect(reportPageView({ target: { host: 'lab', object: { ...monitor, active: false, state: 'exited' } }, vm: false, phase: { kind: 'reading' }, kept: false, clock: CLOCK })).toMatchObject({
      tone: 'inactive',
      kindLine: 'Container · Monitor · Stopped · lab',
    });
  });

  it('says why a read failed, and keeps the content of the read before', () => {
    const view = reportPageView({ target, vm: false, phase: { kind: 'failed', message: 'ssh: connect to host lab port 22: Connection refused' }, content, kept: false, clock: CLOCK });
    expect(view.banner).toEqual({ message: ReportPageTexts.failed, detail: 'ssh: connect to host lab port 22: Connection refused', buttons: [] });
    expect(view.status).toBe('');
    expect(view.content).toBe(content);
  });

  it('reads nothing on a VM that does not run: Start the VM only for a stopped VM', () => {
    const banner = (state: Parameters<typeof reportPageView>[0]['phase'] & { kind: 'vm' }) => reportPageView({ target, vm: true, phase: state, kept: false, clock: CLOCK }).banner;
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
    for (const type of ['ready', 'refresh', 'keepOpen', 'showLog', 'startVm']) expect(parseReportRequest({ type, extra: 1 })).toEqual({ type });
    for (const raw of [undefined, null, 'refresh', { type: 'run' }, { type: 3 }, {}]) expect(parseReportRequest(raw)).toBeUndefined();
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
