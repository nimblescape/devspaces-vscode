// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The ensure and the earlier builds of the helper image (docs/requirements.md R-DS-009): a stopped Monitor from an
// earlier build is replaced from the current build (a running one moves itself, src/remoteMonitor/selfUpgrade.ts), and
// the create of the successor of a Monitor that moves never replaces a container of the name. The engine is a fake.
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../ports';
import type { MonitorCreated, MonitorRunSpec } from '../worker/dockerEngine';
import type { MonitorEngine, MonitorInspected } from './monitorEngine';
import { LABEL_MONITOR_CREATE } from './protocol';
import { RemoteSessionMonitor, monitorLabel } from './remoteSessionMonitor';

const SCRIPT = 'console.log("monitor")';
const TAG = 'devspaces-worker:0123456789ab';
const ID = 'a'.repeat(64);
const EARLIER = `sha256:${'1'.repeat(64)}`;
const CURRENT = `sha256:${'2'.repeat(64)}`;
const unused = (): never => {
  throw new Error('not expected');
};

function setup(methods: Partial<MonitorEngine>) {
  const lines: string[] = [];
  const logger: Logger = { info: (text) => lines.push(text), warn: (text) => lines.push(text), error: (text) => lines.push(text), output: () => {} };
  const engine: MonitorEngine = { inspect: unused, daemonTime: unused, remove: unused, start: unused, storedScript: unused, idsWithLabel: unused, create: unused, ...methods };
  return { monitor: new RemoteSessionMonitor({ engine, logger, script: async () => SCRIPT }), lines };
}

/** The Monitor container of the label of this ensure, exited with 0 (it ended when idle), from `image`. */
function exited(image: string | undefined): MonitorInspected {
  return { exists: true, status: 'exited', exitCode: 0, label: monitorLabel(SCRIPT, TAG, 'idle'), restartCount: 0, id: ID, createdAt: 1, restartPolicy: 'on-failure', ...(image !== undefined ? { image } : {}) };
}

describe('the ensure and the earlier builds of the helper image', () => {
  it('replaces a stopped Monitor from an earlier build with one from the current build at once', async () => {
    const remove = vi.fn(async () => undefined);
    const create = vi.fn(async (_spec: MonitorRunSpec): Promise<MonitorCreated> => ({ kind: 'ready' }));
    const { monitor, lines } = setup({ inspect: async () => exited(EARLIER), remove, create });
    expect(await monitor.ensureOrThrow(TAG, '/sock', undefined, 'devspaces-monitor:0123456789ab', CURRENT)).toBe('created');
    expect(remove).toHaveBeenCalledWith(ID, undefined);
    expect(create.mock.calls[0][0]).toMatchObject({ image: 'devspaces-monitor:0123456789ab', imageId: CURRENT });
    expect(lines[0]).toBe('The Monitor on the Docker host does not run and was created from an earlier build of the helper image; it is replaced (devspaces-monitor).');
  });

  it('starts a stopped Monitor of the current build, of an image that cannot be read, or when ensure has no image ID', async () => {
    for (const [image, imageId] of [
      [CURRENT, CURRENT],
      [undefined, CURRENT],
      [EARLIER, undefined],
    ] as const) {
      const start = vi.fn(async () => undefined);
      const { monitor } = setup({ inspect: async () => exited(image), start, storedScript: async () => 'unknown' });
      expect(await monitor.ensureOrThrow(TAG, '/sock', undefined, undefined, imageId)).toBe('started');
      expect(start).toHaveBeenCalledWith(ID, undefined);
    }
  });

  it('keeps a running Monitor from an earlier build: it moves itself when nothing runs', async () => {
    const { monitor } = setup({ inspect: async () => ({ ...exited(EARLIER), status: 'running' }) });
    expect(await monitor.ensureOrThrow(TAG, '/sock', undefined, undefined, CURRENT)).toBe('running');
  });
});

describe('the create of the successor of a Monitor that moves to the current build', () => {
  it('creates the container of the name with the label of this script and tag, from the current build', async () => {
    const create = vi.fn(async (_spec: MonitorRunSpec): Promise<MonitorCreated> => ({ kind: 'ready' }));
    const { monitor, lines } = setup({ inspect: async () => ({ exists: false }), create });
    expect(await monitor.createSuccessor(TAG, '/sock', 'devspaces-monitor:0123456789ab', CURRENT)).toBe('created');
    expect(create.mock.calls[0][0]).toMatchObject({ name: 'devspaces-monitor', image: 'devspaces-monitor:0123456789ab', imageId: CURRENT, labels: { 'nimblescape.devspaces.monitor': monitorLabel(SCRIPT, TAG, 'idle') } });
    expect(lines).toEqual([]);
  });

  it('never replaces a container of the name: before the create, and after a name conflict', async () => {
    const { monitor } = setup({ inspect: async () => ({ ...exited(CURRENT), status: 'created' }) });
    expect(await monitor.createSuccessor(TAG, '/sock', CURRENT, CURRENT)).toBe('taken');
    // A window created it between the look and the create.
    let looks = 0;
    const conflict = setup({
      inspect: async () => (looks++ === 0 ? { exists: false } : exited(CURRENT)),
      create: async () => ({ kind: 'exited', detail: 'Conflict. The container name "/devspaces-monitor" is already in use', conflict: true }),
      idsWithLabel: async () => [],
    });
    expect(await conflict.monitor.createSuccessor(TAG, '/sock', CURRENT, CURRENT)).toBe('taken');
  });

  it('a name conflict whose container is gone again is created once more; a second conflict fails', async () => {
    const create = vi.fn(async (): Promise<MonitorCreated> => ({ kind: 'exited', detail: 'Conflict.', conflict: true }));
    create.mockResolvedValueOnce({ kind: 'exited', detail: 'Conflict.', conflict: true }).mockResolvedValueOnce({ kind: 'ready' });
    const { monitor } = setup({ inspect: async () => ({ exists: false }), create, idsWithLabel: async () => [] });
    expect(await monitor.createSuccessor(TAG, '/sock', CURRENT, CURRENT)).toBe('created');
    const failing = setup({ inspect: async () => ({ exists: false }), create: async () => ({ kind: 'exited', detail: 'Conflict.', conflict: true }), idsWithLabel: async () => [] });
    await expect(failing.monitor.createSuccessor(TAG, '/sock', CURRENT, CURRENT)).rejects.toThrow('docker run failed: Conflict.');
  });

  it('a failed create removes its own container by its nonce, and rejects with the cause', async () => {
    const removed: string[] = [];
    const listed: string[] = [];
    for (const [result, message] of [
      [{ kind: 'timeout' }, 'did not report its start within 60 seconds'],
      [{ kind: 'exited', detail: 'exec format error', conflict: false }, 'docker run failed: exec format error'],
      // A conflict while a container has the nonce of this create: it made one, so no conflict.
      [{ kind: 'exited', detail: 'Conflict.', conflict: true }, 'docker run failed: Conflict.'],
    ] as const) {
      const { monitor } = setup({
        inspect: async () => ({ exists: false }),
        create: async () => result,
        idsWithLabel: async (label) => {
          listed.push(label);
          return ['c'.repeat(64)];
        },
        remove: async (id) => void removed.push(id),
      });
      await expect(monitor.createSuccessor(TAG, '/sock', CURRENT, CURRENT)).rejects.toThrow(message);
    }
    expect(removed).toEqual(['c'.repeat(64), 'c'.repeat(64), 'c'.repeat(64)]);
    expect(listed.every((label) => label.startsWith(`${LABEL_MONITOR_CREATE}=`))).toBe(true);
  });
});
