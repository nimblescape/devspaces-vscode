// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The management of the VM of Devspaces in its row of the view "Docker Hosts" (R-VM-010).
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { LIMA_HOST } from '../core/docker/dockerHost';
import type { VmState } from '../core/vm/vmState';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';
import { VM_SETTINGS_QUERY, VmCommands, VmTexts, type VmCommandsDeps } from './vmCommands';

const { window } = fakeVscode;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };

let state: VmState;
let deps: { [K in keyof VmCommandsDeps]: VmCommandsDeps[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : VmCommandsDeps[K] };
/** The order of the calls that change the VM. */
let calls: string[];

function vm(extra: Partial<VmCommandsDeps> = {}): VmCommands {
  return new VmCommands({ ...(deps as unknown as VmCommandsDeps), ...extra });
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
  state = { kind: 'running' };
  calls = [];
  deps = {
    logger,
    showLog: vi.fn(),
    vmHost: LIMA_HOST,
    hasSettings: true,
    state: vi.fn(async () => state),
    start: vi.fn(async () => true),
    runningDevspaces: vi.fn(async () => []),
    stop: vi.fn(async () => {
      calls.push('stop');
    }),
    closeConnections: vi.fn(() => {
      calls.push('close');
    }),
    remove: vi.fn(async () => undefined),
    removeAndSetUpAgain: vi.fn(async () => {
      calls.push('reset');
    }),
    setUp: vi.fn(async () => undefined),
    onDidChange: vi.fn(),
  } as unknown as typeof deps;
  window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
    task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
  );
});

describe('VmCommands.start', () => {
  it('starts a stopped VM with the test of its host, and the view reads its state again', async () => {
    state = { kind: 'stopped' };
    await vm().start();
    expect(deps.start).toHaveBeenCalledWith(LIMA_HOST);
    await settle();
    expect(window.showInformationMessage).toHaveBeenCalledWith(VmTexts.started);
    expect(deps.onDidChange).toHaveBeenCalledWith(true);
  });

  it('says that a running VM runs, and offers the setup of a VM that is not set up', async () => {
    await vm().start();
    expect(deps.start).not.toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalledWith(VmTexts.alreadyRunning);
    state = { kind: 'notSetUp' };
    window.showInformationMessage.mockResolvedValueOnce(VmTexts.setUp);
    await vm().start();
    await settle();
    expect(deps.setUp).toHaveBeenCalledTimes(1);
  });
});

describe('VmCommands.stop', () => {
  it('stops the VM without a question while no devspace runs there, after the connections of this window ended', async () => {
    await vm().stop();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(calls).toEqual(['close', 'stop']);
    await settle();
    expect(window.showInformationMessage).toHaveBeenCalledWith(VmTexts.stopped);
  });

  it('names the devspaces that run there and stops only after the answer Stop the VM', async () => {
    deps.runningDevspaces.mockResolvedValue(['majikmate/web', 'majikmate/api']);
    await vm().stop();
    expect(window.showWarningMessage).toHaveBeenCalledWith(VmTexts.stopQuestion, { modal: true, detail: VmTexts.stopDetail(['majikmate/web', 'majikmate/api']) }, VmTexts.stop);
    expect(calls).toEqual([]);
    window.showWarningMessage.mockResolvedValueOnce(VmTexts.stop);
    await vm().stop();
    expect(calls).toEqual(['close', 'stop']);
  });

  it('never asks a VM that does not run for its devspaces, because the Docker call could start it', async () => {
    state = { kind: 'stopped' };
    await vm().stop();
    expect(deps.runningDevspaces).not.toHaveBeenCalled();
    expect(deps.stop).not.toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalledWith(VmTexts.notRunning);
    state = { kind: 'unknown' };
    await vm().stop();
    expect(deps.runningDevspaces).not.toHaveBeenCalled();
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });

  it('says why when the VM could not be stopped', async () => {
    deps.stop.mockRejectedValue(new Error('limactl stop failed'));
    await vm().stop();
    await settle();
    expect(window.showErrorMessage).toHaveBeenCalledWith(`${VmTexts.stopFailed} limactl stop failed`, 'Show details');
  });
});

describe('VmCommands.reset', () => {
  it('asks first, then ends the connections and sets up a new VM', async () => {
    await vm().reset();
    expect(window.showWarningMessage).toHaveBeenCalledWith(VmTexts.resetQuestion, { modal: true, detail: VmTexts.resetDetail }, VmTexts.reset);
    expect(calls).toEqual([]);
    window.showWarningMessage.mockResolvedValueOnce(VmTexts.reset);
    await vm().reset();
    expect(calls).toEqual(['close', 'reset']);
    expect(deps.onDidChange).toHaveBeenLastCalledWith(true);
  });
});

describe('VmCommands without a VM, and the settings', () => {
  it('says that this computer has no VM', async () => {
    const commands = vm({ vmHost: undefined });
    await commands.start();
    await commands.stop();
    await commands.remove();
    await commands.reset();
    expect(window.showInformationMessage).toHaveBeenCalledTimes(4);
    expect(window.showInformationMessage).toHaveBeenCalledWith(VmTexts.noVm);
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('opens the settings of the memory and the CPUs of the VM, and on Windows says where they are', async () => {
    await vm().settings();
    expect(fakeVscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.openSettings', VM_SETTINGS_QUERY);
    expect(VM_SETTINGS_QUERY).toBe('@id:devspaces.vmMemoryGiB,devspaces.vmCpus');
    await vm({ hasSettings: false }).settings();
    expect(window.showInformationMessage).toHaveBeenCalledWith(VmTexts.settingsNotHere);
  });
});
