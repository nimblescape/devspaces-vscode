// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The view "Docker Hosts" (R-ENG-008): a host is read when the user opens it or clicks Refresh, and again when the check
// of the update every 30 seconds changed (only open hosts, while the view is visible and the window has the focus, never
// with questions), never a VM that does not run; Remove… asks once and removes no object of a devspace of this computer and no running container; Start of a
// container that is not of Devspaces; Remove Unused Build Cache… asks once.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { LIMA_HOST } from '../core/docker/dockerHost';
import type { HostInventory, HostObject, ObjectResult } from '../core/hosts/hostObjects';
import { sshPromptsAllowed } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import type { BuildCacheRow, GroupRow, HostRow, HostsNode, MessageRow, ObjectRow } from './dockerHostsModel';
import { DockerHostsCommandTexts, DockerHostsView, UPDATE_INTERVAL_MS, type DockerHostsDeps, type HostsTree } from './dockerHostsView';
import { fakeVscode, resetFakeVscode, type ThemeIcon, type TreeItem } from './testing/fakeVscode';

const { window } = fakeVscode;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };

const worker: HostObject = { kind: 'container', id: 'c-worker', name: 'devspaces-w1-worker1', purpose: 'worker', state: 'running' };
const oldWorker: HostObject = { kind: 'container', id: 'c-old', name: 'devspaces-w2-worker1', purpose: 'worker', state: 'exited' };
const devspaceVolume: HostObject = { kind: 'volume', id: 'v-ws', name: 'majikmate-web-curious-hopper', purpose: 'devspace', devspaceId: 'id-1', repository: 'majikmate/web' };
const foreignVolume: HostObject = { kind: 'volume', id: 'v-other', name: 'majikmate-web-brave-otter', purpose: 'otherDevspace', devspaceId: 'id-9', repository: 'majikmate/web' };
/** A service of the host that is not of Devspaces, stopped, its volume, and a network. */
const shopWeb: HostObject = { kind: 'container', id: 'c-shop', name: 'shop-web-1', purpose: 'notDevspaces', state: 'exited', role: 'service web of shop' };
const pgdata: HostObject = { kind: 'volume', id: 'pgdata', name: 'pgdata', purpose: 'notDevspaces', usedBy: 0 };
const bridge: HostObject = { kind: 'network', id: 'n-bridge', name: 'bridge', purpose: 'notDevspaces', builtIn: true, usedBy: 1 };
/** An image with three tags: its removal removes each. */
const shopImage: HostObject = { kind: 'image', id: 'sha256:shop', name: 'shop:1', tags: ['shop:1', 'shop:latest', 'registry.example/shop:1'], purpose: 'notDevspaces', usedBy: 0 };
const inventory = (): HostInventory => ({ containers: [worker, oldWorker], networks: [], images: [], volumes: [devspaceVolume, foreignVolume], buildCache: { records: 0, bytes: 0, unusedBytes: 0 } });
const fullInventory = (): HostInventory => ({
  containers: [worker, oldWorker, shopWeb],
  networks: [bridge],
  images: [shopImage],
  volumes: [devspaceVolume, foreignVolume, pgdata],
  buildCache: { records: 4, bytes: 3_000_000_000, unusedBytes: 2_500_000_000 },
});

let vmState: VmState;
let hosts: string[];
let selected: string | undefined;
let read: Mock<DockerHostsDeps['read']>;
let removeObjects: Mock<DockerHostsDeps['removeObjects']>;
let stopContainer: Mock<DockerHostsDeps['stopContainer']>;
let startContainer: Mock<DockerHostsDeps['startContainer']>;
let pruneBuildCache: Mock<DockerHostsDeps['pruneBuildCache']>;
let removeFromList: Mock<DockerHostsDeps['removeFromList']>;
let fired: Array<HostsNode | undefined>;

function view(vmHost: string | undefined = LIMA_HOST): DockerHostsView {
  const created = new DockerHostsView({
    logger,
    showLog: vi.fn(),
    vmHost,
    hostList: async () => ({ hosts, selected }),
    vmState: async () => vmState,
    read,
    stopContainer,
    startContainer,
    pruneBuildCache,
    removeObjects,
    removeFromList,
  });
  created.onDidChangeTreeData((node) => fired.push(node));
  return created;
}

async function hostRow(provider: DockerHostsView, host: string): Promise<HostRow> {
  const rows = (await provider.getChildren()) as HostRow[];
  const row = rows.find((candidate) => candidate.host === host);
  if (row === undefined) throw new Error(`no row of ${host}`);
  return row;
}

async function objectRowsOf(provider: DockerHostsView, host: string): Promise<ObjectRow[]> {
  const groups = (await provider.getChildren(await hostRow(provider, host))) as Array<GroupRow | BuildCacheRow>;
  return (await Promise.all(groups.map((group) => provider.getChildren(group)))).flat() as ObjectRow[];
}

async function buildCacheRowOf(provider: DockerHostsView, host: string): Promise<BuildCacheRow> {
  const children = (await provider.getChildren(await hostRow(provider, host))) as Array<GroupRow | BuildCacheRow>;
  const row = children.find((child): child is BuildCacheRow => child.hostsNode === 'buildCache');
  if (row === undefined) throw new Error(`no build cache row of ${host}`);
  return row;
}

const rowOf = (rows: readonly ObjectRow[], object: HostObject): ObjectRow => {
  const row = rows.find((candidate) => candidate.object.id === object.id);
  if (row === undefined) throw new Error(`no row of ${object.name}`);
  return row;
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
  vmState = { kind: 'running', memoryGiB: 4, cpus: 2 };
  hosts = [LIMA_HOST, 'lab'];
  selected = LIMA_HOST;
  fired = [];
  read = vi.fn(async () => inventory());
  removeObjects = vi.fn(async (_host: string, objects: readonly HostObject[]): Promise<ObjectResult[]> => objects.map((object) => ({ object, outcome: 'removed' })));
  stopContainer = vi.fn(async (_host: string, object: HostObject): Promise<ObjectResult> => ({ object, outcome: 'stopped' }));
  startContainer = vi.fn(async (_host: string, object: HostObject): Promise<ObjectResult> => ({ object, outcome: 'started' }));
  pruneBuildCache = vi.fn(async () => undefined);
  removeFromList = vi.fn(async () => undefined);
  window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
    task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
  );
});

describe('DockerHostsView: the rows of the hosts', () => {
  it('shows the VM first with its state, then the remote hosts, and reads no host for it', async () => {
    const rows = (await view().getChildren()) as HostRow[];
    expect(rows.map((row) => [row.host, row.vm, row.selected, row.vmState?.kind])).toEqual([
      [LIMA_HOST, true, true, 'running'],
      ['lab', false, false, undefined],
    ]);
    expect(read).not.toHaveBeenCalled();
  });

  it('gives each row an ID that is new in each window, so that VS Code does not open (and read) the hosts of the last window', () => {
    const row: HostRow = { hostsNode: 'host', host: 'lab', vm: false, selected: false };
    const first = view().getTreeItem(row).id;
    const second = view().getTreeItem(row).id;
    expect(first).toMatch(/:host:lab$/);
    expect(first).not.toBe(second);
  });
});

describe('DockerHostsView: the read of a host', () => {
  it('reads a host when the user opens it, as a flow of the user, and only once until Refresh', async () => {
    let prompts: boolean | undefined;
    read.mockImplementation(async () => {
      prompts = sshPromptsAllowed();
      return inventory();
    });
    const provider = view();
    const children = (await provider.getChildren(await hostRow(provider, 'lab'))) as Array<GroupRow | BuildCacheRow>;
    expect(children.map((child) => (child.hostsNode === 'group' ? [child.group, child.objects.length] : [child.hostsNode, child.cache.records]))).toEqual([
      ['container', 2],
      ['image', 0],
      ['volume', 2],
      ['network', 0],
      ['buildCache', 0],
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toBe('lab');
    // A password login may ask: the user opened the host.
    expect(prompts).toBe(true);
    // A change of the view (another Docker host, a new state of the VM) reads no host again.
    provider.changed();
    await provider.getChildren(await hostRow(provider, 'lab'));
    expect(read).toHaveBeenCalledTimes(1);
    // Refresh of the row reads it again when the view shows it.
    provider.refresh({ hostsNode: 'host', host: 'lab' });
    await provider.getChildren(await hostRow(provider, 'lab'));
    expect(read).toHaveBeenCalledTimes(2);
    // Refresh of the view title: every host.
    provider.refresh();
    await provider.getChildren(await hostRow(provider, 'lab'));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('never reads a VM that does not run: its row starts it', async () => {
    vmState = { kind: 'stopped' };
    const provider = view();
    const children = (await provider.getChildren(await hostRow(provider, LIMA_HOST))) as MessageRow[];
    expect(children.map((child) => child.message)).toEqual(['vmStopped']);
    expect(read).not.toHaveBeenCalled();
  });

  it('follows the state of the VM without a read: a VM that stopped hides its objects, one that runs again offers its read', async () => {
    const provider = view();
    await provider.getChildren(await hostRow(provider, LIMA_HOST));
    expect(read).toHaveBeenCalledTimes(1);
    vmState = { kind: 'stopped' };
    expect(((await provider.getChildren(await hostRow(provider, LIMA_HOST))) as MessageRow[]).map((child) => child.message)).toEqual(['vmStopped']);
    vmState = { kind: 'running' };
    expect(((await provider.getChildren(await hostRow(provider, LIMA_HOST))) as MessageRow[]).map((child) => child.message)).toEqual(['vmNotRead']);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('shows a row with the reason when a host cannot be read', async () => {
    read.mockRejectedValue(new Error('ssh: connect to host lab port 22: Connection refused\nmore'));
    const provider = view();
    const children = (await provider.getChildren(await hostRow(provider, 'lab'))) as MessageRow[];
    expect(children).toEqual([{ hostsNode: 'message', host: 'lab', message: 'readFailed', detail: 'ssh: connect to host lab port 22: Connection refused' }]);
  });

  it('reads a host once while two rows ask at the same time', async () => {
    const provider = view();
    const row = await hostRow(provider, 'lab');
    await Promise.all([provider.getChildren(row), provider.getChildren(row)]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('DockerHostsView: the commands of the rows', () => {
  it('removes a remote host from the list, never the VM', async () => {
    const provider = view();
    await provider.removeFromList({ hostsNode: 'host', host: LIMA_HOST });
    await provider.removeFromList({ hostsNode: 'host', host: 'lab' });
    expect(removeFromList.mock.calls).toEqual([['lab']]);
  });

  it('asks once for the selected rows, removes only what Remove… may remove, and reads the host again', async () => {
    window.showWarningMessage.mockResolvedValue(DockerHostsCommandTexts.remove);
    const provider = view();
    const rows = await objectRowsOf(provider, 'lab');
    const selection = [rowOf(rows, oldWorker), rowOf(rows, foreignVolume), rowOf(rows, devspaceVolume), rowOf(rows, worker)];
    await provider.removeObjects(rowOf(rows, oldWorker), selection);
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    const [question, options] = window.showWarningMessage.mock.calls[0] as [string, { modal: boolean; detail: string }];
    expect(question).toBe('Remove 2 objects from lab?');
    expect(options.modal).toBe(true);
    expect(options.detail).toContain('container devspaces-w2-worker1, volume majikmate-web-brave-otter');
    // A volume of a devspace that this computer does not know may hold changes that were not pushed: the question says so.
    expect(options.detail).toContain('changes of that devspace that were not pushed');
    expect(removeObjects.mock.calls[0][1]).toEqual([oldWorker, foreignVolume]);
    await settle();
    // The object of a devspace of this computer and the running container were skipped.
    expect(window.showInformationMessage).toHaveBeenCalledWith('Removed 2 objects from lab. 2 selected objects were skipped: objects of a devspace of this computer, running containers, or networks of Docker itself.');
    await provider.getChildren(await hostRow(provider, 'lab'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('removes nothing without the answer Remove', async () => {
    const provider = view();
    const rows = await objectRowsOf(provider, 'lab');
    await provider.removeObjects(rowOf(rows, oldWorker));
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it('asks nothing when no selected row may be removed', async () => {
    const provider = view();
    const rows = await objectRowsOf(provider, 'lab');
    await provider.removeObjects(rowOf(rows, devspaceVolume), [rowOf(rows, devspaceVolume), rowOf(rows, worker)]);
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalledWith(DockerHostsCommandTexts.nothingToRemove);
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it('names what is left and why in the log', async () => {
    window.showWarningMessage.mockResolvedValueOnce(DockerHostsCommandTexts.remove);
    removeObjects.mockImplementation(async (_host, objects) => objects.map((object) => ({ object, outcome: 'inUse', detail: 'volume is in use' })));
    const provider = view();
    const rows = await objectRowsOf(provider, 'lab');
    await provider.removeObjects(rowOf(rows, foreignVolume));
    await settle();
    expect(window.showWarningMessage).toHaveBeenLastCalledWith('Removed 0 of 1 objects from lab. Left: majikmate-web-brave-otter. The log says why.', 'Show details');
  });

  it('stops a running container that is no object of a devspace of this computer', async () => {
    const provider = view();
    const rows = await objectRowsOf(provider, 'lab');
    await provider.stopObject(rowOf(rows, worker));
    expect(stopContainer).toHaveBeenCalledWith('lab', worker, expect.any(AbortSignal));
    await provider.stopObject(rowOf(rows, oldWorker));
    expect(stopContainer).toHaveBeenCalledTimes(1);
    await settle();
    expect(window.showInformationMessage).toHaveBeenCalledWith(DockerHostsCommandTexts.stopped(worker.name));
  });
});

describe('DockerHostsView: the objects that are not of Devspaces, the networks and the build cache', () => {
  beforeEach(() => {
    read.mockImplementation(async () => fullInventory());
  });

  it('starts a stopped container that is not of Devspaces, and no container of Devspaces', async () => {
    const provider = view();
    const rows = await objectRowsOf(provider, 'lab');
    await provider.startObject(rowOf(rows, shopWeb));
    expect(startContainer).toHaveBeenCalledWith('lab', shopWeb, expect.any(AbortSignal));
    await provider.startObject(rowOf(rows, oldWorker));
    expect(startContainer).toHaveBeenCalledTimes(1);
    await settle();
    expect(window.showInformationMessage).toHaveBeenCalledWith(DockerHostsCommandTexts.started(shopWeb.name));
    // The row shows the new state after the next read.
    await provider.getChildren(await hostRow(provider, 'lab'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('says why a container did not start', async () => {
    startContainer.mockResolvedValueOnce({ object: shopWeb, outcome: 'failed', detail: 'port is already allocated' });
    const provider = view();
    await provider.startObject(rowOf(await objectRowsOf(provider, 'lab'), shopWeb));
    await settle();
    expect(window.showWarningMessage).toHaveBeenLastCalledWith(DockerHostsCommandTexts.startFailed(shopWeb.name, 'port is already allocated'), 'Show details');
  });

  it('asks once before it removes an object that is not of Devspaces, says that another program may need it, and never removes a network of Docker', async () => {
    window.showWarningMessage.mockResolvedValue(DockerHostsCommandTexts.remove);
    const provider = view();
    const rows = await objectRowsOf(provider, 'lab');
    await provider.removeObjects(rowOf(rows, pgdata), [rowOf(rows, pgdata), rowOf(rows, shopWeb), rowOf(rows, bridge), rowOf(rows, shopImage)]);
    const [question, options] = window.showWarningMessage.mock.calls[0] as [string, { modal: boolean; detail: string }];
    expect(question).toBe('Remove 3 objects from lab?');
    expect(options.detail).toContain('do not belong to Devspaces');
    expect(options.detail).not.toContain('changes of that devspace');
    // An image names every tag that its removal removes.
    expect(options.detail).toContain('image shop:1 (also shop:latest, registry.example/shop:1)');
    expect(removeObjects.mock.calls[0][1]).toEqual([pgdata, shopWeb, shopImage]);
  });

  it('removes the unused build cache after one question, and reads the host again', async () => {
    window.showWarningMessage.mockResolvedValueOnce(DockerHostsCommandTexts.prune);
    const provider = view();
    const row = await buildCacheRowOf(provider, 'lab');
    expect(row.cache).toEqual({ records: 4, bytes: 3_000_000_000, unusedBytes: 2_500_000_000 });
    await provider.pruneBuildCache(row);
    const [question, options] = window.showWarningMessage.mock.calls[0] as [string, { modal: boolean; detail: string }];
    expect(question).toBe(DockerHostsCommandTexts.pruneQuestion('lab'));
    expect(options).toMatchObject({ modal: true, detail: expect.stringContaining('frees about 2.5 GB') });
    expect(pruneBuildCache).toHaveBeenCalledWith('lab', expect.any(AbortSignal));
    await settle();
    expect(window.showInformationMessage).toHaveBeenCalledWith(DockerHostsCommandTexts.pruned('lab'));
    await provider.getChildren(await hostRow(provider, 'lab'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('runs each action as a flow of the user, so that a password login of the shared shell of the host may ask', async () => {
    const asked: Array<[string, boolean]> = [];
    stopContainer.mockImplementation(async (_host, object) => (asked.push(['stop', sshPromptsAllowed()]), { object, outcome: 'stopped' }));
    startContainer.mockImplementation(async (_host, object) => (asked.push(['start', sshPromptsAllowed()]), { object, outcome: 'started' }));
    pruneBuildCache.mockImplementation(async () => void asked.push(['prune', sshPromptsAllowed()]));
    removeObjects.mockImplementation(async (_host, objects) => (asked.push(['remove', sshPromptsAllowed()]), objects.map((object) => ({ object, outcome: 'removed' as const }))));
    const provider = view();
    const rows = await objectRowsOf(provider, 'lab');
    await provider.stopObject(rowOf(rows, worker));
    await provider.startObject(rowOf(rows, shopWeb));
    window.showWarningMessage.mockResolvedValueOnce(DockerHostsCommandTexts.prune);
    await provider.pruneBuildCache(await buildCacheRowOf(provider, 'lab'));
    window.showWarningMessage.mockResolvedValueOnce(DockerHostsCommandTexts.remove);
    await provider.removeObjects(rowOf(await objectRowsOf(provider, 'lab'), pgdata));
    expect(asked).toEqual([
      ['stop', true],
      ['start', true],
      ['prune', true],
      ['remove', true],
    ]);
    // Outside of an action, no login may ask.
    expect(sshPromptsAllowed()).toBe(false);
  });

  it('removes no build cache without the answer, and asks nothing when no build cache is unused', async () => {
    const provider = view();
    const row = await buildCacheRowOf(provider, 'lab');
    await provider.pruneBuildCache(row);
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(pruneBuildCache).not.toHaveBeenCalled();
    await provider.pruneBuildCache({ ...row, cache: { ...row.cache, unusedBytes: 0 } });
    await provider.pruneBuildCache({ hostsNode: 'object', host: 'lab' });
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('changes no object of the VM after the VM stopped (each Docker call would start it), and shows its stopped row again', async () => {
    window.showWarningMessage.mockResolvedValue(DockerHostsCommandTexts.remove);
    const provider = view();
    const rows = await objectRowsOf(provider, LIMA_HOST);
    const cache = await buildCacheRowOf(provider, LIMA_HOST);
    // Stop the VM… in another window: this view still shows the rows of its last read.
    vmState = { kind: 'stopped' };
    fired = [];
    await provider.stopObject(rowOf(rows, worker));
    await provider.startObject(rowOf(rows, shopWeb));
    await provider.removeObjects(rowOf(rows, pgdata));
    window.showWarningMessage.mockResolvedValue(DockerHostsCommandTexts.prune);
    await provider.pruneBuildCache(cache);
    expect(stopContainer).not.toHaveBeenCalled();
    expect(startContainer).not.toHaveBeenCalled();
    expect(removeObjects).not.toHaveBeenCalled();
    expect(pruneBuildCache).not.toHaveBeenCalled();
    await settle();
    expect(window.showInformationMessage).toHaveBeenCalledWith(DockerHostsCommandTexts.vmNotRunning({ kind: 'stopped' }));
    // The whole view again: the VM row with its state of now, and the row that starts the VM.
    expect(fired).toContain(undefined);
    const children = (await provider.getChildren(await hostRow(provider, LIMA_HOST))) as MessageRow[];
    expect(children.map((child) => child.message)).toEqual(['vmStopped']);
    expect(read).toHaveBeenCalledTimes(1);

    // A remote host does not depend on the state of the VM.
    await provider.startObject(rowOf(await objectRowsOf(provider, 'lab'), shopWeb));
    expect(startContainer).toHaveBeenCalledWith('lab', shopWeb, expect.any(AbortSignal));
  });

  it('says why it changed no object of the VM when the state of the VM is not known, broken or not set up', async () => {
    const provider = view();
    const rows = await objectRowsOf(provider, LIMA_HOST);
    vmState = { kind: 'unknown', detail: 'limactl did not answer.' };
    await provider.startObject(rowOf(rows, shopWeb));
    vmState = { kind: 'notSetUp' };
    await provider.startObject(rowOf(rows, shopWeb));
    expect(startContainer).not.toHaveBeenCalled();
    await settle();
    const texts = window.showInformationMessage.mock.calls.map((call) => call[0] as string);
    expect(texts[0]).toBe('Devspaces cannot use the VM of Devspaces now (its state is not known), so it did not change its objects. limactl did not answer.');
    expect(texts[0]).not.toContain('does not run now');
    expect(texts[1]).toBe('The VM of Devspaces is not set up anymore, so Devspaces did not change its objects.');
    expect(DockerHostsCommandTexts.vmNotRunning({ kind: 'broken' })).toContain('(it is broken)');
  });

  it('colors the name and the icon of an object row (violet, dimmed violet, gray), and leaves the hosts and groups as they are', async () => {
    read.mockImplementation(async () => ({ ...fullInventory(), containers: [{ ...worker, active: true }, oldWorker, shopWeb, { ...shopWeb, id: 'c-pg', name: 'my-postgres', state: 'running', active: true }] }));
    const provider = view();
    const rows = await objectRowsOf(provider, 'lab');
    const itemOf = (id: string): TreeItem => provider.getTreeItem(rows.find((row) => row.object.id === id) as ObjectRow) as unknown as TreeItem;
    const colorOf = (item: TreeItem): { label?: string; icon?: string } => ({
      label: (item.resourceUri as { path: string } | undefined)?.path,
      icon: (item.iconPath as ThemeIcon).color?.id,
    });
    expect(colorOf(itemOf('c-worker'))).toEqual({ label: undefined, icon: undefined });
    expect(colorOf(itemOf(oldWorker.id))).toEqual({ label: '/inactive', icon: 'devspaces.inactiveForeground' });
    expect(colorOf(itemOf('c-shop'))).toEqual({ label: '/notDevspacesInactive', icon: 'devspaces.hosts.notDevspacesInactiveForeground' });
    expect(colorOf(itemOf('c-pg'))).toEqual({ label: '/notDevspaces', icon: 'devspaces.hosts.notDevspacesForeground' });
    const hostItem = provider.getTreeItem(await hostRow(provider, 'lab')) as unknown as TreeItem;
    expect(hostItem.resourceUri).toBeUndefined();
    const groups = (await provider.getChildren(await hostRow(provider, 'lab'))) as Array<GroupRow | BuildCacheRow>;
    for (const group of groups) expect((provider.getTreeItem(group) as unknown as TreeItem).resourceUri).toBeUndefined();
  });

  it('opens the report of an object row with vscode.open and only its address, so that VS Code opens a preview tab (R-ENG-010)', async () => {
    read.mockImplementation(async () => ({ ...fullInventory(), containers: [shopWeb] }));
    const provider = view();
    const [row] = (await objectRowsOf(provider, 'lab')).filter((entry) => entry.object.id === shopWeb.id);
    const item = provider.getTreeItem(row) as unknown as TreeItem;
    const command = item.command as { command: string; title: string; arguments: Array<{ toString(): string }> };
    // Only the address: VS Code adds the kind of the click (a double click keeps the tab).
    expect(command).toMatchObject({ command: 'vscode.open', title: 'Show Report' });
    expect(command.arguments.map(String)).toEqual([`devspaces-report:/lab/container/${shopWeb.name}?id=${shopWeb.id}`]);
    const hostItem = provider.getTreeItem(await hostRow(provider, 'lab')) as unknown as TreeItem;
    expect((hostItem.command as { command?: string } | undefined)?.command).not.toBe('vscode.open');
  });

  it('gives the report page the object of the last read of its host, and nothing for another host, kind or ID', async () => {
    read.mockImplementation(async () => ({ ...fullInventory(), containers: [shopWeb] }));
    const provider = view();
    await objectRowsOf(provider, 'lab');
    expect(provider.objectOf('lab', 'container', shopWeb.id)).toEqual(shopWeb);
    expect(provider.objectOf('lab', 'volume', shopWeb.id)).toBeUndefined();
    expect(provider.objectOf('lab', 'container', 'other')).toBeUndefined();
    expect(provider.objectOf('box', 'container', shopWeb.id)).toBeUndefined();
  });

  it('says why the build cache could not be removed', async () => {
    window.showWarningMessage.mockResolvedValueOnce(DockerHostsCommandTexts.prune);
    pruneBuildCache.mockRejectedValueOnce(new Error('a prune operation is already running'));
    const provider = view();
    await provider.pruneBuildCache(await buildCacheRowOf(provider, 'lab'));
    await settle();
    expect(window.showWarningMessage).toHaveBeenLastCalledWith(DockerHostsCommandTexts.pruneFailed('lab', 'a prune operation is already running'), 'Show details');
  });
});

describe('DockerHostsView: the update every 30 seconds', () => {
  const { EventEmitter } = fakeVscode;
  let check: Mock<NonNullable<DockerHostsDeps['check']>>;
  let checkText: string;
  let vmStopping: boolean;
  let tree: HostsTree & { visible: boolean; expand(row: HostRow): void; collapse(row: HostRow): void; show(visible: boolean): void };

  function watched(): DockerHostsView {
    const provider = new DockerHostsView({
      logger,
      showLog: vi.fn(),
      vmHost: LIMA_HOST,
      hostList: async () => ({ hosts, selected }),
      vmState: async () => vmState,
      read,
      check,
      vmStopping: () => vmStopping,
      stopContainer,
      startContainer,
      pruneBuildCache,
      removeObjects,
      removeFromList,
    });
    provider.onDidChangeTreeData((node) => fired.push(node));
    provider.watch(tree);
    return provider;
  }

  /** The user opens the row of `host`: the read of the user, and the tree view says that the row is open. */
  async function open(provider: DockerHostsView, host: string): Promise<HostRow> {
    const row = await hostRow(provider, host);
    await provider.getChildren(row);
    tree.expand(row);
    return row;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    checkText = 'A';
    vmStopping = false;
    check = vi.fn(async () => checkText);
    const expands = new EventEmitter<{ element: HostsNode }>();
    const collapses = new EventEmitter<{ element: HostsNode }>();
    const visibility = new EventEmitter<{ visible: boolean }>();
    tree = {
      visible: true,
      onDidExpandElement: expands.event as HostsTree['onDidExpandElement'],
      onDidCollapseElement: collapses.event as HostsTree['onDidCollapseElement'],
      onDidChangeVisibility: visibility.event as HostsTree['onDidChangeVisibility'],
      expand: (row) => expands.fire({ element: row }),
      collapse: (row) => collapses.fire({ element: row }),
      show: (visible) => {
        tree.visible = visible;
        visibility.fire({ visible });
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks each open host every 30 seconds and reads it again only when the check changed', async () => {
    const provider = watched();
    const row = await open(provider, 'lab');
    // The read of the user checks first, on the same login.
    expect(check.mock.calls.map((call) => call[0])).toEqual(['lab']);
    expect(read).toHaveBeenCalledTimes(1);
    fired = [];
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
    expect(check.mock.calls[1][2]).toEqual({});
    expect(read).toHaveBeenCalledTimes(1);
    expect(fired).toEqual([]);
    // A container started: the read again, in the background, and the row of the host shows it without another read.
    checkText = 'B';
    read.mockImplementationOnce(async () => fullInventory());
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    expect(fired).toEqual([row]);
    expect((await objectRowsOf(provider, 'lab')).map((object) => object.object.name)).toContain('shop-web-1');
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(4);
    expect(read).toHaveBeenCalledTimes(2);
    // A closed host is not checked.
    tree.collapse(row);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(4);
  });

  it('checks nothing while the view is hidden or 2 minutes after the window lost the focus; a show or the focus checks at once', async () => {
    const provider = watched();
    await open(provider, 'lab');
    tree.show(false);
    await vi.advanceTimersByTimeAsync(3 * UPDATE_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(1);
    tree.show(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(2);
    // Without the focus: the checks go on for 2 minutes, then they pause until the focus comes back.
    fakeVscode.fireWindowState(false);
    await vi.advanceTimersByTimeAsync(4 * UPDATE_INTERVAL_MS);
    const beforePause = check.mock.calls.length;
    expect(beforePause).toBe(5);
    await vi.advanceTimersByTimeAsync(4 * UPDATE_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(beforePause);
    fakeVscode.fireWindowState(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(beforePause + 1);
  });

  it('never calls a VM that does not run or that stops now, shows the hosts again when the state of the VM changed, and reads the VM when it runs again', async () => {
    const provider = watched();
    await open(provider, LIMA_HOST);
    expect(read).toHaveBeenCalledTimes(1);
    vmStopping = true;
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(1);
    vmStopping = false;
    vmState = { kind: 'stopped' };
    fired = [];
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(1);
    // The rows of the hosts show again (the VM row follows its state, its objects show the stopped row).
    expect(fired).toEqual([undefined]);
    expect(((await provider.getChildren(await hostRow(provider, LIMA_HOST))) as MessageRow[]).map((child) => child.message)).toEqual(['vmStopped']);
    vmState = { kind: 'running', memoryGiB: 4, cpus: 2 };
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
    expect((await provider.getChildren(await hostRow(provider, LIMA_HOST))).map((child) => child.hostsNode)).toEqual(['group', 'group', 'group', 'group', 'buildCache']);
  });

  it('asks nothing, and after a failed update of a remote host uses only a login that is open until a read of the user works', async () => {
    const prompts: boolean[] = [];
    const provider = watched();
    const row = await open(provider, 'lab');
    check.mockImplementation(async () => {
      prompts.push(sshPromptsAllowed());
      throw new Error('Permission denied (publickey,password).');
    });
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(prompts).toEqual([false, false]);
    expect(check.mock.calls.slice(1).map((call) => call[2])).toEqual([{}, { openLoginOnly: true }]);
    // Logged once, and the rows of the last read stay.
    expect(logger.info.mock.calls.filter(([text]) => String(text).startsWith('The update of the view Docker Hosts could not read lab'))).toHaveLength(1);
    expect((await objectRowsOf(provider, 'lab')).length).toBeGreaterThan(0);
    // Refresh: a read of the user (with its questions) works, and the update may log in again.
    check.mockImplementation(async () => checkText);
    provider.refresh(row);
    await provider.getChildren(row);
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(check.mock.calls.at(-1)?.[2]).toEqual({});
  });

  it('drops the read of the update when a Refresh or an action of the user came in the meantime', async () => {
    const provider = watched();
    const row = await open(provider, 'lab');
    checkText = 'B';
    let finish: (value: HostInventory) => void = () => undefined;
    read.mockImplementationOnce(() => new Promise<HostInventory>((resolve) => (finish = resolve)));
    await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    // The user clicks Refresh on the row while the update reads: the read of the user wins.
    provider.refresh(row);
    await provider.getChildren(row);
    expect(read).toHaveBeenCalledTimes(3);
    fired = [];
    finish(fullInventory());
    await vi.advanceTimersByTimeAsync(0);
    expect(fired).toEqual([]);
    expect((await objectRowsOf(provider, 'lab')).map((object) => object.object.name)).not.toContain('shop-web-1');
  });
});
