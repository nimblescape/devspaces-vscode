// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { WSL_HOST } from '../core/docker/dockerHost';
import { WslSetupError, type WslImage, type WslRegistration, type WslSeparation, type WslSetupStep } from '../core/docker/wslSetup';
import { Actions } from '../core/messages';
import { DockerSetupTexts } from '../core/docker/dockerSetup';
import { abortError } from '../core/ports';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';
import { WslSetupCommands, WslSetupTexts, type WslSetupCommandsDeps } from './wslSetupCommands';

const { window } = fakeVscode;
const FOLDER = 'C:\\Users\\ana\\AppData\\Local\\nimblescape\\devspaces\\wsl';
const IMAGE: WslImage & { size: number } = {
  name: 'Debian',
  url: 'https://salsa.debian.org/debian/WSL/-/jobs/1/artifacts/raw/Debian_WSL_AMD64_v1.0.0.0.wsl',
  sha256: 'ab'.repeat(32),
  size: 117 * 1_048_576 + 1,
};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
const LINK = { path: '/course', query: 'repository=school/course-<username>' };

/** The messages of the progress notifications, as reported. */
let reports: Array<{ message?: string; increment?: number }>;
type Setup = NonNullable<WslSetupCommandsDeps['setup']>;
/** The lock of all windows: runs the task, or undefined (another window holds it). */
type Locked = (task: () => Promise<unknown>) => Promise<{ value: unknown } | undefined>;
let setup: { [K in Exclude<keyof Setup, 'locked'>]: Mock<Setup[K]> } & { locked: Mock<Locked> };
let useHost: Mock<WslSetupCommandsDeps['useHost']>;
let forgetHost: Mock<WslSetupCommandsDeps['forgetHost']>;
let showLog: Mock<() => void>;
let installWsl: Mock<WslSetupCommandsDeps['installWsl']>;

function commands(extra: Partial<WslSetupCommandsDeps> = {}): WslSetupCommands {
  return new WslSetupCommands({
    setup: setup as unknown as Setup,
    folder: FOLDER,
    isWindows: true,
    logger,
    showLog,
    installWsl,
    useHost,
    forgetHost,
    ...extra,
  });
}

function registered(registration: WslRegistration): void {
  setup.registration.mockResolvedValue(registration);
}

/** The modal questions that were shown: their message, detail and button. */
function questions(): Array<{ message: string; detail: string; button: string }> {
  return window.showWarningMessage.mock.calls
    .filter((call: unknown[]) => (call[1] as { modal?: boolean } | undefined)?.modal === true)
    .map((call: unknown[]) => ({ message: call[0] as string, detail: (call[1] as { detail: string }).detail, button: call[2] as string }));
}

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
  reports = [];
  setup = {
    checkWsl: vi.fn(async (_signal?: AbortSignal) => '2.6.1'),
    checkVirtualMachine: vi.fn(async (_signal?: AbortSignal) => undefined),
    registration: vi.fn(async (): Promise<WslRegistration> => 'none'),
    image: vi.fn(async (_signal?: AbortSignal): Promise<WslImage> => IMAGE),
    setUp: vi.fn(async (_image: unknown, onStep: (step: WslSetupStep) => void, _signal?: AbortSignal) => {
      onStep({ kind: 'download', received: 0, total: IMAGE.size });
      onStep({ kind: 'download', received: IMAGE.size / 2, total: IMAGE.size });
      // Another piece of the same megabyte and percent: no new report.
      onStep({ kind: 'download', received: IMAGE.size / 2 + 1024, total: IMAGE.size });
      onStep({ kind: 'download', received: IMAGE.size, total: IMAGE.size });
      onStep({ kind: 'register' });
      onStep({ kind: 'docker', phase: 'docker' });
      return { version: '29.9.2', separation: { state: 'separate', dockerDesktop: true } as WslSeparation };
    }),
    remove: vi.fn(async (_signal?: AbortSignal) => true),
    removeLeftovers: vi.fn(async () => true),
    locked: vi.fn(async (task: () => Promise<unknown>) => ({ value: await task() })),
    separate: vi.fn(async (): Promise<WslSeparation> => ({ state: 'separate', dockerDesktop: true })),
  };
  useHost = vi.fn(async (_host: string) => true);
  forgetHost = vi.fn(async (_host: string): Promise<'notDockerHost' | 'local' | 'unsupported'> => 'notDockerHost');
  showLog = vi.fn();
  installWsl = vi.fn(async () => undefined);
  window.withProgress.mockImplementation(async (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) =>
    task(
      { report: (value: { message?: string; increment?: number }) => reports.push(value) },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    ),
  );
});

describe('the check at the start of a window', () => {
  // Mutation: a check that does not call separate fails it (WSL makes the distribution the default after the removal of
  // the default of the user); so does a warning for a distribution that Devspaces did not set up, or at each check.
  it('keeps the distribution off the default of WSL, and warns once while Docker Desktop integrates it', async () => {
    const dockerDesktopIntegrates = vi.fn(async (_isDefault: boolean) => true);
    const subject = commands({ dockerDesktopIntegrates });
    await subject.checkSeparation();
    await subject.checkSeparation();
    expect(setup.separate).toHaveBeenCalledTimes(2);
    expect(window.showWarningMessage.mock.calls).toEqual([[WslSetupTexts.dockerDesktopIntegrates]]);
    expect(logger.warn).toHaveBeenCalledWith(WslSetupTexts.dockerDesktopIntegrates);
    expect(dockerDesktopIntegrates.mock.calls).toEqual([[false]]);
    // Not for a distribution that Devspaces did not set up, or that is not there.
    setup.separate.mockResolvedValue({ state: 'none', dockerDesktop: true });
    const other = commands({ dockerDesktopIntegrates });
    await other.checkSeparation();
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(dockerDesktopIntegrates).toHaveBeenCalledTimes(1);
  });

  // Mutation: a check of the settings without the distribution of Docker Desktop fails it (the settings files can stay
  // after its removal); so does a check flag that is set only before the read (two checks would both warn).
  it('warns only while WSL has the distribution of Docker Desktop, and once also for two checks at the same time', async () => {
    const dockerDesktopIntegrates = vi.fn(async (_isDefault: boolean) => true);
    setup.separate.mockResolvedValueOnce({ state: 'separate', dockerDesktop: false });
    const subject = commands({ dockerDesktopIntegrates });
    await subject.checkSeparation();
    expect(dockerDesktopIntegrates).not.toHaveBeenCalled();
    await Promise.all([subject.checkSeparation(), subject.checkSeparation()]);
    expect(dockerDesktopIntegrates).toHaveBeenCalledTimes(2);
    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  // Mutation: a check without the default integration while the distribution stays the default fails it; so does a
  // check when the registry cannot be read (nothing tells that Devspaces set up the distribution).
  it('counts the default integration of Docker Desktop while the distribution stays the default of WSL', async () => {
    const dockerDesktopIntegrates = vi.fn(async (_isDefault: boolean) => false);
    setup.separate.mockResolvedValueOnce({ state: 'default', dockerDesktop: true }).mockResolvedValueOnce({ state: 'unknown', dockerDesktop: undefined });
    await commands({ dockerDesktopIntegrates }).checkSeparation();
    await commands({ dockerDesktopIntegrates }).checkSeparation();
    expect(dockerDesktopIntegrates.mock.calls).toEqual([[true]]);
  });

  it('never throws (logged), and warns after a setup while Docker Desktop integrates the distribution', async () => {
    setup.separate.mockRejectedValueOnce(new Error('EPERM'));
    await commands().checkSeparation();
    expect(logger.error).toHaveBeenCalledWith('The WSL distribution of Devspaces could not be checked.', expect.any(Error));
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.setUp);
    setup.separate.mockClear();
    await commands({ dockerDesktopIntegrates: async () => true }).setUp();
    expect(window.showWarningMessage).toHaveBeenLastCalledWith(WslSetupTexts.dockerDesktopIntegrates);
    // With what the check of the setup found, without another one.
    expect(setup.separate).not.toHaveBeenCalled();
  });
});

// A link on Windows without Docker (R-GEN-002, R-ENG-005): the WSL distribution of Devspaces becomes the Docker host,
// after the check of WSL and without a question, and useHost downloads the Docker CLI of Devspaces when the computer has
// none.
describe('Docker for a flow on Windows without Docker', () => {
  // Mutation: a question before the setup fails it (Hannes: as few interactions as possible for students).
  it('checks WSL and its virtual machine, sets up the distribution without a question, and then uses it', async () => {
    expect(await commands().ensureDockerHost(LINK)).toBe('used');
    expect(setup.checkWsl).toHaveBeenCalledTimes(1);
    expect(setup.checkVirtualMachine).toHaveBeenCalledTimes(1);
    expect(window.showWarningMessage.mock.calls.filter((call: unknown[]) => call[0] !== WslSetupTexts.dockerDesktopIntegrates)).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(WslSetupTexts.setUpLog(IMAGE, FOLDER));
    expect(setup.setUp).toHaveBeenCalledWith(IMAGE, expect.any(Function), expect.any(AbortSignal));
    expect(useHost.mock.calls).toEqual([[WSL_HOST]]);
  });

  // Mutation: a flow that sets up the distribution of Devspaces again fails it (a question, and a restart of the
  // distribution that stops its devspaces).
  it('uses a distribution that Devspaces set up before as it is, without a question, under the lock of all windows', async () => {
    registered('own');
    expect(await commands().ensureDockerHost()).toBe('used');
    expect(questions()).toEqual([]);
    expect(setup.setUp).not.toHaveBeenCalled();
    expect(setup.locked).toHaveBeenCalledTimes(1);
    expect(useHost.mock.calls).toEqual([[WSL_HOST]]);
    // useHost shows its own problem.
    useHost.mockResolvedValue(false);
    expect(await commands().ensureDockerHost()).toBe('notUsed');
    // Removed in another window after the check: nothing is used, and the message says so.
    useHost.mockClear();
    setup.registration.mockResolvedValueOnce('own').mockResolvedValueOnce('none');
    expect(await commands().ensureDockerHost()).toBe('notUsed');
    expect(useHost).not.toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.changedElsewhere);
  });

  it('installs WSL 2 first when WSL is missing, with the link for after the restart of Windows, and uses nothing', async () => {
    setup.checkWsl.mockRejectedValue(new WslSetupError('wslMissing', 'wsl.exe was not found.'));
    expect(await commands().ensureDockerHost(LINK)).toBe('notUsed');
    expect(installWsl.mock.calls).toEqual([[LINK]]);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(questions()).toEqual([]);
    expect(useHost).not.toHaveBeenCalled();
  });

  // Mutation: a check of the restart after the download fails it (some 100 MB that WSL cannot register before the restart).
  it('says that Windows must restart first, before any download, while the restart after the installation of WSL is missing', async () => {
    const restartPending = vi.fn(async () => true);
    const wslInstallDone = vi.fn(async () => undefined);
    setup.checkVirtualMachine.mockRejectedValue(new WslSetupError('vmUnavailable', 'wsl.exe --status says that WSL 2 cannot start'));
    expect(await commands({ restartPending, wslInstallDone }).ensureDockerHost(LINK)).toBe('notUsed');
    expect(setup.image).not.toHaveBeenCalled();
    expect(setup.setUp).not.toHaveBeenCalled();
    expect(installWsl).not.toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalledWith(DockerSetupTexts.wslRestartToGoOn);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    // The record stays for the window after the restart.
    expect(wslInstallDone).not.toHaveBeenCalled();
    // A distribution that exists needs no new check of WSL; its use makes the record needless.
    registered('own');
    expect(await commands({ restartPending, wslInstallDone }).ensureDockerHost()).toBe('used');
    expect(wslInstallDone).toHaveBeenCalledTimes(1);
  });

  // An installation of WSL that needed no restart (its virtual machine was on before) must not block the setup for days.
  it('goes on without the restart when WSL 2 can start its virtual machine, and forgets the record after the use', async () => {
    const wslInstallDone = vi.fn(async () => undefined);
    expect(await commands({ restartPending: async () => true, wslInstallDone }).ensureDockerHost(LINK)).toBe('used');
    expect(setup.setUp).toHaveBeenCalledTimes(1);
    expect(wslInstallDone).toHaveBeenCalledTimes(1);
    // Not used: the record stays.
    wslInstallDone.mockClear();
    useHost.mockResolvedValue(false);
    expect(await commands({ restartPending: async () => true, wslInstallDone }).ensureDockerHost(LINK)).toBe('notUsed');
    expect(wslInstallDone).not.toHaveBeenCalled();
  });

  it('says why WSL 2 cannot start its virtual machine, with Show details, before any download', async () => {
    setup.checkVirtualMachine.mockRejectedValue(new WslSetupError('vmUnavailable', 'wsl.exe --status says that WSL 2 cannot start'));
    expect(await commands().ensureDockerHost()).toBe('notUsed');
    expect(setup.image).not.toHaveBeenCalled();
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.problem('vmUnavailable'), Actions.showDetails);
    expect(WslSetupTexts.problem('vmUnavailable')).toContain('When WSL was installed just now, restart Windows.');
    expect(WslSetupTexts.problem('vmUnavailable')).toContain('nested virtualization in the settings of that virtual machine');
  });

  it('asks in a modal question before it uses a distribution devspaces of the user, and never changes it', async () => {
    registered('foreign');
    window.showInformationMessage.mockResolvedValueOnce(WslSetupTexts.useIt);
    expect(await commands().ensureDockerHost()).toBe('used');
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.foreign, { modal: true }, WslSetupTexts.useIt);
    expect(setup.setUp).not.toHaveBeenCalled();
    expect(useHost.mock.calls).toEqual([[WSL_HOST]]);
    useHost.mockClear();
    expect(await commands().ensureDockerHost()).toBe('notUsed');
    expect(useHost).not.toHaveBeenCalled();
  });

  it('is unavailable without the WSL setup of this computer (not Windows, or no LOCALAPPDATA), and shows nothing', async () => {
    expect(await commands({ setup: undefined, isWindows: false }).ensureDockerHost()).toBe('unavailable');
    expect(await commands({ folder: undefined }).ensureDockerHost()).toBe('unavailable');
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('uses nothing while a setup or a removal runs in this window', async () => {
    let release: () => void = () => {};
    setup.setUp.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ version: '29.9.2', separation: { state: 'separate', dockerDesktop: true } }))),
    );
    const instance = commands();
    const first = instance.setUp();
    await vi.waitFor(() => expect(setup.setUp).toHaveBeenCalledTimes(1));
    expect(await instance.ensureDockerHost()).toBe('notUsed');
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.busy);
    release();
    await first;
  });
});

describe('Set Up Docker for Devspaces in WSL…', () => {
  it('sets up a new distribution without a question, logs the downloads and the folder, shows its steps, and then uses it', async () => {
    await commands().setUp();
    expect(questions()).toEqual([]);
    const log = WslSetupTexts.setUpLog(IMAGE, FOLDER);
    expect(logger.info).toHaveBeenCalledWith(log);
    expect(log).toContain(`Debian for WSL (118 MB) from ${IMAGE.url}, checked against its SHA-256`);
    expect(log).toContain(`set up in ${FOLDER}`);
    expect(setup.setUp).toHaveBeenCalledWith(IMAGE, expect.any(Function), expect.any(AbortSignal));
    expect(useHost).toHaveBeenCalledWith(WSL_HOST);
    // The download fills the bar; the other steps only change the text.
    const messages = reports.map((report) => (report.message ?? '').replace(/ \[Show details\]\(command:[^)]*\)$/, ''));
    expect(messages).toEqual([
      WslSetupTexts.checking,
      WslSetupTexts.settingUp,
      `${WslSetupTexts.settingUp} Downloading Debian: 0 of 118 MB.`,
      `${WslSetupTexts.settingUp} Downloading Debian: 58 of 118 MB.`,
      `${WslSetupTexts.settingUp} Downloading Debian: 118 of 118 MB.`,
      `${WslSetupTexts.settingUp} Creating the WSL distribution.`,
      `${WslSetupTexts.settingUp} Installing Docker Engine.`,
    ]);
    // The download fills 40 percent; the other steps start at their places, so the bar is full only at the end.
    expect(reports.map((report) => report.increment).filter((increment) => increment !== undefined)).toEqual([20, 20, 25]);
    // Only the work after the check holds the lock of all windows.
    expect(setup.locked).toHaveBeenCalledTimes(1);
  });

  it('sets up and removes nothing while another window sets up or removes the distribution', async () => {
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.setUp);
    setup.locked.mockResolvedValueOnce(undefined);
    await commands().setUp();
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.busyElsewhere);
    expect(setup.setUp).not.toHaveBeenCalled();
    expect(useHost).not.toHaveBeenCalled();
    registered('own');
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.remove);
    setup.locked.mockResolvedValueOnce(undefined);
    await commands().remove();
    expect(setup.remove).not.toHaveBeenCalled();
    expect(forgetHost).not.toHaveBeenCalled();
    expect(window.showInformationMessage.mock.calls.filter((call: unknown[]) => call[0] === WslSetupTexts.busyElsewhere)).toHaveLength(2);
  });

  it('changes nothing when another window set up or removed the distribution after the check', async () => {
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.setUp);
    setup.registration.mockResolvedValueOnce('none').mockResolvedValueOnce('own');
    await commands().setUp();
    expect(setup.setUp).not.toHaveBeenCalled();
    expect(useHost).not.toHaveBeenCalled();
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.remove);
    setup.registration.mockResolvedValueOnce('own').mockResolvedValueOnce('none');
    await commands().remove();
    expect(setup.remove).not.toHaveBeenCalled();
    setup.registration.mockResolvedValueOnce('none').mockResolvedValueOnce('own');
    await commands().remove();
    expect(setup.removeLeftovers).not.toHaveBeenCalled();
    expect(forgetHost).not.toHaveBeenCalled();
    expect(window.showInformationMessage.mock.calls).toEqual([[WslSetupTexts.changedElsewhere], [WslSetupTexts.changedElsewhere], [WslSetupTexts.changedElsewhere]]);
  });

  it('says that the setup is done when Devspaces cannot use the distribution yet', async () => {
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.setUp);
    useHost.mockResolvedValue(false);
    await commands().setUp();
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.readyNotUsed);
    expect(WslSetupTexts.readyNotUsed).toContain(`To use it, choose "${WSL_HOST}" in "Use a Remote Docker Host…".`);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the question before the setup of an existing distribution is closed', async () => {
    registered('own');
    await commands().setUp();
    expect(questions()).toHaveLength(1);
    expect(setup.setUp).not.toHaveBeenCalled();
    expect(useHost).not.toHaveBeenCalled();
  });

  // Mutation: a new distribution that keeps the answer about the Monitor of one that was removed by hand fails it: it
  // would get a permanent Monitor and a start entry without the question; so does a repair that forgets the answer.
  it('forgets the old distribution before a new one is set up, and not for a repair', async () => {
    const order: string[] = [];
    const forgetDistribution = vi.fn(async () => void order.push('forget'));
    setup.setUp.mockImplementation(async () => (order.push('set up'), { version: '29.9.2', separation: { state: 'separate', dockerDesktop: true } }));
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.setUp);
    await commands({ forgetDistribution }).setUp();
    expect(order).toEqual(['forget', 'set up']);
    registered('own');
    await commands({ forgetDistribution }).setUp();
    expect(order).toEqual(['forget', 'set up', 'set up']);
  });

  it('sets up a distribution of Devspaces again without a download', async () => {
    registered('own');
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.setUp);
    await commands().setUp();
    expect(setup.image).not.toHaveBeenCalled();
    expect(questions()).toEqual([{ message: WslSetupTexts.confirmRepair, detail: WslSetupTexts.confirmRepairDetail, button: WslSetupTexts.setUp }]);
    expect(setup.setUp).toHaveBeenCalledWith(undefined, expect.any(Function), expect.any(AbortSignal));
    expect(useHost).toHaveBeenCalledWith(WSL_HOST);
    // Only a new distribution needs WSL 2.4.4.
    expect(setup.checkWsl).not.toHaveBeenCalled();
  });

  it('never changes a distribution devspaces that Devspaces did not set up, and offers to use it', async () => {
    registered('foreign');
    window.showInformationMessage.mockResolvedValue(WslSetupTexts.useIt);
    await commands().setUp();
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.foreign, WslSetupTexts.useIt);
    expect(questions()).toEqual([]);
    expect(setup.setUp).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(useHost).toHaveBeenCalledWith(WSL_HOST));
  });

  it('does not wait for an answer about a distribution devspaces of the user', async () => {
    registered('foreign');
    window.showInformationMessage.mockReturnValueOnce(new Promise(() => {}));
    const instance = commands();
    await instance.setUp();
    registered('own');
    await instance.setUp();
    expect(window.showInformationMessage).not.toHaveBeenCalledWith(WslSetupTexts.busy);
    expect(questions()).toHaveLength(1);
  });

  // The process of Windows without Docker: WSL first. Its installation says what happens itself (DockerSetup.installWsl),
  // so no message comes before it.
  it('installs WSL 2 first when WSL is missing', async () => {
    setup.checkWsl.mockRejectedValue(new WslSetupError('wslMissing', 'wsl.exe was not found.'));
    await commands().setUp();
    expect(installWsl.mock.calls).toEqual([[undefined]]);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(setup.image).not.toHaveBeenCalled();
    expect(questions()).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith('WSL is not installed, so Devspaces installs WSL 2 first: wsl.exe was not found.');
    // A failed installation is logged.
    installWsl.mockRejectedValueOnce(new Error('terminal not available'));
    await commands().setUp();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith('WSL 2 could not be installed: terminal not available'));
  });


  it('keeps Install WSL 2 in the message of a problem that names it', () => {
    // A user without administrator permission learns the command for an administrator.
    expect(WslSetupTexts.problem('wslMissing')).toContain('"wsl --install --no-distribution"');
  });

  it('names the problem of a failed step, with Show details, and uses nothing', async () => {
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.setUp);
    setup.setUp.mockRejectedValue(new WslSetupError('dockerFailed', 'E: Unable to locate package curl'));
    window.showErrorMessage.mockResolvedValue(Actions.showDetails);
    await commands().setUp();
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.problem('dockerFailed'), Actions.showDetails);
    await vi.waitFor(() => expect(showLog).toHaveBeenCalledTimes(1));
    expect(useHost).not.toHaveBeenCalled();
  });

  it('shows nothing after a cancel, and a general message for an unknown error', async () => {
    setup.image.mockRejectedValue(abortError());
    await commands().setUp();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('The setup of the WSL distribution of Devspaces was cancelled.');
    setup.image.mockRejectedValue(new Error('EACCES'));
    await commands().setUp();
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.failed, Actions.showDetails);
  });

  it('runs one setup at a time in a window', async () => {
    let release: () => void = () => {};
    setup.registration.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve('none'))));
    const instance = commands();
    const first = instance.setUp();
    await instance.setUp();
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.busy);
    await instance.remove();
    expect(setup.registration).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(setup.checkWsl).toHaveBeenCalledTimes(1);
  });

  it('says that the distribution exists only on Windows, or that LOCALAPPDATA is missing on Windows', async () => {
    await commands({ setup: undefined, folder: undefined, isWindows: false }).setUp();
    await commands({ setup: undefined, folder: undefined, isWindows: false }).remove();
    await commands({ setup: undefined, folder: undefined }).setUp();
    expect(window.showInformationMessage.mock.calls).toEqual([[WslSetupTexts.notWindows], [WslSetupTexts.notWindows], [WslSetupTexts.noLocalAppData]]);
  });
});

describe('Remove the WSL Distribution of Devspaces…', () => {
  it('removes the distribution of Devspaces after a warning and forgets its host', async () => {
    registered('own');
    forgetHost.mockResolvedValue('local');
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.remove);
    await commands().remove();
    expect(questions()).toEqual([{ message: WslSetupTexts.confirmRemove, detail: WslSetupTexts.confirmRemoveDetail(FOLDER), button: WslSetupTexts.remove }]);
    expect(questions()[0].detail).toContain('This cannot be undone.');
    expect(setup.remove).toHaveBeenCalledTimes(1);
    expect(forgetHost).toHaveBeenCalledWith(WSL_HOST);
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.removed(true));
    expect(WslSetupTexts.removed(true)).toBe('The WSL distribution of Devspaces was removed. Devspaces now uses the local Docker.');
    // The check before the removal must be sure that the distribution is there or gone.
    expect(setup.registration.mock.calls.every((call) => call[1] === true)).toBe(true);
  });

  // Mutation: a start entry that stays after the removal fails it: Windows would run wslg.exe for a distribution that is
  // gone at each logon; so does an answer about its Monitor that stays (the next window would add the entry again).
  it('forgets the distribution (its Monitor answer and its start entry) with its removal, and with the files of one that is gone', async () => {
    const forgetDistribution = vi.fn(async () => undefined);
    registered('own');
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.remove);
    await commands({ forgetDistribution }).remove();
    expect(setup.remove).toHaveBeenCalledTimes(1);
    expect(forgetDistribution).toHaveBeenCalledTimes(1);
    registered('none');
    await commands({ forgetDistribution }).remove();
    expect(setup.removeLeftovers).toHaveBeenCalledTimes(1);
    expect(forgetDistribution).toHaveBeenCalledTimes(2);
    // Nothing without the answer Remove, and nothing for a distribution that Devspaces did not set up.
    window.showWarningMessage.mockResolvedValue(undefined);
    registered('own');
    await commands({ forgetDistribution }).remove();
    registered('foreign');
    await commands({ forgetDistribution }).remove();
    expect(forgetDistribution).toHaveBeenCalledTimes(2);
  });

  it('names the folder of the distribution when it stays', async () => {
    registered('own');
    setup.remove.mockResolvedValue(false);
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.remove);
    await commands().remove();
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.removed(false, FOLDER));
    expect(WslSetupTexts.removed(false, FOLDER)).toBe(`The WSL distribution of Devspaces was removed. Its folder stays (the log of Devspaces says why): ${FOLDER}`);
  });

  it('does not say "local Docker" after the removal when the local Docker is not supported', async () => {
    registered('own');
    forgetHost.mockResolvedValue('unsupported');
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.remove);
    await commands().remove();
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.removed(false));
    expect(WslSetupTexts.removed(false)).toBe('The WSL distribution of Devspaces was removed.');
  });

  it('removes nothing when the warning is closed', async () => {
    registered('own');
    await commands().remove();
    expect(setup.remove).not.toHaveBeenCalled();
    expect(forgetHost).not.toHaveBeenCalled();
  });

  it('never removes a distribution devspaces that Devspaces did not set up', async () => {
    registered('foreign');
    await commands().remove();
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.foreignRemove);
    expect(questions()).toEqual([]);
    expect(setup.remove).not.toHaveBeenCalled();
    expect(forgetHost).not.toHaveBeenCalled();
  });

  it('forgets the host of a distribution that is gone and removes the files of a setup that did not end, also without WSL', async () => {
    await commands().remove();
    setup.registration.mockRejectedValue(new WslSetupError('wslMissing', 'wsl.exe was not found.'));
    forgetHost.mockRejectedValue(new Error('EBUSY'));
    await commands().remove();
    expect(forgetHost.mock.calls).toEqual([[WSL_HOST], [WSL_HOST]]);
    expect(setup.removeLeftovers).toHaveBeenCalledTimes(2);
    expect(window.showInformationMessage.mock.calls).toEqual([[WslSetupTexts.notInstalled], [WslSetupTexts.notInstalled]]);
    expect(setup.remove).not.toHaveBeenCalled();
  });

  it('says that the distribution is gone when only the list of Devspaces cannot be changed', async () => {
    registered('own');
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.remove);
    forgetHost.mockRejectedValue(new Error('EBUSY: the file is locked'));
    await commands().remove();
    expect(setup.remove).toHaveBeenCalledTimes(1);
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.removedStillListed, Actions.showDetails);
    expect(window.showErrorMessage).not.toHaveBeenCalledWith(WslSetupTexts.removeFailedUnknown, Actions.showDetails);
    expect(logger.error).toHaveBeenCalledWith(`${WSL_HOST} could not be removed from the list of Devspaces: EBUSY: the file is locked`);
  });

  it('keeps the host and the files of a setup while another window holds the lock', async () => {
    setup.locked.mockResolvedValueOnce(undefined);
    await commands().remove();
    expect(forgetHost).not.toHaveBeenCalled();
    expect(setup.removeLeftovers).not.toHaveBeenCalled();
    expect(window.showInformationMessage.mock.calls).toEqual([[WslSetupTexts.busyElsewhere]]);
  });

  it('logs a cancelled check as a cancelled removal', async () => {
    setup.registration.mockRejectedValue(abortError());
    await commands().remove();
    expect(logger.info).toHaveBeenCalledWith('The removal of the WSL distribution of Devspaces was cancelled.');
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('removes nothing when the registry does not tell whether Devspaces set up the distribution', async () => {
    setup.registration.mockRejectedValue(new WslSetupError('registryFailed', 'WSL lists the distribution devspaces, but the registry cannot be read.'));
    await commands().remove();
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.problem('registryFailed'), Actions.showDetails);
    expect(setup.remove).not.toHaveBeenCalled();
    expect(forgetHost).not.toHaveBeenCalled();
  });

  it('keeps the host when WSL refuses the removal, and says so', async () => {
    registered('own');
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.remove);
    setup.remove.mockRejectedValue(new WslSetupError('removeFailed', 'Access is denied.'));
    await commands().remove();
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.problem('removeFailed'), Actions.showDetails);
    expect(forgetHost).not.toHaveBeenCalled();
  });
});

describe('Remove and Set Up Again (a damaged disk of the distribution)', () => {
  const CORRUPT = 'Error code: Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_FILE_CORRUPT';

  // Mutation: a question before the removal fails it: the message with the button says what it deletes (Hannes: as few
  // interactions as possible for students).
  it('removes the distribution without a question, sets up a new one, uses it, and then runs the Try again of the operation', async () => {
    const forgetDistribution = vi.fn(async () => undefined);
    const retry = vi.fn();
    setup.registration.mockResolvedValueOnce('own');
    await commands({ forgetDistribution }).removeAndSetUpAgain(retry);
    expect(questions()).toEqual([]);
    expect(setup.remove).toHaveBeenCalledTimes(1);
    expect(setup.setUp).toHaveBeenCalledTimes(1);
    expect(setup.remove.mock.invocationCallOrder[0]).toBeLessThan(setup.setUp.mock.invocationCallOrder[0]);
    // The host stays in the list meanwhile, so that no other Docker takes its place; the new distribution is used.
    expect(forgetHost).not.toHaveBeenCalled();
    expect(useHost.mock.calls).toEqual([[WSL_HOST]]);
    expect(forgetDistribution).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(WslSetupTexts.removedToSetUpAgain);
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(useHost.mock.invocationCallOrder[0]).toBeLessThan(retry.mock.invocationCallOrder[0]);
  });

  it('never removes a distribution devspaces that Devspaces did not set up, and sets up nothing', async () => {
    const retry = vi.fn();
    registered('foreign');
    await commands().removeAndSetUpAgain(retry);
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.foreignRemove);
    expect(setup.remove).not.toHaveBeenCalled();
    expect(setup.setUp).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  // Mutation: a removal before these checks fails it: without them, the distribution would be gone and no new one set up.
  it('removes nothing when WSL, its virtual machine or the list of WSL distributions would stop the new setup', async () => {
    registered('own');
    setup.checkVirtualMachine.mockRejectedValueOnce(new WslSetupError('vmUnavailable', 'WSL 2 cannot start.'));
    await commands().removeAndSetUpAgain();
    setup.image.mockRejectedValueOnce(new WslSetupError('listFailed', 'ECONNRESET'));
    await commands().removeAndSetUpAgain();
    expect(window.showErrorMessage.mock.calls).toEqual([
      [WslSetupTexts.problem('vmUnavailable'), Actions.showDetails],
      [WslSetupTexts.problem('listFailed'), Actions.showDetails],
    ]);
    expect(setup.remove).not.toHaveBeenCalled();
    expect(setup.setUp).not.toHaveBeenCalled();
  });

  it('sets up nothing when the removal fails or another window holds the lock, and runs no Try again after a failed setup', async () => {
    const retry = vi.fn();
    registered('own');
    setup.remove.mockRejectedValueOnce(new WslSetupError('removeFailed', 'Access is denied.'));
    await commands().removeAndSetUpAgain(retry);
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.problem('removeFailed'), Actions.showDetails);
    setup.locked.mockResolvedValueOnce(undefined);
    await commands().removeAndSetUpAgain(retry);
    expect(window.showInformationMessage).toHaveBeenCalledWith(WslSetupTexts.busyElsewhere);
    expect(setup.setUp).not.toHaveBeenCalled();
    setup.registration.mockResolvedValueOnce('own').mockResolvedValue('none');
    setup.setUp.mockRejectedValueOnce(new WslSetupError('downloadFailed', 'ECONNRESET'));
    await commands().removeAndSetUpAgain(retry);
    expect(setup.setUp).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('offers Remove and Set Up Again when a setup finds the disk of the distribution damaged', async () => {
    registered('own');
    window.showWarningMessage.mockResolvedValue(WslSetupTexts.setUp);
    setup.setUp.mockRejectedValueOnce(new WslSetupError('dockerFailed', `Failed to attach disk: The file or directory is corrupted and unreadable.\r\n${CORRUPT}`));
    window.showErrorMessage.mockResolvedValue(Actions.resetWsl);
    await commands().setUp();
    expect(window.showErrorMessage).toHaveBeenCalledWith(WslSetupTexts.diskCorrupt, Actions.resetWsl, Actions.showDetails);
    expect(WslSetupTexts.diskCorrupt).toBe(
      'The disk of the WSL distribution devspaces is damaged, so WSL cannot start it. "Remove and Set Up Again" deletes the distribution with all devspaces in it, also changes that you did not push, and sets it up again.',
    );
    // The button removes the distribution and sets it up again.
    await vi.waitFor(() => expect(setup.remove).toHaveBeenCalledTimes(1));
    expect(showLog).not.toHaveBeenCalled();
  });
});

describe('the texts of the steps', () => {
  it('name each step, with the megabytes of the download', () => {
    expect(WslSetupTexts.step({ kind: 'download', received: 3 * 1_048_576, total: undefined })).toBe('Downloading Debian: 3 MB.');
    expect(WslSetupTexts.step({ kind: 'download', received: 0, total: 10 * 1_048_576 })).toBe('Downloading Debian: 0 of 10 MB.');
    expect(WslSetupTexts.step({ kind: 'docker', phase: 'packages' })).toBe('Installing the base packages.');
    expect(WslSetupTexts.step({ kind: 'docker', phase: 'repository' })).toBe('Adding the package repository of Docker.');
    expect(WslSetupTexts.step({ kind: 'restart' })).toBe('Restarting the WSL distribution.');
    expect(WslSetupTexts.step({ kind: 'start' })).toBe('Starting Docker.');
  });

  it('show the first start of the distribution and the progress of apt-get', () => {
    expect(WslSetupTexts.step({ kind: 'launch' })).toBe('Starting the WSL distribution. The first start can take some minutes.');
    expect(WslSetupTexts.step({ kind: 'docker', phase: 'docker', progress: { action: 'download', percent: 42.7 } })).toBe('Installing Docker Engine: downloading 42 %.');
    expect(WslSetupTexts.step({ kind: 'docker', phase: 'packages', progress: { action: 'install', percent: 80 } })).toBe('Installing the base packages: installing 80 %.');
  });

  it('give the log a size only when it is known', () => {
    const { size: _size, ...withoutSize } = IMAGE;
    expect(WslSetupTexts.setUpLog(withoutSize, FOLDER)).toContain(`Debian for WSL from ${IMAGE.url}`);
  });
});
