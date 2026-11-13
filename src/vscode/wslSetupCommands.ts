// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// "Set Up Docker for Devspaces in WSL…" and "Remove the WSL Distribution of Devspaces…" on Windows (docs/architecture.md "The
// WSL distribution of Devspaces"): the setup of a new distribution asks nothing (the click or the link is the decision;
// the log names the download and the folder), shows its steps in a progress notification, and then makes the
// distribution the Docker host of Devspaces, as "Use a Remote Docker Host…" does. A distribution that Devspaces set up
// before is used as it is. The removal asks first, because it deletes every devspace in the distribution; the button
// "Remove and Set Up Again" of the error about a damaged disk of the distribution removes it and sets it up again
// without another question, because that message says what it deletes. A distribution with the name devspaces that
// Devspaces did not set up is never changed or removed. The work is in src/core/docker/wslSetup.ts.
import { WSL_DISTRIBUTION, WSL_HOST, wslDiskCorrupt } from '../core/docker/dockerHost';
import { DockerSetupTexts, WSL_INSTALL_COMMAND } from '../core/docker/dockerSetup';
import {
  WSL_FROM_FILE_VERSION,
  WslSetupError,
  isWslSetupError,
  type WslImage,
  type WslRegistration,
  type WslSetup,
  type WslSeparation,
  type WslSetupProblem,
  type WslSetupStep,
} from '../core/docker/wslSetup';
import { errorMessage } from '../core/errors';
import { Actions, dockerHostReason } from '../core/messages';
import { isAbortError, type Logger } from '../core/ports';
import type { LinkUri } from '../core/types';
import { DockerSetupUiTexts } from './dockerSetup';
import { showErrorMessage, showInformationMessage, showWarningMessage } from './notifications';
import { withNotificationProgress } from './progress';

/** The part of the bar of the setup that the download fills with its bytes, in percent. */
const DOWNLOAD_PART = 70;
/** Where the first start of the distribution is on the bar, in percent, so that the bar is full only at the end. */
const START_POSITION = 85;

/** The place of `step` on the bar of the setup, in percent. */
function barPosition(step: WslSetupStep): number {
  switch (step.kind) {
    case 'download':
      return step.total ? Math.min(DOWNLOAD_PART, Math.floor((step.received * DOWNLOAD_PART) / step.total)) : 0;
    case 'register':
      return DOWNLOAD_PART;
    case 'start':
      return START_POSITION;
  }
}

/** User-visible texts of the WSL distribution of Devspaces (plain language). No `vscode` in them. */
export const WslSetupTexts = {
  checking: 'Checking WSL…',
  settingUp: 'Setting up Docker for Devspaces…',
  removing: 'Removing the WSL distribution of Devspaces…',
  notWindows: 'The WSL distribution of Devspaces exists only on Windows.',
  noLocalAppData: 'Devspaces does not find the folder LOCALAPPDATA of your Windows user, where the WSL distribution of Devspaces has its files.',
  busy: 'The WSL distribution of Devspaces is being set up or removed in this window. Try again after that.',
  busyElsewhere: 'The WSL distribution of Devspaces is being set up or removed in another VS Code window. Try again after that.',
  changedElsewhere: 'The WSL distribution of Devspaces was set up or removed in another VS Code window after the check, so nothing was changed. Try again.',
  /** The log of a new setup, which asks nothing: what Devspaces downloads, and the folder. */
  setUpLog: (image: WslImage, folder: string) =>
    `The WSL distribution ${WSL_DISTRIBUTION} of Devspaces is set up in ${folder} from the .wsl file of the image ${image.version} of the VM of Devspaces ` +
    `(${Math.ceil(image.size / 1_048_576)} MB from ${image.repository}, checked against its SHA-256 in the code of Devspaces), which brings Docker Engine. ` +
    'Devspaces runs its commands there as root with wsl.exe.',
  confirmRemove: 'Remove the WSL distribution of Devspaces?',
  confirmRemoveDetail: (folder: string) =>
    [
      `"wsl --unregister ${WSL_DISTRIBUTION}" deletes the distribution with everything in it: all your devspaces there with the changes that you did not push, their images and their volumes. This cannot be undone. The windows of these devspaces lose the connection.`,
      `The folder of the distribution is removed too:\n${folder}`,
    ].join('\n\n'),
  remove: 'Remove',
  /**
   * `noHost`: Devspaces used it, and has no Docker host now.
   * `keptFolder`: the folder of the distribution, when it stays.
   */
  removed: (noHost: boolean, keptFolder?: string) =>
    `The WSL distribution of Devspaces was removed.${noHost ? ' Devspaces has no Docker host now: set up Docker for Devspaces again in the Devspaces view, or choose another host.' : ''}${keptFolder === undefined ? '' : ` Its folder stays (the log of Devspaces says why): ${keptFolder}`}`,
  removedStillListed: `The WSL distribution of Devspaces was removed, but Devspaces could not take "${WSL_HOST}" out of its list of Docker hosts. Take it out with "Remove a Host from the List…".`,
  readyNotUsed: `Docker Engine runs in the WSL distribution of Devspaces, but Devspaces does not use it yet. To use it, choose "${WSL_HOST}" in "Use a Remote Docker Host…".`,
  notInstalled: 'The WSL distribution of Devspaces is not installed.',
  foreign: `A WSL distribution with the name "${WSL_DISTRIBUTION}" exists, but Devspaces did not set it up, so Devspaces does not change it. Use it as it is?`,
  foreignRemove: `The WSL distribution "${WSL_DISTRIBUTION}" was not set up by Devspaces, so Devspaces does not remove it. If you do not need it, remove it in a terminal with "wsl --unregister ${WSL_DISTRIBUTION}".`,
  useIt: 'Use It',
  dockerDesktopIntegrates: `Docker Desktop has its WSL integration turned on for the WSL distribution "${WSL_DISTRIBUTION}" of Devspaces. Docker warns that Docker Desktop and a Docker Engine in the same WSL distribution can conflict. Turn it off in Docker Desktop: Settings > Resources > WSL integration.`,
  installWsl: 'Install WSL 2',
  failed: 'The WSL distribution of Devspaces could not be set up.',
  removeFailedUnknown: 'The WSL distribution of Devspaces could not be removed.',
  /** The error of a setup whose distribution has a damaged disk, with the button Actions.resetWsl. */
  diskCorrupt: dockerHostReason('wslDiskCorrupt', WSL_HOST),
  /** The log before the setup of "Remove and Set Up Again". */
  removedToSetUpAgain: `The WSL distribution ${WSL_DISTRIBUTION} of Devspaces was removed, and is set up again.`,
  step: (step: WslSetupStep): string => {
    switch (step.kind) {
      case 'download': {
        const total = step.total === undefined ? undefined : Math.ceil(step.total / 1_048_576);
        // The end of the download shows the total, also when its last megabyte is not full.
        const received = step.total !== undefined && step.received >= step.total ? total : Math.floor(step.received / 1_048_576);
        return `Downloading the VM of Devspaces: ${DockerSetupUiTexts.downloadProgress(received ?? 0, total)}`;
      }
      case 'register':
        return 'Creating the WSL distribution.';
      case 'start':
        return 'Starting the WSL distribution and Docker. The first start can take some minutes.';
    }
  },
  problem: (problem: WslSetupProblem): string => {
    switch (problem) {
      case 'wslMissing':
        return `WSL is not installed on this computer. Install WSL 2 first: Windows asks for administrator permission (without it, ask an administrator of this computer to run "${WSL_INSTALL_COMMAND}"), and you restart the computer afterwards.`;
      case 'wslTooOld':
        return `The WSL of this computer is too old: Devspaces needs WSL ${WSL_FROM_FILE_VERSION.join('.')} or later. Run "wsl --update" in a terminal, then try again.`;
      case 'restartNeeded':
        return DockerSetupTexts.wslRestartToGoOn;
      case 'vmUnavailable':
        return (
          'WSL 2 cannot start its virtual machine on this computer. When WSL was installed just now, restart Windows. Otherwise turn on virtualization: ' +
          'in the firmware settings (UEFI or BIOS) of the computer, or, when Windows runs in a virtual machine, nested virtualization in the settings of that virtual machine. ' +
          'Then try again. The details show the error of WSL.'
        );
      case 'wslNotAnswering':
        return 'WSL does not answer. Try again. When it does not help, run "wsl --shutdown" in a terminal.';
      case 'noImage':
        return 'Devspaces has no image of its VM for the processor of this computer.';
      case 'downloadFailed':
        return 'The image of the VM of Devspaces could not be downloaded. Check the internet connection and try again.';
      case 'registerFailed':
        return `WSL could not create the distribution "${WSL_DISTRIBUTION}". The details show why.`;
      case 'dockerNotRunning':
        return `Docker does not start in the WSL distribution "${WSL_DISTRIBUTION}". The details show why. Try again.`;
      case 'removeFailed':
        return `WSL could not remove the distribution "${WSL_DISTRIBUTION}". The details show why.`;
      case 'registryFailed':
        return `Devspaces cannot tell whether it set up the WSL distribution "${WSL_DISTRIBUTION}", because it cannot read the list of WSL distributions in the registry of Windows. The details show why.`;
    }
  },
} as const;

export interface WslSetupCommandsDeps {
  /** The setup of this computer; undefined where there is none (not Windows, or no LOCALAPPDATA). */
  setup: Pick<WslSetup, 'checkWsl' | 'checkVirtualMachine' | 'registration' | 'image' | 'setUp' | 'remove' | 'removeLeftovers' | 'locked' | 'separate'> | undefined;
  /** The folder of the distribution (wslSetupFolder), for the questions. */
  folder: string | undefined;
  /** For the message without `setup`. */
  isWindows: boolean;
  logger: Logger;
  showLog: () => void;
  /**
   * Installs WSL when the setup finds it missing (DockerSetup.installWsl: the terminal, and the record for the setup after
   * the restart of Windows, with the link `link` of a flow).
   */
  installWsl: (link?: LinkUri) => Promise<void>;
  /** True while Windows has not restarted since Devspaces started the installation of WSL (WslAfterInstall.restartPending). */
  restartPending?: () => Promise<boolean>;
  /**
   * Devspaces uses the distribution: the record of the installation of WSL is not needed anymore (WslAfterInstall.forget),
   * so that no window opens its link again after a later restart. Never rejects.
   */
  wslInstallDone?: () => Promise<void>;
  /** Devspaces uses the host after its test (RemoteDockerCommands.useHost); true when it does. */
  useHost: (host: string) => Promise<boolean>;
  /**
   * The host leaves the list of Devspaces (RemoteDockerCommands.forgetHost): whether it was the Docker host, so that
   * Devspaces has no Docker host now.
   */
  forgetHost: (host: string) => Promise<boolean>;
  /**
   * The distribution is gone, or a new one takes its place (also after a removal with `wsl --unregister` by hand): the
   * Docker context of the distribution follows. Never rejects.
   */
  forgetDistribution?: () => Promise<void>;
  /**
   * Right before `wsl --unregister`: the connections of this window to the distribution end (its worker, the relay), so
   * that nothing of this window holds or starts it during the removal.
   */
  beforeRemove?: () => void;
  /**
   * Whether Docker Desktop has its WSL integration on for the distribution (dockerDesktopIntegrates), also by its
   * integration with the default distribution of WSL when the distribution is that default (`isDefault`). Never rejects.
   */
  dockerDesktopIntegrates?: (isDefault: boolean) => Promise<boolean>;
}

export class WslSetupCommands {
  /** A setup or a removal runs in this window. */
  private running = false;
  /** This window warned that Docker Desktop integrates the distribution. */
  private dockerDesktopWarned = false;

  constructor(private readonly deps: WslSetupCommandsDeps) {}

  /**
   * At the start of a window: the WSL distribution of Devspaces is not the default distribution of WSL
   * (WslSetup.separate; also after the user removed the default distribution, when WSL made this one the default), and
   * a warning, once in the window, while Docker Desktop has its WSL integration on for it (warnDockerDesktop; a setup
   * warns with what its own check found). Never throws (logged).
   */
  async checkSeparation(): Promise<void> {
    try {
      const separation = await this.deps.setup?.separate();
      if (separation !== undefined) await this.warnDockerDesktop(separation);
    } catch (error) {
      this.deps.logger.error('The WSL distribution of Devspaces could not be checked.', error);
    }
  }

  /**
   * "Set Up Docker for Devspaces in WSL…": checks WSL (without WSL, it installs WSL first, and the setup goes on after the
   * restart of Windows), sets up the distribution without a question with a progress notification, and makes it the
   * Docker host of Devspaces. A distribution that Devspaces set up before is used as it is; one that the user made is
   * only offered for use. Only a new distribution needs the version of WSL that registers a file. Never throws.
   */
  async setUp(): Promise<void> {
    await this.run('command');
  }

  /**
   * A flow that needs Docker on Windows while this computer has none (the link `link` to Devspaces, R-ENG-005, or the
   * setup after the restart of Windows): the WSL distribution of Devspaces becomes the Docker host of Devspaces, which
   * reaches it through its own connection (`wsl.exe`), and useHost downloads the Docker CLI of Devspaces when this
   * computer has none. A distribution that Devspaces set up before (for example with another VS Code) is used as it is.
   * Otherwise as "Set Up Docker for Devspaces in WSL…": the check of WSL (without WSL, it installs WSL, and the setup
   * and the link go on after the restart of Windows), the setup with its progress, and the use, all without a question.
   * A distribution `devspaces` that the user made is offered for use in a modal question. `used`: Devspaces uses the
   * distribution now. `notUsed`: it does not (a closed question, the installation of WSL, or a problem with its
   * message). `unavailable`: this computer has no WSL setup (not Windows, or no LOCALAPPDATA); nothing is shown. Never
   * throws.
   */
  async ensureDockerHost(link?: LinkUri): Promise<'used' | 'notUsed' | 'unavailable'> {
    if (this.deps.setup === undefined || this.deps.folder === undefined) return 'unavailable';
    return (await this.run('flow', link)) ? 'used' : 'notUsed';
  }

  /**
   * Whether WSL is installed (WslSetup.checkWsl), for the setup after the restart of Windows: false without a setup of
   * this computer or without WSL; true also when WSL is too old or does not answer (the setup then says so). Never throws.
   */
  async wslInstalled(): Promise<boolean> {
    const { setup } = this.deps;
    if (setup === undefined) return false;
    try {
      await setup.checkWsl();
      return true;
    } catch (error) {
      return !(isWslSetupError(error) && error.problem === 'wslMissing');
    }
  }

  /** setUp (`command`) or ensureDockerHost (`flow`, with its link); true when Devspaces uses the distribution afterwards. */
  private async run(mode: 'command' | 'flow', link?: LinkUri): Promise<boolean> {
    const { setup, folder } = this.deps;
    if (setup === undefined || folder === undefined) {
      this.inform(this.deps.isWindows ? WslSetupTexts.noLocalAppData : WslSetupTexts.notWindows);
      return false;
    }
    if (!this.start()) return false;
    try {
      const plan = await this.withProgress(WslSetupTexts.checking, async (signal): Promise<{ registration: 'own' } | { registration: 'foreign' } | { registration: 'none'; image: WslImage }> => {
        const registration = await setup.registration(signal);
        if (registration !== 'none') return { registration };
        const version = await setup.checkWsl(signal);
        this.deps.logger.info(`WSL ${version} is installed.`);
        // Before the download: WSL 2 runs only after the restart of Windows that its installation asks for, when it
        // turned on the virtual machine of WSL. An installation that needed no restart passes the check.
        const restartPending = (await this.deps.restartPending?.()) === true;
        try {
          await setup.checkVirtualMachine(signal);
        } catch (error) {
          if (restartPending && isWslSetupError(error) && error.problem === 'vmUnavailable') {
            throw new WslSetupError('restartNeeded', `Windows has not restarted since Devspaces started the installation of WSL: ${error.message}`);
          }
          throw error;
        }
        return { registration, image: await setup.image() };
      });
      if (plan.registration === 'foreign') {
        this.deps.logger.info(`A WSL distribution ${WSL_DISTRIBUTION} exists that Devspaces did not set up; Devspaces does not change it.`);
        if (mode === 'flow') {
          // The flow waits for the answer, so the question is modal: it cannot stay open unnoticed.
          const choice = await showInformationMessage(WslSetupTexts.foreign, { modal: true }, WslSetupTexts.useIt);
          return await this.usedNow(choice === WslSetupTexts.useIt && (await this.deps.useHost(WSL_HOST)));
        }
        // Not awaited: a message that nobody answers must not block the next setup or removal here.
        showInformationMessage(WslSetupTexts.foreign, WslSetupTexts.useIt)
          .then((choice) => (choice === WslSetupTexts.useIt ? this.deps.useHost(WSL_HOST) : undefined))
          .then(undefined, (error: unknown) => this.deps.logger.error(`${WSL_HOST} could not be used: ${errorMessage(error)}`));
        return false;
      }
      if (plan.registration === 'own') {
        // The distribution of Devspaces is used as it is (useHost tests it): its VM upgrades its packages itself. Under
        // the lock of all windows, so that a removal in another window does not come between.
        this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} of Devspaces exists, so Devspaces uses it.`);
        const done = await setup.locked(async () => ((await setup.registration()) === 'own' ? { used: await this.deps.useHost(WSL_HOST) } : false));
        return await this.usedNow(this.finished(done)?.used === true);
      }
      // A new distribution needs no question: the click or the link is the decision, and the log names the download and
      // the folder.
      const { image } = plan;
      this.deps.logger.info(WslSetupTexts.setUpLog(image, folder));
      // The lock of all windows only from here. Under the lock, the distribution must still be missing: another window
      // may have set it up meanwhile. Devspaces chooses the host under
      // the lock too, so that a removal in another window does not come between.
      const done = await setup.locked(async () => {
        const ready = await this.withProgress(WslSetupTexts.settingUp, async (signal, report) => {
          if ((await setup.registration(signal)) !== 'none') return undefined;
          await this.deps.forgetDistribution?.();
          return await setup.setUp(image, (step) => report(step), signal);
        });
        if (ready === undefined) return false;
        // useHost shows its own problem.
        return { used: await this.deps.useHost(WSL_HOST), separation: ready.separation };
      });
      const result = this.finished(done);
      // Not under the lock: only a message.
      if (result !== undefined) await this.warnDockerDesktop(result.separation);
      // This message says that the setup itself is done.
      if (result !== undefined && !result.used) this.inform(WslSetupTexts.readyNotUsed);
      return await this.usedNow(result?.used === true);
    } catch (error) {
      if (isWslSetupError(error) && error.problem === 'wslMissing') {
        // Docker for Devspaces needs WSL: its installation comes next, in a terminal (Windows asks for administrator
        // permission). After the restart of Windows, the setup goes on, with the link.
        this.deps.logger.info(`WSL is not installed, so Devspaces installs WSL 2 first: ${error.message}`);
        this.installWsl(link);
        return false;
      }
      if (isWslSetupError(error) && error.problem === 'restartNeeded') {
        this.deps.logger.info(`${error.message} The setup of Docker for Devspaces goes on after the restart.`);
        this.inform(WslSetupTexts.problem(error.problem));
        return false;
      }
      this.showFailure(error, WslSetupTexts.failed, 'The setup of the WSL distribution of Devspaces was cancelled.');
      return false;
    } finally {
      this.running = false;
    }
  }

  /**
   * "Remove the WSL Distribution of Devspaces…": after a warning, `wsl --unregister devspaces` and the folder of the
   * distribution; the host leaves the list of Devspaces, and when Devspaces used it, Devspaces has no Docker host then.
   * Only a distribution that Devspaces set up. Never throws.
   */
  async remove(): Promise<void> {
    const { setup, folder } = this.deps;
    if (setup === undefined || folder === undefined) {
      this.inform(this.deps.isWindows ? WslSetupTexts.noLocalAppData : WslSetupTexts.notWindows);
      return;
    }
    if (!this.start()) return;
    try {
      const registration = await this.withProgress(WslSetupTexts.checking, (signal) => this.removalCheck(setup, signal));
      if (registration === 'foreign') {
        this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} was not set up by Devspaces; it is not removed.`);
        this.inform(WslSetupTexts.foreignRemove);
        return;
      }
      if (registration === 'none') {
        // Removed by hand, or a setup that did not end: the host leaves the list, and the files of that setup go. Under
        // the lock of all windows, as below, and only while no other window has set up the distribution meanwhile.
        const cleaned = await setup.locked(async () => {
          if ((await this.removalCheck(setup)) !== 'none') return false;
          await this.deps.forgetHost(WSL_HOST).catch((error: unknown) => {
            this.deps.logger.warn(`${WSL_HOST} could not be removed from the list of Devspaces: ${errorMessage(error)}`);
          });
          await this.removeGone(setup);
          return true;
        });
        if (this.finished(cleaned)) this.inform(WslSetupTexts.notInstalled);
        return;
      }
      if (!(await this.confirm(WslSetupTexts.confirmRemove, WslSetupTexts.confirmRemoveDetail(folder), WslSetupTexts.remove))) return;
      // `wsl --unregister` is not cancelled: a half removed distribution would help nobody. The host leaves the list
      // under the lock too, so that a setup in another window afterwards keeps its host.
      const done = await setup.locked(async () =>
        withNotificationProgress({ title: WslSetupTexts.removing }, async () => {
          if ((await this.removalCheck(setup)) !== 'own') return false;
          const folderGone = await this.unregister(setup);
          const forgotten = await this.deps.forgetHost(WSL_HOST).catch((error: unknown) => ({ error }));
          return { folderGone, forgotten };
        }),
      );
      const result = this.finished(done);
      if (result === undefined) return;
      if (typeof result.forgotten === 'object') {
        // The distribution is gone; only the list of Devspaces still names it.
        this.deps.logger.error(`${WSL_HOST} could not be removed from the list of Devspaces: ${errorMessage(result.forgotten.error)}`);
        this.showError(WslSetupTexts.removedStillListed);
        return;
      }
      this.inform(WslSetupTexts.removed(result.forgotten, result.folderGone ? undefined : folder));
    } catch (error) {
      this.showFailure(error, WslSetupTexts.removeFailedUnknown, 'The removal of the WSL distribution of Devspaces was cancelled.');
    } finally {
      this.running = false;
    }
  }

  /**
   * The removal of the distribution for "Remove Devspaces from This Computer…" after its question (R-GEN-009): as
   * remove(), without a question and without a message of its own, in the progress of that command, under the lock of
   * all windows. A distribution that Devspaces did not set up stays. Undefined when the distribution of Devspaces is
   * gone (also when there was none), else what stays, for the message of that command (logged). Never throws. Without
   * forgetDistribution: the next step of that command removes the Docker context and the scheduled task itself
   * (removeDevspacesFiles), so that no update in the background removes them at the same time.
   */
  async removeForComputer(): Promise<string | undefined> {
    const { setup, folder, logger } = this.deps;
    if (setup === undefined || folder === undefined) return undefined;
    if (this.running) return WslSetupTexts.busy;
    this.running = true;
    try {
      const done = await setup.locked(async () => {
        const registration = await this.removalCheck(setup);
        if (registration === 'foreign') return 'foreign' as const;
        if (registration === 'none') {
          await setup.removeLeftovers();
        } else {
          this.deps.beforeRemove?.();
          await setup.remove();
        }
        await this.deps.forgetHost(WSL_HOST).catch((error: unknown) => {
          // The distribution is gone; the list of Devspaces in the storage of VS Code goes with the extension.
          logger.warn(`${WSL_HOST} could not be removed from the list of Devspaces: ${errorMessage(error)}`);
        });
        return 'gone' as const;
      });
      if (done === undefined) return WslSetupTexts.busyElsewhere;
      if (done.value === 'foreign') {
        logger.info(`The WSL distribution ${WSL_DISTRIBUTION} was not set up by Devspaces; it is not removed.`);
        return WslSetupTexts.foreignRemove;
      }
      return undefined;
    } catch (error) {
      const text = isWslSetupError(error)
        ? `${WslSetupTexts.problem(error.problem)} ${error.message}`
        : `${WslSetupTexts.removeFailedUnknown.replace(/\.$/, ':')} ${errorMessage(error)}`;
      logger.error(text);
      return text;
    } finally {
      this.running = false;
    }
  }

  /**
   * The button "Remove and Set Up Again" of the error about a damaged disk of the distribution (the problem
   * wslDiskCorrupt): the removal without its question, because that message says what it deletes, and then the setup of
   * a new distribution as for a link (ensureDockerHost), which Devspaces uses afterwards. Then `retry`, the Try again of
   * the operation that failed, when Devspaces uses the new distribution. The host stays in the list of Devspaces
   * meanwhile, so that no other Docker takes its place; when the new setup does not end, it leaves the list
   * (forgetHostWhenGone). A distribution that Devspaces did not set up is not removed. Never throws.
   */
  async removeAndSetUpAgain(retry?: () => unknown): Promise<void> {
    const { setup, folder } = this.deps;
    if (setup === undefined || folder === undefined) {
      this.inform(this.deps.isWindows ? WslSetupTexts.noLocalAppData : WslSetupTexts.notWindows);
      return;
    }
    if (!this.start()) return;
    let removed = false;
    try {
      // Before anything is removed, what the new setup needs: a WSL that registers a file, its virtual machine, and the
      // image of the VM for this computer (the setup checks them again). A failure keeps the distribution.
      await this.withProgress(WslSetupTexts.checking, async (signal) => {
        await setup.checkWsl(signal);
        await setup.checkVirtualMachine(signal);
        await setup.image();
      });
      // `wsl --unregister` is not cancelled, as in remove. Under the lock of all windows, with the registration of then.
      const done = await setup.locked(async () =>
        withNotificationProgress({ title: WslSetupTexts.removing }, async () => {
          const registration = await this.removalCheck(setup);
          if (registration === 'foreign') return registration;
          if (registration === 'none') await this.removeGone(setup);
          else if (!(await this.unregister(setup))) this.deps.logger.warn(`The folder of the WSL distribution ${WSL_DISTRIBUTION} stays: ${folder}`);
          return 'removed' as const;
        }),
      );
      const result = this.finished(done);
      if (result === 'foreign') {
        this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} was not set up by Devspaces; it is not removed.`);
        this.inform(WslSetupTexts.foreignRemove);
      }
      removed = result === 'removed';
    } catch (error) {
      this.showFailure(error, WslSetupTexts.removeFailedUnknown, 'The removal of the WSL distribution of Devspaces was cancelled.');
    } finally {
      this.running = false;
    }
    if (!removed) return;
    this.deps.logger.info(WslSetupTexts.removedToSetUpAgain);
    if (!(await this.run('flow'))) {
      await this.forgetHostWhenGone(setup);
      return;
    }
    if (retry === undefined) return;
    // A failed async retry must reach the log, not end as an unhandled rejection in the extension host.
    Promise.resolve()
      .then(retry)
      .catch((error: unknown) => this.deps.logger.error('Try again failed.', error));
  }

  /**
   * After "Remove and Set Up Again" whose setup did not end (its message says why): without a distribution, the host
   * leaves the list of Devspaces, as after a removal, so that the view shows the setup of Docker and a link sets the
   * distribution up. Under the lock of all windows, and only while no other window has set it up meanwhile. Never throws.
   */
  private async forgetHostWhenGone(setup: NonNullable<WslSetupCommandsDeps['setup']>): Promise<void> {
    try {
      await setup.locked(async () => {
        if ((await this.removalCheck(setup)) !== 'none') return false;
        await this.deps.forgetHost(WSL_HOST);
        this.deps.logger.info(`The WSL distribution ${WSL_DISTRIBUTION} was not set up again, so ${WSL_HOST} left the list of Devspaces.`);
        return true;
      });
    } catch (error) {
      this.deps.logger.warn(`${WSL_HOST} could not be removed from the list of Devspaces: ${errorMessage(error)}`);
    }
  }

  /**
   * `wsl --unregister` of the distribution of Devspaces and its folder (WslSetup.remove), and forgetDistribution; true
   * when the folder is gone. Under the lock of all windows, after removalCheck gave `own`.
   */
  private async unregister(setup: NonNullable<WslSetupCommandsDeps['setup']>): Promise<boolean> {
    this.deps.beforeRemove?.();
    const folderGone = await setup.remove();
    await this.deps.forgetDistribution?.();
    return folderGone;
  }

  /** The files of a setup of a distribution that is gone (WslSetup.removeLeftovers), and forgetDistribution. Under the lock. */
  private async removeGone(setup: NonNullable<WslSetupCommandsDeps['setup']>): Promise<void> {
    await setup.removeLeftovers();
    await this.deps.forgetDistribution?.();
  }

  /** The registration for the removal (WslSetup.registration, `sure`): `none` without WSL. */
  private async removalCheck(setup: NonNullable<WslSetupCommandsDeps['setup']>, signal?: AbortSignal): Promise<WslRegistration> {
    try {
      return await setup.registration(signal, true);
    } catch (error) {
      if (!isWslSetupError(error) || error.problem !== 'wslMissing') throw error;
      this.deps.logger.info(`WSL is not installed: ${error.message}`);
      return 'none';
    }
  }

  /**
   * The result of the work under the lock of all windows; else undefined, after its message: another window holds the
   * lock (undefined), or it changed the distribution after the check (false).
   */
  private finished<T>(done: { value: T | false } | undefined): T | undefined {
    if (done === undefined) this.inform(WslSetupTexts.busyElsewhere);
    else if (done.value === false) this.inform(WslSetupTexts.changedElsewhere);
    else return done.value;
    return undefined;
  }

  /**
   * False (with a message) while a setup or a removal runs in this window; else marks one as running. The work itself
   * runs with WslSetup.locked, for all windows.
   */
  private start(): boolean {
    if (this.running) {
      this.inform(WslSetupTexts.busy);
      return false;
    }
    this.running = true;
    return true;
  }

  /** `task` with a cancellable progress notification; `report` shows a step of the setup. */
  private withProgress<T>(title: string, task: (signal: AbortSignal, report: (step: WslSetupStep) => void) => Promise<T>): Promise<T> {
    return Promise.resolve(
      withNotificationProgress({ title, cancellable: true }, async (progress, token) => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => abort.abort());
        let percent = 0;
        let shown: string | undefined;
        try {
          return await task(abort.signal, (step) => {
            // The download fills its part of the bar with its bytes; each other step starts at its place.
            const next = Math.max(percent, barPosition(step));
            const message = WslSetupTexts.step(step);
            // The download reports each piece that arrives; the notification changes only with its text or its bar.
            if (message === shown && next === percent) return;
            progress.report({ message, increment: next > percent ? next - percent : undefined });
            shown = message;
            percent = next;
          });
        } finally {
          subscription.dispose();
        }
      }),
    );
  }

  /** Modal question; true only for the confirming button. */
  private async confirm(message: string, detail: string, button: string): Promise<boolean> {
    return (await showWarningMessage(message, { modal: true, detail }, button)) === button;
  }

  /** The message of a failure: `unknown` for an error that is not a WslSetupError; a cancel is only logged (`cancelled`). */
  private showFailure(error: unknown, unknown: string, cancelled: string): void {
    if (isAbortError(error)) {
      this.deps.logger.info(cancelled);
      return;
    }
    if (!isWslSetupError(error)) {
      this.deps.logger.error(unknown, error);
      this.showError(unknown);
      return;
    }
    this.deps.logger.error(`${WslSetupTexts.problem(error.problem)} ${error.message}`);
    // WSL could not start the distribution, because its disk is damaged: its own message, with "Remove and Set Up Again".
    if (wslDiskCorrupt(error.message)) {
      this.showError(WslSetupTexts.diskCorrupt, Actions.resetWsl);
      return;
    }
    this.showError(WslSetupTexts.problem(error.problem), error.problem === 'wslMissing' ? WslSetupTexts.installWsl : undefined);
  }

  /**
   * An error with Show details, and `action`: Install WSL 2 (before Show details) runs the button of the Docker setup;
   * Remove and Set Up Again (after Show details, as errors.ts and RemoteDockerCommands show it) runs removeAndSetUpAgain.
   */
  private showError(message: string, action?: string): void {
    const items = action === undefined ? [Actions.showDetails] : action === Actions.resetWsl ? [Actions.showDetails, action] : [action, Actions.showDetails];
    showErrorMessage(message, ...items).then(
      (choice) => {
        if (choice === Actions.showDetails) {
          this.deps.showLog();
          return;
        }
        if (choice === undefined || choice !== action) return;
        if (action === Actions.resetWsl) void this.removeAndSetUpAgain();
        else this.installWsl();
      },
      (error: unknown) => this.deps.logger.error('Could not show the message.', error),
    );
  }

  /** `used`, after the record of the installation of WSL is forgotten when Devspaces uses the distribution (wslInstallDone). */
  private async usedNow(used: boolean): Promise<boolean> {
    if (used) await this.deps.wslInstallDone?.();
    return used;
  }

  /** "Install WSL 2" of the Docker setup (`wsl --install --no-distribution` in a terminal), with the link of a flow. Not awaited. */
  private installWsl(link?: LinkUri): void {
    this.deps.installWsl(link).then(undefined, (error: unknown) => this.deps.logger.error(`WSL 2 could not be installed: ${errorMessage(error)}`));
  }

  /**
   * The warning while Docker Desktop has its WSL integration on for the distribution, once in the window (logged), after
   * `separation` (WslSetup.separate): only for a distribution that Devspaces set up, and only while the registry has
   * the distribution of Docker Desktop; the integration with the default distribution counts while the distribution
   * stays the default. Never rejects.
   */
  private async warnDockerDesktop(separation: WslSeparation): Promise<void> {
    if ((separation.state !== 'separate' && separation.state !== 'default') || separation.dockerDesktop !== true) return;
    if (this.dockerDesktopWarned || !(await this.deps.dockerDesktopIntegrates?.(separation.state === 'default'))) return;
    // Another check of the window may have warned meanwhile.
    if (this.dockerDesktopWarned) return;
    this.dockerDesktopWarned = true;
    this.deps.logger.warn(WslSetupTexts.dockerDesktopIntegrates);
    showWarningMessage(WslSetupTexts.dockerDesktopIntegrates).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }

  private inform(message: string): void {
    showInformationMessage(message).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }
}
