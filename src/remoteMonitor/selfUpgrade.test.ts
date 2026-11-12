// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The move of the Monitor to the current build of its helper image (docs/requirements.md R-DS-009): the check between
// two ticks, the successor created as a window creates the Monitor, the failures that keep the Monitor, and the removal
// of the containers and images of earlier builds. The engine is a fake.
import { describe, expect, it } from 'vitest';
import { LABEL_HELPER, LABEL_HELPER_BASE_DIGEST, VSCODE_STORE_DIR } from '../core/names';
import { LABEL_MONITOR, LABEL_MONITOR_CREATE, LABEL_MONITOR_OWNER, REMOTE_MONITOR_READY_TEXT } from '../core/remoteMonitor/protocol';
import { MONITOR_SUCCESSOR_ENV, monitorLabel } from '../core/remoteMonitor/remoteSessionMonitor';
import { MONITOR_WORKER_HASH_ENV } from '../core/remoteMonitor/workerScript';
import { EngineError, type DockerEngine, type EngineContainerSummary, type MonitorCreated, type MonitorRunSpec } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import {
  SELF_UPGRADE_CHECK_MS,
  SELF_UPGRADE_COMMAND_LOOK_MS,
  SELF_UPGRADE_COMMAND_WAIT_MS,
  SELF_UPGRADE_RETRY_MS,
  SelfUpgrade,
  bindSource,
  ownEnv,
  ownLabels,
  upgradeCheckFromEnv,
  type SelfUpgradeDeps,
} from './selfUpgrade';

const TAG = 'devspaces-worker:0123456789ab';
const MONITOR_TAG = 'devspaces-monitor:0123456789ab';
const SCRIPT = 'console.log("monitor")';
const CREATE = '0f0f0f0f-0000-4000-8000-000000000001';
const OWN_ID = 'a'.repeat(64);
const EARLIER = `sha256:${'1'.repeat(64)}`;
const CURRENT = `sha256:${'2'.repeat(64)}`;
const STORE = 'devspaces-vscode-store';
const SOCKET = '/run/user/1000/docker.sock';
const IMAGE_ENV = ['PATH=/usr/local/bin:/usr/bin', 'NODE_VERSION=26.1.0'];
const ENV: NodeJS.ProcessEnv = {
  DEVSPACE_MONITOR_CREATE_ID: CREATE,
  DEVSPACE_IMAGE_SCHEDULE: '7 6 * * *',
  DEVSPACE_IMAGE_TZ: 'Europe/Vienna',
  DEVSPACE_MONITOR_PERMANENT: '1',
  DEVSPACE_VSCODE_STORE: STORE,
};
const LABEL = monitorLabel(SCRIPT, TAG, 'permanent', STORE);

interface FakeContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  labels: Record<string, string>;
  env: string[];
  binds: string[];
  execIds: string[];
}

/** The engine of the move, with the own container of the Monitor from the earlier build and the current build of the tag. */
function fakeEngine() {
  const calls: string[] = [];
  const created: MonitorRunSpec[] = [];
  const containers = new Map<string, FakeContainer>();
  containers.set(OWN_ID, {
    id: OWN_ID,
    name: 'devspaces-monitor',
    image: EARLIER,
    state: 'running',
    labels: { [LABEL_MONITOR]: LABEL, [LABEL_MONITOR_CREATE]: CREATE, [LABEL_MONITOR_OWNER]: 'computer-1', [LABEL_HELPER]: 'true', [LABEL_HELPER_BASE_DIGEST]: 'sha256:old', 'test.run': 'r1' },
    env: [...IMAGE_ENV, ...Object.entries(ENV).map(([key, value]) => `${key}=${value}`), `${MONITOR_WORKER_HASH_ENV}=${'c'.repeat(64)}`, 'DEVSPACE_MONITOR_TICK_MS=500'],
    binds: [`${SOCKET}:/var/run/docker.sock`, 'devspaces-monitor:/state'],
    execIds: [],
  });
  const images = new Map<string, { Id: string; RepoTags: string[]; Config: { Labels: Record<string, string>; Env: string[] } }>();
  const earlierImage = { Id: EARLIER, RepoTags: [] as string[], Config: { Labels: { [LABEL_HELPER]: 'true', [LABEL_HELPER_BASE_DIGEST]: 'sha256:old' }, Env: IMAGE_ENV } };
  const currentImage = { Id: CURRENT, RepoTags: [TAG], Config: { Labels: { [LABEL_HELPER]: 'true', [LABEL_HELPER_BASE_DIGEST]: 'sha256:new' }, Env: IMAGE_ENV } };
  images.set(EARLIER, earlierImage);
  images.set(CURRENT, currentImage);
  images.set(TAG, currentImage);
  const execs = new Map<string, boolean>();
  const state = {
    renameFails: [] as boolean[],
    policyFails: [] as boolean[],
    create: (spec: MonitorRunSpec): MonitorCreated => {
      containers.set('b'.repeat(64), { id: 'b'.repeat(64), name: spec.name, image: CURRENT, state: 'running', labels: spec.labels, env: [], binds: [], execIds: [] });
      return { kind: 'ready' };
    },
    removeImage: 'removed' as 'removed' | 'inUse',
  };
  const containerOf = (reference: string) => containers.get(reference) ?? [...containers.values()].find((container) => container.name === reference);
  const engine: DockerEngine = {
    ...unusedEngine(),
    containerIds: async (filters) => {
      const label = filters.label?.[0] ?? '';
      const [key, value] = label.split('=');
      return [...containers.values()].filter((container) => container.labels[key] === value).map((container) => container.id);
    },
    containerSummaries: async (label) =>
      [...containers.values()].filter((container) => label in container.labels).map((container): EngineContainerSummary => ({ id: container.id, name: container.name, state: container.state, labels: container.labels })),
    inspect: async (kind, reference) => {
      if (kind === 'image') return images.get(reference);
      if (kind === 'exec') return execs.has(reference) ? { ID: reference, Running: execs.get(reference) } : undefined;
      const container = containerOf(reference);
      if (container === undefined) return undefined;
      return {
        Id: container.id,
        Name: `/${container.name}`,
        Image: container.image,
        State: { Status: container.state },
        Config: { Labels: container.labels, Env: container.env },
        HostConfig: { Binds: container.binds },
        ExecIDs: container.execIds.length > 0 ? container.execIds : null,
      };
    },
    updateRestartPolicy: async (id, policy) => {
      calls.push(`policy ${id.slice(0, 4)} ${policy}`);
      if (state.policyFails.shift() === true) throw new EngineError('policy refused', 500);
    },
    renameContainer: async (id, name) => {
      calls.push(`rename ${id.slice(0, 4)} ${name}`);
      if (state.renameFails.shift() === true) throw new EngineError('Conflict. The container name is already in use', 409);
      const container = containers.get(id);
      if (container !== undefined) container.name = name;
    },
    tagImage: async (image, reference) => {
      calls.push(`tag ${image.slice(7, 11)} ${reference}`);
    },
    createAttached: async (spec, options) => {
      calls.push(`create ${spec.name} ${spec.image}`);
      expect(options.readyText).toBe(REMOTE_MONITOR_READY_TEXT);
      created.push(spec);
      return state.create(spec);
    },
    removeContainer: async (id) => {
      calls.push(`remove ${id.slice(0, 4)}`);
      containers.delete(id);
    },
    removeImage: async (reference) => {
      calls.push(`remove image ${reference.slice(7, 11)}`);
      return state.removeImage;
    },
  };
  return { engine, calls, created, containers, images, execs, state };
}

type Fake = ReturnType<typeof fakeEngine>;

/** The move over a fake engine; `overrides` may replace any of its deps (with the fake at hand). */
function setup(overrides: (fake: Fake & { sleeps: number[] }) => Partial<SelfUpgradeDeps> = () => ({})) {
  const fake = fakeEngine();
  const lines: string[] = [];
  let mono = 0;
  let busy = false;
  const sleeps: number[] = [];
  const upgrade = new SelfUpgrade({
    engine: fake.engine,
    env: ENV,
    log: (message) => lines.push(message),
    monotonic: () => mono,
    script: async () => SCRIPT,
    helperTag: async () => TAG,
    busy: () => busy,
    removals: () => undefined,
    // No worker scripts of windows (a folder that does not exist), and no version of its own.
    stateDir: '/nonexistent/devspaces-monitor-state',
    version: () => undefined,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides({ ...fake, sleeps }),
  });
  return {
    ...fake,
    upgrade,
    lines,
    sleeps,
    advance: (ms: number) => (mono += ms),
    setBusy: (value: boolean) => (busy = value),
  };
}

/** A create of the successor during which a window starts a command in the container that runs until `ends` says so. */
function lateCommand(fake: Fake, ends: () => boolean): void {
  const create = fake.state.create;
  fake.state.create = (spec) => {
    fake.containers.get(OWN_ID)!.execIds = ['late'];
    fake.execs.set('late', true);
    return create(spec);
  };
  const inspect = fake.engine.inspect;
  fake.engine.inspect = async (kind, reference, signal) => {
    if (kind === 'exec' && reference === 'late' && ends()) fake.execs.set('late', false);
    return inspect(kind, reference, signal);
  };
}

describe('the move of the Monitor to the current build of its helper image', () => {
  it('renames its container, creates its successor from the current build as a window creates it, and ends', async () => {
    const { upgrade, calls, created, lines } = setup();
    expect(upgrade.due()).toBe(true);
    expect(await upgrade.check()).toBe(true);
    expect(upgrade.ending).toBe(true);
    expect(calls).toEqual(['policy aaaa no', `rename aaaa devspaces-monitor-earlier-${'a'.repeat(12)}`, `tag 2222 ${MONITOR_TAG}`, `create devspaces-monitor ${MONITOR_TAG}`]);
    const [spec] = created;
    expect(spec.imageId).toBe(CURRENT);
    expect(spec.restartPolicy).toBe('unless-stopped');
    // The same label (so the windows take it as current), the owner, the label of the test run, a new nonce; never the
    // labels of the earlier image (the current build has its own).
    expect(spec.labels).toEqual({ [LABEL_MONITOR]: LABEL, [LABEL_MONITOR_CREATE]: expect.stringMatching(/^[0-9a-f-]{36}$/), [LABEL_MONITOR_OWNER]: 'computer-1', 'test.run': 'r1' });
    expect(spec.labels[LABEL_MONITOR_CREATE]).not.toBe(CREATE);
    expect(spec.mounts).toEqual({ socket: SOCKET, volume: 'devspaces-monitor', volumeTarget: '/state', store: { volume: STORE, target: VSCODE_STORE_DIR } });
    expect(spec.env).toEqual({
      [MONITOR_WORKER_HASH_ENV]: 'c'.repeat(64),
      DEVSPACE_MONITOR_TICK_MS: '500',
      [MONITOR_SUCCESSOR_ENV]: '1',
      DEVSPACE_MONITOR_CREATE_ID: spec.labels[LABEL_MONITOR_CREATE],
      DEVSPACE_IMAGE_SCHEDULE: '7 6 * * *',
      DEVSPACE_IMAGE_TZ: 'Europe/Vienna',
      DEVSPACE_MONITOR_PERMANENT: '1',
      DEVSPACE_VSCODE_STORE: STORE,
    });
    expect(lines).toEqual([
      `The helper image ${TAG} was built again (111111111111 → 222222222222). The Monitor moves to the current build: it creates its successor devspaces-monitor from it, and then ends.`,
      `The successor devspaces-monitor runs from the current build of the helper image. This Monitor (now devspaces-monitor-earlier-${'a'.repeat(12)}) ends; the successor removes it.`,
    ]);
  });

  it('does nothing while the tag is on its own image or on none, and checks at most once a minute', async () => {
    let reads = 0;
    const { upgrade, calls, images, advance } = setup(() => ({
      script: async () => {
        reads += 1;
        return SCRIPT;
      },
    }));
    images.set(TAG, { Id: EARLIER, RepoTags: [TAG], Config: { Labels: {}, Env: [] } });
    expect(await upgrade.check()).toBe(false);
    expect(upgrade.due()).toBe(false);
    advance(SELF_UPGRADE_CHECK_MS - 1);
    expect(upgrade.due()).toBe(false);
    advance(1);
    expect(upgrade.due()).toBe(true);
    images.delete(TAG);
    expect(await upgrade.check()).toBe(false);
    expect(calls).toEqual([]);
    expect(upgrade.ending).toBe(false);
    // Its script is read for the first check that read its container (and for the create of a successor).
    expect(reads).toBe(1);
  });

  it('never moves when it was created for another helper tag, has no nonce, or has no helper tag of its own', async () => {
    const other = setup(() => ({ helperTag: async () => 'devspaces-worker:ffffffffffff' }));
    expect(await other.upgrade.check()).toBe(false);
    other.advance(SELF_UPGRADE_CHECK_MS);
    expect(other.upgrade.due()).toBe(false);
    expect(other.calls).toEqual([]);
    // Without its nonce or its helper tag it never asks the engine (the tests of main.ts give neither).
    for (const deps of [{ env: { ...ENV, DEVSPACE_MONITOR_CREATE_ID: undefined } }, { helperTag: async () => undefined }]) {
      const { upgrade, lines } = setup(() => ({ ...deps, engine: unusedEngine() }));
      expect(await upgrade.check()).toBe(false);
      expect(upgrade.due()).toBe(false);
      expect(lines).toEqual([]);
    }
    const unreadable = setup(() => ({ script: async () => Promise.reject(new Error('ENOENT')) }));
    expect(await unreadable.upgrade.check()).toBe(false);
    expect(unreadable.upgrade.due()).toBe(false);
    expect(unreadable.lines).toEqual(['The Monitor cannot read its own script, so it never moves to a newer build of its helper image: ENOENT.']);
  });

  it('waits for the next check while a command of a window runs in its container (one that never started does not count)', async () => {
    const { upgrade, calls, containers, execs, advance } = setup();
    containers.get(OWN_ID)!.execIds = ['e1', 'e2'];
    execs.set('e1', false);
    execs.set('e2', true);
    expect(await upgrade.check()).toBe(false);
    expect(calls).toEqual([]);
    execs.set('e2', false);
    advance(SELF_UPGRADE_CHECK_MS);
    expect(await upgrade.check()).toBe(true);
  });

  it('waits at its end until the commands of the windows in its container ended, 30 s at most', async () => {
    const late = setup((fake) => {
      lateCommand(fake, () => fake.sleeps.length >= 3);
      return {};
    });
    expect(await late.upgrade.check()).toBe(true);
    expect(late.sleeps).toEqual([SELF_UPGRADE_COMMAND_LOOK_MS, SELF_UPGRADE_COMMAND_LOOK_MS, SELF_UPGRADE_COMMAND_LOOK_MS]);
    // One that never ends: the end waits SELF_UPGRADE_COMMAND_WAIT_MS.
    const stuck = setup((fake) => {
      lateCommand(fake, () => false);
      return {};
    });
    expect(await stuck.upgrade.check()).toBe(true);
    expect(stuck.sleeps).toHaveLength(SELF_UPGRADE_COMMAND_WAIT_MS / SELF_UPGRADE_COMMAND_LOOK_MS);
  });

  it('keeps going when a background run started meanwhile, and no run starts while it moves', async () => {
    const { upgrade, calls, setBusy } = setup();
    setBusy(true);
    expect(await upgrade.check()).toBe(false);
    expect(upgrade.ending).toBe(false);
    expect(calls).toEqual([]);
    // The move waits for the removals of records that run.
    let finish!: () => void;
    const removals = new Promise<void>((resolve) => (finish = resolve));
    const waiting = setup(() => ({ removals: () => removals }));
    const checking = waiting.upgrade.check();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(waiting.calls).toEqual([]);
    finish();
    expect(await checking).toBe(true);
  });

  it('a successor that cannot be created puts the name and the restart policy back, and is tried again after an hour', async () => {
    const { upgrade, calls, lines, state, advance } = setup();
    state.create = () => ({ kind: 'exited', detail: 'exec format error', conflict: false });
    expect(await upgrade.check()).toBe(false);
    expect(upgrade.ending).toBe(false);
    expect(calls).toEqual([
      'policy aaaa no',
      `rename aaaa devspaces-monitor-earlier-${'a'.repeat(12)}`,
      `tag 2222 ${MONITOR_TAG}`,
      `create devspaces-monitor ${MONITOR_TAG}`,
      'rename aaaa devspaces-monitor',
      'policy aaaa unless-stopped',
    ]);
    expect(lines[1]).toBe('The Monitor could not move to the current build of its helper image (its successor could not be created: docker run failed: exec format error). It tries again in 60 minutes.');
    advance(SELF_UPGRADE_CHECK_MS);
    expect(upgrade.due()).toBe(false);
    advance(SELF_UPGRADE_RETRY_MS - SELF_UPGRADE_CHECK_MS);
    expect(upgrade.due()).toBe(true);
  });

  it('a rename that fails puts the restart policy back; a name that cannot be put back ends it', async () => {
    const renameFails = setup();
    renameFails.state.renameFails = [true];
    expect(await renameFails.upgrade.check()).toBe(false);
    expect(renameFails.calls).toEqual(['policy aaaa no', `rename aaaa devspaces-monitor-earlier-${'a'.repeat(12)}`, 'policy aaaa unless-stopped']);
    const policyFails = setup();
    policyFails.state.policyFails = [true];
    expect(await policyFails.upgrade.check()).toBe(false);
    expect(policyFails.calls).toEqual(['policy aaaa no']);
    expect(policyFails.lines[1]).toBe('The Monitor could not move to the current build of its helper image (its restart policy could not be changed: policy refused). It tries again in 60 minutes.');
    // The successor failed, and a window took the name meanwhile: it ends, so two monitors never run.
    const taken = setup();
    taken.state.create = () => ({ kind: 'timeout' });
    taken.state.renameFails = [false, true];
    expect(await taken.upgrade.check()).toBe(true);
    expect(taken.lines[1]).toContain('and its name could not be put back (Conflict. The container name is already in use). It ends; the next heartbeat of a window starts the Monitor again.');
  });

  it('a container of the name that a window created meanwhile counts as its successor', async () => {
    const { upgrade, calls, lines } = setup((fake) => {
      const rename = fake.engine.renameContainer;
      // The window created it right after the rename.
      fake.engine.renameContainer = async (id, name, signal) => {
        await rename(id, name, signal);
        fake.containers.set('d'.repeat(64), { id: 'd'.repeat(64), name: 'devspaces-monitor', image: CURRENT, state: 'running', labels: { [LABEL_MONITOR]: LABEL }, env: [], binds: [], execIds: [] });
      };
      return {};
    });
    expect(await upgrade.check()).toBe(true);
    expect(calls.some((call) => call.startsWith('create'))).toBe(false);
    expect(lines[1]).toBe(`A window created the Monitor devspaces-monitor meanwhile. This Monitor (now devspaces-monitor-earlier-${'a'.repeat(12)}) ends; the next Monitor removes it.`);
  });

  it('removes the ended containers of its name from earlier builds, and their images without a tag', async () => {
    const { upgrade, calls, containers, images, lines, state } = setup();
    images.set(TAG, { Id: EARLIER, RepoTags: [TAG], Config: { Labels: {}, Env: [] } });
    const older = `sha256:${'3'.repeat(64)}`;
    const tagged = `sha256:${'4'.repeat(64)}`;
    images.set(older, { Id: older, RepoTags: [], Config: { Labels: { [LABEL_HELPER]: 'true' }, Env: [] } });
    images.set(tagged, { Id: tagged, RepoTags: ['devspaces-worker:999999999999'], Config: { Labels: { [LABEL_HELPER]: 'true' }, Env: [] } });
    const earlier = (id: string, name: string, image: string, status: string) =>
      containers.set(id, { id, name, image, state: status, labels: { [LABEL_MONITOR]: 'x' }, env: [], binds: [], execIds: [] });
    earlier('e'.repeat(64), `devspaces-monitor-earlier-${'e'.repeat(12)}`, older, 'exited');
    earlier('f'.repeat(64), `devspaces-monitor-earlier-${'f'.repeat(12)}`, tagged, 'exited');
    // Still ending, and another name: kept.
    earlier('9'.repeat(64), `devspaces-monitor-earlier-${'9'.repeat(12)}`, older, 'running');
    earlier('8'.repeat(64), `devspaces-test-monitor-earlier-${'8'.repeat(12)}`, older, 'exited');
    expect(await upgrade.check()).toBe(false);
    expect(calls).toEqual(['remove eeee', 'remove image 3333', 'remove ffff']);
    expect(lines).toEqual([
      `Removed the Monitor devspaces-monitor-earlier-${'e'.repeat(12)} of an earlier build of the helper image.`,
      'Removed the earlier build 333333333333 of the helper image.',
      `Removed the Monitor devspaces-monitor-earlier-${'f'.repeat(12)} of an earlier build of the helper image.`,
    ]);
    // An image that another container still uses stays, without a line.
    state.removeImage = 'inUse';
    earlier('7'.repeat(64), `devspaces-monitor-earlier-${'7'.repeat(12)}`, older, 'exited');
    lines.length = 0;
    expect(await upgrade.check()).toBe(false);
    expect(lines).toEqual([`Removed the Monitor devspaces-monitor-earlier-${'7'.repeat(12)} of an earlier build of the helper image.`]);
  });

  it('a read that fails is logged once, until a check reads again', async () => {
    let fail = true;
    const { upgrade, lines, advance } = setup((fake) => {
      const containerIds = fake.engine.containerIds;
      fake.engine.containerIds = async (filters, signal) => (fail ? Promise.reject(new Error('socket gone')) : containerIds(filters, signal));
      return {};
    });
    expect(await upgrade.check()).toBe(false);
    advance(SELF_UPGRADE_CHECK_MS);
    expect(await upgrade.check()).toBe(false);
    expect(lines).toEqual(['The Monitor cannot check whether it runs from the current build of its helper image: socket gone.']);
    fail = false;
    advance(SELF_UPGRADE_CHECK_MS);
    expect(await upgrade.check()).toBe(true);
  });
});

describe('the time between two checks', () => {
  it('is a minute; the Docker tests can set a shorter one', () => {
    expect(SELF_UPGRADE_CHECK_MS).toBe(60_000);
    expect(upgradeCheckFromEnv({})).toBe(SELF_UPGRADE_CHECK_MS);
    expect(upgradeCheckFromEnv({ DEVSPACE_MONITOR_UPGRADE_CHECK_MS: '1000' })).toBe(1000);
    for (const value of ['99', '60001', '-1', 'x', '1e3']) expect(upgradeCheckFromEnv({ DEVSPACE_MONITOR_UPGRADE_CHECK_MS: value })).toBe(SELF_UPGRADE_CHECK_MS);
  });

  it('checkMs replaces it', async () => {
    const { upgrade, images, advance } = setup(() => ({ checkMs: 1000 }));
    images.set(TAG, { Id: EARLIER, RepoTags: [TAG], Config: { Labels: {}, Env: [] } });
    expect(await upgrade.check()).toBe(false);
    advance(999);
    expect(upgrade.due()).toBe(false);
    advance(1);
    expect(upgrade.due()).toBe(true);
  });
});

describe('what the successor takes from its predecessor', () => {
  it('the variables and labels that runSpec does not set and whose key no image has', () => {
    expect(ownEnv(['PATH=/bin', 'A=1', 'DEVSPACE_MONITOR_CREATE_ID=x', 'DEVSPACES_VERSION=0.4.2', 'B==2', '=bad', 'C'], [{ env: ['PATH=/bin'] }])).toEqual({ A: '1', B: '=2' });
    // A variable of the image with the value of the earlier build: the successor gets the one of its own image.
    expect(ownEnv(['NODE_VERSION=26.1.0', 'A=1'], [{ env: ['NODE_VERSION=26.2.0'] }, { env: [] }])).toEqual({ A: '1' });
    expect(ownLabels({ [LABEL_MONITOR]: 'l', [LABEL_MONITOR_CREATE]: 'n', [LABEL_MONITOR_OWNER]: 'o', [LABEL_HELPER]: 'true', [LABEL_HELPER_BASE_DIGEST]: 'sha256:old', run: 'r' }, [{ labels: { [LABEL_HELPER]: 'true', [LABEL_HELPER_BASE_DIGEST]: 'sha256:new' } }])).toEqual({ run: 'r' });
    expect(ownLabels({ toString: 'x' }, [{ labels: {} }])).toEqual({ toString: 'x' });
  });

  it('the source of a bind mount by its target', () => {
    expect(bindSource(['/a/docker.sock:/var/run/docker.sock', 'vol:/state'], '/var/run/docker.sock')).toBe('/a/docker.sock');
    expect(bindSource(['vol:/state'], '/state')).toBe('vol');
    expect(bindSource([':/state', 'vol:/statefull'], '/state')).toBeUndefined();
  });
});
