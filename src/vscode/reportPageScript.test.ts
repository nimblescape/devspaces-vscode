// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The script of the report page (resources/reportPage/page.js) in a small stand-in of the DOM (R-ENG-010): it asks for
// the view at the start, shows the view of reportPageView as text only, sends only the actions of its buttons, keeps
// its content while text is selected, and builds a part again only when it changed (a Refresh keeps the scroll).
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, expect, it } from 'vitest';
import { LIMA_HOST } from '../core/docker/dockerHost';
import type { HostObject } from '../core/hosts/hostObjects';
import type { ReportClock, ReportContent } from '../core/hosts/reportModel';
import { reportPageView, type ReportPageView } from './reportPageModel';

type Listener = (event?: unknown) => void;

class StubElement {
  hidden = false;
  disabled = false;
  textContent = '';
  className = '';
  children: StubElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly classList = { toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)) };
  private readonly listeners = new Map<string, Listener[]>();
  /** How often its children were replaced. */
  replaced = 0;
  constructor(readonly tag = '') {}
  /** The script must never set HTML. */
  set innerHTML(_value: string) {
    throw new Error('innerHTML must not be set');
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  replaceChildren(...children: StubElement[]): void {
    this.children = children;
    this.replaced++;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  appendChild(child: StubElement): void {
    this.children.push(child);
  }
  text(): string {
    return [this.textContent, ...this.children.map((child) => child.text())].join('');
  }
  all(tag: string): StubElement[] {
    return this.children.flatMap((child) => [...(child.tag === tag ? [child] : []), ...child.all(tag)]);
  }
}

function loadScript() {
  const elements = new Map<string, StubElement>();
  const document = Object.assign(new StubElement('document'), {
    title: '',
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, new StubElement(id));
      return elements.get(id);
    },
    createElement: (tag: string) => new StubElement(tag),
    createTextNode: (text: string) => Object.assign(new StubElement('#text'), { textContent: text }),
  });
  const selection = { isCollapsed: true };
  const window = Object.assign(new StubElement('window'), { getSelection: () => selection });
  const posted: Array<Record<string, unknown>> = [];
  const context = vm.createContext({ document, window, acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posted.push(message) }) });
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'reportPage', 'page.js'), 'utf8');
  vm.runInContext(source, context);
  const byId = (id: string): StubElement => document.getElementById(id) as StubElement;
  const show = (view: unknown) => window.dispatch('message', { data: { type: 'view', view } });
  return { document, posted, byId, show, selection };
}

const CLOCK: ReportClock = { now: Date.UTC(2026, 10, 12, 6, 52), timeZone: 'Europe/Vienna' };
const monitor: HostObject = { kind: 'container', id: 'm1', name: 'devspaces-monitor', purpose: 'monitor', state: 'running', active: true };
const content: ReportContent = {
  summary: [{ text: '7 runs', tone: 'info' }, { text: '2 removed', tone: 'remove' }],
  notices: ['The reader reached its limit of time or of entries: some sizes and lists are incomplete.'],
  monitorLog: true,
  sections: [
    { title: 'Last runs', chip: { text: 'kept 7', tone: 'keep' }, body: { kind: 'table', columns: ['Started', 'Result'], rows: [[{ text: 'today 07:00' }, { text: 'done', chip: { text: 'ok', tone: 'keep' } }]], more: '3 more runs' }, from: 'From the record runs.json of the Monitor.' },
    { title: 'Monitor', body: { kind: 'facts', facts: [{ label: 'Image', value: { text: '<b>devspaces-monitor</b>' } }] }, from: '' },
    { title: 'Empty', body: { kind: 'table', columns: ['A'], rows: [], empty: 'No runs yet.' }, from: '' },
  ],
};
const view = (overrides: Partial<Parameters<typeof reportPageView>[0]> = {}): ReportPageView =>
  reportPageView({ target: { host: LIMA_HOST, object: monitor }, vm: true, phase: { kind: 'read', at: CLOCK.now }, content, clock: CLOCK, allowed: { actions: true, logs: true }, ...overrides });

describe('the script of the report page', () => {
  it('asks for the view at the start', () => {
    const page = loadScript();
    expect(page.posted).toEqual([{ type: 'ready' }]);
  });

  it('shows the header, the summary, the notes and the sections as text', () => {
    const page = loadScript();
    page.show(view());
    expect(page.document.title).toBe('devspaces-monitor');
    expect(page.byId('title').textContent).toBe('devspaces-monitor');
    expect(page.byId('kind').textContent).toContain('Container · Monitor · Running');
    expect(page.byId('status').textContent).toBe('Read today 07:52');
    expect(page.byId('buttons').all('button').map((button) => button.textContent)).toEqual(['Show Log of the Monitor', 'Refresh']);
    expect(page.byId('summary').text()).toBe('7 runs2 removed');
    expect(page.byId('notices').hidden).toBe(false);
    expect(page.byId('notices').all('li').map((item) => item.textContent)).toEqual(content.notices);
    expect(page.byId('banner').hidden).toBe(true);
    const sections = page.byId('sections');
    expect(sections.all('h2').map((heading) => heading.text())).toEqual(['Last runskept 7', 'Monitor', 'Empty']);
    expect(sections.all('th').map((cell) => cell.textContent)).toEqual(['Started', 'Result']);
    expect(sections.all('td').map((cell) => cell.text())).toEqual(['today 07:00', 'doneok', '3 more runs']);
    expect(sections.all('dd')[0].text()).toBe('<b>devspaces-monitor</b>');
    expect(sections.text()).toContain('No runs yet.');
    expect(sections.text()).toContain('From the record runs.json of the Monitor.');
    expect(sections.all('span').map((chip) => chip.className)).toEqual(['chip tone-keep', 'chip tone-keep']);
  });

  it('sends only the actions of its buttons', () => {
    const page = loadScript();
    page.show(view());
    for (const button of page.byId('buttons').all('button')) button.dispatch('click');
    expect(page.posted.slice(1)).toEqual([{ type: 'showLog' }, { type: 'refresh' }]);
    page.show({ ...view(), buttons: [{ action: 'removeAll', label: 'Remove All' }] });
    expect(page.byId('buttons').all('button')).toEqual([]);
  });

  it('shows the note of a stopped VM with its button Start the VM', () => {
    const page = loadScript();
    page.show(view({ phase: { kind: 'vm', state: { kind: 'stopped' } }, content: undefined }));
    expect(page.byId('banner').hidden).toBe(false);
    expect(page.byId('banner-message').textContent).toBe('The VM of Devspaces does not run.');
    expect(page.byId('banner-detail').hidden).toBe(false);
    const start = page.byId('banner-buttons').all('button');
    expect(start.map((button) => button.textContent)).toEqual(['Start the VM']);
    start[0].dispatch('click');
    expect(page.posted.at(-1)).toEqual({ type: 'startVm' });
    expect(page.byId('sections').children).toEqual([]);
    expect(page.byId('notices').hidden).toBe(true);
  });

  it('dims the content while a Refresh reads, and builds no part again that did not change', () => {
    const page = loadScript();
    page.show(view());
    const sections = page.byId('sections');
    const built = sections.replaced;
    page.show(view({ phase: { kind: 'reading' } }));
    expect(sections.classes.has('stale')).toBe(true);
    expect(sections.replaced).toBe(built);
    expect(page.byId('buttons').all('button').at(-1)?.attributes.has('disabled')).toBe(true);
    page.show(view());
    expect(sections.classes.has('stale')).toBe(false);
    expect(sections.replaced).toBe(built);
  });

  it('keeps its content while text is selected, and shows the newest view when the selection ends', () => {
    const page = loadScript();
    page.show(view());
    page.selection.isCollapsed = false;
    page.show(view({ phase: { kind: 'failed', message: 'ssh: Connection refused' } }));
    expect(page.byId('banner').hidden).toBe(true);
    page.selection.isCollapsed = true;
    page.document.dispatch('selectionchange');
    expect(page.byId('banner').hidden).toBe(false);
    expect(page.byId('banner-detail').textContent).toBe('ssh: Connection refused');
  });

  it('ignores messages that are not a view', () => {
    const page = loadScript();
    page.show(undefined);
    page.document.dispatch('message');
    expect(page.byId('title').textContent).toBe('');
  });
});
