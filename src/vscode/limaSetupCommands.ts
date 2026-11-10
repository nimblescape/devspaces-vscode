// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// "Set Up Docker for Devspaces in Its VM…" on macOS and Linux (docs/architecture.md "The Lima VM of Devspaces"): the
// setup asks nothing (the click or the link is the decision; the log names the downloads and the folder), shows its
// steps in a progress notification, and then makes the Lima VM the Docker host of Devspaces, as "Use a Remote Docker
// Host…" does. A computer that cannot run the VM is told why, with the offer of a remote host (R-ENG-001). On Linux
// without QEMU, or without access to /dev/kvm, it installs QEMU and adds the user to the group kvm in a visible terminal
// (qemuInstall.ts), without a question of Devspaces, as Windows installs WSL: `sudo` asks for the password. The work is
// in src/core/vm/limaSetup.ts.
import { LIMA_HOST } from '../core/docker/dockerHost';
import { errorMessage } from '../core/errors';
import { Actions } from '../core/messages';
import { isAbortError, type Logger } from '../core/ports';
import type { LinkUri } from '../core/types';
import { LimaSetupError, type LimaSetup, type LimaSetupProblem, type LimaSetupStep } from '../core/vm/limaSetup';
import { qemuInstallPlan, type QemuInstallInput } from '../core/vm/qemuInstall';
import { showErrorMessage, showInformationMessage, showWarningMessage } from './notifications';
import { withNotificationProgress } from './progress';

/** The texts of the setup of the Lima VM. */
export const LimaSetupTexts = {
  settingUp: 'Setting up Docker for Devspaces in its VM…',
  busy: 'Docker for Devspaces is being set up in its VM in this window.',
  notAvailable: 'Devspaces has no VM for this computer: it runs its VM on macOS and Linux with an x64 or arm64 processor.',
  setUpLog: (folder: string) =>
    `Devspaces sets up Docker in its VM: it downloads Lima from github.com and the disk of its VM from ghcr.io into ${folder}, and creates and starts the VM.`,
  step: (step: LimaSetupStep): string => {
    switch (step.kind) {
      case 'lima':
        return 'Downloading Lima, which runs the VM.';
      case 'download':
        return step.total === undefined || step.total === 0
          ? 'Downloading the disk of the VM.'
          : `Downloading the disk of the VM: ${Math.floor((step.received / step.total) * 100)} %.`;
      case 'create':
        return 'Creating the VM.';
      case 'start':
        return 'Starting the VM.';
      case 'docker':
        return 'Waiting for Docker in the VM.';
    }
  },
  problem: (problem: LimaSetupProblem): string => {
    switch (problem) {
      case 'platform':
        return LimaSetupTexts.notAvailable;
      case 'kvmMissing':
        return 'This computer cannot run devspaces: its processor has no virtualization for VMs (/dev/kvm is missing), or it is turned off in the firmware settings. Devspaces needs its own VM. You can use Docker on another computer over SSH instead.';
      case 'kvmAccess':
        return 'Your user may not use the virtualization of this computer (/dev/kvm). Add your user to the group kvm, log in again, and set up Docker for Devspaces again.';
      case 'qemuMissing':
        return 'QEMU is not installed, which runs the VM of Devspaces on Linux. Install it (for example the packages qemu-system and qemu-utils), and set up Docker for Devspaces again.';
      case 'imageMissing':
        return 'The image of the VM of Devspaces is not published yet, so Devspaces cannot create its VM.';
      case 'broken':
        return 'The VM of Devspaces is broken, so Lima cannot start it. The details show why.';
      case 'busy':
        return 'Another VS Code window sets up Docker for Devspaces in its VM now. Try again when it has ended.';
      case 'failed':
        return 'Docker for Devspaces could not be set up in its VM. The details show why.';
    }
  },
  unknown: 'Docker for Devspaces could not be set up in its VM. The details show why.',
  cancelled: 'The setup of Docker for Devspaces in its VM was cancelled.',
  useRemoteHost: 'Use a Remote Docker Host…',
  readyNotUsed: `Docker Engine runs in the VM of Devspaces, but Devspaces does not use it yet. To use it, choose "${LIMA_HOST}" in "Use a Remote Docker Host…".`,
  /** The name of the terminal of the installation of QEMU. */
  qemuTerminal: 'Install QEMU',
  /** The installation of QEMU, and of the group kvm, runs in the terminal. */
  qemuInstalling: (qemu: boolean, kvmGroup: boolean): string => {
    const what = qemu && kvmGroup ? 'installs QEMU, which runs its VM on Linux, and adds your user to the group kvm' : qemu ? 'installs QEMU, which runs its VM on Linux,' : 'adds your user to the group kvm, which may use the virtualization of this computer,';
    const then = kvmGroup
      ? 'Then log out of this computer and in again, and set up Docker for Devspaces again.'
      : 'Then Devspaces goes on with the setup of its Docker by itself.';
    return `Devspaces ${what} in the terminal "${LimaSetupTexts.qemuTerminal}". Enter your password there. ${then}`;
  },
  /** The installation of QEMU needs a terminal on this computer. */
  qemuLocalWindow: 'QEMU is installed only from a local window of VS Code. Open a local window and set up Docker for Devspaces there.',
  /** "Remove the VM…" (R-VM-010). */
  confirmRemove: 'Remove the VM of Devspaces?',
  confirmRemoveDetail: (folder: string) =>
    [
      '"limactl delete" deletes the VM with everything in it: all your devspaces there with the changes that you did not push, their images and their volumes. This cannot be undone. The windows of these devspaces lose the connection.',
      `The disk of the VM in this folder is removed too:\n${folder}`,
    ].join('\n\n'),
  remove: 'Remove',
  removing: 'Removing the VM of Devspaces…',
  /** `noHost`: Devspaces used it, and has no Docker host now. */
  removed: (noHost: boolean) =>
    `The VM of Devspaces was removed.${noHost ? ' Devspaces has no Docker host now: set up Docker for Devspaces again in the Devspaces view, or choose another host.' : ''}`,
  notSetUp: 'The VM of Devspaces is not set up.',
  removeFailed: 'The VM of Devspaces could not be removed. The details show why.',
  removedStillListed: `The VM of Devspaces was removed, but Devspaces could not take "${LIMA_HOST}" out of its list of Docker hosts. Take it out with "Remove a Host from the List…".`,
  /** The log before the setup of "Remove and Set Up the VM Again…". */
  removedToSetUpAgain: 'The Lima VM of Devspaces was removed, and is set up again.',
  /** QEMU was not found within 30 minutes after the installation started. */
  qemuNotFound: 'QEMU was not found within 30 minutes after its installation started. Set up Docker for Devspaces again when it is installed.',
} as const;

/** How often the window looks for QEMU after its installation started, and for how long. */
const QEMU_WATCH_INTERVAL_MS = 5_000;
const QEMU_WATCH_MS = 30 * 60_000;

/** The part of the progress bar where each step starts; the download fills its part with its bytes. */
function barPosition(step: LimaSetupStep): number {
  switch (step.kind) {
    case 'lima':
      return 0;
    case 'download':
      return 5 + (step.total ? Math.floor((step.received / step.total) * 60) : 0);
    case 'create':
      return 65;
    case 'start':
      return 75;
    case 'docker':
      return 95;
  }
}

export interface LimaSetupCommandsDeps {
  /** The setup of this computer; undefined where there is none (not macOS or Linux). */
  setup: Pick<LimaSetup, 'precondition' | 'setUp' | 'linuxNeeds' | 'remove'> | undefined;
  /** The folder of the VM (LimaPaths.root), for the log. */
  folder: string | undefined;
  logger: Logger;
  showLog: () => void;
  /** "Use a Remote Docker Host…", offered when this computer cannot run the VM. */
  useRemoteHost: () => Promise<void>;
  /** Devspaces uses the host after its test (RemoteDockerCommands.useHost); true when it does. */
  useHost: (host: string) => Promise<boolean>;
  /**
   * The host leaves the list of Devspaces after the removal of the VM (RemoteDockerCommands.forgetHost): whether it was
   * the Docker host, so that Devspaces has no Docker host now.
   */
  forgetHost?: (host: string) => Promise<boolean>;
  /** Before the removal of the VM: the connections of this window to it end (its worker, the relay). */
  beforeRemove?: () => void;
  /** After the removal of the VM: the Docker context of the setting createDockerContext and the scheduled task follow. Never rejects. */
  afterRemove?: () => Promise<void>;
  /**
   * Linux: the installation of QEMU and of the group kvm in a visible terminal: what the plan needs to know about this
   * computer, whether this window can run a terminal on this computer (not in a remote window), and the terminal.
   * Without it, a missing QEMU is only named.
   */
  installQemu?: {
    input: () => Promise<Pick<QemuInstallInput, 'arch' | 'osRelease' | 'userName'>>;
    localWindow: () => boolean;
    runInTerminal: (commands: string[]) => void;
  };
  /** For tests: the timing of the look for QEMU after its installation started. */
  qemuWatch?: { intervalMs: number; forMs: number };
}

export class LimaSetupCommands {
  /** A setup runs in this window. */
  private running = false;
  /** The look for QEMU after its installation started (watchQemu). */
  private qemuWatch: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: LimaSetupCommandsDeps) {}

  dispose(): void {
    this.stopQemuWatch();
  }

  /** "Set Up Docker for Devspaces in Its VM…": the setup without a question, then the VM as the Docker host. Never throws. */
  async setUp(): Promise<void> {
    if (this.deps.setup === undefined) {
      this.inform(LimaSetupTexts.notAvailable);
      return;
    }
    await this.run();
  }

  /**
   * A flow that needs Docker on macOS or Linux while this computer has none for Devspaces (the link to Devspaces): as
   * setUp, without a question. `used`: Devspaces uses the VM now. `notUsed`: it does not (a problem with its message).
   * `unavailable`: this computer has no VM setup (not macOS or Linux); nothing is shown. Never throws.
   */
  async ensureDockerHost(_link?: LinkUri): Promise<'used' | 'notUsed' | 'unavailable'> {
    if (this.deps.setup === undefined) return 'unavailable';
    return (await this.run()) ? 'used' : 'notUsed';
  }

  /**
   * "Remove the VM…" (R-VM-010): after a warning, `limactl delete --force`, which deletes the VM with its disk; the host
   * leaves the list of Devspaces, and when Devspaces used it, Devspaces has no Docker host then. Never throws.
   */
  async remove(): Promise<void> {
    const { setup, folder, logger } = this.deps;
    if (setup === undefined) {
      this.inform(LimaSetupTexts.notAvailable);
      return;
    }
    if (this.running) {
      this.inform(LimaSetupTexts.busy);
      return;
    }
    const answer = await showWarningMessage(LimaSetupTexts.confirmRemove, { modal: true, detail: LimaSetupTexts.confirmRemoveDetail(folder ?? '') }, LimaSetupTexts.remove);
    if (answer !== LimaSetupTexts.remove) return;
    this.running = true;
    try {
      const removed = await withNotificationProgress({ title: LimaSetupTexts.removing }, async () => {
        this.deps.beforeRemove?.();
        return setup.remove();
      });
      // Also when the VM was gone already (removed by hand): the host leaves the list.
      const forgotten = await (this.deps.forgetHost?.(LIMA_HOST) ?? Promise.resolve(false)).catch((error: unknown) => ({ error }));
      await this.deps.afterRemove?.();
      if (typeof forgotten === 'object') {
        logger.error(`${LIMA_HOST} could not be removed from the list of Devspaces: ${errorMessage(forgotten.error)}`);
        this.showError(LimaSetupTexts.removedStillListed, [Actions.showDetails]);
        return;
      }
      this.inform(removed ? LimaSetupTexts.removed(forgotten) : LimaSetupTexts.notSetUp);
    } catch (error) {
      if (isAbortError(error)) return;
      logger.error(LimaSetupTexts.removeFailed, error);
      this.showError(LimaSetupTexts.removeFailed, [Actions.showDetails]);
    } finally {
      this.running = false;
    }
  }

  /**
   * "Remove and Set Up the VM Again…" after its question (vmCommands.ts): the removal without another question, then the
   * setup of a new VM, which Devspaces uses afterwards. The host stays in the list meanwhile. Never throws.
   */
  async removeAndSetUpAgain(): Promise<void> {
    const { setup, logger } = this.deps;
    if (setup === undefined) {
      this.inform(LimaSetupTexts.notAvailable);
      return;
    }
    if (this.running) {
      this.inform(LimaSetupTexts.busy);
      return;
    }
    this.running = true;
    try {
      await withNotificationProgress({ title: LimaSetupTexts.removing }, async () => {
        this.deps.beforeRemove?.();
        await setup.remove();
      });
      logger.info(LimaSetupTexts.removedToSetUpAgain);
      await this.deps.afterRemove?.();
    } catch (error) {
      this.running = false;
      if (isAbortError(error)) return;
      logger.error(LimaSetupTexts.removeFailed, error);
      this.showError(LimaSetupTexts.removeFailed, [Actions.showDetails]);
      return;
    }
    this.running = false;
    await this.run();
  }

  /** The setup and the use of the VM; true when Devspaces uses it afterwards. */
  private async run(): Promise<boolean> {
    const { setup, folder, logger } = this.deps;
    if (setup === undefined) return false;
    if (this.running) {
      this.inform(LimaSetupTexts.busy);
      return false;
    }
    this.running = true;
    try {
      const blocked = setup.precondition();
      if (blocked !== undefined) {
        // Linux: QEMU and the group kvm with one administrator prompt in a terminal; the setup goes on afterwards.
        if ((blocked.problem === 'qemuMissing' || blocked.problem === 'kvmAccess') && (await this.installQemu())) return false;
        throw blocked;
      }
      if (folder !== undefined) logger.info(LimaSetupTexts.setUpLog(folder));
      await this.withProgress((signal, report) => setup.setUp(report, signal));
      // useHost shows its own problem.
      const used = await this.deps.useHost(LIMA_HOST);
      if (!used) this.inform(LimaSetupTexts.readyNotUsed);
      return used;
    } catch (error) {
      this.showFailure(error);
      return false;
    } finally {
      this.running = false;
    }
  }

  /**
   * Starts the installation of QEMU, and of the group kvm, in a visible terminal, without a question (qemuInstallPlan).
   * True when it started, or when this window cannot run it (a message says so); false when there is no plan for this
   * computer: then the problem is shown as it is.
   */
  private async installQemu(): Promise<boolean> {
    const { installQemu, setup, logger } = this.deps;
    if (installQemu === undefined || setup === undefined) return false;
    const needs = setup.linuxNeeds();
    const qemu = needs.qemuMissing.length > 0;
    const kvmGroup = needs.kvm === 'access';
    const plan = qemuInstallPlan({ ...(await installQemu.input()), qemu, kvmGroup });
    if (plan.kind !== 'terminal' || plan.commands.length === 0) return false;
    if (!installQemu.localWindow()) {
      this.inform(LimaSetupTexts.qemuLocalWindow);
      return true;
    }
    for (const command of plan.commands) logger.info(`Terminal "${LimaSetupTexts.qemuTerminal}": ${command}`);
    installQemu.runInTerminal(plan.commands);
    this.inform(LimaSetupTexts.qemuInstalling(qemu, kvmGroup));
    // The group kvm counts only after a new login, so only the installation of QEMU alone goes on by itself.
    if (!plan.newLogin) this.watchQemu();
    return true;
  }

  /** Looks for QEMU every 5 seconds for at most 30 minutes; when the setup can run, it runs (the click was the decision). */
  private watchQemu(): void {
    this.stopQemuWatch();
    const { intervalMs, forMs } = this.deps.qemuWatch ?? { intervalMs: QEMU_WATCH_INTERVAL_MS, forMs: QEMU_WATCH_MS };
    const started = Date.now();
    this.qemuWatch = setInterval(() => {
      if (this.deps.setup?.precondition() === undefined) {
        this.stopQemuWatch();
        this.deps.logger.info('QEMU is installed: Devspaces goes on with the setup of its Docker.');
        void this.setUp();
      } else if (Date.now() - started >= forMs) {
        this.stopQemuWatch();
        this.deps.logger.info(LimaSetupTexts.qemuNotFound);
        this.inform(LimaSetupTexts.qemuNotFound);
      }
    }, intervalMs);
  }

  private stopQemuWatch(): void {
    if (this.qemuWatch !== undefined) clearInterval(this.qemuWatch);
    this.qemuWatch = undefined;
  }

  /** `task` with a cancellable progress notification; `report` shows a step of the setup. */
  private withProgress<T>(task: (signal: AbortSignal, report: (step: LimaSetupStep) => void) => Promise<T>): Promise<T> {
    return Promise.resolve(
      withNotificationProgress({ title: LimaSetupTexts.settingUp, cancellable: true }, async (progress, token) => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => abort.abort());
        let percent = 0;
        let shown: string | undefined;
        try {
          return await task(abort.signal, (step) => {
            const next = Math.max(percent, barPosition(step));
            const message = LimaSetupTexts.step(step);
            // The download reports each piece that arrives; the notification changes only with its text or its bar.
            if (message === shown && next === percent) return;
            progress.report({ message, increment: next > percent ? next - percent : undefined });
            percent = next;
            shown = message;
          });
        } finally {
          subscription.dispose();
        }
      }),
    );
  }

  /** The message of a failure; a cancel is only logged. A computer without virtualization gets the offer of a remote host. */
  private showFailure(error: unknown): void {
    const { logger } = this.deps;
    if (isAbortError(error)) {
      logger.info(LimaSetupTexts.cancelled);
      return;
    }
    if (!(error instanceof LimaSetupError)) {
      logger.error(LimaSetupTexts.unknown, error);
      this.showError(LimaSetupTexts.unknown, [Actions.showDetails]);
      return;
    }
    logger.error(`${LimaSetupTexts.problem(error.problem)} ${error.message}`);
    const remote = error.problem === 'kvmMissing' || error.problem === 'platform';
    this.showError(LimaSetupTexts.problem(error.problem), remote ? [LimaSetupTexts.useRemoteHost, Actions.showDetails] : [Actions.showDetails]);
  }

  private showError(message: string, actions: string[]): void {
    showErrorMessage(message, ...actions).then(
      (choice) => {
        if (choice === Actions.showDetails) this.deps.showLog();
        else if (choice === LimaSetupTexts.useRemoteHost) void this.deps.useRemoteHost().catch((error: unknown) => this.deps.logger.error(errorMessage(error)));
      },
      (error: unknown) => this.deps.logger.error('Could not show the message.', error),
    );
  }

  private inform(message: string): void {
    showInformationMessage(message).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }
}
