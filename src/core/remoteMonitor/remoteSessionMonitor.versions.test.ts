// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The ensure and the Monitor of another version of Devspaces (docs/requirements.md R-DS-011): the newest version runs.
// A window never replaces a newer Monitor with its own; a running Monitor of an earlier version moves itself to the
// script that the window stored (src/remoteMonitor/selfUpgrade.ts), so the window keeps it; a Monitor without the
// version label (an earlier extension) is replaced as before. The engine is a fake.
import { describe, expect, it, vi } from 'vitest';
import { VERSION_ENV } from '../http';
import { LOADER_EXIT_CODE } from '../loader/pipeLoader';
import type { Logger } from '../ports';
import type { MonitorCreated, MonitorRunSpec } from '../worker/dockerEngine';
import type { MonitorEngine, MonitorInspected } from './monitorEngine';
import { LABEL_MONITOR_VERSION } from './protocol';
import { RemoteSessionMonitor, monitorLabel } from './remoteSessionMonitor';

const SCRIPT = 'console.log("monitor")';
const TAG = 'devspaces-worker:0123456789ab';
const ID = 'a'.repeat(64);
const unused = (): never => {
  throw new Error('not expected');
};

/** An ensure of Devspaces `version` (null: a program without a version) over a fake engine with `methods`. */
function setup(methods: Partial<MonitorEngine>, version: string | null = '0.6.0') {
  const lines: string[] = [];
  const logger: Logger = { info: (text) => lines.push(text), warn: (text) => lines.push(text), error: (text) => lines.push(text), output: () => {} };
  const create = vi.fn(async (_spec: MonitorRunSpec): Promise<MonitorCreated> => ({ kind: 'ready' }));
  const remove = vi.fn(async () => undefined);
  const engine: MonitorEngine = { inspect: unused, daemonTime: unused, remove, start: unused, storedScript: unused, idsWithLabel: async () => [], create, ...methods };
  return { monitor: new RemoteSessionMonitor({ engine, logger, script: async () => SCRIPT, ...(version !== null ? { version } : {}) }), lines, create, remove };
}

/** A Monitor container of another script (another label), of Devspaces `version` (none: an earlier extension). */
function other(version: string | undefined, status = 'running', exitCode = 0): MonitorInspected {
  return { exists: true, status, exitCode, label: 'another-label', restartCount: 0, id: ID, createdAt: 1, restartPolicy: 'on-failure', ...(version !== undefined ? { version } : {}) };
}

describe('the ensure and a Monitor of another version of Devspaces', () => {
  it('creates the Monitor with the version of its script as a label and a variable', async () => {
    const { monitor, create } = setup({ inspect: async () => ({ exists: false }) }, '0.6.0');
    expect(await monitor.ensureOrThrow(TAG, '/sock')).toBe('created');
    expect(create.mock.calls[0][0].labels[LABEL_MONITOR_VERSION]).toBe('0.6.0');
    expect(create.mock.calls[0][0].env[VERSION_ENV]).toBe('0.6.0');
    // Without a version (no label, no variable).
    const plain = setup({ inspect: async () => ({ exists: false }) }, null);
    expect(plain.monitor.runSpec(TAG, '/sock', monitorLabel(SCRIPT, TAG, 'idle'), SCRIPT).labels[LABEL_MONITOR_VERSION]).toBeUndefined();
  });

  it('keeps a running or paused Monitor of a newer version, and never replaces it', async () => {
    for (const status of ['running', 'paused']) {
      const { monitor, create, remove, lines } = setup({ inspect: async () => other('0.10.0', status) });
      expect(await monitor.ensureOrThrow(TAG, '/sock')).toBe('running');
      expect(remove).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(lines).toEqual(['The Monitor on the Docker host runs Devspaces 0.10.0, a newer version than 0.6.0; this window keeps it and works with it (devspaces-monitor).']);
    }
  });

  it('starts a stopped Monitor of a newer version again, and replaces it only when it exits at once or does not work', async () => {
    const start = vi.fn(async () => undefined);
    let looks = 0;
    const started = setup({ inspect: async () => (looks++ === 0 ? other('0.7.0', 'exited', 0) : other('0.7.0', 'running')), start });
    expect(await started.monitor.ensureOrThrow(TAG, '/sock')).toBe('started');
    expect(start).toHaveBeenCalledWith(ID, undefined);
    expect(started.create).not.toHaveBeenCalled();
    // It exits at once without its script after the start.
    looks = 0;
    const failing = setup({ inspect: async () => (looks++ === 0 ? other('0.7.0', 'exited', 0) : other('0.7.0', 'exited', LOADER_EXIT_CODE)), start });
    expect(await failing.monitor.ensureOrThrow(TAG, '/sock')).toBe('created');
    expect(failing.remove).toHaveBeenCalledWith(ID, undefined);
    // The loader refused its script, or it is dead: replaced at once.
    for (const found of [other('0.7.0', 'exited', LOADER_EXIT_CODE), other('0.7.0', 'dead')]) {
      let first = true;
      const broken = setup({ inspect: async () => (first ? ((first = false), found) : { exists: false }) });
      expect(await broken.monitor.ensureOrThrow(TAG, '/sock')).toBe('created');
      expect(broken.remove).toHaveBeenCalledWith(ID, undefined);
    }
  });

  it('keeps a running Monitor of an earlier version (it moves itself), and replaces one that does not run', async () => {
    const running = setup({ inspect: async () => other('0.5.3') });
    expect(await running.monitor.ensureOrThrow(TAG, '/sock')).toBe('running');
    expect(running.create).not.toHaveBeenCalled();
    expect(running.lines[0]).toContain('runs Devspaces 0.5.3, an earlier version than 0.6.0; it moves itself to this version when nothing runs in it');
    let first = true;
    const stopped = setup({ inspect: async () => (first ? ((first = false), other('0.5.3', 'exited', 0)) : { exists: false }) });
    expect(await stopped.monitor.ensureOrThrow(TAG, '/sock')).toBe('created');
    expect(stopped.remove).toHaveBeenCalledWith(ID, undefined);
  });

  it('replaces a Monitor of another label without a version (an earlier extension), of the same version, or when the ensure has none', async () => {
    for (const [found, version] of [
      [other(undefined), '0.6.0'],
      [other('0.6.0'), '0.6.0'],
      [other('0.7.0'), null],
    ] as const) {
      let first = true;
      const { monitor, remove, lines } = setup({ inspect: async () => (first ? ((first = false), found) : { exists: false }) }, version);
      expect(await monitor.ensureOrThrow(TAG, '/sock')).toBe('created');
      expect(remove).toHaveBeenCalledWith(ID, undefined);
      expect(lines[0]).toBe('The Monitor on the Docker host is of another version; it is replaced (devspaces-monitor).');
    }
  });

  it('after a name conflict, takes a running Monitor of another version that a window created meanwhile', async () => {
    let looks = 0;
    const { monitor } = setup({
      inspect: async () => (looks++ === 0 ? { exists: false } : other('0.8.0')),
      create: async () => ({ kind: 'exited', detail: 'Conflict. The container name "/devspaces-monitor" is already in use', conflict: true }),
    });
    expect(await monitor.ensureOrThrow(TAG, '/sock')).toBe('running');
  });
});
