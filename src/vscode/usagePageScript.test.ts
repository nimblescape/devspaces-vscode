// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The script of the utilization page (resources/usagePage/page.js) in a small stand-in of the DOM (R-ENG-009): it asks
// for the view at the start, shows the view of usagePageView as text only, sends only the actions of its buttons, and
// sends `activity` at most every 10 s.
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, expect, it } from 'vitest';
import { LIMA_HOST } from '../core/docker/dockerHost';
import type { HostInventory, HostObject } from '../core/hosts/hostObjects';
import type { HostUsage } from '../core/hosts/usageRates';
import { MAX_CONTAINER_ROWS, UsagePageTexts, usagePageView, type UsagePageInput, type UsagePageView } from './usagePageModel';

type Listener = (event?: unknown) => void;

class StubElement {
  hidden = false;
  disabled = false;
  textContent = '';
  className = '';
  readonly style: { width?: string } = {};
  children: StubElement[] = [];
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();
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
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  appendChild(child: StubElement): void {
    this.children.push(child);
  }
  /** The text of the element and of all its children, as a reader sees it. */
  text(): string {
    return [this.textContent, ...this.children.map((child) => child.text())].join('');
  }
  /** All elements below this one with the tag `tag`. */
  all(tag: string): StubElement[] {
    return this.children.flatMap((child) => [...(child.tag === tag ? [child] : []), ...child.all(tag)]);
  }
}

function loadScript() {
  const elements = new Map<string, StubElement>();
  const document = Object.assign(new StubElement('document'), {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, new StubElement(id));
      return elements.get(id);
    },
    createElement: (tag: string) => new StubElement(tag),
    createElementNS: (_namespace: string, tag: string) => new StubElement(tag),
    createTextNode: (text: string) => Object.assign(new StubElement('#text'), { textContent: text }),
  });
  /** The text selection of the page (window.getSelection). */
  const selection = { isCollapsed: true };
  const window = Object.assign(new StubElement('window'), { getSelection: () => selection });
  const posted: Array<Record<string, unknown>> = [];
  const clock = { now: 100_000 };
  const context = vm.createContext({
    document,
    window,
    Date: { now: () => clock.now },
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posted.push(message) }),
  });
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'usagePage', 'page.js'), 'utf8');
  vm.runInContext(source, context);
  const byId = (id: string): StubElement => document.getElementById(id) as StubElement;
  const show = (view: UsagePageView) => window.dispatch('message', { data: { type: 'view', view } });
  return { document, window, posted, clock, byId, show, selection };
}

const GB = 1_000_000_000;
const id = (n: number) => n.toString(16).padStart(64, '0');
const object = (kind: HostObject['kind'], name: string, extra: Partial<HostObject> = {}): HostObject => ({ kind, id: name, name, purpose: 'notDevspaces', ...extra });

function hostUsage(): HostUsage {
  return {
    seq: 2,
    intervalCs: 200,
    cpu: { busy: 37.2, iowait: 2, steal: 0 },
    cpus: [150, 39].map((busy) => ({ busy, iowait: 0, steal: 0 })),
    cpuCount: 2,
    load: [1.62, 1.35, 0.98],
    memory: { totalBytes: 7.8 * GB, usedBytes: 2.3 * GB, availableBytes: 5.5 * GB, cacheBytes: 1.2 * GB, swapTotalBytes: GB, swapUsedBytes: 0 },
    pressure: {},
    oomKills: 0,
    containers: [{ id: id(1), cpuPercent: 12, memoryBytes: 38e6, pids: 11, network: 'none' }],
  };
}

function input(extra: Partial<UsagePageInput> = {}): UsagePageInput {
  return { host: LIMA_HOST, vm: true, wsl: false, intervalMs: 2000, phase: { kind: 'live' }, busy: [], sizesReading: false, ...extra };
}

/** A name that looks like HTML: the page must show it as text. */
const HTML_NAME = '<img src=x onerror=alert(1)>';

function liveView(extra: Partial<UsagePageInput> = {}): UsagePageView {
  const inventory: HostInventory = {
    containers: [object('container', HTML_NAME, { id: id(1), state: 'running', active: true }), object('container', 'shop-db-1', { state: 'exited', sizeBytes: 4e5 })],
    images: [object('image', 'node:22', { sizeBytes: 1.1 * GB, uniqueBytes: GB, usedBy: 0 })],
    volumes: [object('volume', 'cache', { sizeBytes: 1e6, usedBy: 1 })],
    networks: [],
    buildCache: { records: 0, bytes: 0, unusedBytes: 0 },
  };
  return usagePageView(
    input({
      usage: hostUsage(),
      updatedAt: 1_000,
      busy: [null, 20, 30, null, 40, 50, null, 60],
      names: new Map([[id(1), HTML_NAME]]),
      sizes: { inventory, at: 2_000 },
      ...extra,
    }),
  );
}

describe('page.js', () => {
  it('asks for the view at the start, and ignores messages that are not a view', () => {
    const page = loadScript();
    expect(page.posted).toEqual([{ type: 'ready' }]);
    page.window.dispatch('message', { data: { type: 'other', view: liveView() } });
    page.window.dispatch('message', { data: { type: 'view' } });
    page.window.dispatch('message', { data: null });
    expect(page.byId('title').textContent).toBe('');
    expect(page.byId('cards').children).toEqual([]);
  });

  it('shows the view as text: the header, the cards, the containers, the stopped containers and the tables', () => {
    const page = loadScript();
    const view = liveView();
    page.show(view);
    expect(page.byId('title').textContent).toBe(view.title);
    expect(page.byId('status').className).toBe('status live');
    expect(page.byId('status-text').textContent).toBe(view.status.text);
    expect(page.byId('pause').hidden).toBe(false);
    expect(page.byId('pause').textContent).toBe(UsagePageTexts.pause);
    expect(page.byId('sizes').textContent).toBe(view.sizes.label);
    expect(page.byId('banner').hidden).toBe(true);
    expect(page.byId('values').className).toBe('values');

    const cards = page.byId('cards').children;
    expect(cards.map((card) => card.children[0].textContent)).toEqual([view.cpu.caption, view.memory.caption, view.disk.caption, view.docker.caption]);
    // The bars stay between 0 and 100 %; a core at 150 % (a wrong sample) has a full bar.
    const fills = cards[0].all('span').filter((span) => span.className.startsWith('fill'));
    expect(fills.map((fill) => fill.style.width)).toEqual(['100%', '39%']);
    // The drawing of the CPU use: one line per run of two or more points, none for the single point at the end.
    const lines = cards[0].all('polyline');
    expect(lines).toHaveLength(2);
    expect(lines[0].attributes.get('points')?.split(' ')).toHaveLength(2);

    // The name that looks like HTML is text in the row of the running container and in its title.
    const row = page.byId('containers').children[0];
    expect(row.children[0].textContent).toBe(HTML_NAME);
    expect(row.children[0].attributes.get('title')).toBe(HTML_NAME);
    expect(page.byId('containers-summary').textContent).toBe(view.containers.summary);
    expect(page.byId('containers-notes').hidden).toBe(view.containers.notes.length === 0);

    expect(page.byId('stopped').hidden).toBe(false);
    expect(page.byId('stopped-list').text()).toContain('shop-db-1');
    expect(page.byId('tables').children.map((table) => table.all('h2')[0].textContent)).toEqual(view.tables.map((table) => table.title));
    expect(page.byId('footer').children.map((line) => line.textContent)).toEqual(view.footer);
  });

  it('dims the values of a paused page, and its buttons send only their actions', () => {
    const page = loadScript();
    page.show(liveView({ phase: { kind: 'paused', reason: 'button' } }));
    expect(page.byId('values').className).toBe('values stale');
    expect(page.byId('banner').hidden).toBe(false);
    expect(page.byId('banner').className).toBe('banner warning');
    expect(page.byId('banner-message').textContent).toBe(UsagePageTexts.pausedMessage.button);
    const buttons = page.byId('banner-buttons').children;
    expect(buttons.map((button) => button.textContent)).toEqual([UsagePageTexts.resume]);

    buttons[0].dispatch('click');
    page.byId('pause').dispatch('click');
    page.byId('sizes').dispatch('click');
    expect(page.posted.slice(1)).toEqual([{ type: 'resume' }, { type: 'resume' }, { type: 'readSizes' }]);

    // A view with an action the page does not know: no message (the extension checks again with parseUsageRequest).
    const strange = liveView();
    page.show({ ...strange, pause: { action: 'save' as 'pause', label: 'Save' }, banner: { tone: 'error', message: 'm', buttons: [{ action: 'save' as 'retry', label: 'Save' }] } });
    page.byId('pause').dispatch('click');
    page.byId('banner-buttons').children[0].dispatch('click');
    expect(page.posted).toHaveLength(4);
  });

  it('hides the button Pause and the parts without content, and turns off Read Sizes while it reads', () => {
    const page = loadScript();
    const view = usagePageView(input({ phase: { kind: 'vm', state: { kind: 'notSetUp' } }, sizesReading: true }));
    page.show(view);
    expect(page.byId('pause').hidden).toBe(true);
    page.byId('pause').dispatch('click');
    expect(page.byId('sizes').disabled).toBe(true);
    expect(page.byId('stopped').hidden).toBe(true);
    expect(page.byId('tables').children).toEqual([]);
    expect(page.byId('containers').children.map((row) => row.text())).toEqual([view.containers.empty]);
    expect(page.byId('banner-message').textContent).toBe(UsagePageTexts.vmNotSetUp);
    expect(page.byId('banner-detail').hidden).toBe(true);
    expect(page.byId('banner-buttons').children).toEqual([]);
    expect(page.posted).toEqual([{ type: 'ready' }]);
  });

  it('keeps its content while text is selected, and builds a part again only when it changed', () => {
    const page = loadScript();
    page.show(liveView({ phase: { kind: 'paused', reason: 'button' } }));
    const button = page.byId('banner-buttons').children[0];
    const table = page.byId('tables').children[0];
    const cards = page.byId('cards').children[0];
    // The same banner and the same sizes: the button keeps its focus, and the tables stay.
    page.show(liveView({ phase: { kind: 'paused', reason: 'button' }, busy: [1, 2, 3] }));
    expect(page.byId('banner-buttons').children[0]).toBe(button);
    expect(page.byId('tables').children[0]).toBe(table);
    expect(page.byId('cards').children[0]).not.toBe(cards);

    // While the user selects text, the page waits; the newest view comes when the selection ends.
    page.selection.isCollapsed = false;
    page.show(liveView());
    page.show(liveView({ names: new Map([[id(1), 'newest']]) }));
    expect(page.byId('status').className).toBe('status paused');
    page.document.dispatch('selectionchange');
    expect(page.byId('status').className).toBe('status paused');
    page.selection.isCollapsed = true;
    page.document.dispatch('selectionchange');
    expect(page.byId('status').className).toBe('status live');
    expect(page.byId('banner').hidden).toBe(true);
    expect(page.byId('banner-buttons').children).toEqual([]);
    expect(page.byId('containers').children[0].children[0].textContent).toBe('newest');
  });

  it('cuts a long list of stopped containers', () => {
    const page = loadScript();
    const containers = Array.from({ length: MAX_CONTAINER_ROWS + 2 }, (_, index) => object('container', `stopped-${index}`, { state: 'exited' }));
    const inventory: HostInventory = { containers, images: [], volumes: [], networks: [], buildCache: { records: 0, bytes: 0, unusedBytes: 0 } };
    page.show(usagePageView(input({ sizes: { inventory, at: 0 } })));
    const items = page.byId('stopped-list').children;
    expect(items).toHaveLength(MAX_CONTAINER_ROWS + 1);
    expect(items.at(-1)?.textContent).toBe(UsagePageTexts.moreObjects(2));
  });

  it('sends activity on a click or a key, at most every 10 s', () => {
    const page = loadScript();
    page.document.dispatch('pointerdown');
    page.clock.now += 5_000;
    page.document.dispatch('keydown');
    page.clock.now += 5_000;
    page.document.dispatch('keydown');
    page.clock.now += 9_999;
    page.document.dispatch('pointerdown');
    expect(page.posted).toEqual([{ type: 'ready' }, { type: 'activity' }, { type: 'activity' }]);
  });
});
