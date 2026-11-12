// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The calls of this window to the Monitor of an engine, as operations of the worker of that engine
// (workerMonitor), and the flow with its own target (extensionFlow).
import { describe, expect, it, vi } from 'vitest';
import type { DockerTarget } from '../core/docker/dockerHost';
import type { OperationOptions } from '../core/helperChannel/helperChannel';
import { OP_HEARTBEAT, OP_MONITOR_ENSURE, OP_RECORD_GIT_STATE, OP_WINDOW_STATE } from '../core/helperChannel/protocol';
import { silentLogger } from '../core/ports';
import type { Devspace } from '../core/types';
import { extensionFlow, extensionHostSide, type HostSideDeps } from './hostSide';
import { MONITOR_ENSURE_FLOW_TIMEOUT_MS, MONITOR_FLOW_TIMEOUT_MS } from '../core/pipeline/operationBase';
import { workerMonitor, type TargetFlow } from './workerMonitor';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const TARGET = { kind: 'remote', host: 'ssh://box', endpoint: 'ssh://box', context: 'box' } as DockerTarget;
const DEVSPACE = { id: ID, repository: 'acme/api', containerName: 'devspaces-acme-api-brave-noether' } as Devspace;
const HEARTBEAT = { source: '0123456789abcdef0123456789abcdef', limitSeconds: 600, devspaces: [] };

function monitorWith(answer: (op: string) => unknown) {
  const calls: Parameters<TargetFlow>[] = [];
  const lines: string[] = [];
  const flow: TargetFlow = async (...args) => {
    calls.push(args);
    const value = answer(args[0]);
    if (value instanceof Error) throw value;
    return value;
  };
  const logger = { ...silentLogger, warn: (text: string) => lines.push(`warn ${text}`), info: (text: string) => lines.push(`info ${text}`) };
  return { monitor: workerMonitor({ flow, owner: () => ({ windowId: 'window-1', pid: 7 }), logger }), calls, lines };
}

describe('the calls of a window to the Monitor, as operations of the worker', () => {
  it('a heartbeat goes to the worker of its engine, with the signal; its answer is checked', async () => {
    const signal = new AbortController().signal;
    const { monitor, calls } = monitorWith(() => ({ ok: false, missing: true, detail: 'gone' }));
    expect(await monitor.heartbeat(TARGET, HEARTBEAT, signal)).toEqual({ ok: false, missing: true, detail: 'gone' });
    expect(calls).toEqual([[OP_HEARTBEAT, { heartbeat: HEARTBEAT }, { target: TARGET, timeoutMs: MONITOR_FLOW_TIMEOUT_MS, signal }]]);
    // An answer that does not fit, and a worker that cannot be reached, are failures (never `missing`, so no repair).
    expect(await monitorWith(() => ({ ok: 'yes' })).monitor.heartbeat(TARGET, HEARTBEAT)).toEqual({ ok: false, missing: false, detail: 'the worker answered the heartbeat with an invalid value' });
    expect(await monitorWith(() => new Error('the worker could not be reached')).monitor.heartbeat(TARGET, HEARTBEAT)).toEqual({ ok: false, missing: false, detail: 'the worker could not be reached' });
  });

  it('a heartbeat that carries the last check of the helper image by the Monitor hands it on, and answers ok', async () => {
    const helperCheck = { tag: 'devspaces-worker:0123456789ab', baseImage: 'node:24-trixie-slim', baseDigest: `sha256:${'a'.repeat(64)}`, checkedAt: '2026-11-04T06:08:00.000Z' };
    const checks: unknown[][] = [];
    const flow: TargetFlow = async () => ({ ok: true, helperCheck });
    const monitor = workerMonitor({ flow, owner: () => ({ windowId: 'window-1', pid: 7 }), logger: silentLogger, onHelperCheck: (...args) => checks.push(args) });
    expect(await monitor.heartbeat(TARGET, HEARTBEAT)).toEqual({ ok: true });
    expect(checks).toEqual([[TARGET, helperCheck]]);
    // Without it, and without the hand-on, nothing else changes.
    expect(await monitorWith(() => ({ ok: true, helperCheck })).monitor.heartbeat(TARGET, HEARTBEAT)).toEqual({ ok: true });
    expect(await workerMonitor({ flow: async () => ({ ok: true }), owner: () => ({ windowId: 'w', pid: 7 }), logger: silentLogger, onHelperCheck: (...args) => checks.push(args) }).heartbeat(TARGET, HEARTBEAT)).toEqual({ ok: true });
    expect(checks).toHaveLength(1);
  });

  it('a heartbeat that carries the processes that the kernel ended because the memory ran out hands them on, and answers ok', async () => {
    const oomKills = { boot: '0b5c2d7e-1f3a-4c6b-9d8e-7a6b5c4d3e2f', count: 1 };
    const kills: unknown[][] = [];
    const monitor = workerMonitor({ flow: async () => ({ ok: true, oomKills }), owner: () => ({ windowId: 'w', pid: 7 }), logger: silentLogger, onOomKills: (...args) => kills.push(args) });
    expect(await monitor.heartbeat(TARGET, HEARTBEAT)).toEqual({ ok: true });
    expect(kills).toEqual([[TARGET, oomKills]]);
  });

  it('a heartbeat that says the worker runs from an earlier build hands its engine on, and answers ok', async () => {
    const earlier: unknown[][] = [];
    const monitor = workerMonitor({ flow: async () => ({ ok: true, earlierBuild: true }), owner: () => ({ windowId: 'w', pid: 7 }), logger: silentLogger, onEarlierBuild: (...args) => earlier.push(args) });
    expect(await monitor.heartbeat(TARGET, HEARTBEAT)).toEqual({ ok: true });
    expect(earlier).toEqual([[TARGET]]);
    // Without it: no hand-on.
    const current = workerMonitor({ flow: async () => ({ ok: true }), owner: () => ({ windowId: 'w', pid: 7 }), logger: silentLogger, onEarlierBuild: (...args) => earlier.push(args) });
    expect(await current.heartbeat(TARGET, HEARTBEAT)).toEqual({ ok: true });
    expect(earlier).toHaveLength(1);
  });

  it('the container of a devspace exists unless the worker reads it as missing; a failure counts as not there', async () => {
    for (const [state, exists] of [['running', true], ['stopped', true], ['missing', false]] as const) {
      const { monitor, calls } = monitorWith(() => ({ state }));
      expect(await monitor.containerExists(TARGET, DEVSPACE), state).toBe(exists);
      expect(calls[0].slice(0, 2)).toEqual([OP_WINDOW_STATE, { devspaceId: ID, containerName: DEVSPACE.containerName, checks: 'off' }]);
      expect(calls[0][2].target).toBe(TARGET);
    }
    const failing = monitorWith(() => new Error('no worker'));
    expect(await failing.monitor.containerExists(TARGET, DEVSPACE)).toBe(false);
    expect(failing.lines).toEqual(['info The container of acme/api could not be checked on ssh://box: no worker']);
    expect(await monitorWith(() => ({ state: 'gone' })).monitor.containerExists(TARGET, DEVSPACE)).toBe(false);
  });

  it('the Git state of a release: the devspace, the host of its engine and this window; an answer that does not fit throws', async () => {
    const { monitor, calls } = monitorWith(() => ({ recorded: true }));
    expect(await monitor.recordGitState(TARGET, DEVSPACE)).toBe(true);
    expect(calls[0].slice(0, 2)).toEqual([OP_RECORD_GIT_STATE, { devspaceId: ID, dockerHost: 'ssh://box', owner: { windowId: 'window-1', pid: 7 } }]);
    await expect(monitorWith(() => ({ recorded: 'yes' })).monitor.recordGitState(TARGET, DEVSPACE)).rejects.toThrow('invalid value');
    // A window whose ID is not known yet sends nothing.
    const early = workerMonitor({ flow: vi.fn(), owner: () => ({ windowId: '', pid: 7 }), logger: silentLogger });
    await expect(early.recordGitState(TARGET, DEVSPACE)).rejects.toThrow('cannot be sent');
  });

  it('extensionFlow: a flow with its own target goes to that engine, with the requests of its operation for its devspace', async () => {
    const recorded: unknown[][] = [];
    const registry = { updateDevspace: async (id: string) => void recorded.push([id]) };
    const deps = { registry, sessionFiles: {}, ui: {}, auth: {}, credentials: {}, settings: () => ({}), windowId: 'w1', pid: 1, clock: { now: () => 0 }, isProcessAlive: () => true, logger: silentLogger } as unknown as HostSideDeps;
    const sent: { target: unknown; options: OperationOptions }[] = [];
    const channels = { flow: vi.fn(async (target: unknown, _op: string, _p: unknown, options: OperationOptions = {}) => (sent.push({ target, options }), { recorded: true })) };
    const current = vi.fn(async () => ({ kind: 'local' }) as DockerTarget);
    const flow = extensionFlow(channels as never, current, (account) => extensionHostSide(deps, account), silentLogger);
    await flow(OP_RECORD_GIT_STATE, { devspaceId: ID, dockerHost: 'ssh://box', owner: { windowId: 'w1', pid: 1 } }, { target: TARGET });
    expect(sent[0].target).toBe(TARGET);
    expect(current).not.toHaveBeenCalled();
    const onAsk = sent[0].options.onAsk!;
    const signal = new AbortController().signal;
    const summary = { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: '2026-10-04T12:00:00.000Z' };
    await onAsk('record', { call: 'recordGitSummary', args: [ID, summary] }, signal);
    expect(recorded).toEqual([[ID]]);
    // Another devspace, and a request that the operation may not send, are refused.
    await expect(onAsk('record', { call: 'recordGitSummary', args: ['6b1f0c2e-1d4a-4f5e-9a8b-7c6d5e4f3a2b', summary] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    await expect(onAsk('record', { call: 'remove', args: [ID, {}] }, signal)).rejects.toMatchObject({ code: 'invalid' });
    // Without a target: the current engine.
    await flow(OP_HEARTBEAT, { heartbeat: HEARTBEAT }, {});
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('the ensure of the monitor goes to the worker of its engine with the image maintenance; a failure rejects', async () => {
    const images = { schedule: '7 6 * * *', timeZone: 'UTC' };
    const signal = new AbortController().signal;
    const { monitor, calls } = monitorWith(() => ({ outcome: 'created' }));
    await expect(monitor.monitorEnsure(TARGET, images, signal)).resolves.toBeUndefined();
    expect(calls).toEqual([[OP_MONITOR_ENSURE, { images }, { target: TARGET, timeoutMs: MONITOR_ENSURE_FLOW_TIMEOUT_MS, signal }]]);
    expect(MONITOR_ENSURE_FLOW_TIMEOUT_MS).toBeGreaterThan(60_000 + 25_500);
    await expect(monitorWith(() => new Error('docker run failed: No such image')).monitor.monitorEnsure(TARGET, images)).rejects.toThrow('docker run failed: No such image');
    await expect(monitorWith(() => ({ outcome: 'failed' })).monitor.monitorEnsure(TARGET, images)).rejects.toThrow('invalid value');
    const invalid = monitorWith(() => ({ outcome: 'created' }));
    await expect(invalid.monitor.monitorEnsure(TARGET, { ...images, schedule: 'daily' })).rejects.toThrow('cannot be sent');
    expect(invalid.calls).toEqual([]);
  });
});
