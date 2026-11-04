// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The update of VS Code before a new window connects to a devspace (docs/requirements.md R-DS-006, setting
// devspaces.installVsCodeUpdateFirst): when VS Code has downloaded an update and waits for its restart ("Restart to
// Update"), VS Code restarts first, so that the devspace gets the VS Code Server of the new version.
//
// VS Code has no API for its own updates. Two commands of its workbench serve here (VS Code 1.125 to 1.145 have both;
// the tests in a real VS Code check them, test/vscode/extension.test.ts):
// - `_update.state`, an internal command (UpdateContribution in src/vs/workbench/contrib/update/browser/update.ts of
//   VS Code), returns the state of the update service, for example `{ type: 'ready', update: { version: '<commit>',
//   productVersion: '1.146.0' } }`. The workbench registers it in its phase "Restored". In a window that VS Code opens
//   for a remote authority, the extensions of that authority activate before this phase, and VS Code connects the
//   window only after their activation. A command whose ID is not registered yet waits for the extensions of the
//   window, which in such a window wait for the end of this activation, so the code first looks for the ID in
//   `vscode.commands.getCommands()` and runs the command only when it is there.
// - `update.restartToUpdate` ("Restart to Update") runs `quitAndInstall` of the update service, which does nothing
//   unless the state is `ready`. Else the state becomes `restarting`, and VS Code closes all its windows: each window
//   may ask about unsaved files, and Cancel there keeps every window and gives the state `ready` back. Then VS Code
//   installs the update and starts again with all windows of the last session (also when the setting
//   `window.restoreWindows` says otherwise). VS Code closes a window for a remote authority only after the activation
//   of its extensions, so the window that asks for the restart must end its activation while VS Code closes: a test
//   in VS Code 1.145 showed that the quit waits for the end of the activation (VscodeUpdate.restartToInstall).
// Only an update in the state `ready` is installed. The states before it (the download, the installation in the
// background on Windows) can take minutes, and on Linux VS Code installs no update itself: the state stays
// `available for download`, and the package manager of the system updates VS Code.
import type * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import { sleep, systemClock, type Clock, type Logger } from '../core/ports';
import type { ReadyVscodeUpdate } from '../core/types';

/** The internal command of the workbench that returns the state of the update service. */
export const UPDATE_STATE_COMMAND = '_update.state';
/** "Restart to Update": installs an update in the state `ready`, and does nothing in any other state. */
export const RESTART_TO_UPDATE_COMMAND = 'update.restartToUpdate';

/** The key in the global state of the extension: the last restart of VS Code for an update (UpdateRestartRecord). */
export const UPDATE_RESTART_KEY = 'vscodeUpdateRestart';

/** The state of an update that VS Code installs at its next restart. */
const READY = 'ready';
/** The state while VS Code closes its windows for the restart to update. */
const RESTARTING = 'restarting';
/** The states without an update, about which nothing is logged. */
const QUIET_STATES: ReadonlySet<string> = new Set(['uninitialized', 'idle', 'disabled', 'checking for updates']);

/** The longest wait of a window for the registration of `_update.state`, before it reads the state of the update. */
export const STATE_COMMAND_WAIT_MS = 3_000;
/** The longest wait for the answer of `_update.state`. */
export const STATE_READ_TIMEOUT_MS = 2_000;
/** The pause between two looks at the commands, and between two reads of the state around the restart. */
export const UPDATE_POLL_MS = 500;
/**
 * Without the state `restarting` this long after "Restart to Update", VS Code does not restart: it found a newer update
 * first (it downloads that one and does not restart), or the update was no longer ready. Before the state changes,
 * VS Code asks the update service for a newer update for at most 2 seconds.
 */
export const RESTART_START_MS = 10_000;
/**
 * How long the window watches the state `restarting` after the end of its activation, for example while another window
 * asks about unsaved files: when the state changes back, VS Code keeps running (VscodeUpdate.restartToInstall).
 */
export const RESTART_WATCH_MS = 10 * 60_000;

/**
 * The last restart of VS Code for an update, in the global state of the extension (shared by the windows of this
 * computer): the update, the version of VS Code that restarted for it (`vscode.version`), and the time.
 */
export interface UpdateRestartRecord {
  version: string;
  from: string;
  at: string;
}

/** What "Restart to Update" did (VscodeUpdate.restartToInstall). */
export type RestartOutcome =
  /** The state is `restarting`: VS Code closes its windows, and this window must not connect. */
  | 'restarting'
  /** VS Code did not begin to restart (no state `restarting` within RESTART_START_MS). */
  | 'notStarted'
  /** The state could not be read, so it is not known whether VS Code restarts. */
  | 'unknown'
  /** The command "Restart to Update" is missing or failed. */
  | 'failed';

/** The ReadyVscodeUpdate of a value of `_update.state`, or `undefined` for any other state or value. */
export function readyUpdateOf(state: unknown): ReadyVscodeUpdate | undefined {
  if (updateStateType(state) !== READY) return undefined;
  const update = (state as { update?: unknown }).update;
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
export function updateLabel(update: ReadyVscodeUpdate): string {
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
}

/** `reason`: one line for the log, or `undefined` when there is nothing to say (no update, or the setting is off). */
export type UpdateFirstDecision = { install: true; update: ReadyVscodeUpdate } | { install: false; reason?: string };

/**
 * Whether a new window of a devspace installs the update of VS Code first: only an update in the state `ready`, and not
 * one that VS Code restarted for before from the same version (the restart did not install it, for example because
 * the installation needs the rights of an administrator).
 */
export function decideUpdateFirst(input: UpdateFirstInput): UpdateFirstDecision {
  if (!input.enabled) return { install: false };
  if (input.state === undefined) return { install: false, reason: 'the state of the update of VS Code could not be read' };
  const update = readyUpdateOf(input.state);
  if (update === undefined) {
    const type = updateStateType(input.state);
    if (type === undefined) return { install: false, reason: 'the state of the update of VS Code has an unknown form' };
    if (QUIET_STATES.has(type)) return { install: false };
    return { install: false, reason: `the update of VS Code is in the state "${type}", not "${READY}"` };
  }
  const record = input.record;
  if (record !== undefined && record.version === update.version && record.from === input.runningVersion) {
    return {
      install: false,
      reason: `VS Code restarted for the update ${updateLabel(update)} at ${record.at} and still runs ${input.runningVersion}, so it does not restart for that update again`,
    };
  }
  return { install: true, update };
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
  logger: Logger;
  clock?: Clock;
  /** For tests. Default: `sleep`. */
  delay?: (ms: number) => Promise<void>;
}

/** The update of VS Code before a window connects to a devspace. */
export class VscodeUpdate {
  private readonly clock: Clock;
  private readonly delay: (ms: number) => Promise<void>;

  constructor(private readonly deps: VscodeUpdateDeps) {
    this.clock = deps.clock ?? systemClock;
    this.delay = deps.delay ?? ((ms) => sleep(ms));
  }

  /**
   * In the window that runs a Start, right before it opens the window of the devspace: the update that the new window
   * installs first (decideUpdateFirst), or `undefined`. Logs the decision when there is something to say. Never rejects.
   */
  async readyToInstall(enabled: boolean): Promise<ReadyVscodeUpdate | undefined> {
    if (!enabled) return undefined;
    try {
      const state = await this.readState(STATE_COMMAND_WAIT_MS);
      const decision = decideUpdateFirst({
        enabled,
        state,
        runningVersion: this.deps.runningVersion,
        record: updateRestartRecordOf(this.deps.state.get<unknown>(UPDATE_RESTART_KEY)),
      });
      if (decision.install) {
        this.deps.logger.info(
          `VS Code ${this.deps.runningVersion} has downloaded the update ${updateLabel(decision.update)} and waits for its restart: the window of the devspace installs it before it connects (setting installVsCodeUpdateFirst).`,
        );
        return decision.update;
      }
      if (decision.reason !== undefined) this.deps.logger.info(`The window of the devspace connects without an update of VS Code: ${decision.reason}.`);
      return undefined;
    } catch (error) {
      this.deps.logger.warn(`The window of the devspace connects without an update of VS Code: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * The watch of the state after the outcome `restarting` (restartToInstall). For tests: it settles when the state left
   * `restarting` or after RESTART_WATCH_MS; when VS Code closes the window first, it never settles.
   */
  restartWatch: Promise<void> | undefined;

  /**
   * In the new window of a devspace, during its activation and before it connects: "Restart to Update". Resolves with
   * `restarting` as soon as the state says that VS Code closes its windows: the activation of the window must end then,
   * without a connection, because VS Code closes the window only after it. VS Code opens the window again after the
   * update, and it connects then (as a restored window). With any other outcome, the window connects with the running
   * version. The record of the restart (UPDATE_RESTART_KEY) is written first and removed again when VS Code surely did
   * not begin to restart. After `restarting`, a watch (restartWatch) reads the state on: when it leaves `restarting`
   * while this window is still there (a window asked about unsaved files, and the user chose Cancel), VS Code keeps
   * running, and `kept` runs, so that the window connects with the running version. VS Code closes each window without
   * unsaved files at once, so this window is often closed before the answer. The record stays after Cancel: Devspaces
   * does not restart VS Code for that update again, and VS Code installs it at its next restart. Never rejects.
   */
  async restartToInstall(update: ReadyVscodeUpdate, kept?: () => void): Promise<RestartOutcome> {
    const { logger } = this.deps;
    const label = updateLabel(update);
    const running = this.deps.runningVersion;
    const record: UpdateRestartRecord = { version: update.version, from: running, at: new Date(this.clock.now()).toISOString() };
    try {
      await this.deps.state.update(UPDATE_RESTART_KEY, record);
    } catch (error) {
      logger.warn(`The restart for the update ${label} could not be recorded: ${errorMessage(error)}`);
    }
    if (!(await this.commandListed(RESTART_TO_UPDATE_COMMAND, STATE_COMMAND_WAIT_MS))) {
      logger.warn(`VS Code has no command "${RESTART_TO_UPDATE_COMMAND}", so this window connects with VS Code ${running}.`);
      await this.forgetRestart();
      return 'failed';
    }
    logger.info(
      `VS Code restarts to install the update ${label} before this window connects. A window may ask about unsaved files; Cancel there keeps VS Code ${running} running, and this window connects with it if VS Code did not close it.`,
    );
    const started = this.clock.now();
    try {
      await this.deps.execute(RESTART_TO_UPDATE_COMMAND);
    } catch (error) {
      logger.warn(`VS Code could not restart for the update ${label}, so this window connects with VS Code ${running}: ${errorMessage(error)}`);
      await this.forgetRestart();
      return 'failed';
    }
    let readable = false;
    for (;;) {
      const type = updateStateType(await this.readState(0));
      if (type === RESTARTING) {
        logger.info(`VS Code closes its windows to install the update ${label}. This window connects after the restart.`);
        this.restartWatch = this.watchRestart(label, kept);
        return 'restarting';
      }
      if (type !== undefined) readable = true;
      if (this.clock.now() - started >= RESTART_START_MS) {
        if (!readable) {
          logger.warn(`The state of the update of VS Code could not be read after "Restart to Update", so this window connects with VS Code ${running}.`);
          return 'unknown';
        }
        logger.info(`VS Code did not begin to restart for the update ${label} (state "${type ?? 'not readable'}"), so this window connects with VS Code ${running}.`);
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
        `VS Code did not restart for the update ${label} (a window kept it running, for example after Cancel on unsaved files), so this window connects with VS Code ${this.deps.runningVersion}. Devspaces does not restart VS Code for this update again; VS Code installs it at its next restart.`,
      );
      try {
        kept?.();
      } catch (error) {
        logger.warn(`The window could not connect after VS Code kept running: ${errorMessage(error)}`);
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
   * for the extensions of the window, which in a window for a remote authority wait for the end of this activation, so
   * a command runs only when it is listed.
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
