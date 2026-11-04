// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_WAIT_MS,
  DOWNLOAD_UPDATE_COMMAND,
  INSTALL_UPDATE_COMMAND,
  RESTART_TO_UPDATE_COMMAND,
  RESTART_WATCH_MS,
  STATE_READ_TIMEOUT_MS,
  STEP_START_MS,
  UPDATE_PREPARE_MS,
  UPDATE_RESTART_KEY,
  UPDATE_STATE_COMMAND,
  VscodeUpdate,
  decideUpdateFirst,
  updateOf,
  updateRestartRecordOf,
  type UpdatePlan,
  type UpdateRestartRecord,
  type UpdateStep,
} from './vscodeUpdate';

const COMMIT = 'a717861c07586a53d83b80d742cd3f59b20a6273';
const UPDATE = { version: COMMIT, productVersion: '1.146.0' };
const READY_STATE = { type: 'ready', update: UPDATE, explicit: false, overwrite: false };
const DOWNLOADED_STATE = { type: 'downloaded', update: UPDATE, explicit: false, overwrite: false };
const AVAILABLE_STATE = { type: 'available for download', update: UPDATE };
const RESTARTING_STATE = { type: 'restarting', update: UPDATE };
const RUNNING = '1.145.0';
const START = Date.parse('2026-11-04T22:00:00.000Z');
const RECORD: UpdateRestartRecord = { version: COMMIT, from: RUNNING, at: '2026-11-04T22:00:00.000Z' };
const ALL_COMMANDS = ['workbench.action.reloadWindow', UPDATE_STATE_COMMAND, DOWNLOAD_UPDATE_COMMAND, INSTALL_UPDATE_COMMAND, RESTART_TO_UPDATE_COMMAND];

describe('updateOf', () => {
  it('takes the commit and the version number of an update', () => {
    for (const state of [READY_STATE, DOWNLOADED_STATE, AVAILABLE_STATE]) expect(updateOf(state)).toEqual(UPDATE);
    // A Snap package names no commit and no version number.
    expect(updateOf({ type: 'ready', update: { version: 'something' } })).toEqual({ version: 'something' });
  });

  it('gives nothing for values without an update', () => {
    for (const state of [{ type: 'idle', updateType: 1 }, { type: 'ready' }, { type: 'ready', update: { version: '' } }, { type: 'ready', update: { version: 7 } }, 'ready', undefined, null, [READY_STATE]]) {
      expect(updateOf(state)).toBeUndefined();
    }
  });
});

describe('updateRestartRecordOf', () => {
  it('reads a record with three strings and nothing else', () => {
    expect(updateRestartRecordOf(RECORD)).toEqual(RECORD);
    expect(updateRestartRecordOf({ version: COMMIT, from: RUNNING })).toBeUndefined();
    expect(updateRestartRecordOf('x')).toBeUndefined();
    expect(updateRestartRecordOf(undefined)).toBeUndefined();
  });
});

describe('decideUpdateFirst', () => {
  const input = { enabled: true, state: READY_STATE as unknown, runningVersion: RUNNING, record: undefined as UpdateRestartRecord | undefined, platform: 'darwin' as NodeJS.Platform };

  it('takes the step of the button Update: restart, install, or download', () => {
    expect(decideUpdateFirst(input)).toEqual({ install: true, plan: { first: 'restart', update: UPDATE } });
    expect(decideUpdateFirst({ ...input, state: DOWNLOADED_STATE, platform: 'win32' })).toEqual({ install: true, plan: { first: 'install', update: UPDATE } });
    expect(decideUpdateFirst({ ...input, state: AVAILABLE_STATE })).toEqual({ install: true, plan: { first: 'download', update: UPDATE } });
  });

  it('does not download where the button Update opens the download page: Windows, Linux, and an app that cannot install', () => {
    const reason = 'VS Code does not install the update 1.146.0 itself here (its button Update opens the download page)';
    expect(decideUpdateFirst({ ...input, state: AVAILABLE_STATE, platform: 'linux' })).toEqual({ install: false, reason });
    expect(decideUpdateFirst({ ...input, state: AVAILABLE_STATE, platform: 'win32' })).toEqual({ install: false, reason });
    expect(decideUpdateFirst({ ...input, state: { ...AVAILABLE_STATE, canInstall: false } })).toEqual({ install: false, reason });
    // On Linux, VS Code of a package manager reaches no other state of the button.
    expect(decideUpdateFirst({ ...input, platform: 'linux' }).install).toBe(true);
  });

  it('installs nothing and says nothing when the setting is off', () => {
    expect(decideUpdateFirst({ ...input, enabled: false })).toEqual({ install: false });
  });

  it('says nothing without an update, and names the state of an update that VS Code still downloads or installs', () => {
    for (const type of ['uninitialized', 'idle', 'disabled', 'checking for updates']) {
      expect(decideUpdateFirst({ ...input, state: { type } })).toEqual({ install: false });
    }
    expect(decideUpdateFirst({ ...input, state: { type: 'downloading', update: UPDATE } })).toEqual({ install: false, reason: 'the update of VS Code is in the state "downloading"' });
    expect(decideUpdateFirst({ ...input, state: { type: 'updating', update: UPDATE } })).toEqual({ install: false, reason: 'the update of VS Code is in the state "updating"' });
    expect(decideUpdateFirst({ ...input, state: { type: 'ready' } })).toEqual({ install: false, reason: 'the update of VS Code is in the state "ready"' });
  });

  it('says so when the state cannot be read or has another form', () => {
    expect(decideUpdateFirst({ ...input, state: undefined })).toEqual({ install: false, reason: 'the state of the update of VS Code could not be read' });
    expect(decideUpdateFirst({ ...input, state: 'ready' })).toEqual({ install: false, reason: 'the state of the update of VS Code has an unknown form' });
  });

  it('does not restart again for an update that the last restart from the same version did not install', () => {
    const record = { version: COMMIT, from: RUNNING, at: '2026-11-04T21:00:00.000Z' };
    const reason = 'VS Code restarted for the update 1.146.0 at 2026-11-04T21:00:00.000Z and still runs 1.145.0, so it does not restart for that update again';
    expect(decideUpdateFirst({ ...input, record })).toEqual({ install: false, reason });
    expect(decideUpdateFirst({ ...input, record, state: DOWNLOADED_STATE })).toEqual({ install: false, reason });
    // Another update, or a restart that changed the version of VS Code (a Snap package names no commit): it restarts.
    expect(decideUpdateFirst({ ...input, record: { ...record, version: 'b224f6bf5a4fcad5fa4c640ed10f179c3b613e48' } }).install).toBe(true);
    expect(decideUpdateFirst({ ...input, record: { ...record, from: '1.144.2' } }).install).toBe(true);
  });
});

/**
 * A VscodeUpdate over fakes: `states` are the answers of `_update.state` in turn (the last one repeats), `commands` the
 * commands that VS Code lists, `listedFrom` the look at the commands from which they are listed. `delay` moves the fake
 * clock.
 */
function harness(
  options: {
    states?: unknown[];
    commands?: string[];
    listedFrom?: number;
    stored?: unknown;
    fails?: Partial<Record<string, Error>>;
    platform?: NodeJS.Platform;
  } = {},
) {
  let time = START;
  const states = [...(options.states ?? [READY_STATE])];
  let looks = 0;
  const values = new Map<string, unknown>(options.stored === undefined ? [] : [[UPDATE_RESTART_KEY, options.stored]]);
  const state = {
    get: vi.fn((key: string) => values.get(key)),
    update: vi.fn(async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    }),
  };
  const commands = vi.fn(async () => (looks++ >= (options.listedFrom ?? 0) ? (options.commands ?? ALL_COMMANDS) : []));
  const execute = vi.fn(async (command: string): Promise<unknown> => {
    const failure = options.fails?.[command];
    if (failure) throw failure;
    if (command === UPDATE_STATE_COMMAND) return states.length > 1 ? states.shift() : states[0];
    if ([DOWNLOAD_UPDATE_COMMAND, INSTALL_UPDATE_COMMAND, RESTART_TO_UPDATE_COMMAND].includes(command)) return undefined;
    throw new Error(`command '${command}' not found`);
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
  const delay = vi.fn(async (ms: number) => {
    time += ms;
  });
  const update = new VscodeUpdate({ commands, execute, state, runningVersion: RUNNING, platform: options.platform ?? 'darwin', logger, clock: { now: () => time }, delay });
  return { update, commands, execute, state, values, logger, delay, elapsed: () => time - START };
}

const calls = (execute: ReturnType<typeof harness>['execute'], command: string) => execute.mock.calls.filter(([name]) => name === command).length;

describe('VscodeUpdate.planBeforeStart', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the plan of an update in the state ready and logs it', async () => {
    const h = harness();
    await expect(h.update.planBeforeStart(true)).resolves.toEqual({ first: 'restart', update: UPDATE });
    expect(h.logger.info).toHaveBeenCalledWith('VS Code 1.145.0 shows its button Update for the update 1.146.0: the Start updates VS Code first (setting installVsCodeUpdateFirst).');
    expect(h.delay).not.toHaveBeenCalled();
  });

  it('asks nothing when the setting is off', async () => {
    const h = harness();
    await expect(h.update.planBeforeStart(false)).resolves.toBeUndefined();
    expect(h.commands).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('runs _update.state only once the command is registered, and waits for it at most COMMAND_WAIT_MS', async () => {
    const later = harness({ listedFrom: 2 });
    await expect(later.update.planBeforeStart(true)).resolves.toEqual({ first: 'restart', update: UPDATE });
    expect(later.commands).toHaveBeenCalledTimes(3);

    const never = harness({ listedFrom: Number.POSITIVE_INFINITY });
    await expect(never.update.planBeforeStart(true)).resolves.toBeUndefined();
    expect(never.execute).not.toHaveBeenCalled();
    expect(never.elapsed()).toBe(COMMAND_WAIT_MS);
    expect(never.logger.info).toHaveBeenCalledWith('The Start does not update VS Code first: the state of the update of VS Code could not be read.');
  });

  it('gives nothing when _update.state fails or does not answer in time', async () => {
    const failing = harness({ fails: { [UPDATE_STATE_COMMAND]: new Error('boom') } });
    await expect(failing.update.planBeforeStart(true)).resolves.toBeUndefined();

    vi.useFakeTimers();
    const silent = harness();
    silent.execute.mockImplementation(() => new Promise<never>(() => {}));
    const result = silent.update.planBeforeStart(true);
    await vi.advanceTimersByTimeAsync(STATE_READ_TIMEOUT_MS);
    await expect(result).resolves.toBeUndefined();
  });

  it('gives nothing for an update that the last restart from this version did not install, and logs why', async () => {
    const h = harness({ stored: { version: COMMIT, from: RUNNING, at: '2026-11-04T21:00:00.000Z' } });
    await expect(h.update.planBeforeStart(true)).resolves.toBeUndefined();
    expect(h.logger.info).toHaveBeenCalledWith(
      'The Start does not update VS Code first: VS Code restarted for the update 1.146.0 at 2026-11-04T21:00:00.000Z and still runs 1.145.0, so it does not restart for that update again.',
    );
  });

  it('logs nothing without an update', async () => {
    const h = harness({ states: [{ type: 'idle', updateType: 1 }] });
    await expect(h.update.planBeforeStart(true)).resolves.toBeUndefined();
    expect(h.logger.info).not.toHaveBeenCalled();
  });
});

describe('VscodeUpdate.updateAndRestart', () => {
  const restartPlan: UpdatePlan = { first: 'restart', update: UPDATE };
  const installPlan: UpdatePlan = { first: 'install', update: UPDATE };
  const downloadPlan: UpdatePlan = { first: 'download', update: UPDATE };

  it('records the restart before "Restart to Update"', async () => {
    const h = harness({ states: [RESTARTING_STATE] });
    h.execute.mockImplementationOnce(async (command: string) => {
      // The record is there when VS Code begins to close its windows.
      expect(command).toBe(RESTART_TO_UPDATE_COMMAND);
      expect(h.values.get(UPDATE_RESTART_KEY)).toEqual(RECORD);
      return undefined;
    });
    await expect(h.update.updateAndRestart(restartPlan)).resolves.toBe('restarting');
    expect(calls(h.execute, RESTART_TO_UPDATE_COMMAND)).toBe(1);
  });

  it('ends with restarting as soon as VS Code closes its windows, and keeps the record', async () => {
    const h = harness({ states: [READY_STATE, READY_STATE, RESTARTING_STATE] });
    // The time of the outcome, before the watch moves the fake clock on.
    let restartingAt: number | undefined;
    h.logger.info.mockImplementation((message: string) => {
      if (message.startsWith('VS Code closes its windows')) restartingAt = h.elapsed();
    });
    const steps: UpdateStep[] = [];
    await expect(h.update.updateAndRestart(restartPlan, { onStep: (step) => steps.push(step) })).resolves.toBe('restarting');
    expect(restartingAt).toBe(2 * 500);
    expect(steps).toEqual(['restart']);
    expect(h.values.get(UPDATE_RESTART_KEY)).toEqual(RECORD);
  });

  it('installs a downloaded update first, waits for ready, and then restarts', async () => {
    const h = harness({ states: [DOWNLOADED_STATE, { type: 'updating', update: UPDATE }, { type: 'updating', update: UPDATE }, READY_STATE, RESTARTING_STATE] });
    const steps: UpdateStep[] = [];
    await expect(h.update.updateAndRestart(installPlan, { onStep: (step) => steps.push(step) })).resolves.toBe('restarting');
    expect(steps).toEqual(['install', 'restart']);
    expect(h.execute.mock.calls.map(([command]) => command).filter((command) => command !== UPDATE_STATE_COMMAND)).toEqual([INSTALL_UPDATE_COMMAND, RESTART_TO_UPDATE_COMMAND]);
  });

  it('downloads an update on macOS first, and restarts for the update that became ready', async () => {
    const newer = { version: 'b224f6bf5a4fcad5fa4c640ed10f179c3b613e48', productVersion: '1.146.1' };
    const h = harness({ states: [AVAILABLE_STATE, { type: 'checking for updates', explicit: true }, { type: 'downloading', explicit: true }, { type: 'ready', update: newer }, RESTARTING_STATE] });
    const steps: UpdateStep[] = [];
    await expect(h.update.updateAndRestart(downloadPlan, { onStep: (step) => steps.push(step) })).resolves.toBe('restarting');
    expect(steps).toEqual(['download', 'restart']);
    expect(calls(h.execute, DOWNLOAD_UPDATE_COMMAND)).toBe(1);
    expect(h.values.get(UPDATE_RESTART_KEY)).toEqual({ version: newer.version, from: RUNNING, at: '2026-11-04T22:00:01.500Z' });
  });

  it('does not wait for the answer of Install Update, which comes only at the end of the installation on Windows', async () => {
    const h = harness({ states: [READY_STATE, RESTARTING_STATE] });
    h.execute.mockImplementationOnce(() => new Promise<never>(() => {}));
    await expect(h.update.updateAndRestart(installPlan)).resolves.toBe('restarting');
  });

  it('ends with notReady when the update does not become ready, and restarts nothing', async () => {
    // The installation failed: VS Code goes back to idle.
    const failed = harness({ states: [{ type: 'updating', update: UPDATE }, { type: 'idle', updateType: 1, error: 'boom' }] });
    await expect(failed.update.updateAndRestart(installPlan)).resolves.toBe('notReady');
    expect(calls(failed.execute, RESTART_TO_UPDATE_COMMAND)).toBe(0);
    expect(failed.logger.info).toHaveBeenCalledWith('The update 1.146.0 of VS Code did not become ready (state "idle"), so the Start does not update VS Code.');

    // VS Code does not begin the step.
    const unchanged = harness({ states: [DOWNLOADED_STATE] });
    await expect(unchanged.update.updateAndRestart(installPlan)).resolves.toBe('notReady');
    expect(unchanged.elapsed()).toBe(STEP_START_MS);

    // The download takes too long.
    const slow = harness({ states: [{ type: 'downloading', explicit: true }] });
    await expect(slow.update.updateAndRestart(downloadPlan)).resolves.toBe('notReady');
    expect(slow.elapsed()).toBe(UPDATE_PREPARE_MS);
    expect(slow.logger.warn).toHaveBeenCalledWith('The update 1.146.0 of VS Code was not ready after 15 minutes, so the Start does not update VS Code.');
  });

  it('ends with cancelled when the progress notification is cancelled during the download', async () => {
    const controller = new AbortController();
    const h = harness({ states: [{ type: 'downloading', explicit: true }] });
    h.delay.mockImplementation(async () => {
      controller.abort();
    });
    await expect(h.update.updateAndRestart(downloadPlan, { signal: controller.signal })).resolves.toBe('cancelled');
    expect(calls(h.execute, RESTART_TO_UPDATE_COMMAND)).toBe(0);
  });

  it('ends with failed when Install Update fails or is missing', async () => {
    const failing = harness({ states: [DOWNLOADED_STATE], fails: { [INSTALL_UPDATE_COMMAND]: new Error('boom') } });
    await expect(failing.update.updateAndRestart(installPlan)).resolves.toBe('failed');
    expect(failing.logger.warn).toHaveBeenCalledWith('VS Code could not install the update 1.146.0, so the Start does not update VS Code: boom');

    const missing = harness({ commands: [UPDATE_STATE_COMMAND, RESTART_TO_UPDATE_COMMAND] });
    await expect(missing.update.updateAndRestart(installPlan)).resolves.toBe('failed');
    expect(calls(missing.execute, INSTALL_UPDATE_COMMAND)).toBe(0);
  });

  it('runs kept and keeps the record when the state goes from restarting back to ready', async () => {
    // A window asked about unsaved files, and the user chose Cancel: VS Code keeps running.
    const h = harness({ states: [RESTARTING_STATE, RESTARTING_STATE, undefined, RESTARTING_STATE, READY_STATE] });
    const kept = vi.fn();
    await expect(h.update.updateAndRestart(restartPlan, { kept })).resolves.toBe('restarting');
    await h.update.restartWatch;
    expect(kept).toHaveBeenCalledTimes(1);
    // After Cancel, Devspaces does not restart VS Code for this update again.
    expect(h.values.get(UPDATE_RESTART_KEY)).toEqual(RECORD);
    // An unreadable state (undefined) does not end the watch.
    expect(h.elapsed()).toBe(4 * 500);
  });

  it('logs an error of kept', async () => {
    const h = harness({ states: [RESTARTING_STATE, READY_STATE] });
    await h.update.updateAndRestart(restartPlan, {
      kept: () => {
        throw new Error('gone');
      },
    });
    await h.update.restartWatch;
    expect(h.logger.warn).toHaveBeenCalledWith('The devspace could not start after VS Code kept running: gone');
  });

  it('ends the watch after RESTART_WATCH_MS when VS Code stays in the state restarting, and keeps the record', async () => {
    const h = harness({ states: [RESTARTING_STATE] });
    const kept = vi.fn();
    await h.update.updateAndRestart(restartPlan, { kept });
    await h.update.restartWatch;
    expect(h.elapsed()).toBe(RESTART_WATCH_MS);
    expect(kept).not.toHaveBeenCalled();
    expect(h.values.get(UPDATE_RESTART_KEY)).toEqual(RECORD);
  });

  it('ends with notStarted when VS Code does not begin to restart, and forgets the restart', async () => {
    for (const state of [READY_STATE, { type: 'overwriting', update: UPDATE }, { type: 'idle', updateType: 1 }]) {
      const h = harness({ states: [state] });
      await expect(h.update.updateAndRestart(restartPlan)).resolves.toBe('notStarted');
      expect(h.elapsed()).toBe(STEP_START_MS);
      expect(h.values.has(UPDATE_RESTART_KEY)).toBe(false);
      expect(h.update.restartWatch).toBeUndefined();
    }
  });

  it('ends with unknown when the state cannot be read after the restart, and keeps the record', async () => {
    const h = harness({ commands: [RESTART_TO_UPDATE_COMMAND] });
    await expect(h.update.updateAndRestart(restartPlan)).resolves.toBe('unknown');
    expect(h.elapsed()).toBe(STEP_START_MS);
    expect(h.values.has(UPDATE_RESTART_KEY)).toBe(true);
  });

  it('ends with failed when "Restart to Update" fails or is missing, and forgets the restart', async () => {
    const failing = harness({ fails: { [RESTART_TO_UPDATE_COMMAND]: new Error('boom') } });
    await expect(failing.update.updateAndRestart(restartPlan)).resolves.toBe('failed');
    expect(failing.values.has(UPDATE_RESTART_KEY)).toBe(false);
    expect(failing.logger.warn).toHaveBeenCalledWith('VS Code could not restart for the update 1.146.0, so the devspace starts with VS Code 1.145.0: boom');

    // A command that is not registered would wait for the extensions of the window, so it never runs unlisted.
    const missing = harness({ commands: [UPDATE_STATE_COMMAND] });
    await expect(missing.update.updateAndRestart(restartPlan)).resolves.toBe('failed');
    expect(missing.execute).not.toHaveBeenCalled();
    expect(missing.elapsed()).toBe(COMMAND_WAIT_MS);
    expect(missing.values.has(UPDATE_RESTART_KEY)).toBe(false);
  });

  it('runs beforeRestart after the installation and right before "Restart to Update", and restarts nothing when it refuses', async () => {
    const h = harness({ states: [DOWNLOADED_STATE, { type: 'updating', update: UPDATE }, READY_STATE, RESTARTING_STATE] });
    const commands = (): unknown[] => h.execute.mock.calls.map(([command]) => command).filter((command) => command !== UPDATE_STATE_COMMAND);
    let before: unknown[] | undefined;
    const beforeRestart = vi.fn(async () => {
      before = commands();
      return true;
    });
    await expect(h.update.updateAndRestart(installPlan, { beforeRestart })).resolves.toBe('restarting');
    expect(beforeRestart).toHaveBeenCalledTimes(1);
    expect(before).toEqual([INSTALL_UPDATE_COMMAND]);
    expect(commands()).toEqual([INSTALL_UPDATE_COMMAND, RESTART_TO_UPDATE_COMMAND]);

    const refused = harness({ states: [READY_STATE] });
    await expect(refused.update.updateAndRestart(restartPlan, { beforeRestart: async () => false })).resolves.toBe('failed');
    expect(calls(refused.execute, RESTART_TO_UPDATE_COMMAND)).toBe(0);
    expect(refused.values.has(UPDATE_RESTART_KEY)).toBe(false);
  });

  it('restarts also when the record cannot be written', async () => {
    const h = harness({ states: [RESTARTING_STATE] });
    h.state.update.mockRejectedValueOnce(new Error('storage closed'));
    await expect(h.update.updateAndRestart(restartPlan)).resolves.toBe('restarting');
    expect(h.logger.warn).toHaveBeenCalledWith('The restart for the update 1.146.0 could not be recorded: storage closed');
  });
});
