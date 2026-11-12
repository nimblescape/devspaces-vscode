// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The merge of identical devspace images by the Monitor (imageMerge.ts, R-DS-010, D6), on a fake engine with images,
// containers and volumes, a fake lock and in-memory records.
import { describe, expect, it } from 'vitest';
import type { MergeRecord, MergeRecords } from '../core/helperChannel/mergeRecords';
import type { SharedImageRecords } from '../core/helperChannel/sharedImageRecords';
import { buildRecordLabel, imageRecordLabels } from '../core/pipeline/imageRecord';
import { LABEL_BUILD_RECORD, LABEL_DEVSPACE_ID, LABEL_IMAGE_KEY, LABEL_OWNER_ID, LABEL_REPOSITORY, devspaceImageName, resourceName } from '../core/names';
import type { BuildRecord } from '../core/types';
import type { EngineContainer, EngineImage } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import type { MergeEngine } from './engine';
import { ImageMerge, imageContent } from './imageMerge';
import type { StopLockAttempt } from './stopLock';

const OWNER = '4242';
const API = { id: 'aaaaaaaaaaaa', repository: 'acme/api', owner: { id: OWNER, login: '' } };
const WEB = { id: 'bbbbbbbbbbbb', repository: 'acme/web', owner: { id: OWNER, login: '' } };
const KEY = `sha256:${'a'.repeat(64)}`;
const SHARED = `sha256:${'5'.repeat(64)}`;
const DUPLICATE = `sha256:${'d'.repeat(64)}`;
const LAYERS = [`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`];
const CONFIG = { Env: ['PATH=/usr/bin'], Cmd: ['bash'], User: 'vscode', WorkingDir: '', Volumes: null, Image: '' };
const METADATA = { 'devcontainer.metadata': '[{"remoteUser":"vscode"}]' };

interface FakeImage extends EngineImage {
  config: Record<string, unknown>;
  layers: string[];
}

function record(env: typeof API, buildNumber: number, extra: Partial<BuildRecord> = {}): BuildRecord {
  return {
    builtAt: '2026-11-10T08:00:00.000Z',
    devspaceImage: devspaceImageName(env.repository, env.id, buildNumber),
    buildNumber,
    configPath: '.devcontainer/devcontainer.json',
    configHash: `sha256:${'c'.repeat(64)}`,
    images: { 'node:24': `sha256:${'e'.repeat(64)}` },
    features: {},
    ...extra,
  };
}

/** The shared image of KEY with the tag of the devspace API (build 1). */
function sharedImage(overrides: Partial<FakeImage> = {}): FakeImage {
  return {
    id: SHARED,
    repoTags: [devspaceImageName(API.repository, API.id, 1)],
    repoDigests: [],
    labels: { ...METADATA, [LABEL_IMAGE_KEY]: KEY },
    created: '2026-11-12T08:00:00Z',
    config: { ...CONFIG },
    layers: [...LAYERS],
    ...overrides,
  };
}

/** The devspace image of WEB (build 3), built for WEB alone, with the same layers and settings as the shared image. */
function duplicate(overrides: Partial<FakeImage> = {}): FakeImage {
  return {
    id: DUPLICATE,
    repoTags: [devspaceImageName(WEB.repository, WEB.id, 3)],
    repoDigests: [],
    labels: { ...METADATA, ...imageRecordLabels(WEB, record(WEB, 3)) },
    created: '2026-11-10T08:00:00Z',
    config: { ...CONFIG },
    layers: [...LAYERS],
    ...overrides,
  };
}

/** A dev container of `env` created from `imageId`; the dev container of API vouches for the shared image. */
function devContainer(env: typeof API, imageId: string, rawState = 'exited', labels: Record<string, string> = {}): EngineContainer {
  return {
    id: `container-of-${env.id}`,
    name: resourceName(env.repository, env.id),
    state: rawState === 'running' ? 'running' : 'stopped',
    rawState,
    image: '',
    imageId,
    labels: { [LABEL_DEVSPACE_ID]: env.id, ...labels },
  };
}

const vouching = devContainer(API, SHARED, 'running', { [LABEL_BUILD_RECORD]: buildRecordLabel(record(API, 1, { imageKey: KEY })) });

function fake(p: { images: FakeImage[]; containers: EngineContainer[]; volumes?: (typeof API)[]; refuse?: boolean; tagFails?: boolean }) {
  const images = p.images;
  const containers = [...p.containers];
  const calls: string[] = [];
  const volumes = p.volumes ?? [API, WEB];
  const byReference = (reference: string) => images.find((image) => image.id === reference || image.repoTags.includes(reference));
  const engine: MergeEngine = {
    ...unusedEngine(),
    volumeNames: async () => volumes.map((env) => resourceName(env.repository, env.id)),
    inspect: async (kind, reference) => {
      if (kind === 'volume') {
        const env = volumes.find((entry) => resourceName(entry.repository, entry.id) === reference);
        return env === undefined ? undefined : { Name: reference, Labels: { [LABEL_DEVSPACE_ID]: env.id, [LABEL_REPOSITORY]: env.repository, [LABEL_OWNER_ID]: OWNER } };
      }
      const image = byReference(reference);
      if (image === undefined) return undefined;
      return { Id: image.id, RootFS: { Type: 'layers', Layers: image.layers }, Config: { ...image.config, Labels: image.labels }, Os: 'linux', Architecture: 'amd64' };
    },
    images: async (filters) => images.filter((image) => image.repoTags.length > 0 && (filters.label ?? []).every((key) => image.labels[key] !== undefined)),
    containers: async (label) => {
      const [key, value] = label.split('=');
      return containers.filter((container) => container.labels[key] !== undefined && (value === undefined || container.labels[key] === value));
    },
    containerIds: async (filters) => containers.filter((container) => container.imageId === (filters.ancestor ?? [])[0]).map((container) => container.id),
    removeStoppedContainer: async (id) => {
      calls.push(`rm ${id}`);
      const index = containers.findIndex((container) => container.id === id);
      if (index < 0) return 'missing';
      if (p.refuse === true || containers[index].rawState === 'running') return 'refused';
      containers.splice(index, 1);
      return 'removed';
    },
    tagImage: async (id, reference) => {
      calls.push(`tag ${id} ${reference}`);
      if (p.tagFails === true) throw new Error('no space left on device');
      for (const image of images) image.repoTags = image.repoTags.filter((tag) => tag !== reference);
      byReference(id)!.repoTags.push(reference);
    },
    removeImage: async (reference) => {
      calls.push(`rmi ${reference}`);
      const image = byReference(reference);
      if (image === undefined) return 'missing';
      image.repoTags = image.repoTags.filter((tag) => tag !== reference);
      if (image.repoTags.length === 0) images.splice(images.indexOf(image), 1);
      return 'removed';
    },
  };
  return { engine, images, containers, calls };
}

function memoryRecords(): MergeRecords & { map: Map<string, MergeRecord> } {
  const map = new Map<string, MergeRecord>();
  return {
    map,
    read: (id) => map.get(id),
    write: (id, value) => void map.set(id, value),
    list: () => [...map.keys()],
    remove: (id) => void map.delete(id),
  };
}

function setup(p: Parameters<typeof fake>[0] & { lock?: StopLockAttempt['kind']; prepared?: Record<string, string> }) {
  const engine = fake(p);
  const logs: string[] = [];
  const locks: string[] = [];
  const records = memoryRecords();
  const shared: SharedImageRecords = { read: (key) => p.prepared?.[key], write: () => undefined, list: () => [], remove: () => undefined };
  let clock = 0;
  const merge = new ImageMerge({
    engine: engine.engine,
    log: (message) => void logs.push(message),
    monotonic: () => clock,
    lockDevspace: async (id) => {
      locks.push(`take ${id}`);
      if (p.lock === 'busy') return { kind: 'busy' };
      if (p.lock === 'failed') return { kind: 'failed', detail: 'flock is missing' };
      return { kind: 'locked', release: () => void locks.push(`release ${id}`) };
    },
    sharedImageRecords: shared,
    mergeRecords: records,
    firstMs: 100,
    checkMs: 1_000,
  });
  return { ...engine, merge, logs, locks, records, advance: (ms: number) => void (clock += ms) };
}

const webTag = (n: number) => devspaceImageName(WEB.repository, WEB.id, n);

describe('imageContent', () => {
  const inspect = (labels: Record<string, string>, config: Record<string, unknown> = CONFIG, layers = LAYERS) => ({
    Id: 'x',
    RootFS: { Type: 'layers', Layers: layers },
    Config: { ...config, Labels: labels },
    Os: 'linux',
    Architecture: 'amd64',
  });

  it('is the same without the labels of Devspaces, the parent image and the settings without a value', () => {
    const own = imageContent(inspect({ ...METADATA, ...imageRecordLabels(WEB, record(WEB, 3)) }, { ...CONFIG, Image: 'sha256:parent' }));
    expect(own).toBeDefined();
    expect(imageContent(inspect({ ...METADATA, [LABEL_IMAGE_KEY]: KEY }, { Env: CONFIG.Env, Cmd: CONFIG.Cmd, User: 'vscode', WorkingDir: '' }))).toBe(own);
  });

  it('leaves out empty layers, which add no file (a commit of the labels can add one)', () => {
    const empty = 'sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfb3e10ce5a1b6';
    expect(imageContent(inspect(METADATA, CONFIG, [...LAYERS, empty]))).toBe(imageContent(inspect(METADATA)));
    expect(imageContent(inspect(METADATA, CONFIG, [empty]))).toBeUndefined();
  });

  it('differs in the layers, a setting, another label or the platform; an inspect without layers or settings is none', () => {
    const own = imageContent(inspect(METADATA));
    expect(imageContent(inspect(METADATA, CONFIG, [LAYERS[0]]))).not.toBe(own);
    expect(imageContent(inspect(METADATA, { ...CONFIG, Env: ['PATH=/bin'] }))).not.toBe(own);
    expect(imageContent(inspect({ 'devcontainer.metadata': '[]' }))).not.toBe(own);
    expect(imageContent({ ...inspect(METADATA), Architecture: 'arm64' })).not.toBe(own);
    expect(imageContent({ ...inspect(METADATA), RootFS: { Type: 'layers', Layers: [] } })).toBeUndefined();
    expect(imageContent({ Id: 'x', RootFS: { Layers: LAYERS } })).toBeUndefined();
    expect(imageContent(undefined)).toBeUndefined();
  });
});

describe('the merge of identical devspace images', () => {
  it('moves a stopped devspace to the identical shared image: container and duplicate removed, record and tag written', async () => {
    const t = setup({ images: [sharedImage(), duplicate()], containers: [vouching, devContainer(WEB, DUPLICATE)] });
    await t.merge.pass();
    expect(t.locks).toEqual([`take ${WEB.id}`, `release ${WEB.id}`]);
    expect(t.calls).toEqual([`rm container-of-${WEB.id}`, `tag ${SHARED} ${webTag(4)}`, `rmi ${webTag(3)}`]);
    expect(t.containers.map((container) => container.id)).toEqual([vouching.id]);
    expect(t.images.map((image) => image.id)).toEqual([SHARED]);
    expect(t.images[0].repoTags).toContain(webTag(4));
    expect(t.records.map.get(WEB.id)).toEqual({ ownerId: OWNER, record: { ...record(WEB, 4), imageId: SHARED, imageKey: KEY } });
    expect(t.logs).toEqual([
      `The devspace image ${webTag(3)} of ${WEB.repository} was identical to the shared image ${SHARED} (1 tag): the devspace image is now ${webTag(4)} on the shared image, and its stopped container ${resourceName(WEB.repository, WEB.id)} was removed. The next Start creates the dev container from it.`,
    ]);
  });

  it('takes the build record of the dev container before the one of the image, and moves a duplicate without a container', async () => {
    const fromContainer = record(WEB, 3, { configHash: `sha256:${'f'.repeat(64)}` });
    const labels = { [LABEL_BUILD_RECORD]: buildRecordLabel(fromContainer), [LABEL_REPOSITORY]: WEB.repository, [LABEL_OWNER_ID]: OWNER };
    const t = setup({ images: [sharedImage(), duplicate()], containers: [vouching, devContainer(WEB, DUPLICATE, 'exited', labels)] });
    await t.merge.pass();
    expect(t.records.map.get(WEB.id)?.record.configHash).toBe(fromContainer.configHash);
    const unused = setup({ images: [sharedImage(), duplicate()], containers: [vouching] });
    await unused.merge.pass();
    expect(unused.calls).toEqual([`tag ${SHARED} ${webTag(4)}`, `rmi ${webTag(3)}`]);
    expect(unused.logs[0]).toContain('and it had no container.');
  });

  it('takes a shared image that only the record of a prepare vouches for, and never one that nothing vouches for', async () => {
    const prepared = setup({ images: [sharedImage(), duplicate()], containers: [devContainer(WEB, DUPLICATE)], prepared: { [KEY]: SHARED } });
    await prepared.merge.pass();
    expect(prepared.records.map.has(WEB.id)).toBe(true);
    const alone = setup({ images: [sharedImage(), duplicate()], containers: [devContainer(WEB, DUPLICATE)] });
    await alone.merge.pass();
    expect(alone.calls).toEqual([]);
    expect(alone.locks).toEqual([]);
  });

  it('leaves a devspace whose container runs, and merges it at a pass after it stopped', async () => {
    const t = setup({ images: [sharedImage(), duplicate()], containers: [vouching, devContainer(WEB, DUPLICATE, 'running')] });
    await t.merge.pass();
    expect(t.calls).toEqual([]);
    expect(t.logs).toEqual([]);
    expect(t.locks).toEqual([`take ${WEB.id}`, `release ${WEB.id}`]);
    t.containers[1].rawState = 'exited';
    await t.merge.pass();
    expect(t.calls).toContain(`tag ${SHARED} ${webTag(4)}`);
  });

  it('changes nothing while an operation holds the lock of the devspace, or when the lock cannot be taken (one line)', async () => {
    const busy = setup({ images: [sharedImage(), duplicate()], containers: [vouching, devContainer(WEB, DUPLICATE)], lock: 'busy' });
    await busy.merge.pass();
    expect(busy.calls).toEqual([]);
    expect(busy.logs).toEqual([]);
    const failed = setup({ images: [sharedImage(), duplicate()], containers: [vouching, devContainer(WEB, DUPLICATE)], lock: 'failed' });
    await failed.merge.pass();
    await failed.merge.pass();
    expect(failed.calls).toEqual([]);
    expect(failed.logs).toEqual([
      `The devspace image ${webTag(3)} of ${WEB.repository} is not merged with the identical shared image ${SHARED}: the lock of the devspace could not be taken (flock is missing).`,
    ]);
  });

  it('does not merge an image that is not really identical: other layers, another setting, another label', async () => {
    for (const other of [duplicate({ layers: [LAYERS[0]] }), duplicate({ config: { ...CONFIG, User: 'root' } }), duplicate({ labels: { ...duplicate().labels, 'org.example': 'x' } })]) {
      const t = setup({ images: [sharedImage(), other], containers: [vouching, devContainer(WEB, DUPLICATE)] });
      await t.merge.pass();
      expect(t.calls).toEqual([]);
      expect(t.locks).toEqual([]);
    }
  });

  it('does not merge when another container uses the image, or a dev container of the devspace has another image (one line each)', async () => {
    const stranger: EngineContainer = { ...devContainer(WEB, DUPLICATE), id: 'stranger', labels: {} };
    const other = setup({ images: [sharedImage(), duplicate()], containers: [vouching, devContainer(WEB, DUPLICATE), stranger] });
    await other.merge.pass();
    expect(other.calls).toEqual([]);
    expect(other.logs).toEqual([`The devspace image ${webTag(3)} of ${WEB.repository} is not merged with the identical shared image ${SHARED}: another container uses it.`]);
    const older = setup({ images: [sharedImage(), duplicate()], containers: [vouching, devContainer(WEB, `sha256:${'0'.repeat(64)}`)] });
    await older.merge.pass();
    expect(older.calls).toEqual([]);
    expect(older.logs[0]).toContain('a container of the devspace was created from another image.');
  });

  it('does not merge a devspace of Docker Compose, an image without a build record, or one with a tag of another repository', async () => {
    const compose = setup({ images: [sharedImage(), duplicate()], containers: [vouching, devContainer(WEB, DUPLICATE, 'exited', { 'com.docker.compose.project': 'x' })] });
    await compose.merge.pass();
    expect(compose.logs[0]).toContain('it is a devspace of Docker Compose.');
    const noRecord = setup({ images: [sharedImage(), duplicate({ labels: { ...duplicate().labels, [LABEL_BUILD_RECORD]: '' } })], containers: [vouching] });
    await noRecord.merge.pass();
    expect(noRecord.logs[0]).toContain('it has no build record of the devspace.');
    const named = setup({ images: [sharedImage(), duplicate({ repoTags: [webTag(3), 'mine:latest'] })], containers: [vouching] });
    await named.merge.pass();
    expect(named.calls).toEqual([]);
    expect(named.logs[0]).toContain('has a tag that is not of its devspace image');
    for (const t of [compose, noRecord]) expect(t.calls).toEqual([]);
  });

  it('merges only the newest devspace image of a devspace, and none of a devspace without a volume', async () => {
    const newer = duplicate({ id: `sha256:${'e'.repeat(64)}`, repoTags: [webTag(4)], labels: { ...METADATA, ...imageRecordLabels(WEB, record(WEB, 4)) }, layers: [LAYERS[0]] });
    const t = setup({ images: [sharedImage(), duplicate(), newer], containers: [vouching] });
    await t.merge.pass();
    expect(t.calls).toEqual([]);
    const gone = setup({ images: [sharedImage(), duplicate()], containers: [vouching], volumes: [API] });
    await gone.merge.pass();
    expect(gone.calls).toEqual([]);
  });

  it('changes nothing else when Docker refuses to remove the container (it started meanwhile)', async () => {
    const t = setup({ images: [sharedImage(), duplicate()], containers: [vouching, devContainer(WEB, DUPLICATE)], refuse: true });
    await t.merge.pass();
    expect(t.calls).toEqual([`rm container-of-${WEB.id}`]);
    expect(t.records.map.size).toBe(0);
    expect(t.logs[0]).toContain('Docker refused to remove its container');
  });

  it('removes the record and the tag again when the shared image cannot be tagged; the duplicate stays', async () => {
    const t = setup({ images: [sharedImage(), duplicate()], containers: [vouching, devContainer(WEB, DUPLICATE)], tagFails: true });
    await t.merge.pass();
    expect(t.calls).toEqual([`rm container-of-${WEB.id}`, `tag ${SHARED} ${webTag(4)}`, `rmi ${webTag(4)}`]);
    expect(t.records.map.size).toBe(0);
    expect(t.images.map((image) => image.id)).toEqual([SHARED, DUPLICATE]);
    expect(t.logs[0]).toContain(`the shared image could not be tagged ${webTag(4)} (no space left on device)`);
  });

  it('removes the merge records of a devspace without a volume, or whose tag no longer names their image', async () => {
    const t = setup({ images: [sharedImage({ repoTags: [devspaceImageName(API.repository, API.id, 1), webTag(4)] })], containers: [vouching], volumes: [API, WEB] });
    const valid: MergeRecord = { ownerId: OWNER, record: { ...record(WEB, 4), imageId: SHARED, imageKey: KEY } };
    t.records.map.set(WEB.id, valid);
    t.records.map.set(API.id, { ownerId: OWNER, record: { ...record(API, 7), imageId: SHARED, imageKey: KEY } });
    t.records.map.set('cccccccccccc', valid);
    await t.merge.pass();
    expect([...t.records.map.keys()]).toEqual([WEB.id]);
    expect(t.logs).toEqual([
      `The merge record of the devspace ${API.id} was removed: its tag ${devspaceImageName(API.repository, API.id, 7)} no longer names its image.`,
      'The merge record of the devspace cccccccccccc was removed: its devspace has no volume.',
    ]);
  });

  it('is due after its first wait, then again after its interval from the end of the last pass', async () => {
    const t = setup({ images: [], containers: [] });
    expect(t.merge.due()).toBe(false);
    t.advance(100);
    expect(t.merge.due()).toBe(true);
    await t.merge.pass();
    expect(t.merge.due()).toBe(false);
    t.advance(1_000);
    expect(t.merge.due()).toBe(true);
  });

  it('logs one line and never throws when the engine fails, and the same failure of later passes not again', async () => {
    const t = setup({ images: [sharedImage()], containers: [vouching] });
    const images = t.engine.images;
    t.engine.images = async () => Promise.reject(new Error('the socket is gone'));
    await expect(t.merge.pass()).resolves.toBeUndefined();
    await t.merge.pass();
    expect(t.logs).toEqual(['The identical devspace images could not be merged: the socket is gone']);
    // A pass that works ends the failure: the next failure is logged again.
    t.engine.images = images;
    await t.merge.pass();
    t.engine.images = async () => Promise.reject(new Error('the socket is gone'));
    await t.merge.pass();
    expect(t.logs).toEqual(['The identical devspace images could not be merged: the socket is gone', 'The identical devspace images could not be merged: the socket is gone']);
    // Also a failure of the list of the volumes, with what failed.
    t.engine.images = images;
    t.engine.volumeNames = async () => Promise.reject(new Error('the socket is gone'));
    await t.merge.pass();
    await t.merge.pass();
    expect(t.logs.slice(2)).toEqual(['The identical devspace images could not be merged: the volumes of the devspaces could not be read: the socket is gone']);
  });
});
