// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Docker setup: the context keys of the welcome view (the setup in the sidebar) and the commands of its buttons: Install
// WSL 2 on Windows runs its command in a visible terminal. Devspaces never installs Docker Desktop or Docker Engine on
// this computer: Set Up Docker for Devspaces sets up its VM (wslSetupCommands.ts, limaSetupCommands.ts). Only an
// operation starts an installed Docker Desktop on Windows (ensureDockerRunning, src/core/docker/dockerStart.ts). The
// rules are pure functions in src/core/docker/dockerSetup.ts.
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import type { BootstrapDocker } from '../core/docker/bootstrapDocker';
import { usesComputerDocker } from '../core/docker/dockerHost';
import {
  DockerContextKeys,
  DockerSetupTexts,
  INITIAL_DOCKER_SETUP_STATE,
  INSTALL_WATCH_INTERVAL_MS,
  MISSING_CLI_CHECK_MS,
  WSL_INSTALL_COMMAND,
  changedContextValues,
  dockerContextValues,
  dockerSetupRequired,
  type DockerContextKey,
  keepWatchingInstall,
  needsMissingCliCheck,
  nextDockerSetupState,
  parseOsRelease,
  terminalLines,
  type DockerSetupEvent,
  type DockerSetupState,
  installTerminalOptions,
} from '../core/docker/dockerSetup';
import { errorMessage } from '../core/errors';
import { systemClock, type Clock, type Logger, type ProcessRunner } from '../core/ports';
import type { LinkUri } from '../core/types';
import type { WslAfterInstall } from '../core/docker/wslAfterInstall';
import { showInformationMessage } from './notifications';

/** Shows the sidebar view (VS Code contributes `<view id>.focus` for each view of package.json). */
const SHOW_SIDEBAR_COMMAND = 'devspaces.repositories.focus';
/** Name of the terminal of the installation of WSL 2. */
export const INSTALL_TERMINAL_NAME = 'Install Docker';
const WSL_STATUS_TIMEOUT_MS = 15_000;
const OS_RELEASE_FILES = ['/etc/os-release', '/usr/lib/os-release'];

// User-visible texts that messages.ts lacks; to be moved there.
export const DockerSetupUiTexts = {
  /** A terminal of a remote window runs on the remote computer, not on this one. */
  localWindowNeeded: 'Open a local window to install WSL 2.',
  /** The progress of a download in megabytes (the Debian file of WSL). */
  downloadProgress: (receivedMb: number, totalMb: number | undefined) =>
    totalMb === undefined ? `${receivedMb} MB.` : `${receivedMb} of ${totalMb} MB.`,
  wslAlreadyInstalled: 'WSL 2 is already installed on this computer.',
} as const;

export interface DockerSetupDeps {
  docker: BootstrapDocker;
  runner: ProcessRunner;
  logger: Logger;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /**
   * The CLI was found or lost, or the Docker host of Devspaces changed whether the setup shows (onDockerHostChanged):
   * the sidebar shows the repositories or the Docker setup (`setupRequired`).
   */
  onDidChangeInstalled: () => void;
  /**
   * True when a remote Docker host is configured (a host of the list of Devspaces, also its VM): a missing local CLI then
   * needs no setup, and on macOS and Linux only such a host needs none (see `dockerSetupRequired`).
   */
  remoteDockerHostConfigured: () => boolean;
  /**
   * True while the sidebar view is visible. Windows: `wsl --status` runs only while the view shows the Docker setup
   * (see `onViewShown`), and after an installation started.
   */
  viewVisible: () => boolean;
  /**
   * Windows: the record of the installation of WSL, so that Devspaces goes on with the setup of its Docker after the
   * restart of Windows (WslAfterInstall).
   */
  wslAfterInstall?: Pick<WslAfterInstall, 'started'>;
  clock?: Clock;
  /** For tests: MISSING_CLI_CHECK_MS and INSTALL_WATCH_INTERVAL_MS. */
  timing?: { missingCheckMs?: number; watchIntervalMs?: number };
}

/** Linux: the fields of /etc/os-release, else of /usr/lib/os-release; undefined when neither can be read. */
export async function readOsRelease(): Promise<Record<string, string> | undefined> {
  for (const file of OS_RELEASE_FILES) {
    try {
      return parseOsRelease(await fs.promises.readFile(file, 'utf8'));
    } catch {
      // The next file.
    }
  }
  return undefined;
}

/** The login name of the user, or undefined when it cannot be read. */
export function currentUserName(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

export class DockerSetup implements vscode.Disposable {
  private readonly clock: Clock;
  private state: DockerSetupState = INITIAL_DOCKER_SETUP_STATE;
  /** The values that the context keys show; `undefined` until they were set once. */
  private shown: Record<DockerContextKey, boolean> | undefined;
  private missingTimer: NodeJS.Timeout | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private watchStartedAt = 0;
  /** The `wsl --status` that runs (one at a time). */
  private wslCheck: Promise<void> | undefined;
  /** True once a `wsl --status` ended. */
  private wslChecked = false;
  /** This window started the installation of WSL, and WSL was not ready then. */
  private wslInstallStarted = false;
  private disposed = false;

  constructor(private readonly deps: DockerSetupDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** True while no Docker CLI is found. */
  get dockerMissing(): boolean {
    return !this.state.cliFound;
  }

  /**
   * True while the sidebar shows the Docker setup instead of the repositories (`dockerSetupRequired`: no remote Docker
   * host is configured and the local Docker is not available; on macOS and Linux, Devspaces never uses it).
   */
  get setupRequired(): boolean {
    return dockerSetupRequired(this.dockerMissing, this.deps.remoteDockerHostConfigured(), usesComputerDocker(this.deps.platform));
  }

  /**
   * Sets the context keys; while the CLI is missing, it is looked up again every 10 seconds. No `docker info`. Windows:
   * `wsl --status` only while the view is visible and shows the Docker setup.
   */
  initialize(): void {
    this.checkCli();
    this.checkWslWhileShown();
  }

  /**
   * The sidebar view became visible. Windows: while it shows the Docker setup and WSL is not known to be ready,
   * `wsl --status` runs, so that the step Install WSL 2 shows the state of WSL.
   */
  onViewShown(): void {
    this.checkWslWhileShown();
  }

  /**
   * Asks BootstrapDocker whether the CLI is found. A missing CLI is looked up again (at most every 10 seconds); a CLI
   * that was found counts as found until a call of it fails with ENOENT (then BootstrapDocker reports `reportCliLost`).
   */
  checkCli(): boolean {
    return this.lookUp(() => this.deps.docker.isInstalled());
  }

  /**
   * BootstrapDocker option `onCliLost`: a CLI that was found cannot be started anymore. The sidebar shows the setup at
   * once; no lookup runs here, so the next call of the adapter (or the check every 10 seconds) looks the CLI up again,
   * for example after Docker Desktop has updated itself.
   */
  reportCliLost(): void {
    this.apply({ kind: 'cli', found: false });
  }

  /**
   * Command devspaces.dockerSetup.show (action Install Docker… of the error "Docker Desktop is not installed."):
   * updates the context keys from the adapter (a missing CLI may be found again; a lost CLI was reported already by
   * `reportCliLost`), then shows the sidebar view.
   */
  async show(): Promise<void> {
    this.checkCli();
    await vscode.commands.executeCommand(SHOW_SIDEBAR_COMMAND);
  }

  /** The result of a `docker info` that ran anyway (BootstrapDocker option `onDaemonStatus`). */
  reportDaemonStatus(running: boolean): void {
    this.apply({ kind: 'engine', running });
  }

  /**
   * A read of the Docker host of Devspaces (DockerTargets.onDidResolve): the context keys follow `setupRequired`, which
   * depends on it (a remote host needs no Docker of this computer), and the sidebar renders again when it changed. Asks
   * nothing. Before `initialize`, nothing.
   */
  onDockerHostChanged(): void {
    if (this.shown === undefined) return;
    const before = this.shown[DockerContextKeys.setupRequired];
    this.apply({ kind: 'cli', found: this.state.cliFound });
    if (this.shown[DockerContextKeys.setupRequired] !== before) this.deps.onDidChangeInstalled();
  }

  /**
   * Command devspaces.dockerSetup.installWsl (sidebar button "Install WSL 2", Windows), and the setup of Docker for
   * Devspaces or a link (`link`) when WSL is missing (WslSetupCommands): WSL_INSTALL_COMMAND in the terminal, without a
   * question of Devspaces, because Windows asks for administrator permission itself; a message says what happens. The
   * record of the installation (WslAfterInstall) lets the first window after the restart of Windows go on with the setup
   * of Docker for Devspaces, and with the link.
   */
  async installWsl(link?: LinkUri): Promise<void> {
    if (this.refuseInRemoteWindow()) return;
    // The button shows until a check finds WSL ready, so a click before the first check ended waits for one.
    if (!this.wslChecked) await this.checkWsl();
    if (this.state.wslReady) {
      this.inform(DockerSetupUiTexts.wslAlreadyInstalled);
      return;
    }
    await this.deps.wslAfterInstall?.started(link);
    this.runInTerminal([WSL_INSTALL_COMMAND]);
    this.wslInstallStarted = true;
    this.inform(DockerSetupTexts.wslInstalling(INSTALL_TERMINAL_NAME, WSL_INSTALL_COMMAND));
    this.startInstallWatch();
  }

  dispose(): void {
    this.disposed = true;
    this.stopMissingTimer();
    this.stopInstallWatch();
  }

  private inform(message: string): void {
    showInformationMessage(message).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }

  /** The commands run visibly in a new terminal of VS Code; the user follows them and enters a password there. */
  private runInTerminal(commands: readonly string[]): void {
    // A fixed shell, folder, and environment: no terminal setting of the workspace and no file of the opened folder
    // changes what the listed commands run.
    const options = installTerminalOptions(this.deps.platform, this.deps.env, os.homedir(), currentUserName());
    const terminal = vscode.window.createTerminal({ name: INSTALL_TERMINAL_NAME, ...options });
    terminal.show();
    for (const line of terminalLines(commands, this.deps.platform)) {
      this.deps.logger.info(`Terminal "${INSTALL_TERMINAL_NAME}": ${line}`);
      terminal.sendText(line);
    }
  }

  /** In a remote window, a terminal would run on the remote computer: the user is asked to open a local window. */
  private refuseInRemoteWindow(): boolean {
    if (vscode.env.remoteName === undefined) return false;
    this.deps.logger.info(`WSL 2 is installed only from a local window (this window: ${vscode.env.remoteName}).`);
    showInformationMessage(DockerSetupUiTexts.localWindowNeeded)
      .then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
    return true;
  }

  /** After an installation started: the CLI every 5 seconds until it is found, for at most 30 minutes. */
  private startInstallWatch(): void {
    if (this.disposed) return;
    this.watchStartedAt = this.clock.now();
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => this.watchInstall(), this.deps.timing?.watchIntervalMs ?? INSTALL_WATCH_INTERVAL_MS);
  }

  private watchInstall(): void {
    this.lookUp(() => this.deps.docker.lookUpCliNow());
    // Follows the installation that the user started, also while the view is hidden.
    if (!this.state.wslReady) void this.checkWsl();
    if (this.watchTimer && !keepWatchingInstall(this.state, this.watchStartedAt, this.clock.now())) {
      if (!this.state.cliFound) this.deps.logger.info('Docker was not found within 30 minutes after the installation started.');
      this.stopInstallWatch();
    }
  }

  private stopInstallWatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = undefined;
  }

  /** `wsl --status` while the view is visible and shows the Docker setup, and WSL is not known to be ready. */
  private checkWslWhileShown(): void {
    if (this.setupRequired && !this.state.wslReady && this.deps.viewVisible()) void this.checkWsl();
  }

  /**
   * Windows: `wsl --status` (exit code 0: WSL is installed). One check at a time: a call while one runs gets that one.
   * Resolves when it ended; a `wsl` that cannot run counts as not ready.
   */
  private checkWsl(): Promise<void> {
    if (this.deps.platform !== 'win32' || this.disposed) return Promise.resolve();
    // Assumption: `wsl --status` ends with exit code 0 only when WSL is installed and set up.
    this.wslCheck ??= this.deps.runner
      .run('wsl.exe', ['--status'], { timeoutMs: WSL_STATUS_TIMEOUT_MS })
      .then(
        (result) => this.apply({ kind: 'wsl', ready: result.exitCode === 0 }),
        (error: unknown) => {
          this.deps.logger.info(`wsl --status could not run: ${errorMessage(error)}`);
          this.apply({ kind: 'wsl', ready: false });
        },
      )
      .finally(() => {
        this.wslChecked = true;
        this.wslCheck = undefined;
      });
    return this.wslCheck;
  }

  private lookUp(find: () => boolean): boolean {
    let found: boolean;
    try {
      found = find();
    } catch (error) {
      this.deps.logger.warn(`The Docker CLI could not be looked up: ${errorMessage(error)}`);
      found = false;
    }
    this.apply({ kind: 'cli', found });
    return found;
  }

  private apply(event: DockerSetupEvent): void {
    if (this.disposed) return;
    const before = this.state;
    const first = this.shown === undefined;
    this.state = nextDockerSetupState(before, event);
    const values = dockerContextValues(this.state, this.deps.remoteDockerHostConfigured(), usesComputerDocker(this.deps.platform));
    for (const [key, value] of changedContextValues(this.shown, values)) {
      vscode.commands.executeCommand('setContext', key, value).then(undefined, (error: unknown) => {
        this.deps.logger.warn(`Could not set the context key ${key}: ${errorMessage(error)}`);
      });
    }
    this.shown = values;
    // WSL is installed now: Windows must restart, and the first window after the restart goes on with the setup.
    if (event.kind === 'wsl' && !before.wslReady && this.state.wslReady && this.wslInstallStarted) {
      this.wslInstallStarted = false;
      this.deps.logger.info('WSL is installed. Devspaces goes on with the setup of its Docker after the restart of Windows.');
      this.inform(DockerSetupTexts.wslRestartToGoOn);
    }
    // The first check only sets the keys: the sidebar reads `setupRequired` when it renders.
    if (!first && before.cliFound !== this.state.cliFound) {
      this.deps.logger.info(this.state.cliFound ? 'The Docker CLI was found.' : 'The Docker CLI was not found.');
      this.deps.onDidChangeInstalled();
      if (this.state.cliFound && this.watchTimer) this.stopInstallWatch();
      // Windows: a CLI found at activation skipped `wsl --status`; the setup now shows the step Install WSL 2, so it
      // needs the state of WSL, now while the view is visible, else when it is shown (onViewShown). Returns at once on
      // other platforms.
      if (!this.state.cliFound) this.checkWslWhileShown();
    }
    this.updateMissingTimer();
  }

  private updateMissingTimer(): void {
    if (!needsMissingCliCheck(this.state)) {
      this.stopMissingTimer();
      return;
    }
    if (this.missingTimer) return;
    this.missingTimer = setInterval(() => this.checkCli(), this.deps.timing?.missingCheckMs ?? MISSING_CLI_CHECK_MS);
  }

  private stopMissingTimer(): void {
    if (this.missingTimer) clearInterval(this.missingTimer);
    this.missingTimer = undefined;
  }
}
