// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Monitor triggers the prepare. The part of its background run on a fake engine and a fake worker: which
// devspaces, in which order, one at a time, one line each; the stale prepared images; and the worker itself as a
// child process (its command, its environment, the script from the volume, the operation `prepare` over the helper
// channel to a ChannelServer in this process, without any secret).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { CHANNEL_ENTRY, OP_PREPARE, type PrepareValue } from '../core/helperChannel/protocol';
import { setUserAgentVersion } from '../core/http';
import { PIPE_LOADER, bundleHash } from '../core/loader/pipeLoader';
import { LABEL_CONFIG_PATH, LABEL_DEFAULT_IMAGE, LABEL_DEVSPACE_ID, LABEL_IMAGE_KEY, LABEL_PREPARED, LABEL_REPOSITORY, LABEL_VOLUME, devspaceImageName, preparedImageName, resourceName } from '../core/names';
import type { SharedImageRecords } from '../core/helperChannel/sharedImageRecords';
import { PREPARE_LIMIT_MS } from '../core/pipeline/pipelineRules';
import type { StartOptions, StartedProcess } from '../core/ports';
import { storeWorkerScript, workerScriptPath } from '../core/remoteMonitor/workerScript';
import type { EngineImage } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { ChannelServer, type OperationContext } from '../helperChannel/server';
import { RunReportBuilder } from '../core/remoteMonitor/runReport';
import type { PrepareEngine } from './engine';
import { withRunNotes } from './runNotes';
import {
  PREPARE_OPERATION_TIMEOUT_MS,
  PREPARE_WORKER_PATH,
  childPrepareWorker,
  prepareDevspaces,
  prepareLine,
  prepareOrder,
  removeStalePreparedImages,
  removeStalePreparedSharedTags,
  scanDevspaceVolumes,
  removeStaleSharedImageRecords,
  storedPrepareWorker,
  type PrepareSession,
  type PrepareWorker,
} from './prepares';

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
const C = 'cccccccccccc';
const REPO_A = 'acme/app';
const REPO_B = 'acme/api';
const REPO_C = 'acme/web';

/** A fake engine: the volumes (name → labels), the images, the containers of an image, and the removals. */
function fakeEngine(volumes: Record<string, Record<string, string>>, images: EngineImage[] = [], users: Record<string, string[]> = {}) {
  const removed: string[] = [];
  const engine: PrepareEngine = {
    ...unusedEngine(),
    volumeNames: async (filters) => {
      const [label] = filters.label ?? [];
      const [key, value] = label.split('=');
      return Object.entries(volumes)
        .filter(([, labels]) => labels[key] !== undefined && (value === undefined || labels[key] === value))
        .map(([name]) => name);
    },
    inspect: async (kind, name) => (kind === 'volume' && volumes[name] !== undefined ? { Name: name, Labels: volumes[name] } : undefined),
    images: async (filters) => images.filter((image) => (filters.label ?? []).every((key) => image.labels[key] !== undefined)),
    containerIds: async (filters) => users[(filters.ancestor ?? [])[0]] ?? [],
    removeImage: async (reference) => {
      removed.push(reference);
      return 'removed';
    },
  };
  return { engine, removed };
}

const volume = (repository: string, id: string, extra: Record<string, string> = {}) => ({
  [resourceName(repository, id)]: { [LABEL_DEVSPACE_ID]: id, [LABEL_REPOSITORY]: repository, ...extra },
});

/** A fake worker: records the opens, the prepares (and that one runs at a time), and the closes. */
function fakeWorker(answer: (id: string) => Promise<PrepareValue> = async () => ({ outcome: 'skipped', detail: 'its images are current (no update)', seconds: 1 })) {
  const events: string[] = [];
  let running = 0;
  let most = 0;
  const worker: PrepareWorker = {
    open: async () => {
      events.push('open');
      const session: PrepareSession = {
        prepare: async (id) => {
          running++;
          most = Math.max(most, running);
          events.push(`prepare ${id}`);
          try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return await answer(id);
          } finally {
            running--;
          }
        },
        close: async () => void events.push('close'),
      };
      return session;
    },
  };
  return { worker, events, most: () => most };
}

describe('the devspaces of the prepares', () => {
  it('are the workspace volumes with valid labels and the name of their devspace; additional and foreign volumes are not', async () => {
    const { engine } = fakeEngine({
      ...volume(REPO_A, A),
      ...volume(REPO_B, B, { [LABEL_VOLUME]: 'node_modules' }),
      'not-the-name': { [LABEL_DEVSPACE_ID]: C, [LABEL_REPOSITORY]: REPO_C },
      [resourceName(REPO_C, C)]: { [LABEL_DEVSPACE_ID]: C, [LABEL_REPOSITORY]: 'no slash' },
    });
    expect((await scanDevspaceVolumes(engine)).devspaces).toEqual([{ id: A, repository: REPO_A }]);
  });

  it('are also the volumes named with the word of their source (version 0.6.0 and later), as their labels name it', async () => {
    const D = 'dddddddddddd';
    const E = 'eeeeeeeeeeee';
    const F = 'ffffffffffff';
    const python = '.devcontainer/python/devcontainer.json';
    const { engine } = fakeEngine({
      [resourceName(REPO_A, A, 'default')]: { [LABEL_DEVSPACE_ID]: A, [LABEL_REPOSITORY]: REPO_A, [LABEL_DEFAULT_IMAGE]: 'ghcr.io/acme/base:latest' },
      [resourceName(REPO_B, B, 'config')]: { [LABEL_DEVSPACE_ID]: B, [LABEL_REPOSITORY]: REPO_B, [LABEL_CONFIG_PATH]: '.devcontainer/devcontainer.json' },
      [resourceName(REPO_C, C, 'python')]: { [LABEL_DEVSPACE_ID]: C, [LABEL_REPOSITORY]: REPO_C, [LABEL_CONFIG_PATH]: python },
      // The word of another source, or of none, is not the name of the devspace of the labels.
      [resourceName(REPO_A, D, 'config')]: { [LABEL_DEVSPACE_ID]: D, [LABEL_REPOSITORY]: REPO_A, [LABEL_DEFAULT_IMAGE]: 'ghcr.io/acme/base:latest' },
      [resourceName(REPO_B, E, 'python')]: { [LABEL_DEVSPACE_ID]: E, [LABEL_REPOSITORY]: REPO_B },
      // A volume of version 0.5.0 or older, whose labels do not name its source.
      ...volume(REPO_C, F),
    });
    expect((await scanDevspaceVolumes(engine)).devspaces).toEqual([
      { id: A, repository: REPO_A },
      { id: B, repository: REPO_B },
      { id: C, repository: REPO_C },
      { id: F, repository: REPO_C },
    ]);
  });

  it('are ordered by their last use (the newest heartbeat record first), then those without one by their ID', () => {
    const devspaces = [
      { id: C, repository: REPO_C },
      { id: B, repository: REPO_B },
      { id: A, repository: REPO_A },
      { id: 'dddddddddddd', repository: 'acme/d' },
    ];
    const order = prepareOrder(devspaces, new Map([[B, 200], [A, 100]]));
    expect(order.map((env) => env.id)).toEqual([B, A, C, 'dddddddddddd']);
  });
});

describe('the part "prepares" of the background run', () => {
  it('prepares every devspace, one at a time, the most recently used first, with one line each, in one worker', async () => {
    const { engine } = fakeEngine({ ...volume(REPO_A, A), ...volume(REPO_B, B), ...volume(REPO_C, C) });
    const answers: Record<string, PrepareValue> = {
      [A]: { outcome: 'prepared', detail: `the newer image was prepared as ${preparedImageName(REPO_A, A)}`, seconds: 125 },
      [B]: { outcome: 'skipped', detail: 'its images are current (no update)', seconds: 0 },
      [C]: { outcome: 'stopped', detail: 'the prepare was stopped after 30 minutes; the next open builds it.', seconds: 1800 },
    };
    const { worker, events, most } = fakeWorker(async (id) => answers[id]);
    const lines: string[] = [];
    const notes = new RunReportBuilder(0);
    await withRunNotes(notes, () => prepareDevspaces({ engine, log: (line) => lines.push(line), monotonic: () => 0, lastUsed: async () => new Map([[C, 3], [A, 2]]), worker: () => worker }));
    expect(events).toEqual(['open', `prepare ${C}`, `prepare ${A}`, `prepare ${B}`, 'close']);
    // The report of the run (R-DS-003): a prepare stopped by its time limit counts as failed.
    expect(notes.finish(0, true).events).toEqual({
      devspacePrepared: { count: 1, items: [REPO_A] },
      devspacePrepareSkipped: { count: 1, items: [`${REPO_B}: its images are current (no update)`] },
      devspacePrepareFailed: { count: 1, items: [`${REPO_C}: stopped by its time limit`] },
    });
    expect(most()).toBe(1);
    expect(lines).toEqual([
      `${REPO_C}: the prepare was stopped after 30 min 0 s by its time limit; the next open builds it.`,
      `${REPO_A}: prepared in 2 min 5 s (the newer image was prepared as ${preparedImageName(REPO_A, A)}).`,
      `${REPO_B}: no prepare (0 s): its images are current (no update).`,
    ]);
  });

  it('a failed prepare is one line, and the next devspace gets a new worker', async () => {
    const { engine } = fakeEngine({ ...volume(REPO_A, A), ...volume(REPO_B, B) });
    const { worker, events } = fakeWorker(async (id) => {
      if (id === A) throw new Error('the helper channel was lost');
      return { outcome: 'failed', detail: 'the lockfile does not match\nat line 2', seconds: 61 };
    });
    const lines: string[] = [];
    let clock = 0;
    const notes = new RunReportBuilder(0);
    await withRunNotes(notes, () => prepareDevspaces({ engine, log: (line) => lines.push(line), monotonic: () => (clock += 1000), lastUsed: async () => new Map(), worker: () => worker }));
    expect(notes.finish(0, true).events).toEqual({
      devspacePrepareFailed: { count: 2, items: [`${REPO_A}: the helper channel was lost`, `${REPO_B}: the lockfile does not match at line 2`] },
    });
    expect(events).toEqual(['open', `prepare ${A}`, 'close', 'open', `prepare ${B}`, 'close']);
    expect(lines).toEqual([`${REPO_A}: the prepare failed after 1 s: the helper channel was lost.`, `${REPO_B}: the prepare failed after 1 min 1 s: the lockfile does not match at line 2.`]);
  });

  it('without a worker script, one line and no prepare; without a devspace, no worker', async () => {
    const lines: string[] = [];
    const { engine } = fakeEngine(volume(REPO_A, A));
    const notes = new RunReportBuilder(0);
    await withRunNotes(notes, () => prepareDevspaces({ engine, log: (line) => lines.push(line), monotonic: () => 0, lastUsed: async () => new Map(), worker: () => ({ reason: 'the worker script 0123 is not in the volume' }) }));
    expect(lines).toEqual(['No devspace image is prepared: the worker script 0123 is not in the volume.']);
    expect(notes.finish(0, true).events).toEqual({ devspacePrepareSkipped: { count: 1, items: ['1 devspace(s): the worker script 0123 is not in the volume'] } });
    const none = fakeEngine({});
    const { worker, events } = fakeWorker();
    await prepareDevspaces({ engine: none.engine, log: () => {}, monotonic: () => 0, lastUsed: async () => new Map(), worker: () => worker });
    expect(events).toEqual([]);
  });

  it('a worker that cannot be started leaves the rest for the next run', async () => {
    const { engine } = fakeEngine({ ...volume(REPO_A, A), ...volume(REPO_B, B) });
    const lines: string[] = [];
    const worker: PrepareWorker = { open: async () => Promise.reject(new Error('no answer within 120 seconds')) };
    const notes = new RunReportBuilder(0);
    await withRunNotes(notes, () => prepareDevspaces({ engine, log: (line) => lines.push(line), monotonic: () => 0, lastUsed: async () => new Map(), worker: () => worker }));
    expect(notes.finish(0, true).events).toEqual({
      devspacePrepareFailed: { count: 2, items: ['2 devspace(s): the worker of the prepares could not be started: no answer within 120 seconds'] },
    });
    expect(lines).toEqual(['The worker of the prepares could not be started, so 2 devspace(s) are prepared at the next run: no answer within 120 seconds.']);
  });

  it('the report names a cancel as stopped, and a repository alone when the worker gives no detail', async () => {
    const { engine } = fakeEngine({ ...volume(REPO_A, A), ...volume(REPO_B, B) });
    const answers: Record<string, PrepareValue> = {
      [A]: { outcome: 'cancelled', detail: '', seconds: 3 },
      [B]: { outcome: 'skipped', detail: '', seconds: 0 },
    };
    const { worker } = fakeWorker(async (id) => answers[id]);
    const notes = new RunReportBuilder(0);
    await withRunNotes(notes, () => prepareDevspaces({ engine, log: () => {}, monotonic: () => 0, lastUsed: async () => new Map(), worker: () => worker }));
    expect(notes.finish(0, true).events).toEqual({ devspacePrepareSkipped: { count: 2, items: [`${REPO_A}: stopped`, REPO_B] } });
  });

  it('the line of each outcome', () => {
    const env = { id: A, repository: REPO_A };
    expect(prepareLine(env, { outcome: 'cancelled', detail: 'it was asked to stop', seconds: 3 })).toBe(`${REPO_A}: the prepare was stopped after 3 s: it was asked to stop.`);
    expect(prepareLine(env, { outcome: 'skipped', detail: 'its prepare lock is held (it is tried again at the next pass)', seconds: 0 })).toBe(
      `${REPO_A}: no prepare (0 s): its prepare lock is held (it is tried again at the next pass).`,
    );
  });

  it('the time limit of the operation is longer than the prepare limit of the worker', () => {
    expect(PREPARE_OPERATION_TIMEOUT_MS).toBeGreaterThan(PREPARE_LIMIT_MS);
  });
});

describe('the stale prepared images', () => {
  const ID_1 = `sha256:${'1'.repeat(64)}`;
  const ID_2 = `sha256:${'2'.repeat(64)}`;
  const ID_3 = `sha256:${'3'.repeat(64)}`;
  const ID_4 = `sha256:${'4'.repeat(64)}`;
  const image = (id: string, repository: string, envId: string, prepared = '{"x":1}', tags = [preparedImageName(repository, envId)]): EngineImage => ({
    id,
    repoTags: tags,
    repoDigests: [],
    created: '2026-10-11T00:00:00Z',
    labels: { [LABEL_DEVSPACE_ID]: envId, [LABEL_REPOSITORY]: repository, [LABEL_PREPARED]: prepared },
  });

  it('removes, by the tag and without force, only the prepared images of devspaces without a volume that no container uses', async () => {
    const { engine, removed } = fakeEngine(
      volume(REPO_A, A),
      [
        image(ID_1, REPO_A, A),
        image(ID_2, REPO_B, B),
        image(ID_3, REPO_C, C),
        // Taken over by an open (the label emptied, the tag a build number), and a tag of another name.
        image(ID_4, 'acme/old', 'eeeeeeeeeeee', ''),
        image(`sha256:${'5'.repeat(64)}`, 'acme/odd', 'ffffffffffff', '{"x":1}', ['something:prepared']),
      ],
      { [ID_3]: ['f'.repeat(64)] },
    );
    const lines: string[] = [];
    const notes = new RunReportBuilder(0);
    await withRunNotes(notes, () => removeStalePreparedImages(engine, (line) => lines.push(line)));
    expect(removed).toEqual([preparedImageName(REPO_B, B)]);
    expect(notes.finish(0, true).events).toEqual({
      engineObjectRemoved: { count: 1, items: [`the prepared image ${preparedImageName(REPO_B, B)} of a devspace without a volume`] },
    });
    expect(lines).toEqual([
      `Removed the prepared image ${preparedImageName(REPO_B, B)}: its devspace ${B} has no volume on this engine.`,
      `The prepared image ${preparedImageName(REPO_C, C)} of the removed devspace ${C} stays: a container uses it.`,
    ]);
  });

  it('removes nothing when the images cannot be listed', async () => {
    const { engine, removed } = fakeEngine({});
    const lines: string[] = [];
    await removeStalePreparedImages({ ...engine, images: async () => Promise.reject(new Error('down')) }, (line) => lines.push(line));
    expect(removed).toEqual([]);
    expect(lines).toEqual(['The prepared images could not be listed, so none is removed: down']);
  });

  it('run after the prepares of the part', async () => {
    const { engine, removed } = fakeEngine({}, [image(ID_2, REPO_B, B)]);
    await prepareDevspaces({ engine, log: () => {}, monotonic: () => 0, lastUsed: async () => new Map(), worker: () => ({ reason: 'none' }) });
    expect(removed).toEqual([preparedImageName(REPO_B, B)]);
  });
});

describe('the stale prepared shared images and their records (R-DS-010)', () => {
  const KEY = `sha256:${'9'.repeat(64)}`;
  const SHARED = `sha256:${'6'.repeat(64)}`;
  const OWN = `sha256:${'7'.repeat(64)}`;
  const shared = (id: string, tags: string[], labels: Record<string, string> = { [LABEL_IMAGE_KEY]: KEY }): EngineImage => ({
    id,
    repoTags: tags,
    repoDigests: [],
    created: '2026-11-12T00:00:00Z',
    labels,
  });

  it('removes from shared images the tags <resource>:prepared of devspaces without a volume, by the tag; the others stay', async () => {
    const { engine, removed } = fakeEngine(volume(REPO_A, A), [
      shared(SHARED, [preparedImageName(REPO_A, A), preparedImageName(REPO_B, B), devspaceImageName(REPO_C, C, 3)]),
      // An image built for one devspace (its labels) is the part of removeStalePreparedImages.
      shared(OWN, [preparedImageName(REPO_C, C)], { [LABEL_IMAGE_KEY]: KEY, [LABEL_DEVSPACE_ID]: C }),
    ]);
    const lines: string[] = [];
    await removeStalePreparedSharedTags(engine, (line) => lines.push(line));
    expect(removed).toEqual([preparedImageName(REPO_B, B)]);
    expect(lines).toEqual([`Removed the tag ${preparedImageName(REPO_B, B)} of a shared image: its devspace has no volume on this engine.`]);
  });

  it('says so when Docker keeps the image in use, and removes nothing when the volumes cannot be listed', async () => {
    const { engine } = fakeEngine({}, [shared(SHARED, [preparedImageName(REPO_B, B)])]);
    const lines: string[] = [];
    await removeStalePreparedSharedTags({ ...engine, removeImage: async () => 'inUse' }, (line) => lines.push(line));
    expect(lines).toEqual([`The tag ${preparedImageName(REPO_B, B)} of a shared image stays: Docker says the image is in use.`]);
    lines.length = 0;
    const removed: string[] = [];
    await removeStalePreparedSharedTags(
      { ...engine, volumeNames: async () => Promise.reject(new Error('down')), removeImage: async (reference) => (removed.push(reference), 'removed') },
      (line) => lines.push(line),
    );
    expect(removed).toEqual([]);
    expect(lines).toEqual(['The prepared shared images could not be listed, so no tag is removed: down']);
  });

  it('takes a volume that is gone after the list for none, and removes nothing when a volume cannot be read', async () => {
    const { engine, removed } = fakeEngine(volume(REPO_A, A), [shared(SHARED, [preparedImageName(REPO_A, A), preparedImageName(REPO_B, B)])]);
    const listed = async () => [resourceName(REPO_A, A), 'removed-meanwhile'];
    const lines: string[] = [];
    await removeStalePreparedSharedTags({ ...engine, volumeNames: listed }, (line) => lines.push(line));
    expect(removed).toEqual([preparedImageName(REPO_B, B)]);
    removed.length = 0;
    lines.length = 0;
    await removeStalePreparedSharedTags({ ...engine, inspect: async () => Promise.reject(new Error('busy')) }, (line) => lines.push(line));
    expect(removed).toEqual([]);
    expect(lines).toEqual(['The prepared shared images could not be listed, so no tag is removed: busy']);
    lines.length = 0;
    await removeStalePreparedSharedTags({ ...engine, inspect: async (_kind, name) => ({ Name: name }) }, (line) => lines.push(line));
    expect(removed).toEqual([]);
    expect(lines).toEqual(['The prepared shared images could not be listed, so no tag is removed: a volume of a devspace could not be read']);
  });

  it('takes the volumes that the run read at its start, and reads them again only before a removal', async () => {
    const volumes: Record<string, Record<string, string>> = { ...volume(REPO_A, A) };
    const { engine, removed } = fakeEngine(volumes, [shared(SHARED, [preparedImageName(REPO_A, A)])]);
    const inspected: string[] = [];
    const counting: PrepareEngine = { ...engine, inspect: async (kind, name, signal) => (inspected.push(name), engine.inspect(kind, name, signal)) };
    const run = () => prepareDevspaces({ engine: counting, log: () => {}, monotonic: () => 0, lastUsed: async () => new Map(), worker: () => ({ reason: 'none' }) });
    // Nothing to remove: the volumes are read once.
    await run();
    expect(inspected).toEqual([resourceName(REPO_A, A)]);
    expect(removed).toEqual([]);
    // A tag of a devspace without a volume: read again, then removed.
    const { engine: second, removed: removedSecond } = fakeEngine(volumes, [shared(SHARED, [preparedImageName(REPO_A, A), preparedImageName(REPO_B, B)])]);
    inspected.length = 0;
    await prepareDevspaces({ engine: { ...second, inspect: counting.inspect }, log: () => {}, monotonic: () => 0, lastUsed: async () => new Map(), worker: () => ({ reason: 'none' }) });
    expect(inspected).toEqual([resourceName(REPO_A, A), resourceName(REPO_A, A)]);
    expect(removedSecond).toEqual([preparedImageName(REPO_B, B)]);
  });

  it('keeps the tag of a devspace whose volume came during the run', async () => {
    const volumes: Record<string, Record<string, string>> = { ...volume(REPO_A, A) };
    const { engine, removed } = fakeEngine(volumes, [shared(SHARED, [preparedImageName(REPO_B, B)])]);
    const start = await scanDevspaceVolumes(engine);
    Object.assign(volumes, volume(REPO_B, B));
    await removeStalePreparedSharedTags(engine, () => {}, start);
    expect(removed).toEqual([]);
  });

  /** Records of the test (SharedImageRecords) by key. */
  function fakeRecords(entries: Record<string, string | undefined>): SharedImageRecords & { keys: () => string[] } {
    const map = new Map(Object.entries(entries));
    return {
      read: (key) => map.get(key),
      write: (key, imageId) => void map.set(key, imageId),
      list: () => [...map].map(([key, imageId]) => ({ key, imageId })),
      remove: (key) => void map.delete(key),
      keys: () => [...map.keys()],
    };
  }

  it('removes the records whose image is gone or that hold no image ID; one whose image cannot be asked about stays', async () => {
    const GONE = `sha256:${'1'.repeat(64)}`;
    const ASK = `sha256:${'2'.repeat(64)}`;
    const keys = [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`, `sha256:${'c'.repeat(64)}`, `sha256:${'d'.repeat(64)}`];
    const records = fakeRecords({ [keys[0]]: SHARED, [keys[1]]: GONE, [keys[2]]: undefined, [keys[3]]: ASK });
    const { engine } = fakeEngine({});
    const inspect: PrepareEngine['inspect'] = async (kind, reference) => {
      if (kind === 'image' && reference === ASK) throw new Error('down');
      return kind === 'image' && reference === SHARED ? { Id: SHARED } : undefined;
    };
    const lines: string[] = [];
    await removeStaleSharedImageRecords({ ...engine, inspect }, records, (line) => lines.push(line));
    expect(records.keys()).toEqual([keys[0], keys[3]]);
    expect(lines).toEqual([
      `Removed the record of the shared image key ${keys[1]}: its image ${GONE} is gone.`,
      `Removed the record of the shared image key ${keys[2]}: it holds no image ID.`,
      `The image ${ASK} of the record of the shared image key ${keys[3]} could not be asked about: down`,
    ]);
  });

  it('run after the prepares of the part, with the records of the volume', async () => {
    const records = fakeRecords({ [KEY]: SHARED });
    const { engine, removed } = fakeEngine({}, [shared(SHARED, [preparedImageName(REPO_B, B)])]);
    await prepareDevspaces({ engine, log: () => {}, monotonic: () => 0, lastUsed: async () => new Map(), worker: () => ({ reason: 'none' }), sharedImageRecords: records });
    expect(removed).toEqual([preparedImageName(REPO_B, B)]);
    // The fake engine knows no image: the record goes.
    expect(records.keys()).toEqual([]);
  });
});

describe('the worker of the prepares', () => {
  let stateDir: string;
  let tempRoot: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-11k2c-state-'));
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-11k2c-tmp-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  /**
   * A start of the worker that connects the monitor's channel to a ChannelServer in this process with one operation
   * `prepare` (its parameters and secrets recorded); the first line (the script) is recorded too.
   */
  function inProcessStart(answer: (params: unknown, context: OperationContext) => Promise<unknown>) {
    const started: Array<{ file: string; args: readonly string[]; options: StartOptions; script?: string }> = [];
    const start = (file: string, args: readonly string[], options: StartOptions): StartedProcess => {
      const entry: (typeof started)[number] = { file, args, options };
      started.push(entry);
      let toMonitor: (text: string) => void = () => {};
      let resolveExit!: (value: { exitCode: number | null }) => void;
      const exited = new Promise<{ exitCode: number | null }>((resolve) => (resolveExit = resolve));
      const server = new ChannelServer({
        write: (text) => {
          setImmediate(() => toMonitor(text));
          return true;
        },
        operations: { [OP_PREPARE]: answer },
        exit: (code) => resolveExit({ exitCode: code }),
      });
      server.start();
      let first = '';
      return {
        write: (text) => {
          let rest = text;
          if (entry.script === undefined) {
            first += rest;
            const end = first.indexOf('\n');
            if (end < 0) return true;
            entry.script = JSON.parse(first.slice(0, end)) as string;
            rest = first.slice(end + 1);
          }
          setImmediate(() => server.input(rest));
          return true;
        },
        end: () => setImmediate(() => server.inputEnded()),
        kill: () => server.shutdown(),
        onStdout: (listener) => (toMonitor = listener),
        onStderr: () => {},
        exited,
      };
    };
    return { start, started };
  }

  it('runs the stored script of its hash with the pipe loader at a private path, PATH only, and sends `prepare` with the ID only, no secret', async () => {
    const script = '/* the worker */ module.exports.startChannel = () => {};';
    const hash = storeWorkerScript(stateDir, script);
    const calls: Array<{ params: unknown; secrets: boolean }> = [];
    const { start, started } = inProcessStart(async (params, context) => {
      calls.push({ params, secrets: !context.hasNoSecret() });
      return { outcome: 'prepared', detail: 'the newer image was prepared', seconds: 42 };
    });
    const make = storedPrepareWorker(hash, stateDir, () => Date.now(), { start, tempRoot, node: '/usr/local/bin/node' });
    const worker = make();
    if ('reason' in worker) throw new Error(worker.reason);
    const session = await worker.open();
    expect(await session.prepare(A)).toEqual({ outcome: 'prepared', detail: 'the newer image was prepared', seconds: 42 });
    expect(calls).toEqual([{ params: { devspaceId: A }, secrets: false }]);
    const [{ file, args, options, script: sent }] = started;
    expect(file).toBe('/usr/local/bin/node');
    const folder = path.dirname(args[2]);
    expect(args).toEqual(['-e', PIPE_LOADER, path.join(folder, 'channel.js'), hash, CHANNEL_ENTRY]);
    expect(path.dirname(folder)).toBe(tempRoot);
    expect(options).toEqual({ env: { PATH: PREPARE_WORKER_PATH }, cwd: folder });
    expect(sent).toBe(script);
    // No token, no credential, nothing of a computer on the command line or in the environment.
    expect(JSON.stringify({ args: args.filter((arg) => arg !== PIPE_LOADER), options })).not.toMatch(/token|gh[opsu]_|REMOTE_CONTAINERS|SSH_AUTH_SOCK|BROWSER|VSCODE_|DOCKER_HOST/i);
    await session.close();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('gives the worker the version of Devspaces that the Monitor got, for the header User-Agent', async () => {
    const hash = storeWorkerScript(stateDir, 'x');
    const { start, started } = inProcessStart(async () => ({ outcome: 'prepared', detail: '', seconds: 1 }));
    setUserAgentVersion('1.20.3');
    onTestFinished(() => void setUserAgentVersion(undefined));
    const session = await childPrepareWorker({ script: 'x', hash, start, tempRoot }).open();
    await session.close();
    expect(started.map(({ options }) => options.env)).toEqual([{ PATH: PREPARE_WORKER_PATH, DEVSPACES_VERSION: '1.20.3' }]);
  });

  it('refuses an invalid value of the worker', async () => {
    const hash = storeWorkerScript(stateDir, 'x');
    const { start } = inProcessStart(async () => ({ outcome: 'built', detail: '', seconds: 1 }));
    const session = await childPrepareWorker({ script: 'x', hash, start, tempRoot }).open();
    await expect(session.prepare(A)).rejects.toThrow('the worker answered with an invalid value');
    await session.close();
  });

  it('has no worker without the hash, without its script, or with a script that does not match it', () => {
    expect(storedPrepareWorker(undefined, stateDir, Date.now)()).toEqual({ reason: 'the Monitor was created without the hash of a worker script' });
    const hash = bundleHash('the worker');
    expect(storedPrepareWorker(hash, stateDir, Date.now)()).toEqual({ reason: `the worker script ${hash.slice(0, 12)} is not in the volume (the next open stores it)` });
    storeWorkerScript(stateDir, 'the worker');
    fs.writeFileSync(workerScriptPath(stateDir, hash), 'another worker');
    expect(storedPrepareWorker(hash, stateDir, Date.now)()).toEqual({ reason: `the worker script ${hash.slice(0, 12)} in the volume does not match its hash (the next open stores it again)` });
  });
});
