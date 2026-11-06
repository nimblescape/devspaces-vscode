// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// "Set Up Docker for Devspaces in Its VM…" on macOS and Linux (docs/architecture.md "The Lima VM of Devspaces"): the
// setup asks nothing (the click or the link is the decision; the log names the downloads and the folder), shows its
// steps in a progress notification, and then makes the Lima VM the Docker host of Devspaces, as "Use a Remote Docker
// Host…" does. A computer that cannot run the VM is told why, with the offer of a remote host (R-ENG-001). The work is
// in src/core/vm/limaSetup.ts.
import { LIMA_HOST } from '../core/docker/dockerHost';
import { errorMessage } from '../core/errors';
import { Actions } from '../core/messages';
import { isAbortError, type Logger } from '../core/ports';
import type { LinkUri } from '../core/types';
import { LimaSetupError, type LimaSetup, type LimaSetupProblem, type LimaSetupStep } from '../core/vm/limaSetup';
import { showErrorMessage, showInformationMessage } from './notifications';
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
} as const;

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
  setup: Pick<LimaSetup, 'precondition' | 'setUp'> | undefined;
  /** The folder of the VM (LimaPaths.root), for the log. */
  folder: string | undefined;
  logger: Logger;
  showLog: () => void;
  /** "Use a Remote Docker Host…", offered when this computer cannot run the VM. */
  useRemoteHost: () => Promise<void>;
  /** Devspaces uses the host after its test (RemoteDockerCommands.useHost); true when it does. */
  useHost: (host: string) => Promise<boolean>;
}

export class LimaSetupCommands {
  /** A setup runs in this window. */
  private running = false;

  constructor(private readonly deps: LimaSetupCommandsDeps) {}

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
      if (blocked !== undefined) throw blocked;
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
