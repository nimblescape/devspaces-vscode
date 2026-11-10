// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The management of the VM of Devspaces in its row of the view "Docker Hosts" (docs/requirements.md R-VM-010), the
// same on every platform: Start the VM, Stop the VM…, Remove the VM…, Remove and Set Up the VM Again…, and Settings of
// the VM (macOS and Linux, R-VM-006). The work is in the setup of each platform: on macOS and Linux the Lima VM
// (limaSetupCommands.ts, `limactl stop` and `limactl delete`), on Windows the WSL distribution (wslSetupCommands.ts,
// `wsl --terminate` and `wsl --unregister`). Start is the test of the host, which starts the VM (each Docker connection
// to it starts it), without a change of the Docker host of Devspaces. Stop asks first while devspaces run in the VM and
// names them; Remove and Remove and Set Up Again ask first, because they delete every devspace in the VM.
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import { Actions } from '../core/messages';
import { isAbortError, type Logger } from '../core/ports';
import type { VmState } from '../core/vm/vmState';
import { showErrorMessage, showInformationMessage, showWarningMessage } from './notifications';
import { withNotificationProgress } from './progress';
import { SETTINGS_SECTION } from './settings';

/** User-visible texts of the commands of the VM (plain language). */
export const VmTexts = {
  noVm: 'This computer has no VM of Devspaces.',
  notSetUp: 'The VM of Devspaces is not set up yet.',
  setUp: 'Set Up',
  notRunning: 'The VM of Devspaces does not run.',
  alreadyRunning: 'The VM of Devspaces runs already.',
  started: 'The VM of Devspaces runs. It powers itself off two minutes after nothing runs there and nothing is connected to its Docker.',
  stopQuestion: 'Stop the VM of Devspaces?',
  stopDetail: (devspaces: readonly string[]) =>
    `${devspaces.length === 1 ? 'This devspace runs' : 'These devspaces run'} in the VM and stop with it: ${devspaces.join(', ')}. ` +
    `The ${devspaces.length === 1 ? 'window of this devspace loses its' : 'windows of these devspaces lose their'} connection. Nothing is deleted. The VM starts again with the next Start of a devspace.`,
  stop: 'Stop the VM',
  stopping: 'Stopping the VM of Devspaces…',
  stopped: 'The VM of Devspaces was stopped. It starts again with the next Start of a devspace.',
  stopFailed: 'The VM of Devspaces could not be stopped.',
  resetQuestion: 'Remove the VM of Devspaces and set it up again?',
  resetDetail:
    'Devspaces deletes the VM with everything in it: all your devspaces there with the changes that you did not push, their images and their volumes. This cannot be undone. ' +
    'The windows of these devspaces lose the connection. Then Devspaces sets up a new VM from its image and uses it.',
  reset: 'Remove and Set Up Again',
  settingsNotHere: 'On Windows, the memory and the processors of the WSL distribution of Devspaces are the settings of WSL (the file .wslconfig of your Windows user).',
} as const;

/** The query of the Settings editor for the settings of the VM: its memory and its CPUs (a list of IDs after `@id:`). */
export const VM_SETTINGS_QUERY = `@id:${SETTINGS_SECTION}.vmMemoryGiB,${SETTINGS_SECTION}.vmCpus`;

export interface VmCommandsDeps {
  logger: Logger;
  showLog: () => void;
  /** The VM of Devspaces on this platform (LIMA_HOST or WSL_HOST), undefined where there is none. */
  vmHost: string | undefined;
  /** Whether the settings of the VM are settings of Devspaces (macOS and Linux). */
  hasSettings: boolean;
  /** The state of the VM, read without a start. */
  state: () => Promise<VmState>;
  /** The test of the host of the VM with its progress, which starts it (RemoteDockerCommands.testHost); true when Docker answers. */
  start: (host: string) => Promise<boolean>;
  /** The names of the devspaces whose containers run in the VM now (the VM runs). */
  runningDevspaces: () => Promise<string[]>;
  /** Stops the VM: `limactl stop`, or `wsl --terminate devspaces`. */
  stop: (signal: AbortSignal) => Promise<void>;
  /** The connections of this window to the VM end (its worker, the relay), before a stop or a removal. */
  closeConnections: () => void;
  /** "Remove the VM…" of the platform, with its own question (LimaSetupCommands.remove, WslSetupCommands.remove). */
  remove: () => Promise<void>;
  /** The removal without a question and a new setup (LimaSetupCommands.removeAndSetUpAgain, WslSetupCommands.removeAndSetUpAgain). */
  removeAndSetUpAgain: () => Promise<void>;
  /** The setup of the VM (LimaSetupCommands.setUp, WslSetupCommands.setUp). */
  setUp: () => Promise<void>;
  /** The VM changed: the view "Docker Hosts" shows its state again, and reads it again when it is open (`reread`). */
  onDidChange: (reread: boolean) => void;
}

export class VmCommands {
  constructor(private readonly deps: VmCommandsDeps) {}

  /** "Start the VM": the test of its host, which starts it. Never throws. */
  async start(): Promise<void> {
    const host = this.deps.vmHost;
    if (host === undefined) return this.inform(VmTexts.noVm);
    try {
      const state = await this.deps.state();
      if (state.kind === 'notSetUp') return this.offerSetUp();
      if (state.kind === 'running') {
        this.inform(VmTexts.alreadyRunning);
        return;
      }
      this.deps.logger.info('Start the VM: the test of the VM of Devspaces starts it.');
      if (await this.deps.start(host)) this.inform(VmTexts.started);
    } catch (error) {
      this.deps.logger.error('The VM of Devspaces could not be started.', error);
    } finally {
      this.deps.onDidChange(true);
    }
  }

  /**
   * "Stop the VM…": asks first while devspaces run there (it names them; their windows lose the connection), then stops
   * the VM. Never throws.
   */
  async stop(): Promise<void> {
    if (this.deps.vmHost === undefined) return this.inform(VmTexts.noVm);
    try {
      const state = await this.deps.state();
      if (state.kind === 'notSetUp') return this.offerSetUp();
      if (state.kind === 'stopped') {
        this.inform(VmTexts.notRunning);
        return;
      }
      // Only a VM that runs is asked for its devspaces: a Docker call to a VM in another state could start it.
      const running =
        state.kind !== 'running'
          ? []
          : await this.deps.runningDevspaces().catch((error: unknown) => {
              this.deps.logger.warn(`The devspaces that run in the VM of Devspaces could not be read: ${errorMessage(error)}`);
              return [];
            });
      if (running.length > 0) {
        const answer = await showWarningMessage(VmTexts.stopQuestion, { modal: true, detail: VmTexts.stopDetail(running) }, VmTexts.stop);
        if (answer !== VmTexts.stop) return;
      }
      this.deps.logger.info(`Stop the VM${running.length > 0 ? ` (with the devspaces ${running.join(', ')})` : ''}.`);
      await withNotificationProgress({ title: VmTexts.stopping, cancellable: false }, async () => {
        this.deps.closeConnections();
        await this.deps.stop(new AbortController().signal);
      });
      this.inform(VmTexts.stopped);
    } catch (error) {
      if (isAbortError(error)) return;
      this.deps.logger.error(VmTexts.stopFailed, error);
      this.showError(`${VmTexts.stopFailed} ${errorMessage(error)}`);
    } finally {
      this.deps.onDidChange(false);
    }
  }

  /** "Remove the VM…": the removal of the platform, which asks first. Never throws. */
  async remove(): Promise<void> {
    if (this.deps.vmHost === undefined) return this.inform(VmTexts.noVm);
    try {
      await this.deps.remove();
    } finally {
      this.deps.onDidChange(false);
    }
  }

  /** "Remove and Set Up the VM Again…": asks first, then removes the VM and sets up a new one. Never throws. */
  async reset(): Promise<void> {
    if (this.deps.vmHost === undefined) return this.inform(VmTexts.noVm);
    try {
      const state = await this.deps.state();
      if (state.kind === 'notSetUp') return this.offerSetUp();
      const answer = await showWarningMessage(VmTexts.resetQuestion, { modal: true, detail: VmTexts.resetDetail }, VmTexts.reset);
      if (answer !== VmTexts.reset) return;
      this.deps.closeConnections();
      await this.deps.removeAndSetUpAgain();
    } catch (error) {
      this.deps.logger.error('The VM of Devspaces could not be set up again.', error);
    } finally {
      this.deps.onDidChange(true);
    }
  }

  /** "Settings of the VM": the Settings editor with the memory and the CPUs of the VM (macOS and Linux). */
  async settings(): Promise<void> {
    if (!this.deps.hasSettings) return this.inform(VmTexts.settingsNotHere);
    await vscode.commands.executeCommand('workbench.action.openSettings', VM_SETTINGS_QUERY);
  }

  /** The message that the VM is not set up, with its setup; not awaited, so that the command ends. */
  private offerSetUp(): void {
    showInformationMessage(VmTexts.notSetUp, VmTexts.setUp)
      .then((answer) => (answer === VmTexts.setUp ? this.deps.setUp() : undefined))
      .then(undefined, (error: unknown) => this.deps.logger.error('The VM of Devspaces could not be set up.', error));
  }

  private inform(text: string): void {
    showInformationMessage(text).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }

  private showError(text: string): void {
    showErrorMessage(text, Actions.showDetails).then(
      (choice) => {
        if (choice === Actions.showDetails) this.deps.showLog();
      },
      (error: unknown) => this.deps.logger.error('Could not show the message.', error),
    );
  }
}
