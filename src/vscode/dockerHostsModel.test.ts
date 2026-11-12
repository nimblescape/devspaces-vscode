// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The rows of the view "Docker Hosts" (R-ENG-008, R-VM-010): their order, their flags for the menus of package.json, and
// the actions of each object, also of the objects that are not of Devspaces, the networks and the build cache.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { LIMA_HOST, WSL_HOST } from '../core/docker/dockerHost';
import type { HostObject } from '../core/hosts/hostObjects';
import { Commands } from './commands';
import {
  buildCacheRowLook,
  DOCKER_HOSTS_VIEW_ID,
  DockerHostsTexts,
  groupRowLook,
  hostOfArgument,
  hostOfNode,
  hostRowLook,
  hostRows,
  messageRowLook,
  objectActions,
  objectColor,
  objectRowLook,
  objectRows,
  rowLook,
  type HostRow,
  type ObjectRow,
} from './dockerHostsModel';

const container = (state: string, extra: Partial<HostObject> = {}): HostObject => ({ kind: 'container', id: 'c1', name: 'devspaces-monitor', purpose: 'monitor', state, ...extra });
const objectRow = (object: HostObject, devspaceId?: string): ObjectRow => ({ hostsNode: 'object', host: LIMA_HOST, object, ...(devspaceId !== undefined ? { devspaceId } : {}) });

describe('hostRows', () => {
  it('shows the VM of Devspaces first, also before its setup, then the remote hosts in the order of the list', () => {
    const rows = hostRows({ vmHost: LIMA_HOST, vmState: { kind: 'notSetUp' }, hosts: ['build-box', LIMA_HOST, 'lab'], selected: 'lab' });
    expect(rows.map((row) => [row.host, row.vm, row.selected])).toEqual([
      [LIMA_HOST, true, false],
      ['build-box', false, false],
      ['lab', false, true],
    ]);
  });

  it('has no VM row where there is no VM, and never shows the VM of another platform as a remote host', () => {
    expect(hostRows({ vmHost: undefined, vmState: undefined, hosts: [WSL_HOST, 'lab'], selected: undefined }).map((row) => row.host)).toEqual(['lab']);
  });
});

describe('hostRowLook', () => {
  const vm = (kind: 'notSetUp' | 'stopped' | 'running' | 'unknown', selected = false): HostRow => ({ hostsNode: 'host', host: LIMA_HOST, vm: true, selected, vmState: { kind } });

  it('offers the setup for a VM that is not set up, and nothing that needs its engine', () => {
    const look = hostRowLook(vm('notSetUp'));
    expect(look.contextValue).toBe('hostsHost;vm;vmNotSetUp');
    expect(look.collapsible).toBe('none');
    expect(look.description).toBe('Local VM of Devspaces · Not set up');
    expect(look.tooltip).toContain(DockerHostsTexts.setUpInMenu);
  });

  it('offers Start for a stopped VM and Stop for a running one; the selected host has a check mark', () => {
    expect(hostRowLook(vm('stopped')).contextValue).toBe('hostsHost;vm;vmSetUp;engine;vmCanStart');
    expect(hostRowLook(vm('unknown')).contextValue).toContain(';vmCanStart');
    const running = hostRowLook(vm('running', true));
    expect(running.contextValue).toBe('hostsHost;vm;vmSetUp;engine;vmCanStop;selected');
    expect(running.icon).toBe('check');
    expect(running.tooltip).toContain(DockerHostsTexts.selected);
  });

  it('gives a host row no click command: the Docker host of Devspaces is chosen only in the repository view', () => {
    for (const row of [vm('notSetUp'), vm('stopped'), vm('running', true), { hostsNode: 'host', host: 'lab', vm: false, selected: false } satisfies HostRow]) {
      expect(hostRowLook(row).command).toBeUndefined();
    }
    const other = hostRowLook({ hostsNode: 'host', host: 'lab', vm: false, selected: false });
    expect(other.tooltip).toContain(DockerHostsTexts.chooseInRepositoryView);
    expect(other.tooltip).not.toContain(DockerHostsTexts.selected);
  });

  it('says the memory, the CPUs and the space of the disk of the VM in its tooltip', () => {
    const look = hostRowLook({ hostsNode: 'host', host: LIMA_HOST, vm: true, selected: false, vmState: { kind: 'stopped', memoryGiB: 4, cpus: 2, diskBytes: 3_200_000_000 } });
    expect(look.tooltip).toContain('4 GiB of memory, 2 CPUs, its disk takes 3.2 GB on this computer.');
    expect(look.tooltip).toContain('Devspaces does not start it to read it.');
  });

  it('gives a remote host the actions of its engine and Remove from the List', () => {
    const look = hostRowLook({ hostsNode: 'host', host: 'lab', vm: false, selected: false });
    expect(look.contextValue).toBe('hostsHost;remote;engine');
    expect(look.collapsible).toBe('collapsed');
  });
});

describe('objectActions', () => {
  it('gives the objects of a devspace of this computer its Stop and Delete…, never Remove…', () => {
    expect(objectActions(objectRow(container('running', { purpose: 'devspace' }), 'id-1'))).toEqual({ stopDevspace: true, deleteDevspace: true, stop: false, start: false, remove: false });
    expect(objectActions(objectRow({ kind: 'volume', id: 'v', name: 'v', purpose: 'devspace' }, 'id-1'))).toEqual({ stopDevspace: false, deleteDevspace: true, stop: false, start: false, remove: false });
    expect(objectActions(objectRow({ kind: 'network', id: 'n', name: 'n', purpose: 'devspace' }, 'id-1'))).toMatchObject({ deleteDevspace: true, remove: false });
  });

  it('gives any other running container Stop first, and Remove… only after it stopped', () => {
    expect(objectActions(objectRow(container('running')))).toEqual({ stopDevspace: false, deleteDevspace: false, stop: true, start: false, remove: false });
    expect(objectActions(objectRow(container('paused')))).toMatchObject({ stop: true, remove: false });
    expect(objectActions(objectRow(container('exited')))).toMatchObject({ stop: false, remove: true });
    expect(objectActions(objectRow({ kind: 'image', id: 'sha256:1', name: 'devspaces-worker:1', purpose: 'helperImage' }))).toMatchObject({ remove: true });
  });

  it('gives a stopped container that is not of Devspaces Start; Devspaces starts its own helpers itself', () => {
    const other = (state: string) => container(state, { name: 'shop-web-1', purpose: 'notDevspaces' });
    expect(objectActions(objectRow(other('exited')))).toEqual({ stopDevspace: false, deleteDevspace: false, stop: false, start: true, remove: true });
    expect(objectActions(objectRow(other('created')))).toMatchObject({ start: true, remove: true });
    expect(objectActions(objectRow(other('running')))).toMatchObject({ start: false, stop: true, remove: false });
    expect(objectActions(objectRow(other('dead')))).toMatchObject({ start: false, remove: true });
    expect(objectActions(objectRow(container('exited')))).toMatchObject({ start: false });
  });

  it('gives a network Remove…, but never a network of Docker itself', () => {
    expect(objectActions(objectRow({ kind: 'network', id: 'n6', name: 'mynet', purpose: 'notDevspaces', usedBy: 0 }))).toMatchObject({ stop: false, start: false, remove: true });
    expect(objectActions(objectRow({ kind: 'network', id: 'n1', name: 'bridge', purpose: 'notDevspaces', builtIn: true }))).toEqual({ stopDevspace: false, deleteDevspace: false, stop: false, start: false, remove: false });
  });

  it('names the actions in the context value, which the menus of package.json match', () => {
    expect(objectRowLook(objectRow(container('running'))).contextValue).toBe('hostsObject;container;monitor;canStop');
    expect(objectRowLook(objectRow(container('exited', { purpose: 'otherDevspace' }))).contextValue).toBe('hostsObject;container;otherDevspace;canRemove');
    expect(objectRowLook(objectRow(container('running', { purpose: 'devspace' }), 'id-1')).contextValue).toBe('hostsObject;container;devspace;canStopDevspace;canDeleteDevspace');
    expect(objectRowLook(objectRow(container('exited', { purpose: 'notDevspaces' }))).contextValue).toBe('hostsObject;container;notDevspaces;canStart;canRemove');
  });
});

describe('objectRowLook', () => {
  it('marks an object that is not of Devspaces, with the service of Docker Compose of a container', () => {
    const look = objectRowLook(objectRow(container('exited', { name: 'shop-web-1', purpose: 'notDevspaces', role: 'service web of shop' })));
    expect(look.description).toBe('not of Devspaces · service web of shop · Stopped');
    expect(look.tooltip).toContain('does not belong to Devspaces');
  });

  it('shows the driver of a network and the number of its containers; a network of Docker says that Docker keeps it', () => {
    const look = objectRowLook(objectRow({ kind: 'network', id: 'n5', name: 'shop_default', purpose: 'notDevspaces', role: 'network of shop', driver: 'bridge', usedBy: 2 }));
    expect(look).toMatchObject({ label: 'shop_default', description: 'not of Devspaces · network of shop · bridge · 2 containers', icon: 'plug', contextValue: 'hostsObject;network;notDevspaces;canRemove' });
    const bridge = objectRowLook(objectRow({ kind: 'network', id: 'n1', name: 'bridge', purpose: 'notDevspaces', role: 'network of Docker', builtIn: true, driver: 'bridge', usedBy: 0 }));
    expect(bridge.description).toBe('not of Devspaces · network of Docker · bridge');
    expect(bridge.tooltip).toContain('A network that Docker creates itself');
    expect(bridge.tooltip).toContain('Devspaces does not remove it.');
    const ingress = objectRowLook(objectRow({ kind: 'network', id: 'n9', name: 'ingress', purpose: 'notDevspaces', role: 'network of Docker', builtIn: true, driver: 'overlay' }));
    expect(ingress.tooltip).toContain('on a node of Docker Swarm');
    expect(ingress.contextValue).toBe('hostsObject;network;notDevspaces');
    expect(bridge.contextValue).toBe('hostsObject;network;notDevspaces');
  });

  it('says why a helper image has no tag, and names the base image of the helper image', () => {
    const earlier = objectRowLook(objectRow({ kind: 'image', id: 'sha256:547784e940da', name: 'devspaces-worker (earlier build, 547784e940da)', tags: [], purpose: 'helperImage', sizeBytes: 721_000_000, active: true }));
    expect(earlier).toMatchObject({ label: 'devspaces-worker (earlier build, 547784e940da)', description: 'helper image · 721 MB' });
    expect(earlier.tooltip).toContain('A helper image without a tag: usually an earlier build, whose tag devspaces-worker:<hash> a newer build took.');
    const current = objectRowLook(objectRow({ kind: 'image', id: 'sha256:w', name: 'devspaces-worker:6ba87151934c', tags: ['devspaces-worker:6ba87151934c', 'devspaces-monitor:6ba87151934c'], purpose: 'helperImage' }));
    expect(current.tooltip).not.toContain('without a tag');
    expect(current.tooltip).toContain('Tags: devspaces-worker:6ba87151934c, devspaces-monitor:6ba87151934c');
    const base = objectRowLook(objectRow({ kind: 'image', id: 'sha256:n', name: 'node:24-trixie-slim', tags: ['node:24-trixie-slim'], purpose: 'helperBaseImage', sizeBytes: 356_000_000 }));
    expect(base).toMatchObject({ description: 'base image of the helper image · 356 MB', color: 'inactive' });
    expect(base.tooltip).toContain('The image that the Dockerfile of the helper image starts from.');
  });
});

describe('the colors of the object rows', () => {
  it('shows an object that is not of Devspaces in violet, dimmed when inactive, and an inactive object of Devspaces in gray', () => {
    expect(objectColor(container('running', { purpose: 'notDevspaces', active: true }))).toBe('notDevspaces');
    expect(objectColor(container('exited', { purpose: 'notDevspaces' }))).toBe('notDevspacesInactive');
    expect(objectColor(container('running', { active: true }))).toBeUndefined();
    expect(objectColor(container('exited'))).toBe('inactive');
    // A devspace of another computer is of Devspaces too.
    expect(objectColor({ kind: 'volume', id: 'v', name: 'devspaces-x', purpose: 'otherDevspace' })).toBe('inactive');
    expect(objectColor({ kind: 'network', id: 'n1', name: 'bridge', purpose: 'notDevspaces', builtIn: true, active: true })).toBe('notDevspaces');
  });

  it('carries the color in the look of the row, and says in the tooltip why the row is active or not', () => {
    const running = objectRowLook(objectRow(container('running', { name: 'my-postgres', purpose: 'notDevspaces', active: true })));
    expect(running.color).toBe('notDevspaces');
    expect(running.tooltip).toContain('Active: it runs.');
    const own = objectRowLook(objectRow(container('running', { active: true })));
    expect(own.color).toBeUndefined();
    expect('color' in own).toBe(false);
    const image = objectRowLook(objectRow({ kind: 'image', id: 'sha256:w', name: 'node:22', purpose: 'notDevspaces', usedBy: 1 }));
    expect(image.color).toBe('notDevspacesInactive');
    expect(image.tooltip).toContain('Inactive: no running container uses it.');
    const volume = objectRowLook(objectRow({ kind: 'volume', id: 'devspaces-vscode', name: 'devspaces-vscode', purpose: 'sharedVolume', active: true }));
    expect(volume.tooltip).toContain('Active: a running container uses it.');
    expect(objectRowLook(objectRow(container('exited'))).tooltip).toContain('Inactive: it does not run.');
  });

  it('leaves the hosts, the groups and the row of the build cache in the colors of the theme', () => {
    expect(hostRowLook({ hostsNode: 'host', host: 'lab', vm: false, selected: false }).color).toBeUndefined();
    expect(groupRowLook({ hostsNode: 'group', host: 'lab', group: 'container', objects: [container('exited')] }).color).toBeUndefined();
    expect(buildCacheRowLook({ hostsNode: 'buildCache', host: 'lab', cache: { records: 1, bytes: 10, unusedBytes: 10 } }).color).toBeUndefined();
  });

  it('contributes the three colors with a value for every kind of theme (package.json)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      contributes: { colors: Array<{ id: string; description: string; defaults: Record<string, string> }> };
    };
    expect(manifest.contributes.colors.map((color) => color.id).sort()).toEqual(['devspaces.hosts.notDevspacesForeground', 'devspaces.hosts.notDevspacesInactiveForeground', 'devspaces.inactiveForeground']);
    for (const color of manifest.contributes.colors) expect(Object.keys(color.defaults).sort()).toEqual(['dark', 'highContrast', 'highContrastLight', 'light']);
  });
});

describe('objectRows', () => {
  it('carries the ID of the devspace only for an object of a devspace of this computer (the commands Stop and Delete… take it)', () => {
    const rows = objectRows(LIMA_HOST, [
      { kind: 'volume', id: 'a', name: 'a', purpose: 'devspace', devspaceId: 'id-1' },
      { kind: 'volume', id: 'b', name: 'b', purpose: 'otherDevspace', devspaceId: 'id-2' },
    ]);
    expect(rows.map((row) => row.devspaceId)).toEqual(['id-1', undefined]);
  });
});

describe('groupRowLook', () => {
  it('shows the number of objects and their size, and none for an empty group', () => {
    const look = groupRowLook({ hostsNode: 'group', host: 'lab', group: 'volume', objects: [{ kind: 'volume', id: 'v', name: 'v', purpose: 'sharedVolume', sizeBytes: 2_500 }] });
    expect(look.description).toBe('1 · 2.5 kB');
    expect(groupRowLook({ hostsNode: 'group', host: 'lab', group: 'image', objects: [] })).toMatchObject({ description: 'none', collapsible: 'none' });
  });

  it('has a group Networks with its own icon, and says in each tooltip that the objects of Devspaces come first', () => {
    const look = groupRowLook({ hostsNode: 'group', host: 'lab', group: 'network', objects: [{ kind: 'network', id: 'n1', name: 'bridge', purpose: 'notDevspaces', builtIn: true }] });
    expect(look).toMatchObject({ label: 'Networks', icon: 'type-hierarchy', id: 'group:lab:network' });
    expect(look.tooltip).toContain('those of Devspaces first, then the others');
  });
});

describe('buildCacheRowLook', () => {
  it('shows the records of the build cache, their size and what no build uses; Remove Unused Build Cache… only when there is some', () => {
    const look = buildCacheRowLook({ hostsNode: 'buildCache', host: 'lab', cache: { records: 3, bytes: 2_000_000_000, unusedBytes: 1_500_000_000 } });
    expect(look).toMatchObject({ id: 'buildCache:lab', label: 'Build cache', description: '3 · 2 GB · 1.5 GB can be freed', contextValue: 'hostsBuildCache;canPrune', collapsible: 'none' });
    expect(look.tooltip).toContain('3 records');
    expect(buildCacheRowLook({ hostsNode: 'buildCache', host: 'lab', cache: { records: 1, bytes: 500, unusedBytes: 0 } }).contextValue).toBe('hostsBuildCache');
    expect(buildCacheRowLook({ hostsNode: 'buildCache', host: 'lab', cache: { records: 0, bytes: 0, unusedBytes: 0 } }).description).toBe('none');
    expect(rowLook({ hostsNode: 'buildCache', host: 'lab', cache: { records: 0, bytes: 0, unusedBytes: 0 } }).label).toBe('Build cache');
  });
});

describe('messageRowLook', () => {
  it('starts a stopped VM from its row, and reads a VM that runs again', () => {
    expect(messageRowLook({ hostsNode: 'message', host: LIMA_HOST, message: 'vmStopped' }).command).toEqual({ command: Commands.startVm, title: 'Start the VM' });
    expect(messageRowLook({ hostsNode: 'message', host: LIMA_HOST, message: 'vmNotRead' }).command).toEqual({
      command: Commands.refreshDockerHosts,
      title: 'Refresh',
      arguments: [{ hostsNode: 'host', host: LIMA_HOST }],
    });
  });
});

describe('the host of a command argument', () => {
  it('takes only a host row as a host, and any row for its host', () => {
    expect(hostOfArgument({ hostsNode: 'host', host: 'lab' })).toBe('lab');
    expect(hostOfArgument({ hostsNode: 'object', host: 'lab' })).toBeUndefined();
    expect(hostOfArgument({ devspaceId: 'id-1' })).toBeUndefined();
    expect(hostOfNode({ hostsNode: 'object', host: 'lab' })).toBe('lab');
    expect(hostOfNode(undefined)).toBeUndefined();
  });
});

describe('the menus of the view (package.json)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    contributes: {
      views: Record<string, Array<{ id: string }>>;
      menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
    };
  };
  const items = manifest.contributes.menus['view/item/context'].filter((item) => item.when?.startsWith(`view == ${DOCKER_HOSTS_VIEW_ID} `));
  /** The commands of the context menu of a row with `contextValue` (only the clause viewItem of each `when`). */
  const commandsOf = (contextValue: string): string[] =>
    items
      .filter((item) => {
        const regex = /viewItem =~ \/(.+?)\//.exec(item.when ?? '');
        return regex !== null && new RegExp(regex[1]).test(contextValue) && !item.group?.startsWith('inline');
      })
      .map((item) => item.command ?? '');

  it('shows the view "Docker Hosts" below the repositories', () => {
    expect(manifest.contributes.views.devspaces.map((view) => view.id)).toEqual(['devspaces.repositories', DOCKER_HOSTS_VIEW_ID]);
  });

  it('offers on each row exactly its actions', () => {
    const stoppedVm = hostRowLook({ hostsNode: 'host', host: LIMA_HOST, vm: true, selected: true, vmState: { kind: 'stopped' } }).contextValue;
    expect(commandsOf(stoppedVm)).toEqual(['devspaces.startVm', 'devspaces.vmSettings', 'devspaces.showUtilization', 'devspaces.updateImagesNow', 'devspaces.removeFromDockerEngine', 'devspaces.removeVm', 'devspaces.resetVm']);
    const notSetUp = hostRowLook({ hostsNode: 'host', host: LIMA_HOST, vm: true, selected: false, vmState: { kind: 'notSetUp' } }).contextValue;
    expect(commandsOf(notSetUp)).toEqual(['devspaces.setUpLimaVm', 'devspaces.setUpWslDistribution', 'devspaces.vmSettings']);
    const remote = hostRowLook({ hostsNode: 'host', host: 'lab', vm: false, selected: false }).contextValue;
    expect(commandsOf(remote)).toEqual(['devspaces.showUtilization', 'devspaces.updateImagesNow', 'devspaces.removeFromDockerEngine', 'devspaces.removeDockerHostFromList']);
    expect(commandsOf(objectRowLook(objectRow(container('running', { purpose: 'devspace' }), 'id-1')).contextValue)).toEqual(['devspaces.stop', 'devspaces.delete']);
    expect(commandsOf(objectRowLook(objectRow(container('running'))).contextValue)).toEqual(['devspaces.stopDockerObject']);
    expect(commandsOf(objectRowLook(objectRow(container('exited'))).contextValue)).toEqual(['devspaces.removeDockerObjects']);
    expect(commandsOf(objectRowLook(objectRow(container('exited', { purpose: 'notDevspaces' }))).contextValue)).toEqual(['devspaces.startDockerObject', 'devspaces.removeDockerObjects']);
    expect(commandsOf(objectRowLook(objectRow({ kind: 'network', id: 'n1', name: 'bridge', purpose: 'notDevspaces', builtIn: true })).contextValue)).toEqual([]);
    const cache = { records: 1, bytes: 10, unusedBytes: 10 };
    expect(commandsOf(buildCacheRowLook({ hostsNode: 'buildCache', host: 'lab', cache }).contextValue)).toEqual(['devspaces.pruneBuildCache']);
    expect(commandsOf(buildCacheRowLook({ hostsNode: 'buildCache', host: 'lab', cache: { ...cache, unusedBytes: 0 } }).contextValue)).toEqual([]);
  });
});
