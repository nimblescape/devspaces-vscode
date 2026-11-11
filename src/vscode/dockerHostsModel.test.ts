// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The rows of the view "Docker Hosts" (R-ENG-008, R-VM-010): their order, their flags for the menus of package.json, and
// the actions of each object (H2 of the design).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { LIMA_HOST, WSL_HOST } from '../core/docker/dockerHost';
import type { HostObject } from '../core/hosts/hostObjects';
import { Commands } from './commands';
import {
  DOCKER_HOSTS_VIEW_ID,
  groupRowLook,
  hostOfArgument,
  hostOfNode,
  hostRowLook,
  hostRows,
  messageRowLook,
  objectActions,
  objectRowLook,
  objectRows,
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
  });

  it('offers Start for a stopped VM and Stop for a running one; the selected host has a check mark and no Select', () => {
    expect(hostRowLook(vm('stopped')).contextValue).toBe('hostsHost;vm;vmSetUp;engine;vmCanStart;canSelect');
    expect(hostRowLook(vm('unknown')).contextValue).toContain(';vmCanStart');
    const running = hostRowLook(vm('running', true));
    expect(running.contextValue).toBe('hostsHost;vm;vmSetUp;engine;vmCanStop;selected');
    expect(running.icon).toBe('check');
    expect(running.command).toEqual({ command: Commands.selectDockerHost, title: 'Select', arguments: [vm('running', true)] });
  });

  it('says the memory, the CPUs and the space of the disk of the VM in its tooltip', () => {
    const look = hostRowLook({ hostsNode: 'host', host: LIMA_HOST, vm: true, selected: false, vmState: { kind: 'stopped', memoryGiB: 4, cpus: 2, diskBytes: 3_200_000_000 } });
    expect(look.tooltip).toContain('4 GiB of memory, 2 CPUs, its disk takes 3.2 GB on this computer.');
    expect(look.tooltip).toContain('Devspaces does not start it to read it.');
  });

  it('gives a remote host the actions of its engine and Remove from the List', () => {
    const look = hostRowLook({ hostsNode: 'host', host: 'lab', vm: false, selected: false });
    expect(look.contextValue).toBe('hostsHost;remote;engine;canSelect');
    expect(look.collapsible).toBe('collapsed');
  });
});

describe('objectActions', () => {
  it('gives the objects of a devspace of this computer its Stop and Delete…, never Remove…', () => {
    expect(objectActions(objectRow(container('running', { purpose: 'devspace' }), 'id-1'))).toEqual({ stopDevspace: true, deleteDevspace: true, stop: false, remove: false });
    expect(objectActions(objectRow({ kind: 'volume', id: 'v', name: 'v', purpose: 'devspace' }, 'id-1'))).toEqual({ stopDevspace: false, deleteDevspace: true, stop: false, remove: false });
  });

  it('gives any other running container Stop first, and Remove… only after it stopped', () => {
    expect(objectActions(objectRow(container('running')))).toEqual({ stopDevspace: false, deleteDevspace: false, stop: true, remove: false });
    expect(objectActions(objectRow(container('paused')))).toMatchObject({ stop: true, remove: false });
    expect(objectActions(objectRow(container('exited')))).toMatchObject({ stop: false, remove: true });
    expect(objectActions(objectRow({ kind: 'image', id: 'sha256:1', name: 'devspaces-worker:1', purpose: 'helperImage' }))).toMatchObject({ remove: true });
  });

  it('names the actions in the context value, which the menus of package.json match', () => {
    expect(objectRowLook(objectRow(container('running'))).contextValue).toBe('hostsObject;container;monitor;canStop');
    expect(objectRowLook(objectRow(container('exited', { purpose: 'otherDevspace' }))).contextValue).toBe('hostsObject;container;otherDevspace;canRemove');
    expect(objectRowLook(objectRow(container('running', { purpose: 'devspace' }), 'id-1')).contextValue).toBe('hostsObject;container;devspace;canStopDevspace;canDeleteDevspace');
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
    expect(commandsOf(stoppedVm)).toEqual(['devspaces.startVm', 'devspaces.vmSettings', 'devspaces.updateImagesNow', 'devspaces.removeFromDockerEngine', 'devspaces.removeVm', 'devspaces.resetVm']);
    const notSetUp = hostRowLook({ hostsNode: 'host', host: LIMA_HOST, vm: true, selected: false, vmState: { kind: 'notSetUp' } }).contextValue;
    expect(commandsOf(notSetUp)).toEqual(['devspaces.setUpLimaVm', 'devspaces.setUpWslDistribution', 'devspaces.vmSettings']);
    const remote = hostRowLook({ hostsNode: 'host', host: 'lab', vm: false, selected: false }).contextValue;
    expect(commandsOf(remote)).toEqual(['devspaces.selectDockerHost', 'devspaces.updateImagesNow', 'devspaces.removeFromDockerEngine', 'devspaces.removeDockerHostFromList']);
    expect(commandsOf(objectRowLook(objectRow(container('running', { purpose: 'devspace' }), 'id-1')).contextValue)).toEqual(['devspaces.stop', 'devspaces.delete']);
    expect(commandsOf(objectRowLook(objectRow(container('running'))).contextValue)).toEqual(['devspaces.stopDockerObject']);
    expect(commandsOf(objectRowLook(objectRow(container('exited'))).contextValue)).toEqual(['devspaces.removeDockerObjects']);
  });
});
