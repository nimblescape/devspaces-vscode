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
let setup: { precondition: Mock<Setup['precondition']>; setUp: Mock<Setup['setUp']> };
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
});
