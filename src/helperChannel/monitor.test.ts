// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The operations `heartbeat` and `recordGitState` of the worker, and the image settings that come with the open
// (giveMonitorImages), with a small engine in memory; `recordGitState` with a fake extension behind its handler (the
// requests that it may send, for its devspace only).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { OP_RECORD_GIT_STATE, type AskKind } from '../core/helperChannel/protocol';
import { LABEL_DEVSPACE_ID } from '../core/names';
import { silentLogger } from '../core/ports';
import { HELPER_CHECK_FILE, engineHelperRecordText } from '../core/remoteMonitor/helperCheck';
import { REMOTE_MONITOR_CONTAINER } from '../core/remoteMonitor/protocol';
import type { Devspace } from '../core/types';
import { scriptCommand } from '../core/worker/containerScripts';
import { EngineError, type DockerEngine, type EngineContainer, type EngineExecOptions } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { FLOW_REQUESTS, type HostSide } from '../core/worker/hostSide';
import { hostSideHandler } from '../core/worker/hostSideHandler';
import type { OwnHelper } from '../core/worker/ownHelper';
import { contextLogger, giveMonitorImages, heartbeatOperation, recordGitStateOperation } from './flowOperations';
import { contextSecrets } from './operationContext.testkit';
import type { OperationContext } from './server';

const ID = '3f2a9c1e-5b7d-4e8a-9c0f-2d1e6a7b8c9d';
const NAME = 'devspaces-acme-api-brave-noether';
const SOURCE = '0123456789abcdef0123456789abcdef';
const HEARTBEAT = { source: SOURCE, limitSeconds: 600, devspaces: [{ id: ID, keepRunning: false, seq: 1 }] };
const OWN: OwnHelper = { image: { tag: 'devspaces-worker:abc', id: `sha256:${'a'.repeat(64)}` }, socket: '/run/user/1000/docker.sock' };
const DEVSPACE = {
  id: ID,
  repository: 'acme/api',
  owner: { id: '42', login: 'octo' },
  volumeName: NAME,
  containerName: NAME,
  configPath: '.devcontainer/devcontainer.json',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: '2026-10-01T00:00:00.000Z',
  remoteUser: 'node',
} as unknown as Devspace;

function contextOf(ask: OperationContext['ask'] = async () => undefined, secrets: Record<string, string> = {}) {
  const controller = new AbortController();
  const lines: string[] = [];
  const context: OperationContext = {
    signal: controller.signal,
    ...contextSecrets(secrets, ask),
    progress: () => {},
    log: (text) => lines.push(text),
    output: () => {},
  };
  return { context, controller, lines };
}

function engineOf(exec: (container: string, command: readonly string[], options?: EngineExecOptions) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>, containers: EngineContainer[] = []) {
  const execs: { container: string; command: readonly string[]; options?: EngineExecOptions }[] = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    version: async () => ({ apiVersion: '1.48', version: '29.0.0' }),
    containers: async () => containers,
    container: async (reference) => containers.find((c) => c.name === reference || c.id === reference),
    exec: async (container, command, options) => (execs.push({ container, command, options }), exec(container, command, options)),
  };
  return { engine, execs };
}

const ok = async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false });

describe('the operations of the Monitor in the worker', () => {
  it('heartbeat: sends it to the monitor container and answers ok, or why not (missing)', async () => {
    const { engine, execs } = engineOf(ok);
    const { context, controller } = contextOf();
    expect(await heartbeatOperation(() => engine, undefined, () => undefined)({ heartbeat: HEARTBEAT }, context)).toEqual({ ok: true });
    // The command of the entry monitorHeartbeat.
    expect(execs).toEqual([{ container: REMOTE_MONITOR_CONTAINER, command: scriptCommand('monitorHeartbeat', [JSON.stringify(HEARTBEAT)]), options: { timeoutMs: 20_000, signal: controller.signal } }]);
    const missing = engineOf(() => Promise.reject(new EngineError('No such container', 404)));
    expect(await heartbeatOperation(() => missing.engine)({ heartbeat: HEARTBEAT }, contextOf().context)).toMatchObject({ ok: false, missing: true });
  });

  it('heartbeat: answers the last check of the helper image by the Monitor from its volume, when it found the image current', async () => {
    const volume = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-monitor-volume-'));
    try {
      const { engine } = engineOf(ok);
      const heartbeat = () => heartbeatOperation(() => engine, volume, () => undefined)({ heartbeat: HEARTBEAT }, contextOf().context);
      // No record yet.
      expect(await heartbeat()).toEqual({ ok: true });
      const record = { tag: 'devspaces-worker:0123456789ab', baseImage: 'node:24-trixie-slim', baseDigest: `sha256:${'a'.repeat(64)}`, checkedAt: '2026-11-04T06:08:00.000Z' };
      fs.writeFileSync(path.join(volume, HELPER_CHECK_FILE), engineHelperRecordText({ ...record, attemptedAt: '2026-11-03T06:08:00.000Z', builtAt: '2026-11-04T06:08:00.000Z' }));
      expect(await heartbeat()).toEqual({ ok: true, helperCheck: record });
      // A record of attempts only, and one that is not valid, give none.
      fs.writeFileSync(path.join(volume, HELPER_CHECK_FILE), engineHelperRecordText({ tag: record.tag, baseImage: record.baseImage, attemptedAt: record.checkedAt }));
      expect(await heartbeat()).toEqual({ ok: true });
      fs.writeFileSync(path.join(volume, HELPER_CHECK_FILE), '{"tag":"x"}');
      expect(await heartbeat()).toEqual({ ok: true });
      // A heartbeat that the monitor did not take answers no check.
      fs.writeFileSync(path.join(volume, HELPER_CHECK_FILE), engineHelperRecordText(record));
      const missing = engineOf(() => Promise.reject(new EngineError('No such container', 404)));
      expect(await heartbeatOperation(() => missing.engine, volume)({ heartbeat: HEARTBEAT }, contextOf().context)).toEqual({ ok: false, missing: true, detail: expect.any(String) });
    } finally {
      fs.rmSync(volume, { recursive: true, force: true });
    }
  });

  it('heartbeat: answers the processes that the kernel of the engine ended because the memory ran out, when it can read them', async () => {
    const { engine } = engineOf(ok);
    const oomKills = { boot: '0b5c2d7e-1f3a-4c6b-9d8e-7a6b5c4d3e2f', count: 3 };
    expect(await heartbeatOperation(() => engine, undefined, () => oomKills)({ heartbeat: HEARTBEAT }, contextOf().context)).toEqual({ ok: true, oomKills });
    // A heartbeat that the monitor did not take answers none.
    const missing = engineOf(() => Promise.reject(new EngineError('No such container', 404)));
    expect(await heartbeatOperation(() => missing.engine, undefined, () => oomKills)({ heartbeat: HEARTBEAT }, contextOf().context)).toEqual({ ok: false, missing: true, detail: expect.any(String) });
  });

  // R-DS-008: the helper tag that the worker started from is on another image now (a rebuild).
  it('heartbeat: answers that the worker runs from an earlier build of its helper tag; never fails for that look', async () => {
    const { engine } = engineOf(ok);
    const inspects: { kind: string; reference: string }[] = [];
    let current: unknown = { Id: OWN.image.id };
    const withImage: DockerEngine = {
      ...engine,
      inspect: async (kind, reference) => {
        inspects.push({ kind, reference });
        if (current instanceof Error) throw current;
        return current;
      },
    };
    const heartbeat = (ownHelperOf: () => Promise<OwnHelper> = async () => OWN) =>
      heartbeatOperation(() => withImage, undefined, () => undefined, ownHelperOf)({ heartbeat: HEARTBEAT }, contextOf().context);
    // The tag is on the image of the worker.
    expect(await heartbeat()).toEqual({ ok: true });
    expect(inspects).toEqual([{ kind: 'image', reference: OWN.image.tag }]);
    // The tag is on another image.
    current = { Id: `sha256:${'b'.repeat(64)}` };
    expect(await heartbeat()).toEqual({ ok: true, earlierBuild: true });
    // The tag is on no image, the inspect fails, or the worker cannot read its own image: no answer, the heartbeat is ok.
    for (const value of [undefined, { Id: 7 }, new EngineError('boom', 500)]) {
      current = value;
      expect(await heartbeat(), String(value)).toEqual({ ok: true });
    }
    current = { Id: `sha256:${'b'.repeat(64)}` };
    expect(await heartbeat(() => Promise.reject(new Error('no inspect')))).toEqual({ ok: true });
    // Without the reader of its own image (the tests of other parts), no look.
    inspects.length = 0;
    expect(await heartbeatOperation(() => withImage, undefined, () => undefined)({ heartbeat: HEARTBEAT }, contextOf().context)).toEqual({ ok: true });
    expect(inspects).toEqual([]);
    // A heartbeat that the monitor did not take: no look.
    const missing = engineOf(() => Promise.reject(new EngineError('No such container', 404)));
    expect(await heartbeatOperation(() => ({ ...missing.engine, inspect: withImage.inspect }), undefined, () => undefined, async () => OWN)({ heartbeat: HEARTBEAT }, contextOf().context)).toMatchObject({ ok: false });
    expect(inspects).toEqual([]);
  });

  it('heartbeat: refuses parameters that do not fit and a secret before anything runs; a cancel is cancelled', async () => {
    const { engine, execs } = engineOf(ok);
    await expect(heartbeatOperation(() => engine)({ heartbeat: { ...HEARTBEAT, source: 'x' } }, contextOf().context)).rejects.toMatchObject({ code: 'invalid' });
    await expect(heartbeatOperation(() => engine)({ heartbeat: HEARTBEAT }, contextOf(undefined, { token: 'gho_x' }).context)).rejects.toMatchObject({ code: 'invalid' });
    expect(execs).toEqual([]);
    const aborting = contextOf();
    const hanging = engineOf(() => {
      aborting.controller.abort();
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    await expect(heartbeatOperation(() => hanging.engine)({ heartbeat: HEARTBEAT }, aborting.context)).rejects.toMatchObject({ code: 'cancelled' });
  });

  // The open gives the settings after its ensure (giveMonitorImages); the settings carry no prefixes and the open no
  // image list; the references in use go after the settings.
  it('the image settings and the references in use of an open go to the monitor; a failure is logged', async () => {
    const { engine, execs } = engineOf(ok);
    const settings = { schedule: '7 6 * * *', timeZone: 'UTC' };
    const { context } = contextOf();
    await giveMonitorImages(engine, { images: settings, references: ['node:20'], monitorSource: SOURCE }, contextLogger(context), context.signal);
    expect(execs.map((exec) => exec.options?.input)).toEqual([JSON.stringify(settings), JSON.stringify({ source: SOURCE, references: ['node:20'] })]);
    // The settings always go (they hold the schedule of the whole background run), and without references nothing more;
    // the mode of the monitor never goes with them.
    const none = engineOf(ok);
    await giveMonitorImages(none.engine, { images: { ...settings, permanent: true } }, contextLogger(context), context.signal);
    expect(none.execs.map((exec) => exec.options?.input)).toEqual([JSON.stringify(settings)]);
    const failing = engineOf(async () => ({ exitCode: 2, stdout: '', stderr: 'Invalid image list.', timedOut: false }));
    const logged = contextOf();
    await giveMonitorImages(failing.engine, { images: settings, references: ['node:20'], monitorSource: SOURCE }, contextLogger(logged.context), logged.context.signal);
    // The failed settings are logged too.
    expect(logged.lines).toEqual(['The image settings could not be given to the Monitor: Invalid image list.', 'The image references in use could not be given to the Monitor: Invalid image list.']);
  });

  function recordGitState(setup: { container?: 'running' | 'stopped' | 'missing'; record?: Devspace | null; params?: Record<string, unknown> } = {}) {
    const asks: { kind: AskKind; call: string; args: unknown[] }[] = [];
    const record = setup.record === undefined ? DEVSPACE : setup.record;
    const answer = (kind: AskKind, call: string) => async (...args: unknown[]) => (asks.push({ kind, call, args }), call === 'get' ? (record ?? undefined) : undefined);
    const host = { records: { get: answer('record', 'get'), recordGitSummary: answer('record', 'recordGitSummary') }, questions: {}, state: {}, secrets: {} } as unknown as HostSide;
    const handler = hostSideHandler(host, silentLogger, FLOW_REQUESTS[OP_RECORD_GIT_STATE], { devspaceId: ID });
    const { context } = contextOf(async (kind, payload) => (await handler(kind, payload, new AbortController().signal)).value);
    const state = setup.container ?? 'running';
    const containers: EngineContainer[] =
      state === 'missing' ? [] : [{ id: 'c'.repeat(64), name: NAME, state, rawState: state === 'running' ? 'running' : 'exited', labels: { [LABEL_DEVSPACE_ID]: ID }, image: `${NAME}:1` }];
    const { engine, execs } = engineOf(async () => ({ exitCode: 0, stdout: 'main\n2\n1\n0\n', stderr: '', timedOut: false }), containers);
    const operation = recordGitStateOperation(
      () => engine,
      async () => OWN,
      async () => {
        throw new Error('The Git state of a release opens no batch helper.');
      },
    );
    const params = { devspaceId: ID, dockerHost: '', owner: { windowId: 'window-1', pid: 4242 }, ...setup.params };
    return { result: operation(params, context), asks, execs };
  }

  it('recordGitState: reads the Git state in the running dev container as its user and records it through the extension', async () => {
    const { result, asks, execs } = recordGitState();
    expect(await result).toEqual({ recorded: true });
    expect(execs).toHaveLength(1);
    expect(execs[0].options?.user).toBe('node');
    expect(asks.map((ask) => `${ask.kind} ${ask.call}`)).toEqual(['record get', 'record recordGitSummary']);
    expect(asks[1].args[0]).toBe(ID);
    expect(asks[1].args[1]).toMatchObject({ branch: 'main', uncommittedFiles: 2, unpushedCommits: 1, stashes: 0 });
  });

  it('recordGitState: nothing for a container that does not run, an entry that is gone, or another Docker host', async () => {
    for (const setup of [{ container: 'stopped' as const }, { container: 'missing' as const }, { record: null }, { params: { dockerHost: 'ssh://box' } }]) {
      const { result, asks, execs } = recordGitState(setup);
      expect(await result, JSON.stringify(setup)).toEqual({ recorded: false });
      expect(asks.map((ask) => ask.call)).not.toContain('recordGitSummary');
      expect(execs).toEqual([]);
    }
  });

  it('recordGitState: refuses parameters that do not fit before anything runs', async () => {
    for (const odd of [{ devspaceId: '../x' }, { extra: 1 }, { owner: { windowId: 'window-1', pid: -1 } }]) {
      const { result, asks } = recordGitState({ params: odd });
      await expect(result, JSON.stringify(odd)).rejects.toMatchObject({ code: 'invalid' });
      expect(asks).toEqual([]);
    }
  });
});
