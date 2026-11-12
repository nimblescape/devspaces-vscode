// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Shared devspace images (R-DS-010): the build of a configuration with an image labels the image only with its key
// (imageKey.ts), and a build of another devspace with the same key tags that image instead of a build. The pure
// functions: imageKey.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LABEL_BUILD_RECORD, LABEL_DEVSPACE_ID, LABEL_IMAGE_KEY, LABEL_OWNER_ID, LABEL_REPOSITORY } from '../names';
import type { BuildRecord } from '../types';
import type { RepositoryTarget } from './operationBase';
import { BASE_IMAGE, DEFAULT_CONFIG_TEXT, DIGEST_NEW, FEATURE, FEATURE_DIGEST, REPO, checked, createHarness, imageConfigWithUser, type Harness } from './devspaceService.testkit';
import { DEFAULT_CONFIG_PATH } from './recordRules';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const WEB_REPO = 'acme/web';
const WEB: RepositoryTarget = { ...TARGET, repository: WEB_REPO };

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

type Extra = { forceRebuild?: boolean; configPath?: string };

function options(extra: Extra = {}) {
  return { progress: h.progress, ...extra };
}

/** Opens `target` and returns the build record of its devspace. */
async function openRecord(target: RepositoryTarget, extra: Extra = {}): Promise<BuildRecord> {
  const result = await h.service.open(target, options(extra));
  return (await h.registry.get(result.devspace.id))!.buildRecord!;
}

/** The key that the extension gave the image `tag` (labelImage). */
function keyOf(tag: string): string {
  return h.docker.labelled.get(tag)![LABEL_IMAGE_KEY];
}

/** A local image `tag` with the ID `id` and the labels `labels`. */
function addImage(tag: string, id: string, labels: Record<string, string>, createdAt = ''): void {
  h.docker.images.add(tag);
  h.docker.imageIds.set(tag, id);
  const config = imageConfigWithUser('vscode');
  h.docker.imageConfigs.set(tag, { ...config, Labels: { ...config.Labels, ...labels } });
  if (createdAt !== '') h.docker.imageCreated.set(id, createdAt);
}

const tags = () => h.docker.log.filter((line) => line.startsWith('tag '));

describe('a shared devspace image', () => {
  it('is built once: a devspace of another repository with the same inputs tags it, without a build', async () => {
    const api = await openRecord(TARGET);
    const web = await openRecord(WEB);
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([api.devspaceImage]);
    // The shared image carries only its key.
    expect(Object.keys(h.docker.labelled.get(api.devspaceImage)!)).toEqual([LABEL_IMAGE_KEY]);
    expect(h.docker.labelFilters).toEqual([`${LABEL_IMAGE_KEY}=${keyOf(api.devspaceImage)}`, `${LABEL_IMAGE_KEY}=${keyOf(api.devspaceImage)}`]);
    // The second devspace has its own tag on the same image, which its record pins.
    expect(web.devspaceImage).toMatch(/^devspaces-acme-web-/);
    expect(web.imageId).toBe(api.imageId);
    expect(tags()).toEqual([`tag ${api.imageId} ${web.devspaceImage}`]);
    expect(h.helper.ups.map((up) => up.image)).toEqual([api.devspaceImage, web.devspaceImage]);
    // Each dev container carries the build record of its own devspace.
    const records = h.helper.ups.map((up) => (up.override.runArgs as string[]).find((arg) => arg.startsWith(`${LABEL_BUILD_RECORD}=`)));
    const parsed = records.map((label) => JSON.parse(label!.slice(LABEL_BUILD_RECORD.length + 1)) as BuildRecord);
    expect(parsed.map((record) => record.devspaceImage)).toEqual([api.devspaceImage, web.devspaceImage]);
    // Each record names the key: the dev containers vouch for the shared image (isSharedImage).
    expect(parsed.map((record) => record.imageKey)).toEqual([keyOf(api.devspaceImage), keyOf(api.devspaceImage)]);
    expect([api.imageKey, web.imageKey]).toEqual([keyOf(api.devspaceImage), keyOf(api.devspaceImage)]);
    expect(h.logger.infos).toContain(
      `The devspace image ${web.devspaceImage} of ${WEB_REPO} is the shared image ${api.imageId}, which had 1 tag: its inputs are the same, so it is not built.`,
    );
    expect(h.ui.warnings).toEqual([]);
  });

  it('is shared also when the configurations differ only in properties that are not in the image (here: name)', async () => {
    const api = await openRecord(TARGET);
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT.replace('{', '{ "name": "Web",') } };
    h.helper.config = { ...h.helper.config, name: 'Web' };
    const web = await openRecord(WEB);
    expect(h.helper.builds).toHaveLength(1);
    expect(web.imageId).toBe(api.imageId);
  });

  it('is not taken by a configuration that differs in a property of the image: that one builds its own shared image', async () => {
    const api = await openRecord(TARGET);
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT.replace('{', '{ "containerEnv": { "A": "1" },') } };
    h.helper.config = { ...h.helper.config, containerEnv: { A: '1' } };
    const web = await openRecord(WEB);
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([api.devspaceImage, web.devspaceImage]);
    expect(tags()).toEqual([]);
    expect(keyOf(web.devspaceImage)).not.toBe(keyOf(api.devspaceImage));
  });

  it('is not taken by the same configuration with another lockfile, and not built with a lockfile that cannot be read', async () => {
    const api = await openRecord(TARGET);
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT, lockfileText: '{ "features": {} }' } };
    const web = await openRecord(WEB);
    expect(keyOf(web.devspaceImage)).not.toBe(keyOf(api.devspaceImage));
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT, lockfileUnreadable: true } };
    const other = await openRecord({ ...TARGET, repository: 'acme/docs' });
    expect(h.helper.builds).toHaveLength(3);
    expect(tags()).toEqual([]);
    expect(Object.keys(h.docker.labelled.get(other.devspaceImage)!)).toContain(LABEL_BUILD_RECORD);
    expect(h.logger.infos).toContain('The devspace image of acme/docs is not shared: its lockfile cannot be read.');
  });

  it('is neither taken nor built with the host access checks off: the devspace builds its own image with its build record', async () => {
    await openRecord(TARGET);
    h.settings = { ...h.settings, hostAccessChecksOff: [WEB_REPO] };
    const web = await openRecord(WEB);
    expect(h.helper.builds).toHaveLength(2);
    expect(h.docker.labelFilters).toHaveLength(1);
    expect(h.docker.labelled.get(web.devspaceImage)).toMatchObject({ [LABEL_BUILD_RECORD]: expect.any(String) });
    expect(h.docker.labelled.get(web.devspaceImage)).not.toHaveProperty(LABEL_IMAGE_KEY);
    expect(h.logger.infos).toContain(`The devspace image of ${WEB_REPO} is not shared: the host access checks are off for it.`);
  });

  it('is not taken by a rebuild, which builds a new shared image as the user asked, and a later build takes the newest', async () => {
    const api = await openRecord(TARGET);
    const rebuilt = await openRecord(TARGET, { forceRebuild: true });
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([api.devspaceImage, rebuilt.devspaceImage]);
    expect(keyOf(rebuilt.devspaceImage)).toBe(keyOf(api.devspaceImage));
    // The rebuild did not look for a shared image.
    expect(h.docker.labelFilters).toHaveLength(1);
    // An older image of the same key (of another devspace) and the rebuilt one: the newest is taken.
    addImage('devspaces-acme-old-config-curious-hopper:4', `sha256:${'0'.repeat(64)}`, { [LABEL_IMAGE_KEY]: keyOf(api.devspaceImage) }, '2026-01-01T00:00:00Z');
    h.docker.imageCreated.set(rebuilt.imageId!, '2026-11-12T10:00:00Z');
    const web = await openRecord(WEB);
    expect(web.imageId).toBe(rebuilt.imageId);
  });

  it('is only an image with the key, none of the labels of a devspace, and the tag of a devspace image', async () => {
    const api = await openRecord(TARGET);
    const key = keyOf(api.devspaceImage);
    // The shared image is gone; images with the key that are no shared images remain.
    h.docker.images.delete(api.devspaceImage);
    addImage('devspaces-acme-old-config-curious-hopper:2', `sha256:${'1'.repeat(64)}`, { [LABEL_IMAGE_KEY]: key, [LABEL_DEVSPACE_ID]: 'other' });
    addImage('acme/devspaces-x-config-curious-hopper:3', `sha256:${'2'.repeat(64)}`, { [LABEL_IMAGE_KEY]: key });
    addImage('devspaces-acme-old-config-curious-hopper:prepared', `sha256:${'3'.repeat(64)}`, { [LABEL_IMAGE_KEY]: key });
    const web = await openRecord(WEB);
    expect(tags()).toEqual([]);
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([api.devspaceImage, web.devspaceImage]);
    expect(h.logger.infos).toContain(`No shared image has the key ${key} of ${WEB_REPO}. The devspace image is built, as a shared image.`);
  });

  it('is taken only when a dev container of the extension was created from it with its key, not by its label alone', async () => {
    const api = await openRecord(TARGET);
    const key = keyOf(api.devspaceImage);
    // The dev container of the first devspace is gone; an image with the key and the tag of a devspace image, as the
    // Dockerfile of another repository could write it, has none either.
    h.docker.containers.clear();
    addImage('devspaces-acme-old-config-curious-hopper:2', `sha256:${'4'.repeat(64)}`, { [LABEL_IMAGE_KEY]: key }, '2027-01-01T00:00:00Z');
    const web = await openRecord(WEB);
    expect(tags()).toEqual([]);
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([api.devspaceImage, web.devspaceImage]);
    expect(web.imageKey).toBe(key);
  });

  it('is taken by a rebuild for another configuration, which the user did not ask for as a rebuild', async () => {
    const api = await openRecord(TARGET);
    const config = h.helper.config;
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT.replace('{', '{ "containerEnv": { "A": "1" },') } };
    h.helper.config = { ...config, containerEnv: { A: '1' } };
    await openRecord(WEB);
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: DEFAULT_CONFIG_TEXT } };
    h.helper.config = config;
    const web = await openRecord(WEB, { configPath: DEFAULT_CONFIG_PATH });
    expect(h.helper.builds).toHaveLength(2);
    expect(web.imageId).toBe(api.imageId);
  });

  it('is built when its tag fails, and the tag is removed again', async () => {
    const api = await openRecord(TARGET);
    h.docker.tagImageError = new Error('engine busy');
    const web = await openRecord(WEB);
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([api.devspaceImage, web.devspaceImage]);
    expect(h.docker.log).toContain(`rmi ${web.devspaceImage}`);
    expect(h.logger.warnings).toContain(`The shared image ${api.imageId} could not be tagged ${web.devspaceImage}: engine busy. The devspace image is built.`);
  });

  it('keeps its other tags when the start of a devspace that tagged it fails: only that tag goes', async () => {
    const api = await openRecord(TARGET);
    h.helper.upError = (image) => (image.startsWith('devspaces-acme-web-') ? new Error('up failed') : undefined);
    await expect(h.service.open(WEB, options())).rejects.toThrow();
    // The first open of the second devspace failed (its entry is gone): its tag names it.
    const [line] = tags();
    const webImage = line.split(' ')[2];
    expect(line).toBe(`tag ${api.imageId} ${webImage}`);
    expect(webImage).toMatch(/^devspaces-acme-web-[a-z0-9-]+:1$/);
    expect(h.docker.log).toContain(`rmi ${webImage}`);
    expect(h.docker.images.has(api.devspaceImage)).toBe(true);
  });

  it('is not built from the image of a devspace, whose labels of that devspace would stay on an image with only the key', async () => {
    const config = imageConfigWithUser('vscode');
    const inherited = { [LABEL_DEVSPACE_ID]: 'other', [LABEL_REPOSITORY]: 'acme/other', [LABEL_OWNER_ID]: '1' };
    h.docker.imageConfigs.set(BASE_IMAGE, { ...config, Labels: { ...config.Labels, ...inherited } });
    // The built image inherits them; the labels of this devspace go over them.
    h.helper.buildLabels = inherited;
    const result = await h.service.open(TARGET, options());
    const api = (await h.registry.get(result.devspace.id))!.buildRecord!;
    expect(h.docker.labelFilters).toEqual([]);
    expect(api.imageKey).toBeUndefined();
    expect(h.logger.infos).toContain(`The devspace image of ${REPO} is not shared: its image ${BASE_IMAGE} was built for one devspace.`);
    expect(h.docker.labelled.get(api.devspaceImage)).toMatchObject({ [LABEL_DEVSPACE_ID]: result.devspace.id, [LABEL_REPOSITORY]: REPO, [LABEL_BUILD_RECORD]: expect.any(String) });
    expect(h.docker.labelled.get(api.devspaceImage)).not.toHaveProperty(LABEL_IMAGE_KEY);
  });

  it('is not built when the build record does not fit on the dev container, which then could not vouch for it', async () => {
    const features = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`ghcr.io/acme/features/feature-number-${index}:1`, {}]));
    h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText: JSON.stringify({ image: BASE_IMAGE, features }) } };
    h.helper.config = { ...h.helper.config, features };
    h.checker.outcome = checked({ [BASE_IMAGE]: DIGEST_NEW }, Object.fromEntries(Object.keys(features).map((feature) => [feature, FEATURE_DIGEST])));
    const api = await openRecord(TARGET);
    expect(api.imageKey).toBeUndefined();
    expect(h.logger.infos).toContain(`The devspace image of ${REPO} is not shared: its build record does not fit on its dev container.`);
    expect(h.docker.labelled.get(api.devspaceImage)).not.toHaveProperty(LABEL_IMAGE_KEY);
  });

  it('needs the digest of each Feature from the registry in this open, and the image on the engine', async () => {
    h.checker.outcome = { status: 'checked', images: { [BASE_IMAGE]: `sha256:${'b'.repeat(64)}` }, features: {}, authRequired: [], failed: [FEATURE] };
    await openRecord(TARGET);
    expect(h.logger.infos).toContain(`The devspace image of ${REPO} is not shared: the digest of its Feature ${FEATURE} is not known in this open.`);
    expect(h.docker.labelFilters).toEqual([]);
  });
});
