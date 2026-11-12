// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Shared devspace images built from a Dockerfile (R-DS-010): the key holds the text of the Dockerfile, its path in the
// build context and the hash of the build context (read again before the key, READ_FILES_SCRIPT), and the build reads a
// checked copy of the build context (WRITE_AND_RUN_SCRIPT), never the folder of the repository. The shared images of a
// configuration with an image: devspaceService.sharedImage.test.ts; the rules of the key: imageKey.test.ts; the hash
// and the copy: scripts.contextTree.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandError } from '../errors';
import { CONTEXT_COPY_FOLDER, LOCKFILE_CHANGED_EXIT, LOCKFILE_CHANGED_TEXT } from '../helper/scripts';
import { LABEL_BUILD_RECORD, LABEL_IMAGE_KEY } from '../names';
import type { BuildRecord } from '../types';
import type { RepositoryTarget } from './operationBase';
import {
  BASE_IMAGE,
  DIGEST_OLD,
  ENV_ID,
  FAKE_CONTEXT_HASH,
  REPO,
  createHarness,
  fakeSharedImageRecords,
  headlessPrepareService,
  imageConfigWithUser,
  prepareRun,
  seedDevspace,
  type Harness,
} from './devspaceService.testkit';
import { imageRecordLabels } from './imageRecord';
import { configHash } from './pipelineRules';
import { DEFAULT_CONFIG_PATH } from './recordRules';
import { preparedImageName } from '../names';

const TARGET: RepositoryTarget = { repository: REPO, defaultBranch: 'main', configPaths: [DEFAULT_CONFIG_PATH], trusted: true };
const WEB_REPO = 'acme/web';
const WEB: RepositoryTarget = { ...TARGET, repository: WEB_REPO };
const DOCKERFILE = `FROM ${BASE_IMAGE}\nRUN echo ready\n`;

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

/** The configuration `configText` (resolved: `config`) with the Dockerfile `text` at `.devcontainer/Dockerfile`. */
function useDockerfile(
  text = DOCKERFILE,
  configText = '{ "build": { "dockerfile": "Dockerfile" } }',
  config: Record<string, unknown> = { build: { dockerfile: 'Dockerfile' } },
): void {
  h.helper.config = config;
  h.helper.files = { [DEFAULT_CONFIG_PATH]: { configText, dockerfilePath: '.devcontainer/Dockerfile', dockerfileText: text } };
}

/** Opens `target` and returns the build record of its devspace. */
async function openRecord(target: RepositoryTarget): Promise<BuildRecord> {
  const result = await h.service.open(target, { progress: h.progress });
  return (await h.registry.get(result.devspace.id))!.buildRecord!;
}

/** The key that the extension gave the image `tag` (labelImage). */
const keyOf = (tag: string): string => h.docker.labelled.get(tag)![LABEL_IMAGE_KEY];
const tags = () => h.docker.log.filter((line) => line.startsWith('tag '));

describe('a shared devspace image built from a Dockerfile', () => {
  beforeEach(() => useDockerfile());

  it('is built from a copy of its build context with the hash of its key, and only carries its key', async () => {
    const api = await openRecord(TARGET);
    // The read again before the key, with the Dockerfile that the resolved configuration names and the hash of the build
    // context (the folder of the Dockerfile, as the Dev Container CLI takes it without build.context).
    expect(h.helper.dockerfileReads).toEqual(['Dockerfile']);
    expect(h.helper.contextReads).toEqual(['.devcontainer']);
    // Our copy of the configuration names the copy of the build context and the Dockerfile in it.
    expect(h.helper.builds).toEqual([
      {
        imageName: api.devspaceImage,
        configPath: DEFAULT_CONFIG_PATH,
        override: { build: { dockerfile: `${CONTEXT_COPY_FOLDER}/Dockerfile`, context: CONTEXT_COPY_FOLDER } },
        lockfileText: null,
        context: { path: '.devcontainer', hash: FAKE_CONTEXT_HASH, dockerfile: 'Dockerfile' },
      },
    ]);
    expect(Object.keys(h.docker.labelled.get(api.devspaceImage)!)).toEqual([LABEL_IMAGE_KEY]);
    expect(api.imageKey).toBe(keyOf(api.devspaceImage));
  });

  it('is tagged by a devspace of another repository with the same Dockerfile and the same build context, without a build', async () => {
    const api = await openRecord(TARGET);
    const web = await openRecord(WEB);
    expect(h.helper.builds.map((build) => build.imageName)).toEqual([api.devspaceImage]);
    expect(web.imageId).toBe(api.imageId);
    expect(web.imageKey).toBe(api.imageKey);
    expect(tags()).toEqual([`tag ${api.imageId} ${web.devspaceImage}`]);
  });

  it('is not taken by a devspace whose build context differs (another hash): it builds its own shared image', async () => {
    const api = await openRecord(TARGET);
    h.helper.contextHashes = { '.devcontainer': `sha256:${'d'.repeat(64)}` };
    const web = await openRecord(WEB);
    expect(h.helper.builds.map((build) => [build.imageName, build.context?.hash])).toEqual([
      [api.devspaceImage, FAKE_CONTEXT_HASH],
      [web.devspaceImage, `sha256:${'d'.repeat(64)}`],
    ]);
    expect(tags()).toEqual([]);
    expect(keyOf(web.devspaceImage)).not.toBe(keyOf(api.devspaceImage));
  });

  it('is not taken by a devspace whose Dockerfile differs: it builds its own shared image', async () => {
    const api = await openRecord(TARGET);
    useDockerfile(`${DOCKERFILE}RUN echo more\n`);
    const web = await openRecord(WEB);
    expect(h.helper.builds).toHaveLength(2);
    expect(keyOf(web.devspaceImage)).not.toBe(keyOf(api.devspaceImage));
  });

  it('names the copy in place of the older dockerFile and context, with the build context of the repository folder', async () => {
    useDockerfile(DOCKERFILE, '{ "dockerFile": "Dockerfile", "context": "..", "remoteUser": "vscode" }', { dockerFile: 'Dockerfile', context: '..', remoteUser: 'vscode' });
    const api = await openRecord(TARGET);
    expect(h.helper.contextReads).toEqual(['.']);
    expect(h.helper.builds).toEqual([
      {
        imageName: api.devspaceImage,
        configPath: DEFAULT_CONFIG_PATH,
        override: { remoteUser: 'vscode', build: { context: CONTEXT_COPY_FOLDER, dockerfile: `${CONTEXT_COPY_FOLDER}/.devcontainer/Dockerfile` } },
        lockfileText: null,
        context: { path: '.', hash: FAKE_CONTEXT_HASH, dockerfile: '.devcontainer/Dockerfile' },
      },
    ]);
  });

  it('is not shared when its build context cannot be hashed: the devspace builds its own image from the repository', async () => {
    h.helper.contextUnhashable = 'it has more than 10000 files, folders and links';
    const api = await openRecord(TARGET);
    expect(h.helper.builds).toEqual([{ imageName: api.devspaceImage, configPath: DEFAULT_CONFIG_PATH }]);
    expect(api.imageKey).toBeUndefined();
    expect(h.docker.labelled.get(api.devspaceImage)).toMatchObject({ [LABEL_BUILD_RECORD]: expect.any(String) });
    expect(h.logger.infos).toContain(
      `The devspace image of ${REPO} is not shared: its build context .devcontainer cannot be part of the key: it has more than 10000 files, folders and links.`,
    );
  });

  it('is not shared when its Dockerfile uses what the key cannot name (here: a secret)', async () => {
    useDockerfile(`FROM ${BASE_IMAGE}\nRUN --mount=type=secret,id=npm cat /run/secrets/npm\n`);
    const api = await openRecord(TARGET);
    expect(h.helper.builds).toEqual([{ imageName: api.devspaceImage, configPath: DEFAULT_CONFIG_PATH }]);
    expect(h.helper.contextReads).toEqual([]);
    expect(h.logger.infos).toContain(`The devspace image of ${REPO} is not shared: its Dockerfile has a RUN that mounts a secret.`);
  });

  it('is not shared when the Dockerfile changed after the read of the update check', async () => {
    const read = h.helper.readConfigFiles.bind(h.helper);
    h.helper.readConfigFiles = async (p) => {
      // The read again before the key finds another Dockerfile.
      if (p.context !== undefined) useDockerfile(`${DOCKERFILE}RUN echo changed\n`);
      return read(p);
    };
    const api = await openRecord(TARGET);
    expect(api.imageKey).toBeUndefined();
    expect(h.helper.builds.map((build) => build.context)).toEqual([undefined]);
    expect(h.logger.infos).toContain(`The devspace image of ${REPO} is not shared: its configuration, its Dockerfile or its lockfile changed since they were read.`);
  });

  it('is built for the devspace alone when its build context changed after the read of the key', async () => {
    let builds = 0;
    h.helper.buildError = () =>
      ++builds === 1 ? new CommandError('devcontainer build', LOCKFILE_CHANGED_EXIT, '', `The build context .devcontainer ${LOCKFILE_CHANGED_TEXT} (the file Dockerfile changed while it was read)\n`) : undefined;
    const api = await openRecord(TARGET);
    expect(api.imageKey).toBeUndefined();
    expect(h.helper.builds.map((build) => [build.override !== undefined, build.context?.path])).toEqual([
      [true, '.devcontainer'],
      [false, undefined],
    ]);
    expect(h.docker.labelled.get(api.devspaceImage)).toMatchObject({ [LABEL_BUILD_RECORD]: expect.any(String) });
    expect(h.docker.labelled.get(api.devspaceImage)).not.toHaveProperty(LABEL_IMAGE_KEY);
    expect(h.logger.infos).toContain(`The devspace image of ${REPO} is not shared: its lockfile or its build context changed after it was read. It is built for the devspace alone.`);
  });
});

describe('the prepare of a shared devspace image built from a Dockerfile', () => {
  const WEB_ID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
  const CONFIG_TEXT = '{ "build": { "dockerfile": "Dockerfile" } }';
  let records: ReturnType<typeof fakeSharedImageRecords>;

  beforeEach(() => {
    h.cleanup();
    records = fakeSharedImageRecords();
    h = createHarness({ sharedImageRecords: records });
    useDockerfile(DOCKERFILE, CONFIG_TEXT);
  });

  /** A devspace of the Dockerfile with an older base image, whose image carries its build record. */
  async function seed(id: string, repository: string): Promise<void> {
    const env = await seedDevspace(h, {
      id,
      repository,
      record: { configHash: configHash(CONFIG_TEXT, DOCKERFILE), images: { [BASE_IMAGE]: DIGEST_OLD }, features: {} },
      container: 'running',
    });
    const record = env.buildRecord as BuildRecord;
    const config = imageConfigWithUser('vscode');
    h.docker.imageConfigs.set(record.devspaceImage, { ...config, Labels: { ...config.Labels, ...imageRecordLabels(env, record) } });
  }

  async function prepare(id: string) {
    const { service } = headlessPrepareService(h, { sharedImageRecords: records });
    return service.prepare(id, prepareRun().run);
  }

  it('builds the newer image from a copy of its build context; the prepare of another devspace tags it', async () => {
    await seed(ENV_ID, REPO);
    await seed(WEB_ID, WEB_REPO);
    const prepared = preparedImageName(REPO, ENV_ID);
    expect((await prepare(ENV_ID)).outcome).toBe('prepared');
    // A prepare builds with the configuration of its key (our copy), never with --frozen-lockfile.
    expect(h.helper.builds).toEqual([
      {
        imageName: prepared,
        configPath: DEFAULT_CONFIG_PATH,
        override: { build: { dockerfile: `${CONTEXT_COPY_FOLDER}/Dockerfile`, context: CONTEXT_COPY_FOLDER } },
        lockfileText: null,
        context: { path: '.devcontainer', hash: FAKE_CONTEXT_HASH, dockerfile: 'Dockerfile' },
      },
    ]);
    expect(Object.keys(h.docker.labelled.get(prepared)!)).toEqual([LABEL_IMAGE_KEY]);
    const id = (await h.docker.imageId(prepared))!;
    expect(await prepare(WEB_ID)).toMatchObject({ outcome: 'prepared' });
    expect(h.helper.builds).toHaveLength(1);
    expect(tags()).toEqual([`tag ${id} ${preparedImageName(WEB_REPO, WEB_ID)}`]);
  });

  it('records no failure when the build context changed after the read of the key: the next pass tries again', async () => {
    await seed(ENV_ID, REPO);
    h.helper.buildError = () => new CommandError('devcontainer build', LOCKFILE_CHANGED_EXIT, '', `The build context .devcontainer ${LOCKFILE_CHANGED_TEXT}\n`);
    const { run, recorded } = prepareRun();
    const { service } = headlessPrepareService(h, { sharedImageRecords: records });
    expect((await service.prepare(ENV_ID, run)).outcome).toBe('failed');
    expect(h.helper.builds.map((build) => build.context?.path)).toEqual(['.devcontainer']);
    expect(recorded).toEqual([]);
    expect(records.records.size).toBe(0);
  });
});
