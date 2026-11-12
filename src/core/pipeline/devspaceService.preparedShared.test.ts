// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The background prepare with shared images (R-DS-010): the prepare of a devspace builds its newer image as a shared
// image (only the image key) and records it for the key (sharedImageRecords, in the volume of the Monitor); the
// prepare of another devspace with the same inputs tags that image as its own prepared image, without a build; each
// open takes it by its key after the pulls (no download: the prepare pulled the same digests), without a build or new
// labels. The record vouches for the image before a dev container was created from it (isSharedImage). The prepare
// without shared images: devspaceService.prepare.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LABEL_IMAGE_KEY, LABEL_PREPARED, MAX_BUILD_RECORD_LABEL_LENGTH, devspaceImageName, preparedImageName } from '../names';
import type { BuildRecord, Devspace } from '../types';
import { CommandError } from '../errors';
import { LOCKFILE_CHANGED_EXIT, LOCKFILE_CHANGED_TEXT } from '../helper/scripts';
import { isLockfileChanged } from '../helper/stepInputs';
import type { RepositoryTarget } from './operationBase';
import {
  ACCOUNT,
  DIGEST_NEW,
  DIGEST_OLD,
  BASE_IMAGE,
  DEFAULT_CONFIG_TEXT,
  ENV_ID,
  FEATURE,
  FEATURE_DIGEST,
  REPO,
  createHarness,
  fakeSharedImageRecords,
  headlessPrepareService,
  imageConfigWithUser,
  prepareRun,
  seedDevspace,
  type Harness,
} from './devspaceService.testkit';
import { buildRecordLabel, imageRecordLabels, preparedImageLabels, type PrepareKey } from './imageRecord';
import { configHash } from './pipelineRules';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const WEB_REPO = 'acme/web';
const WEB_ID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const PREPARED = preparedImageName(REPO, ENV_ID);
const WEB_PREPARED = preparedImageName(WEB_REPO, WEB_ID);
const OLD_RECORD = { images: { [BASE_IMAGE]: DIGEST_OLD } };

let h: Harness;
let records: ReturnType<typeof fakeSharedImageRecords>;

beforeEach(() => {
  records = fakeSharedImageRecords();
  h = createHarness({ sharedImageRecords: records });
});

afterEach(() => {
  h.cleanup();
});

/** A devspace whose image carries its build record (OLD_RECORD), as a build of the open labels it. */
async function seedLabelled(id = ENV_ID, repository = REPO): Promise<Devspace> {
  const env = await seedDevspace(h, { id, repository, record: OLD_RECORD, container: 'running' });
  const record = env.buildRecord as BuildRecord;
  const config = imageConfigWithUser('vscode');
  h.docker.imageConfigs.set(record.devspaceImage, { ...config, Labels: { ...config.Labels, ...imageRecordLabels(env, record) } });
  return env;
}

/** The headless prepare of `id`, with the records of the test (or none). */
async function prepare(id = ENV_ID, withRecords = true) {
  const { run } = prepareRun();
  const { service, hostUses } = headlessPrepareService(h, withRecords ? { sharedImageRecords: records } : {});
  const result = await service.prepare(id, run);
  expect(hostUses).toEqual([]);
  return result;
}

const tags = () => h.docker.log.filter((line) => line.startsWith('tag '));
const builds = () => h.helper.builds.map((build) => build.imageName);

describe('the prepare with shared images', () => {
  it('builds the newer image as a shared image (only its key) and records it; the prepare of another devspace tags it', async () => {
    await seedLabelled();
    await seedLabelled(WEB_ID, WEB_REPO);
    const first = await prepare();
    expect(first.outcome).toBe('prepared');
    expect(builds()).toEqual([PREPARED]);
    const key = h.docker.labelled.get(PREPARED)![LABEL_IMAGE_KEY];
    expect(h.docker.labelled.get(PREPARED)).toEqual({ [LABEL_IMAGE_KEY]: key });
    const id = (await h.docker.imageId(PREPARED))!;
    expect([...records.records]).toEqual([[key, id]]);
    expect(first.detail).toBe(`the newer image was prepared as ${PREPARED} (${id}), as a shared image`);

    const second = await prepare(WEB_ID);
    expect(second).toMatchObject({ outcome: 'prepared', detail: `the newer image is the shared image ${id} with the same inputs, tagged ${WEB_PREPARED} without a build` });
    expect(builds()).toEqual([PREPARED]);
    expect(tags()).toEqual([`tag ${id} ${WEB_PREPARED}`]);
    // The record stays the one of the image that the first prepare built.
    expect([...records.records]).toEqual([[key, id]]);
  });

  it('then each open takes it by its key after the pulls: no build, no new labels; each dev container carries the key', async () => {
    await seedLabelled();
    await seedLabelled(WEB_ID, WEB_REPO);
    await prepare();
    await prepare(WEB_ID);
    const id = (await h.docker.imageId(PREPARED))!;
    const key = h.docker.labelled.get(PREPARED)![LABEL_IMAGE_KEY];
    const pulls = [...h.docker.pulls];
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    await h.service.openDevspace(WEB_ID, { progress: h.progress });
    expect(builds()).toEqual([PREPARED]);
    // The open pulls the digests that the prepare pulled (no download), so its key is the key of the images it pulls.
    expect(h.docker.pulls).toEqual([...pulls, ...pulls]);
    const api = (await h.registry.get(ENV_ID))!.buildRecord!;
    const web = (await h.registry.get(WEB_ID))!.buildRecord!;
    expect([api.devspaceImage, web.devspaceImage]).toEqual([devspaceImageName(REPO, ENV_ID, 2), devspaceImageName(WEB_REPO, WEB_ID, 2)]);
    expect([api.imageId, web.imageId]).toEqual([id, id]);
    expect([api.imageKey, web.imageKey]).toEqual([key, key]);
    expect(h.helper.calls).toContain(`up ${api.devspaceImage} --remove-existing-container`);
    expect(h.helper.calls).toContain(`up ${web.devspaceImage} --remove-existing-container`);
    // The shared image keeps only its key: the open gave it no labels of a devspace.
    expect(h.docker.labelled.has(api.devspaceImage)).toBe(false);
    expect(h.docker.labelled.has(web.devspaceImage)).toBe(false);
    expect(h.logger.infos).toContain(`The prepared image ${WEB_PREPARED} of ${WEB_REPO} is a shared image: the build takes it by its image key after the pulls, when the key is the same.`);
    expect(h.logger.infos.some((line) => line.startsWith(`The devspace image ${web.devspaceImage} of ${WEB_REPO} is the shared image ${id}, which had `))).toBe(true);
    expect(tags()).toEqual([`tag ${id} ${WEB_PREPARED}`, `tag ${id} ${api.devspaceImage}`, `tag ${id} ${web.devspaceImage}`]);
    // The tags of the prepares go with the old images of each devspace at the end of its update.
    expect(h.docker.images.has(PREPARED)).toBe(false);
    expect(h.docker.images.has(WEB_PREPARED)).toBe(false);
  });

  it('the first open of another devspace takes the shared image that a prepare built: the record of the prepare vouches for it', async () => {
    await seedLabelled();
    await prepare();
    const id = (await h.docker.imageId(PREPARED))!;
    const target: RepositoryTarget = { repository: 'acme/docs', defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
    const docs = (await h.registry.get((await h.service.open(target, { progress: h.progress })).devspace.id))!.buildRecord!;
    expect(builds()).toEqual([PREPARED]);
    expect(docs.imageId).toBe(id);
    expect(tags()).toEqual([`tag ${id} ${docs.devspaceImage}`]);
  });

  it('a second prepare of the same update finds the shared image prepared already', async () => {
    await seedLabelled();
    await prepare();
    expect(await prepare()).toMatchObject({ outcome: 'skipped', detail: `the newer image is prepared already (${PREPARED})` });
    expect(builds()).toEqual([PREPARED]);
  });

  it('tags the shared image that an open built, for which its dev container vouches, and records it for the key', async () => {
    const target: RepositoryTarget = { repository: 'acme/docs', defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
    const docs = (await h.registry.get((await h.service.open(target, { progress: h.progress })).devspace.id))!.buildRecord!;
    await seedLabelled();
    const result = await prepare();
    expect(result.detail).toBe(`the newer image is the shared image ${docs.imageId} with the same inputs, tagged ${PREPARED} without a build`);
    expect(builds()).toEqual([docs.devspaceImage]);
    expect([...records.records]).toEqual([[docs.imageKey, docs.imageId]]);
  });

  it('records the shared image that it tags in place of a record of the key whose image is gone, but keeps a record of an image that stays', async () => {
    const target: RepositoryTarget = { repository: 'acme/docs', defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
    const docs = (await h.registry.get((await h.service.open(target, { progress: h.progress })).devspace.id))!.buildRecord!;
    const gone = `sha256:${'f'.repeat(64)}`;
    records.records.set(docs.imageKey!, gone);
    await seedLabelled();
    await seedLabelled(WEB_ID, WEB_REPO);
    expect((await prepare()).detail).toBe(`the newer image is the shared image ${docs.imageId} with the same inputs, tagged ${PREPARED} without a build`);
    expect([...records.records]).toEqual([[docs.imageKey, docs.imageId]]);
    // A record of another image of the key, which stays: kept, and the prepare tags that image (the record keeps it
    // vouched after the dev containers are gone), although the fake IDs make the image of acme/docs the first choice.
    const other = { name: devspaceImageName('acme/other', WEB_ID, 1), id: 'sha256:zz-other' };
    h.docker.images.add(other.name);
    h.docker.imageIds.set(other.name, other.id);
    h.docker.imageConfigs.set(other.name, { Labels: { [LABEL_IMAGE_KEY]: docs.imageKey! } });
    records.records.set(docs.imageKey!, other.id);
    expect((await prepare(WEB_ID)).detail).toBe(`the newer image is the shared image ${other.id} with the same inputs, tagged ${WEB_PREPARED} without a build`);
    expect([...records.records]).toEqual([[docs.imageKey, other.id]]);
  });

  it('prepares the image for its devspace alone when the shared image of the record cannot be tagged, and keeps the record', async () => {
    await seedLabelled();
    await seedLabelled(WEB_ID, WEB_REPO);
    await prepare();
    const id = (await h.docker.imageId(PREPARED))!;
    const key = h.docker.labelled.get(PREPARED)![LABEL_IMAGE_KEY];
    h.docker.tagImageError = new Error('the engine is busy');
    const result = await prepare(WEB_ID);
    expect(result.outcome).toBe('prepared');
    expect(h.logger.warnings).toContain(`The shared image ${id} could not be tagged ${WEB_PREPARED}: the engine is busy. The newer image is built.`);
    expect(h.logger.infos).toContain(`The prepared image ${WEB_PREPARED} of ${WEB_REPO} is not shared: the record of its key names another shared image.`);
    expect(builds()).toEqual([PREPARED, WEB_PREPARED]);
    expect(h.docker.labelled.get(WEB_PREPARED)).toHaveProperty(LABEL_PREPARED);
    expect([...records.records]).toEqual([[key, id]]);
  });

  it('records its prepared shared image for the key when it finds it prepared already and the key has no record', async () => {
    const target: RepositoryTarget = { repository: 'acme/docs', defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
    const docs = (await h.registry.get((await h.service.open(target, { progress: h.progress })).devspace.id))!.buildRecord!;
    await seedLabelled();
    await prepare();
    records.records.clear();
    expect(await prepare()).toMatchObject({ outcome: 'skipped', detail: `the newer image is prepared already (${PREPARED})` });
    expect([...records.records]).toEqual([[docs.imageKey, docs.imageId]]);
  });

  it('builds the image for its devspace alone at the open when the lockfile changed after it was read', async () => {
    await seedLabelled();
    const read = h.helper.readConfigFiles.bind(h.helper);
    let reads = 0;
    h.helper.readConfigFiles = async (p) => {
      reads += 1;
      // From the read before the key on (the first ones are the read of the configuration).
      if (reads > 1) h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT, lockfileText: '{ "features": {} }' } };
      return read(p);
    };
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    const record = (await h.registry.get(ENV_ID))!.buildRecord!;
    expect(record.imageKey).toBeUndefined();
    expect(h.logger.infos).toContain(`The devspace image of ${REPO} is not shared: its configuration or its lockfile changed since they were read.`);
    expect(h.helper.builds.at(-1)).toEqual({ imageName: record.devspaceImage, configPath: DEFAULT_CONFIG_PATH });
  });

  it('builds the image for its devspace alone at the open when the build of the key finds another lockfile', async () => {
    await seedLabelled();
    let builds = 0;
    h.helper.buildError = () => (++builds === 1 ? new CommandError('devcontainer build', LOCKFILE_CHANGED_EXIT, '', `The lockfile .devcontainer/devcontainer-lock.json ${LOCKFILE_CHANGED_TEXT}\n`) : undefined);
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    const record = (await h.registry.get(ENV_ID))!.buildRecord!;
    expect(record.imageKey).toBeUndefined();
    expect(h.logger.infos).toContain(`The devspace image of ${REPO} is not shared: its lockfile or its build context changed after it was read. It is built for the devspace alone.`);
    expect(h.helper.builds.map((build) => [build.imageName, build.lockfileText])).toEqual([
      [record.devspaceImage, null],
      [record.devspaceImage, undefined],
    ]);
    expect(h.docker.labelled.get(record.devspaceImage)).toEqual(imageRecordLabels((await h.registry.get(ENV_ID))!, { ...record, imageId: undefined } as BuildRecord));
    // Another failure of the build of the key fails the update as before.
    h.helper.buildError = () => new CommandError('devcontainer build', 2, '', 'The lockfile is longer than allowed.\n');
    expect(isLockfileChanged(h.helper.buildError('x'))).toBe(false);
  });

  it('replaces a prepared shared image of another key (here: another lockfile)', async () => {
    await seedLabelled();
    await prepare();
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT, lockfileText: '{ "features": {} }' } };
    const result = await prepare();
    expect(result.outcome).toBe('prepared');
    expect(h.logger.infos.some((line) => line.startsWith(`The older prepared image ${PREPARED} `))).toBe(true);
    expect(h.docker.log).toContain(`rmi ${PREPARED}`);
    expect(builds()).toEqual([PREPARED, PREPARED]);
    expect(records.records.size).toBe(2);
  });

  it('replaces its prepared shared image when neither a record nor a dev container vouches for it any more', async () => {
    await seedLabelled();
    await prepare();
    records.records.clear();
    const result = await prepare();
    expect(result.outcome).toBe('prepared');
    expect(h.logger.infos.some((line) => line.startsWith(`The older prepared image ${PREPARED} `))).toBe(true);
    expect(h.docker.log).toContain(`rmi ${PREPARED}`);
    expect(builds()).toEqual([PREPARED, PREPARED]);
    expect([...records.records.values()]).toEqual([(await h.docker.imageId(PREPARED))!]);
  });

  it('fails when the shared images cannot be listed, and keeps its prepared shared image (tried again at the next pass)', async () => {
    await seedLabelled();
    await prepare();
    const id = (await h.docker.imageId(PREPARED))!;
    h.docker.imagesByLabelError = new Error('the engine is busy');
    expect(await prepare()).toMatchObject({ outcome: 'failed', detail: 'the engine is busy' });
    expect(builds()).toEqual([PREPARED]);
    expect(await h.docker.imageId(PREPARED)).toBe(id);
    expect(h.docker.log).not.toContain(`rmi ${PREPARED}`);
  });

  it('builds the image for its devspace alone without the records, or when its record cannot be written', async () => {
    await seedLabelled();
    await seedLabelled(WEB_ID, WEB_REPO);
    expect((await prepare(ENV_ID, false)).outcome).toBe('prepared');
    const key: PrepareKey = { configPath: DEFAULT_CONFIG_PATH, configHash: configHash(DEFAULT_CONFIG_TEXT), images: { [BASE_IMAGE]: DIGEST_NEW }, features: { [FEATURE]: FEATURE_DIGEST } };
    const own = preparedImageLabels({ id: ENV_ID, repository: REPO, owner: ACCOUNT }, { key, helperImage: h.helper.currentHelperImageId });
    expect(h.docker.labelled.get(PREPARED)).toEqual(own);
    records.failWrite = true;
    expect((await prepare(WEB_ID)).outcome).toBe('prepared');
    expect(builds()).toEqual([PREPARED, WEB_PREPARED]);
    // Its key stays under the labels of its devspace, which no other devspace takes as a shared image.
    const labels = await h.docker.imageLabels(WEB_PREPARED);
    expect(labels).toMatchObject({ [LABEL_IMAGE_KEY]: expect.any(String), [LABEL_PREPARED]: expect.any(String) });
    expect(h.logger.infos).toContain(`The prepared image ${WEB_PREPARED} of ${WEB_REPO} is not shared: its record could not be written.`);
    // Its own open takes it, as a prepared image of its devspace.
    await h.service.openDevspace(WEB_ID, { progress: h.progress });
    expect(builds()).toEqual([PREPARED, WEB_PREPARED]);
    expect(h.docker.labelled.get(devspaceImageName(WEB_REPO, WEB_ID, 2))?.[LABEL_PREPARED]).toBe('');
  });

  it('builds the image for its devspace alone when the build gives no shared image (here: a lockfile that cannot be read)', async () => {
    await seedLabelled();
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT, lockfileUnreadable: true } };
    expect((await prepare()).outcome).toBe('prepared');
    expect(h.docker.labelled.get(PREPARED)).toHaveProperty(LABEL_PREPARED);
    expect(h.docker.labelled.get(PREPARED)).not.toHaveProperty(LABEL_IMAGE_KEY);
    expect(records.records.size).toBe(0);
  });
});

describe('the open of a prepared shared image', () => {
  it('does not take it without the record of its prepare or a dev container (its key label and its tag are not enough)', async () => {
    await seedLabelled();
    await prepare();
    const key = h.docker.labelled.get(PREPARED)![LABEL_IMAGE_KEY];
    records.records.clear();
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    expect(h.logger.infos).toContain(`No shared image has the key ${key} of ${REPO}. The devspace image is built, as a shared image.`);
    expect(builds()).toEqual([PREPARED, devspaceImageName(REPO, ENV_ID, 2)]);
    expect(tags()).toEqual([]);
  });

  it('does not take it for another key: its inputs are not those of the update', async () => {
    await seedLabelled();
    await prepare();
    const key = h.docker.labelled.get(PREPARED)![LABEL_IMAGE_KEY];
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT, lockfileText: '{ "features": {} }' } };
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    const record = (await h.registry.get(ENV_ID))!.buildRecord!;
    expect(record.imageKey).not.toBe(key);
    expect(h.logger.infos).toContain(`No shared image has the key ${record.imageKey} of ${REPO}. The devspace image is built, as a shared image.`);
    expect(builds()).toEqual([PREPARED, devspaceImageName(REPO, ENV_ID, 2)]);
    // The build takes our copy of the configuration and the lockfile of its key.
    expect(h.helper.builds[1]).toMatchObject({ lockfileText: '{ "features": {} }' });
  });

  it('prepares the image for its devspace alone when the build record of the open would not fit on its dev container; the open takes it', async () => {
    // Features whose old build record just fits on the image, and the new one with its key does not.
    const configOf = (padding: number) => {
      const names = [...Array.from({ length: 60 }, (_, index) => `ghcr.io/acme/features/feature-number-${index}:1`), `ghcr.io/acme/features/${'p'.repeat(padding)}:1`];
      const features = Object.fromEntries(names.map((name) => [name, {}]));
      const text = JSON.stringify({ image: BASE_IMAGE, features });
      const record: BuildRecord = {
        builtAt: '2026-09-20T10:00:00.000Z',
        devspaceImage: devspaceImageName(REPO, ENV_ID, 1),
        buildNumber: 1,
        configPath: DEFAULT_CONFIG_PATH,
        configHash: configHash(text),
        ...OLD_RECORD,
        features: Object.fromEntries(names.map((name) => [name, DIGEST_OLD])),
      };
      return { features, text, record, length: buildRecordLabel(record).length };
    };
    const { length } = configOf(1);
    const { features, text, record: old } = configOf(1 + MAX_BUILD_RECORD_LABEL_LENGTH - 40 - length);
    expect(buildRecordLabel(old).length).toBe(MAX_BUILD_RECORD_LABEL_LENGTH - 40);
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: text } };
    h.helper.config = { ...h.helper.config, features };
    h.checker.outcome = { status: 'checked', images: { [BASE_IMAGE]: DIGEST_NEW }, features: Object.fromEntries(Object.keys(features).map((feature) => [feature, FEATURE_DIGEST])), authRequired: [], failed: [] };
    const env = await seedDevspace(h, { record: old, container: 'running' });
    const config = imageConfigWithUser('vscode');
    h.docker.imageConfigs.set(env.buildRecord!.devspaceImage, { ...config, Labels: { ...config.Labels, ...imageRecordLabels(env, env.buildRecord!) } });
    const result = await prepare();
    expect(result.outcome).toBe('prepared');
    expect(result.detail).not.toMatch(/shared/);
    expect(h.logger.infos).toContain(`The prepared image ${PREPARED} of ${REPO} is not shared: the build record of its open would not fit on its dev container.`);
    expect(h.docker.labelled.get(PREPARED)).toHaveProperty(LABEL_PREPARED);
    expect(records.records.size).toBe(0);
    await h.service.openDevspace(ENV_ID, { progress: h.progress });
    const record = (await h.registry.get(ENV_ID))!.buildRecord!;
    expect(record.imageKey).toBeUndefined();
    expect(builds()).toEqual([PREPARED]);
    expect(h.docker.labelled.get(record.devspaceImage)).toMatchObject({ ...imageRecordLabels(env, { ...record, imageId: undefined } as BuildRecord), [LABEL_PREPARED]: '' });
  });
});
