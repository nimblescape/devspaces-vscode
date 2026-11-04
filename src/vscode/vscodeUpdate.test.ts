// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RESTART_START_MS,
  RESTART_TO_UPDATE_COMMAND,
  RESTART_WATCH_MS,
  STATE_COMMAND_WAIT_MS,
  STATE_READ_TIMEOUT_MS,
  UPDATE_RESTART_KEY,
  UPDATE_STATE_COMMAND,
  VscodeUpdate,
  decideUpdateFirst,
  readyUpdateOf,
  updateRestartRecordOf,
  type UpdateRestartRecord,
} from './vscodeUpdate';

const COMMIT = 'a717861c07586a53d83b80d742cd3f59b20a6273';
const READY_STATE = { type: 'ready', update: { version: COMMIT, productVersion: '1.146.0' }, explicit: false, overwrite: false };
const RUNNING = '1.145.0';
const START = Date.parse('2026-11-04T22:00:00.000Z');

describe('readyUpdateOf', () => {
  it('takes the commit and the version number of an update in the state ready', () => {
    expect(readyUpdateOf(READY_STATE)).toEqual({ version: COMMIT, productVersion: '1.146.0' });
    // A Snap package names no commit and no version number.
    expect(readyUpdateOf({ type: 'ready', update: { version: 'something' } })).toEqual({ version: 'something' });
  });

  it('gives nothing for the other states and for values of another form', () => {
    for (const state of [
      { type: 'idle', updateType: 1 },
      { type: 'downloading', update: { version: COMMIT } },
      { type: 'restarting', update: { version: COMMIT } },
      { type: 'ready' },
      { type: 'ready', update: { version: '' } },
      { type: 'ready', update: { version: 7 } },
      'ready',
      undefined,
      null,
      [READY_STATE],
    ]) {
      expect(readyUpdateOf(state)).toBeUndefined();
    }
  });
});

describe('updateRestartRecordOf', () => {
  it('reads a record with three strings and nothing else', () => {
    const record: UpdateRestartRecord = { version: COMMIT, from: RUNNING, at: '2026-11-04T22:00:00.000Z' };
    expect(updateRestartRecordOf(record)).toEqual(record);
    expect(updateRestartRecordOf({ version: COMMIT, from: RUNNING })).toBeUndefined();
    expect(updateRestartRecordOf('x')).toBeUndefined();
    expect(updateRestartRecordOf(undefined)).toBeUndefined();
  });
});

describe('decideUpdateFirst', () => {
  const input = { enabled: true, state: READY_STATE as unknown, runningVersion: RUNNING, record: undefined as UpdateRestartRecord | undefined };

  it('installs an update in the state ready', () => {
    expect(decideUpdateFirst(input)).toEqual({ install: true, update: { version: COMMIT, productVersion: '1.146.0' } });
  });

  it('installs nothing and says nothing when the setting is off', () => {
    expect(decideUpdateFirst({ ...input, enabled: false })).toEqual({ install: false });
  });

  it('says nothing without an update, and names the state of an update that is not ready yet', () => {
    for (const type of ['uninitialized', 'idle', 'disabled', 'checking for updates']) {
      expect(decideUpdateFirst({ ...input, state: { type } })).toEqual({ install: false });
    }
    expect(decideUpdateFirst({ ...input, state: { type: 'downloading' } })).toEqual({ install: false, reason: 'the update of VS Code is in the state "downloading", not "ready"' });
    expect(decideUpdateFirst({ ...input, state: { type: 'available for download', update: { version: COMMIT } } })).toEqual({
      install: false,
      reason: 'the update of VS Code is in the state "available for download", not "ready"',
    });
  });

  it('says so when the state cannot be read or has another form', () => {
    expect(decideUpdateFirst({ ...input, state: undefined })).toEqual({ install: false, reason: 'the state of the update of VS Code could not be read' });
    expect(decideUpdateFirst({ ...input, state: 'ready' })).toEqual({ install: false, reason: 'the state of the update of VS Code has an unknown form' });
  });

  it('does not restart again for an update that the last restart from the same version did not install', () => {
    const record = { version: COMMIT, from: RUNNING, at: '2026-11-04T21:00:00.000Z' };
    expect(decideUpdateFirst({ ...input, record })).toEqual({
      install: false,
      reason: 'VS Code restarted for the update 1.146.0 at 2026-11-04T21:00:00.000Z and still runs 1.145.0, so it does not restart for that update again',
    });
    // Another update, or a restart that changed the version of VS Code (a Snap package names no commit): it restarts.
    expect(decideUpdateFirst({ ...input, record: { ...record, version: 'b224f6bf5a4fcad5fa4c640ed10f179c3b613e48' } }).install).toBe(true);
    expect(decideUpdateFirst({ ...input, record: { ...record, from: '1.144.2' } }).install).toBe(true);
  });
});

/**
 * A VscodeUpdate over fakes: `states` are the answers of `_update.state` in turn (the last one repeats), `listedFrom`
 * the look at the commands from which `_update.state` is registered, `restartListed: false` a VS Code without
 * "Restart to Update". `delay` moves the fake clock.
 */
function harness(
  options: { states?: unknown[]; listedFrom?: number; restartListed?: boolean; stored?: unknown; restartFails?: Error; stateFails?: Error } = {},
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
  const restart = options.restartListed === false ? [] : [RESTART_TO_UPDATE_COMMAND];
  const commands = vi.fn(async () => (looks++ >= (options.listedFrom ?? 0) ? ['workbench.action.reloadWindow', UPDATE_STATE_COMMAND, ...restart] : restart));
  const execute = vi.fn(async (command: string): Promise<unknown> => {
    if (command === RESTART_TO_UPDATE_COMMAND) {
      if (options.restartFails) throw options.restartFails;
      return undefined;
    }
    if (command !== UPDATE_STATE_COMMAND) throw new Error(`command '${command}' not found`);
    if (options.stateFails) throw options.stateFails;
    return states.length > 1 ? states.shift() : states[0];
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
  const delay = vi.fn(async (ms: number) => {
    time += ms;
  });
  const update = new VscodeUpdate({ commands, execute, state, runningVersion: RUNNING, logger, clock: { now: () => time }, delay });
  return { update, commands, execute, state, values, logger, delay, elapsed: () => time - START };
}

const restartCalls = (execute: ReturnType<typeof harness>['execute']) => execute.mock.calls.filter(([command]) => command === RESTART_TO_UPDATE_COMMAND).length;

describe('VscodeUpdate.readyToInstall', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the update in the state ready and logs it', async () => {
    const h = harness();
    await expect(h.update.readyToInstall(true)).resolves.toEqual({ version: COMMIT, productVersion: '1.146.0' });
    expect(h.logger.info).toHaveBeenCalledWith(
      'VS Code 1.145.0 has downloaded the update 1.146.0 and waits for its restart: the window of the devspace installs it before it connects (setting installVsCodeUpdateFirst).',
    );
    expect(h.delay).not.toHaveBeenCalled();
  });

  it('asks nothing when the setting is off', async () => {
    const h = harness();
    await expect(h.update.readyToInstall(false)).resolves.toBeUndefined();
    expect(h.commands).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('runs _update.state only once the command is registered, and waits for it at most STATE_COMMAND_WAIT_MS', async () => {
    const later = harness({ listedFrom: 2 });
    await expect(later.update.readyToInstall(true)).resolves.toEqual({ version: COMMIT, productVersion: '1.146.0' });
    expect(later.commands).toHaveBeenCalledTimes(3);

    const never = harness({ listedFrom: Number.POSITIVE_INFINITY });
    await expect(never.update.readyToInstall(true)).resolves.toBeUndefined();
    expect(never.execute).not.toHaveBeenCalled();
    expect(never.elapsed()).toBe(STATE_COMMAND_WAIT_MS);
    expect(never.logger.info).toHaveBeenCalledWith('The window of the devspace connects without an update of VS Code: the state of the update of VS Code could not be read.');
  });

  it('gives nothing when _update.state fails or does not answer in time', async () => {
    const failing = harness({ stateFails: new Error('boom') });
    await expect(failing.update.readyToInstall(true)).resolves.toBeUndefined();
    expect(failing.logger.info).toHaveBeenCalledWith('The window of the devspace connects without an update of VS Code: the state of the update of VS Code could not be read.');

    vi.useFakeTimers();
    const silent = harness();
    silent.execute.mockImplementation(() => new Promise<never>(() => {}));
    const result = silent.update.readyToInstall(true);
    await vi.advanceTimersByTimeAsync(STATE_READ_TIMEOUT_MS);
    await expect(result).resolves.toBeUndefined();
  });

  it('gives nothing for an update that the last restart from this version did not install, and logs why', async () => {
    const h = harness({ stored: { version: COMMIT, from: RUNNING, at: '2026-11-04T21:00:00.000Z' } });
    await expect(h.update.readyToInstall(true)).resolves.toBeUndefined();
    expect(h.logger.info).toHaveBeenCalledWith(
      'The window of the devspace connects without an update of VS Code: VS Code restarted for the update 1.146.0 at 2026-11-04T21:00:00.000Z and still runs 1.145.0, so it does not restart for that update again.',
    );
  });

  it('logs nothing without an update', async () => {
    const h = harness({ states: [{ type: 'idle', updateType: 1 }] });
    await expect(h.update.readyToInstall(true)).resolves.toBeUndefined();
    expect(h.logger.info).not.toHaveBeenCalled();
  });
});

describe('VscodeUpdate.restartToInstall', () => {
  const update = { version: COMMIT, productVersion: '1.146.0' };
  const restarting = { type: 'restarting', update };
  const RECORD = { version: COMMIT, from: RUNNING, at: '2026-11-04T22:00:00.000Z' };

  it('records the restart before "Restart to Update"', async () => {
    const h = harness({ states: [restarting] });
    h.execute.mockImplementationOnce(async (command: string) => {
      // The record is there when VS Code begins to close its windows.
      expect(command).toBe(RESTART_TO_UPDATE_COMMAND);
      expect(h.values.get(UPDATE_RESTART_KEY)).toEqual(RECORD);
      return undefined;
    });
    await expect(h.update.restartToInstall(update)).resolves.toBe('restarting');
    expect(restartCalls(h.execute)).toBe(1);
  });

  it('ends with restarting as soon as VS Code closes its windows, and keeps the record', async () => {
    // VS Code closes the window only after the end of its activation, so the outcome must not wait for the restart.
    const h = harness({ states: [READY_STATE, READY_STATE, restarting] });
    // The time of the outcome, before the watch moves the fake clock on.
    let restartingAt: number | undefined;
    h.logger.info.mockImplementation((message: string) => {
      if (message.startsWith('VS Code closes its windows')) restartingAt = h.elapsed();
    });
    await expect(h.update.restartToInstall(update)).resolves.toBe('restarting');
    expect(restartingAt).toBe(2 * 500);
    expect(h.values.get(UPDATE_RESTART_KEY)).toEqual(RECORD);
    expect(h.logger.info).toHaveBeenCalledWith('VS Code closes its windows to install the update 1.146.0. This window connects after the restart.');
  });

  it('runs kept and keeps the record when the state goes from restarting back to ready', async () => {
    // A window asked about unsaved files, and the user chose Cancel: VS Code keeps running.
    const h = harness({ states: [restarting, restarting, undefined, restarting, READY_STATE] });
    const kept = vi.fn();
    await expect(h.update.restartToInstall(update, kept)).resolves.toBe('restarting');
    await h.update.restartWatch;
    expect(kept).toHaveBeenCalledTimes(1);
    // After Cancel, Devspaces does not restart VS Code for this update again.
    expect(h.values.get(UPDATE_RESTART_KEY)).toEqual(RECORD);
    // An unreadable state (undefined) does not end the watch.
    expect(h.elapsed()).toBe(4 * 500);
    expect(h.logger.info).toHaveBeenCalledWith(
      'VS Code did not restart for the update 1.146.0 (a window kept it running, for example after Cancel on unsaved files), so this window connects with VS Code 1.145.0. Devspaces does not restart VS Code for this update again; VS Code installs it at its next restart.',
    );
  });

  it('logs an error of kept', async () => {
    const h = harness({ states: [restarting, READY_STATE] });
    await h.update.restartToInstall(update, () => {
      throw new Error('gone');
    });
    await h.update.restartWatch;
    expect(h.logger.warn).toHaveBeenCalledWith('The window could not connect after VS Code kept running: gone');
  });

  it('ends the watch after RESTART_WATCH_MS when VS Code stays in the state restarting, and keeps the record', async () => {
    const h = harness({ states: [restarting] });
    const kept = vi.fn();
    await h.update.restartToInstall(update, kept);
    await h.update.restartWatch;
    expect(h.elapsed()).toBe(RESTART_WATCH_MS);
    expect(kept).not.toHaveBeenCalled();
    expect(h.values.get(UPDATE_RESTART_KEY)).toEqual(RECORD);
    expect(h.logger.warn).toHaveBeenCalledWith('VS Code is still in the state "restarting" 10 minutes after "Restart to Update" for the update 1.146.0.');
  });

  it('ends with notStarted when VS Code does not begin to restart, and forgets the restart', async () => {
    for (const state of [READY_STATE, { type: 'overwriting', update }, { type: 'idle', updateType: 1 }]) {
      const h = harness({ states: [state] });
      await expect(h.update.restartToInstall(update)).resolves.toBe('notStarted');
      expect(h.elapsed()).toBe(RESTART_START_MS);
      expect(h.values.has(UPDATE_RESTART_KEY)).toBe(false);
      expect(h.update.restartWatch).toBeUndefined();
    }
  });

  it('ends with unknown when the state cannot be read, and keeps the record', async () => {
    const h = harness({ listedFrom: Number.POSITIVE_INFINITY });
    await expect(h.update.restartToInstall(update)).resolves.toBe('unknown');
    expect(h.elapsed()).toBe(RESTART_START_MS);
    expect(h.values.has(UPDATE_RESTART_KEY)).toBe(true);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('ends with failed when "Restart to Update" fails, and forgets the restart', async () => {
    const h = harness({ restartFails: new Error('boom') });
    await expect(h.update.restartToInstall(update)).resolves.toBe('failed');
    expect(h.values.has(UPDATE_RESTART_KEY)).toBe(false);
    expect(h.logger.warn).toHaveBeenCalledWith('VS Code could not restart for the update 1.146.0, so this window connects with VS Code 1.145.0: boom');
  });

  it('ends with failed without running "Restart to Update" when VS Code does not list it', async () => {
    // A command that is not registered would wait for the extensions of the window, so it never runs unlisted.
    const h = harness({ restartListed: false });
    await expect(h.update.restartToInstall(update)).resolves.toBe('failed');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.elapsed()).toBe(STATE_COMMAND_WAIT_MS);
    expect(h.values.has(UPDATE_RESTART_KEY)).toBe(false);
    expect(h.logger.warn).toHaveBeenCalledWith('VS Code has no command "update.restartToUpdate", so this window connects with VS Code 1.145.0.');
  });

  it('restarts also when the record cannot be written', async () => {
    const h = harness({ states: [restarting] });
    h.state.update.mockRejectedValueOnce(new Error('storage closed'));
    await expect(h.update.restartToInstall(update)).resolves.toBe('restarting');
    expect(restartCalls(h.execute)).toBe(1);
    expect(h.logger.warn).toHaveBeenCalledWith('The restart for the update 1.146.0 could not be recorded: storage closed');
  });
});
