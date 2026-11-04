// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The update of VS Code before a devspace starts (docs/requirements.md R-DS-006, setting
// devspaces.installVsCodeUpdateFirst): while VS Code shows its button Update in the title bar, a Start updates VS Code
// first, so that the devspace starts with the VS Code Server of the new version. The Controller continues the Start
// after the restart (Controller.startAfterUpdate).
//
// VS Code has no API for its own updates. These commands of its workbench serve here (VS Code 1.125 to 1.145 have all of
// them; the tests in a real VS Code check them, test/vscode/extension.test.ts):
// - `_update.state`, an internal command (UpdateContribution in src/vs/workbench/contrib/update/browser/update.ts of
//   VS Code), returns the state of the update service, for example `{ type: 'ready', update: { version: '<commit>',
//   productVersion: '1.146.0' } }`. The workbench registers it in its phase "Restored".
// - The button Update (UpdateTitleBarEntry in updateTitleBarEntry.ts of VS Code) shows in the states `available for
//   download`, `downloaded` and `ready`, and runs the step of the state. The same steps as commands:
//   `update.downloadUpdate` (Download Update), `update.installUpdate` (Install Update), and `update.restartToUpdate`
//   (Restart to Update). Each does nothing in any other state.
// - Download Update downloads the update only on macOS. On Windows and Linux, the state `available for download` means
//   an installation that VS Code does not update itself (a ZIP archive, a package of Linux): the command opens the
//   download page in the browser, so Devspaces does not run it.
// - Restart to Update sets the state `restarting`, and VS Code closes all its windows: each window may ask about unsaved
//   files, and Cancel there keeps VS Code running and gives the state `ready` back. VS Code closes each window without
//   unsaved files at once. Then VS Code installs the update and starts again with all windows of the last session (also
//   when the setting `window.restoreWindows` says otherwise).
// A command whose ID is not registered yet waits for the extensions of the window, so a command runs only when
// `vscode.commands.getCommands()` lists it.
import type * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import { sleep, systemClock, type Clock, type Logger } from '../core/ports';

/** The internal command of the workbench that returns the state of the update service. */
export const UPDATE_STATE_COMMAND = '_update.state';
/** "Download Update": in the state `available for download`. */
export const DOWNLOAD_UPDATE_COMMAND = 'update.downloadUpdate';
/** "Install Update": in the state `downloaded`. */
export const INSTALL_UPDATE_COMMAND = 'update.installUpdate';
/** "Restart to Update": in the state `ready`. */
export const RESTART_TO_UPDATE_COMMAND = 'update.restartToUpdate';

/** The key in the global state of the extension: the last restart of VS Code for an update (UpdateRestartRecord). */
export const UPDATE_RESTART_KEY = 'vscodeUpdateRestart';

const AVAILABLE = 'available for download';
const DOWNLOADED = 'downloaded';
const READY = 'ready';
const RESTARTING = 'restarting';
/** The states without an update, about which nothing is logged. */
const QUIET_STATES: ReadonlySet<string> = new Set(['uninitialized', 'idle', 'disabled', 'checking for updates']);
/** The states while VS Code downloads or installs an update, through which the wait for `ready` goes on. */
const WORKING_STATES: ReadonlySet<string> = new Set(['checking for updates', 'downloading', DOWNLOADED, 'updating', 'overwriting']);

/** The longest wait for the registration of a command of the update. */
export const COMMAND_WAIT_MS = 3_000;
/** The longest wait for the answer of `_update.state`. */
export const STATE_READ_TIMEOUT_MS = 2_000;
/** The pause between two looks at the commands, and between two reads of the state. */
export const UPDATE_POLL_MS = 500;
/**
 * Without a change of the state this long after the command of a step, VS Code does not do the step: for example, it
 * found a newer update first, or the update was no longer in that state. Before `restarting`, VS Code asks the update
 * service for a newer update for at most 2 seconds.
 */
export const STEP_START_MS = 10_000;
/** The longest wait for the download and the installation of an update, until the state is `ready`. */
export const UPDATE_PREPARE_MS = 15 * 60_000;
/**
 * How long the window watches the state `restarting`, for example while another window asks about unsaved files: when
 * the state changes back, VS Code keeps running (VscodeUpdate.updateAndRestart, `kept`).
 */
export const RESTART_WATCH_MS = 10 * 60_000;

/** An update of VS Code. */
export interface VscodeUpdateVersion {
  /** The commit of the new build (`update.version` of the update service; a Snap package names no commit). */
  version: string;
  /** Its version number, for example `1.146.0`, when the update service named it. */
  productVersion?: string;
}

/** The step that the button Update would run: download, install, or restart. */
export type UpdateStep = 'download' | 'install' | 'restart';

/** What a Start does before the devspace starts: the first step, and the update. */
export interface UpdatePlan {
  first: UpdateStep;
  update: VscodeUpdateVersion;
}

/**
 * The last restart of VS Code for an update, in the global state of the extension (shared by the windows of this
 * computer): the update, the version of VS Code that restarted for it (`vscode.version`), and the time.
 */
export interface UpdateRestartRecord {
  version: string;
  from: string;
  at: string;
}

/** How the update before a Start ended (VscodeUpdate.updateAndRestart). */
export type UpdateOutcome =
  /** The state is `restarting`: VS Code closes its windows. */
  | 'restarting'
  /** The user cancelled the progress notification during the download or the installation. */
  | 'cancelled'
  /** The update did not become `ready` (VS Code did not do a step, a step ended in another state, or the time ran out). */
  | 'notReady'
  /** VS Code did not begin to restart (no state `restarting` within STEP_START_MS). */
  | 'notStarted'
  /** The state could not be read, so it is not known whether VS Code restarts. */
  | 'unknown'
  /** A command is missing or failed. */
  | 'failed';

/** The update of a value of `_update.state` in the states that name one, or `undefined`. */
export function updateOf(state: unknown): VscodeUpdateVersion | undefined {
  if (!isRecord(state)) return undefined;
  const update = state.update;
  if (!isRecord(update)) return undefined;
  const { version, productVersion } = update;
  if (typeof version !== 'string' || version.trim() === '') return undefined;
  return typeof productVersion === 'string' && productVersion.trim() !== '' ? { version, productVersion } : { version };
}

/** The type of a value of `_update.state` (`idle`, `downloading`, `ready`, …), or `undefined`. */
export function updateStateType(state: unknown): string | undefined {
  if (!isRecord(state)) return undefined;
  return typeof state.type === 'string' ? state.type : undefined;
}

/** The UpdateRestartRecord of a value of the global state, or `undefined`. */
export function updateRestartRecordOf(value: unknown): UpdateRestartRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { version, from, at } = value;
  return typeof version === 'string' && typeof from === 'string' && typeof at === 'string' ? { version, from, at } : undefined;
}

/** The name of an update in the log and in the texts: its version number, else its commit. */
export function updateLabel(update: VscodeUpdateVersion): string {
  return update.productVersion ?? update.version;
}

export interface UpdateFirstInput {
  /** The setting installVsCodeUpdateFirst. */
  enabled: boolean;
  /** The value of `_update.state`, or `undefined` when it could not be read. */
  state: unknown;
  /** The version of the running VS Code (`vscode.version`). */
  runningVersion: string;
  /** The last restart for an update (UPDATE_RESTART_KEY). */
  record: UpdateRestartRecord | undefined;
  /** `process.platform`: only VS Code on macOS downloads an update in the state `available for download`. */
  platform: NodeJS.Platform;
}

/** `reason`: one line for the log, or `undefined` when there is nothing to say (no update, or the setting is off). */
export type UpdateFirstDecision = { install: true; plan: UpdatePlan } | { install: false; reason?: string };

/**
 * Whether a Start updates VS Code first, and with which step: in the states of the button Update, when VS Code can do
 * the steps itself, and not for an update that VS Code restarted for before from the same version (the restart did not
 * install it, for example because the installation needs the rights of an administrator, or the user chose Cancel).
 */
export function decideUpdateFirst(input: UpdateFirstInput): UpdateFirstDecision {
  if (!input.enabled) return { install: false };
  if (input.state === undefined) return { install: false, reason: 'the state of the update of VS Code could not be read' };
  const type = updateStateType(input.state);
  if (type === undefined) return { install: false, reason: 'the state of the update of VS Code has an unknown form' };
  if (QUIET_STATES.has(type)) return { install: false };
  const update = updateOf(input.state);
  const first: UpdateStep | undefined = type === READY ? 'restart' : type === DOWNLOADED ? 'install' : type === AVAILABLE ? 'download' : undefined;
  if (first === undefined || update === undefined) return { install: false, reason: `the update of VS Code is in the state "${type}"` };
  if (first === 'download' && (input.platform !== 'darwin' || (input.state as { canInstall?: unknown }).canInstall === false)) {
    return { install: false, reason: `VS Code does not install the update ${updateLabel(update)} itself here (its button Update opens the download page)` };
  }
  const record = input.record;
  if (record !== undefined && record.version === update.version && record.from === input.runningVersion) {
    return {
      install: false,
      reason: `VS Code restarted for the update ${updateLabel(update)} at ${record.at} and still runs ${input.runningVersion}, so it does not restart for that update again`,
    };
  }
  return { install: true, plan: { first, update } };
}

export interface VscodeUpdateDeps {
  /** The IDs of the commands of VS Code, also the internal ones (`vscode.commands.getCommands(false)`). */
  commands(): Thenable<readonly string[]>;
  /** Runs a command of VS Code without arguments (`vscode.commands.executeCommand`). */
  execute(command: string): Thenable<unknown>;
  /** The global state of the extension (ExtensionContext.globalState): shared by the windows of this computer. */
  state: Pick<vscode.Memento, 'get' | 'update'>;
  /** The version of the running VS Code (`vscode.version`). */
  runningVersion: string;
  /** `process.platform`. */
  platform: NodeJS.Platform;
  logger: Logger;
  clock?: Clock;
  /** For tests. Default: `sleep`. */
  delay?: (ms: number) => Promise<void>;
}

export interface UpdateRunOptions {
  /** The Cancel of the progress notification: it ends the wait for the download or the installation. */
  signal?: AbortSignal;
  /** Each step when it begins, for the progress notification. */
  onStep?: (step: UpdateStep) => void;
  /**
   * Right before "Restart to Update", after the download or the installation: false stops the update (outcome
   * `failed`), for example when the Start after the restart could not be recorded.
   */
  beforeRestart?: () => Promise<boolean>;
  /** After `restarting`, when VS Code keeps running while this window is still there (Cancel on unsaved files). */
  kept?: () => void;
}

/** The update of VS Code before a devspace starts. */
export class VscodeUpdate {
  private readonly clock: Clock;
  private readonly delay: (ms: number) => Promise<void>;

  /**
   * The watch of the state after the outcome `restarting` (updateAndRestart). For tests: it settles when the state left
   * `restarting` or after RESTART_WATCH_MS; when VS Code closes the window first, it never settles.
   */
  restartWatch: Promise<void> | undefined;

  constructor(private readonly deps: VscodeUpdateDeps) {
    this.clock = deps.clock ?? systemClock;
    this.delay = deps.delay ?? ((ms) => sleep(ms));
  }

  /** The version of the running VS Code. */
  get runningVersion(): string {
    return this.deps.runningVersion;
  }

  /**
   * At a Start, before the devspace starts: what the Start does first (decideUpdateFirst), or `undefined`. Logs the
   * decision when there is something to say. Never rejects.
   */
  async planBeforeStart(enabled: boolean): Promise<UpdatePlan | undefined> {
    if (!enabled) return undefined;
    try {
      const state = await this.readState(COMMAND_WAIT_MS);
      const decision = decideUpdateFirst({
        enabled,
        state,
        runningVersion: this.deps.runningVersion,
        record: updateRestartRecordOf(this.deps.state.get<unknown>(UPDATE_RESTART_KEY)),
        platform: this.deps.platform,
      });
      if (decision.install) {
        this.deps.logger.info(
          `VS Code ${this.deps.runningVersion} shows its button Update for the update ${updateLabel(decision.plan.update)}: the Start updates VS Code first (setting installVsCodeUpdateFirst).`,
        );
        return decision.plan;
      }
      if (decision.reason !== undefined) this.deps.logger.info(`The Start does not update VS Code first: ${decision.reason}.`);
      return undefined;
    } catch (error) {
      this.deps.logger.warn(`The Start does not update VS Code first: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * The steps of the button Update from the first step of the plan: download (macOS), install, and then "Restart to
   * Update". Resolves with `restarting` as soon as the state says that VS Code closes its windows; then a watch
   * (restartWatch) reads the state on: when it leaves `restarting` while this window is still there (a window asked
   * about unsaved files, and the user chose Cancel), VS Code keeps running, and `kept` runs. VS Code closes each window
   * without unsaved files at once, so this window is often closed before the answer. The record of the restart
   * (UPDATE_RESTART_KEY) is written before "Restart to Update" and removed again when VS Code surely did not begin to
   * restart; it stays after Cancel, so that VS Code does not restart for that update again. Never rejects.
   */
  async updateAndRestart(plan: UpdatePlan, options: UpdateRunOptions = {}): Promise<UpdateOutcome> {
    let update = plan.update;
    if (plan.first !== 'restart') {
      const prepared = await this.prepare(plan, options);
      if (typeof prepared === 'string') return prepared;
      update = prepared;
    }
    if (options.signal?.aborted) return 'cancelled';
    options.onStep?.('restart');
    return this.restart(update, options);
  }

  /** Download (macOS) or install, until the state is `ready`: the update in the state `ready`, or the outcome. */
  private async prepare(plan: UpdatePlan, options: UpdateRunOptions): Promise<VscodeUpdateVersion | UpdateOutcome> {
    const { logger } = this.deps;
    const label = updateLabel(plan.update);
    const command = plan.first === 'download' ? DOWNLOAD_UPDATE_COMMAND : INSTALL_UPDATE_COMMAND;
    const startState = plan.first === 'download' ? AVAILABLE : DOWNLOADED;
    if (!(await this.commandListed(command, COMMAND_WAIT_MS))) {
      logger.warn(`VS Code has no command "${command}", so the Start does not update VS Code.`);
      return 'failed';
    }
    options.onStep?.(plan.first);
    logger.info(`VS Code ${plan.first === 'download' ? 'downloads' : 'installs'} the update ${label} before the devspace starts.`);
    // Not awaited: the installation on Windows answers only at its end, and the wait below has its own limits and Cancel.
    const run: { failed: boolean; error?: unknown } = { failed: false };
    Promise.resolve(this.deps.execute(command)).then(undefined, (error: unknown) => {
      run.failed = true;
      run.error = error;
    });
    const started = this.clock.now();
    for (;;) {
      if (options.signal?.aborted) {
        logger.info(`The Start was cancelled while VS Code prepared the update ${label}. VS Code goes on with the update.`);
        return 'cancelled';
      }
      if (run.failed) {
        logger.warn(`VS Code could not ${plan.first} the update ${label}, so the Start does not update VS Code: ${errorMessage(run.error)}`);
        return 'failed';
      }
      const state = await this.readState(0);
      const type = updateStateType(state);
      if (type === READY) return updateOf(state) ?? plan.update;
      const waited = this.clock.now() - started;
      if (type === startState) {
        if (waited >= STEP_START_MS) {
          logger.info(`VS Code did not begin to ${plan.first} the update ${label} (state "${type}"), so the Start does not update VS Code.`);
          return 'notReady';
        }
      } else if (type !== undefined && !WORKING_STATES.has(type)) {
        logger.info(`The update ${label} of VS Code did not become ready (state "${type}"), so the Start does not update VS Code.`);
        return 'notReady';
      }
      if (waited >= UPDATE_PREPARE_MS) {
        logger.warn(`The update ${label} of VS Code was not ready after ${UPDATE_PREPARE_MS / 60_000} minutes, so the Start does not update VS Code.`);
        return 'notReady';
      }
      await this.delay(UPDATE_POLL_MS);
    }
  }

  /** "Restart to Update" for an update in the state `ready` (updateAndRestart). */
  private async restart(update: VscodeUpdateVersion, options: UpdateRunOptions): Promise<UpdateOutcome> {
    const { logger } = this.deps;
    const label = updateLabel(update);
    const running = this.deps.runningVersion;
    if (!(await this.commandListed(RESTART_TO_UPDATE_COMMAND, COMMAND_WAIT_MS))) {
      logger.warn(`VS Code has no command "${RESTART_TO_UPDATE_COMMAND}", so the Start does not update VS Code.`);
      return 'failed';
    }
    if (options.beforeRestart !== undefined && !(await options.beforeRestart())) return 'failed';
    const record: UpdateRestartRecord = { version: update.version, from: running, at: new Date(this.clock.now()).toISOString() };
    try {
      await this.deps.state.update(UPDATE_RESTART_KEY, record);
    } catch (error) {
      logger.warn(`The restart for the update ${label} could not be recorded: ${errorMessage(error)}`);
    }
    logger.info(
      `VS Code restarts to install the update ${label}, and the devspace starts after the restart. A window may ask about unsaved files; Cancel there keeps VS Code ${running} running.`,
    );
    const started = this.clock.now();
    try {
      await this.deps.execute(RESTART_TO_UPDATE_COMMAND);
    } catch (error) {
      logger.warn(`VS Code could not restart for the update ${label}, so the devspace starts with VS Code ${running}: ${errorMessage(error)}`);
      await this.forgetRestart();
      return 'failed';
    }
    let readable = false;
    for (;;) {
      const type = updateStateType(await this.readState(0));
      if (type === RESTARTING) {
        logger.info(`VS Code closes its windows to install the update ${label}.`);
        this.restartWatch = this.watchRestart(label, options.kept);
        return 'restarting';
      }
      if (type !== undefined) readable = true;
      if (this.clock.now() - started >= STEP_START_MS) {
        if (!readable) {
          logger.warn(`The state of the update of VS Code could not be read after "Restart to Update", so the devspace starts with VS Code ${running}.`);
          return 'unknown';
        }
        logger.info(`VS Code did not begin to restart for the update ${label} (state "${type ?? 'not readable'}"), so the devspace starts with VS Code ${running}.`);
        await this.forgetRestart();
        return 'notStarted';
      }
      await this.delay(UPDATE_POLL_MS);
    }
  }

  /**
   * Reads the state after the outcome `restarting` until it leaves `restarting` (VS Code keeps running, and `kept` runs)
   * or RESTART_WATCH_MS passed. Never rejects.
   */
  private async watchRestart(label: string, kept: (() => void) | undefined): Promise<void> {
    const { logger } = this.deps;
    const started = this.clock.now();
    while (this.clock.now() - started < RESTART_WATCH_MS) {
      await this.delay(UPDATE_POLL_MS);
      const type = updateStateType(await this.readState(0));
      if (type === undefined || type === RESTARTING) continue;
      logger.info(
        `VS Code did not restart for the update ${label} (a window kept it running, for example after Cancel on unsaved files), so the devspace starts with VS Code ${this.deps.runningVersion}. Devspaces does not restart VS Code for this update again; VS Code installs it at its next restart.`,
      );
      try {
        kept?.();
      } catch (error) {
        logger.warn(`The devspace could not start after VS Code kept running: ${errorMessage(error)}`);
      }
      return;
    }
    logger.warn(`VS Code is still in the state "${RESTARTING}" ${RESTART_WATCH_MS / 60_000} minutes after "Restart to Update" for the update ${label}.`);
  }

  /**
   * The value of `_update.state`, or `undefined` when the command is not registered within `waitMs`, fails, or does not
   * answer within STATE_READ_TIMEOUT_MS.
   */
  private async readState(waitMs: number): Promise<unknown> {
    if (!(await this.commandListed(UPDATE_STATE_COMMAND, waitMs))) return undefined;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), STATE_READ_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([Promise.resolve(this.deps.execute(UPDATE_STATE_COMMAND)).catch(() => undefined), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Whether VS Code lists the command, looked for until `waitMs` passed. A command whose ID is not registered yet waits
   * for the extensions of the window, so a command runs only when it is listed.
   */
  private async commandListed(command: string, waitMs: number): Promise<boolean> {
    const deadline = this.clock.now() + waitMs;
    for (;;) {
      const commands = await Promise.resolve(this.deps.commands()).catch(() => [] as readonly string[]);
      if (commands.includes(command)) return true;
      if (this.clock.now() >= deadline) return false;
      await this.delay(UPDATE_POLL_MS);
    }
  }

  /** Removes the record of the restart: VS Code did not restart, so a later Start may restart it for this update. */
  private async forgetRestart(): Promise<void> {
    try {
      await this.deps.state.update(UPDATE_RESTART_KEY, undefined);
    } catch (error) {
      this.deps.logger.warn(`The record of the restart for the update of VS Code could not be removed: ${errorMessage(error)}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
