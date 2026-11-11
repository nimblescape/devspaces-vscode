// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { LIMA_HOST } from '../core/docker/dockerHost';
import { Actions } from '../core/messages';
import { abortError } from '../core/ports';
import { LimaSetupError, type LimaSetupStep } from '../core/vm/limaSetup';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';
import { LimaSetupCommands, LimaSetupTexts, type LimaSetupCommandsDeps } from './limaSetupCommands';

const { window } = fakeVscode;
const FOLDER = '/Users/ana/.nimblescape/devspaces';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };

type Setup = NonNullable<LimaSetupCommandsDeps['setup']>;
let setup: { precondition: Mock<Setup['precondition']>; setUp: Mock<Setup['setUp']>; linuxNeeds: Mock<Setup['linuxNeeds']>; remove: Mock<Setup['remove']> };
let useHost: Mock<LimaSetupCommandsDeps['useHost']>;
let useRemoteHost: Mock<LimaSetupCommandsDeps['useRemoteHost']>;
let showLog: Mock<() => void>;
/** The messages of the progress notification, as reported. */
let reports: Array<{ message?: string; increment?: number }>;
/** Cancels the progress notification that runs. */
let cancel: () => void;

function commands(extra: Partial<LimaSetupCommandsDeps> = {}): LimaSetupCommands {
  return new LimaSetupCommands({ setup, folder: FOLDER, logger, showLog, useRemoteHost, useHost, ...extra });
}

/** Lets the then() of a shown message run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
  reports = [];
  cancel = () => undefined;
  setup = {
    precondition: vi.fn(() => undefined),
    linuxNeeds: vi.fn(() => ({ kvm: 'ok' as const, qemuMissing: [] })),
    remove: vi.fn(async () => true),
    setUp: vi.fn(async (onStep: (step: LimaSetupStep) => void, _signal?: AbortSignal) => {
      onStep({ kind: 'lima' });
      onStep({ kind: 'download', received: 0, total: undefined });
      onStep({ kind: 'download', received: 50, total: 100 });
      // Another piece of the same percent: no new report.
      onStep({ kind: 'download', received: 50.5, total: 100 });
      onStep({ kind: 'create' });
      onStep({ kind: 'start' });
      onStep({ kind: 'docker' });
    }),
  };
  useHost = vi.fn(async (_host: string) => true);
  useRemoteHost = vi.fn(async () => undefined);
  showLog = vi.fn();
  window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) => {
    const listeners: Array<() => void> = [];
    cancel = () => listeners.forEach((listener) => listener());
    return task(
      { report: (value: { message?: string; increment?: number }) => reports.push(value) },
      { isCancellationRequested: false, onCancellationRequested: (listener: () => void) => (listeners.push(listener), { dispose() {} }) },
    );
  });
});

describe('LimaSetupCommands', () => {
  // Mutation: a question before the setup, or a setup that does not use the VM afterwards, fails it.
  it('sets up the VM without a question, shows its steps, and then uses it as the Docker host', async () => {
    await commands().setUp();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(LimaSetupTexts.setUpLog(FOLDER));
    const messages = reports.map((report) => (report.message ?? '').replace(/ \[Show details\]\(command:[^)]*\)$/, ''));
    expect(messages).toEqual([
      LimaSetupTexts.settingUp,
      `${LimaSetupTexts.settingUp} Downloading Lima, which runs the VM.`,
      `${LimaSetupTexts.settingUp} Downloading the disk of the VM.`,
      `${LimaSetupTexts.settingUp} Downloading the disk of the VM: 50 %.`,
      `${LimaSetupTexts.settingUp} Creating the VM.`,
      `${LimaSetupTexts.settingUp} Starting the VM.`,
      `${LimaSetupTexts.settingUp} Waiting for Docker in the VM.`,
    ]);
    // The bar never goes back, and ends below 100 % for the test of the host.
    const total = reports.reduce((sum, report) => sum + (report.increment ?? 0), 0);
    expect(total).toBe(95);
    expect(useHost.mock.calls).toEqual([[LIMA_HOST]]);
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('says that Devspaces does not use the VM when the test of the host fails, and that one setup runs at a time', async () => {
    useHost.mockResolvedValue(false);
    await expect(commands().ensureDockerHost()).resolves.toBe('notUsed');
    expect(window.showInformationMessage.mock.calls).toEqual([[LimaSetupTexts.readyNotUsed]]);

    let release: () => void = () => undefined;
    setup.setUp.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    useHost.mockResolvedValue(true);
    const subject = commands();
    const first = subject.ensureDockerHost();
    await settle();
    await expect(subject.ensureDockerHost()).resolves.toBe('notUsed');
    expect(window.showInformationMessage).toHaveBeenLastCalledWith(LimaSetupTexts.busy);
    release();
    await expect(first).resolves.toBe('used');
  });

  // Mutation: a setup that starts a download on a computer without /dev/kvm, or no offer of a remote host, fails it.
  it('stops before anything is downloaded on a computer without /dev/kvm, and offers a remote host', async () => {
    setup.precondition.mockReturnValue(new LimaSetupError('kvmMissing', 'This computer has no /dev/kvm.'));
    window.showErrorMessage.mockResolvedValueOnce(LimaSetupTexts.useRemoteHost);
    await expect(commands().ensureDockerHost()).resolves.toBe('notUsed');
    await settle();
    expect(setup.setUp).not.toHaveBeenCalled();
    expect(window.showErrorMessage.mock.calls).toEqual([[LimaSetupTexts.problem('kvmMissing'), LimaSetupTexts.useRemoteHost, Actions.showDetails]]);
    expect(useRemoteHost).toHaveBeenCalledTimes(1);
    expect(useHost).not.toHaveBeenCalled();
  });

  it('names a missing QEMU with Show details only, and opens the log on a click', async () => {
    setup.precondition.mockReturnValue(new LimaSetupError('qemuMissing', 'QEMU is not installed: qemu-img not found.'));
    window.showErrorMessage.mockResolvedValueOnce(Actions.showDetails);
    await commands().setUp();
    await settle();
    expect(window.showErrorMessage.mock.calls).toEqual([[LimaSetupTexts.problem('qemuMissing'), Actions.showDetails]]);
    expect(logger.error).toHaveBeenCalledWith(`${LimaSetupTexts.problem('qemuMissing')} QEMU is not installed: qemu-img not found.`);
    expect(showLog).toHaveBeenCalledTimes(1);
  });

  // Mutation: a cancel that does not reach the signal of the setup, or an error message after a cancel, fails it.
  it('stops the step that runs on Cancel, and only logs the cancel', async () => {
    setup.setUp.mockImplementation(
      (_onStep, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(abortError()));
        }),
    );
    const running = commands().ensureDockerHost();
    await settle();
    cancel();
    await expect(running).resolves.toBe('notUsed');
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(LimaSetupTexts.cancelled);
  });

  it('shows nothing for a link where this computer has no VM setup, and says so for the command', async () => {
    await expect(commands({ setup: undefined }).ensureDockerHost()).resolves.toBe('unavailable');
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    await commands({ setup: undefined }).setUp();
    expect(window.showInformationMessage.mock.calls).toEqual([[LimaSetupTexts.notAvailable]]);
  });

  describe('the installation of QEMU on Linux', () => {
    const UBUNTU = { ID: 'ubuntu', ID_LIKE: 'debian', VERSION_CODENAME: 'noble' };
    let runInTerminal: Mock<(commands: string[]) => void>;
    let local: boolean;
    const installQemu = () => ({ input: async () => ({ arch: 'x64', osRelease: UBUNTU, userName: 'ada' }), localWindow: () => local, runInTerminal });

    beforeEach(() => {
      runInTerminal = vi.fn();
      local = true;
    });

    // Mutation: a question before the terminal, or a setup that does not go on once QEMU is there, fails it.
    it('installs QEMU in a terminal without a question, and goes on with the setup once QEMU is found', async () => {
      const missing = new LimaSetupError('qemuMissing', 'QEMU is not installed: qemu-img not found.');
      setup.precondition.mockReturnValue(missing);
      setup.linuxNeeds.mockReturnValue({ kvm: 'ok', qemuMissing: ['qemu-img'] });
      await expect(commands({ installQemu: installQemu(), qemuWatch: { intervalMs: 1, forMs: 60_000 } }).ensureDockerHost()).resolves.toBe('notUsed');
      expect(window.showWarningMessage).not.toHaveBeenCalled();
      expect(window.showErrorMessage).not.toHaveBeenCalled();
      expect(runInTerminal.mock.calls).toEqual([[['sudo apt-get update', 'sudo apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils ovmf']]]);
      expect(window.showInformationMessage.mock.calls).toEqual([[LimaSetupTexts.qemuInstalling(true, false)]]);
      expect(LimaSetupTexts.qemuInstalling(true, false)).toBe(
        'Devspaces installs QEMU, which runs its VM on Linux, in the terminal "Install QEMU". Enter your password there. Then Devspaces goes on with the setup of its Docker by itself.',
      );
      // QEMU arrives: the setup runs, and Devspaces uses the VM.
      setup.precondition.mockReturnValue(undefined);
      await vi.waitFor(() => expect(useHost).toHaveBeenCalledWith(LIMA_HOST));
      expect(setup.setUp).toHaveBeenCalledTimes(1);
    });

    it('adds the user to the group kvm and says to log in again, without going on by itself', async () => {
      setup.precondition.mockReturnValue(new LimaSetupError('kvmAccess', 'Your user may not use /dev/kvm.'));
      setup.linuxNeeds.mockReturnValue({ kvm: 'access', qemuMissing: [] });
      const subject = commands({ installQemu: installQemu(), qemuWatch: { intervalMs: 1, forMs: 60_000 } });
      await subject.setUp();
      expect(runInTerminal.mock.calls).toEqual([[['sudo usermod -aG kvm ada']]]);
      expect(window.showInformationMessage.mock.calls).toEqual([[LimaSetupTexts.qemuInstalling(false, true)]]);
      expect(LimaSetupTexts.qemuInstalling(false, true)).toContain('Then log out of this computer and in again, and set up Docker for Devspaces again.');
      setup.precondition.mockReturnValue(undefined);
      await settle();
      await settle();
      expect(setup.setUp).not.toHaveBeenCalled();
      subject.dispose();
    });

    it('names the problem on a distribution without a plan, and installs nothing from a remote window', async () => {
      setup.precondition.mockReturnValue(new LimaSetupError('qemuMissing', 'QEMU is not installed: qemu-img not found.'));
      setup.linuxNeeds.mockReturnValue({ kvm: 'ok', qemuMissing: ['qemu-img'] });
      await commands({ installQemu: { ...installQemu(), input: async () => ({ arch: 'x64', osRelease: { ID: 'rhel' }, userName: 'ada' }) } }).setUp();
      expect(window.showErrorMessage.mock.calls).toEqual([[LimaSetupTexts.problem('qemuMissing'), Actions.showDetails]]);
      local = false;
      await commands({ installQemu: installQemu() }).setUp();
      expect(runInTerminal).not.toHaveBeenCalled();
      expect(window.showInformationMessage.mock.calls).toEqual([[LimaSetupTexts.qemuLocalWindow]]);
    });

    it('stops looking for QEMU after its time, and says so', async () => {
      setup.precondition.mockReturnValue(new LimaSetupError('qemuMissing', 'QEMU is not installed: qemu-img not found.'));
      setup.linuxNeeds.mockReturnValue({ kvm: 'ok', qemuMissing: ['qemu-img'] });
      await commands({ installQemu: installQemu(), qemuWatch: { intervalMs: 1, forMs: 0 } }).setUp();
      await vi.waitFor(() => expect(window.showInformationMessage).toHaveBeenLastCalledWith(LimaSetupTexts.qemuNotFound));
      expect(setup.setUp).not.toHaveBeenCalled();
    });
  });
});

describe('Remove the VM… and Remove and Set Up the VM Again… (R-VM-010)', () => {
  it('asks first, and removes nothing without the answer', async () => {
    window.showWarningMessage.mockResolvedValue(undefined);
    const forgetHost = vi.fn(async () => true);
    await commands({ forgetHost }).remove();
    expect(window.showWarningMessage.mock.calls[0][0]).toBe(LimaSetupTexts.confirmRemove);
    expect(window.showWarningMessage.mock.calls[0][1]).toMatchObject({ modal: true, detail: LimaSetupTexts.confirmRemoveDetail(FOLDER) });
    expect(setup.remove).not.toHaveBeenCalled();
    expect(forgetHost).not.toHaveBeenCalled();
  });

  it('removes the VM after the answer, ends the connections first, and takes the host out of the list', async () => {
    window.showWarningMessage.mockResolvedValue(LimaSetupTexts.remove);
    const order: string[] = [];
    const beforeRemove = vi.fn(() => order.push('close'));
    setup.remove.mockImplementation(async () => {
      order.push('remove');
      return true;
    });
    const forgetHost = vi.fn(async (_host: string) => {
      order.push('forget');
      return true;
    });
    const afterRemove = vi.fn(async () => {
      order.push('after');
    });
    await commands({ forgetHost, beforeRemove, afterRemove }).remove();
    expect(order).toEqual(['close', 'remove', 'forget', 'after']);
    expect(forgetHost).toHaveBeenCalledWith(LIMA_HOST);
    expect(window.showInformationMessage).toHaveBeenCalledWith(LimaSetupTexts.removed(true));
  });

  it('says so when the removal fails', async () => {
    window.showWarningMessage.mockResolvedValue(LimaSetupTexts.remove);
    setup.remove.mockRejectedValue(new LimaSetupError('failed', 'limactl delete failed: boom'));
    await commands({ forgetHost: vi.fn(async () => false) }).remove();
    expect(window.showErrorMessage.mock.calls).toEqual([[LimaSetupTexts.removeFailed, Actions.showDetails]]);
  });

  it('removes the VM without another question and sets it up again, which Devspaces then uses', async () => {
    const forgetHost = vi.fn(async () => true);
    await commands({ forgetHost }).removeAndSetUpAgain();
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(setup.remove).toHaveBeenCalledTimes(1);
    expect(setup.setUp).toHaveBeenCalledTimes(1);
    expect(useHost).toHaveBeenCalledWith(LIMA_HOST);
    // The host stays in the list meanwhile.
    expect(forgetHost).not.toHaveBeenCalled();
  });
});
