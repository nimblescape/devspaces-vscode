// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Refresh of the workspace helper image against the real Docker engine and the real registry, with a tiny helper
// Dockerfile of this run (so its own tag). The windows remove no helper image (the cleanup of the Monitor does:
// test/docker/engineCleanup.test.ts). The helper image of a window is HelperImages' (the extension's), so the tests use
// it directly.
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The Docker CLI of the extension (BootstrapDocker).
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import {
  HELPER_CHECK_INTERVAL_MS,
  helperImageTag,
  registryBaseDigest,
  type BaseDigestLookup,
} from '../../src/core/helper/helperImage';
import { readHelperState, updateHelperState } from '../../src/core/helper/helperState';
import { HelperImages, type HelperImageDocker } from '../../src/core/helper/helperImages';
import { ImageChecker } from '../../src/core/imageCheck/imageCheck';
import { LABEL_HELPER, LABEL_HELPER_BASE_DIGEST } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { Timings, dockerTestContext, registryClient, registryDigest, registryTransport } from './harness';

const DAY_MS = 24 * 60 * 60 * 1000;
const FAKE_DIGEST = `sha256:${'0'.repeat(64)}`;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** The real BootstrapDocker, which records the builds. The Docker port of HelperImages. */
class RecordingDocker implements HelperImageDocker {
  readonly builds: Array<{ tag: string; pull: boolean; noCache: boolean }> = [];

  constructor(private readonly docker: BootstrapDocker) {}

  imageExists(reference: string): Promise<boolean> {
    return this.docker.imageExists(reference);
  }

  imageId(reference: string): Promise<string | undefined> {
    return this.docker.imageId(reference);
  }

  async buildImage(options: Parameters<BootstrapDocker['buildImage']>[0]): Promise<string | undefined> {
    this.builds.push({ tag: options.tag, pull: options.pull === true, noCache: options.noCache === true });
    // The ID of the built image (found by its build label).
    return this.docker.buildImage(options);
  }
}

describe('workspace helper image: weekly refresh', () => {
  const { run, env, cli, log } = dockerTestContext('helperImage');
  const runner = new NodeProcessRunner();
  const docker = new RecordingDocker(new BootstrapDocker(runner, run.dockerPath, env, log));
  const client = registryClient(registryTransport, runner, env, log);
  const digestChecker = new ImageChecker(client, log);
  const lookUp = registryBaseDigest(client);
  const lookups: string[] = [];
  const baseDigest: BaseDigestLookup = (reference, signal) => {
    lookups.push(reference);
    return lookUp(reference, signal);
  };
  const dockerfilePath = path.join(run.runDir, 'tiny-helper', 'Dockerfile');
  // The label makes the tag unique to the run; RUN gives each build without cache a new image.
  const dockerfile = [`FROM ${TEST_BASE_IMAGE}`, 'RUN date > /built-at', `LABEL ${TEST_RUN_LABEL}=${run.runId}`, ''].join('\n');
  const tag = helperImageTag(dockerfile);
  const statePath = path.join(run.runDir, 'helper-state', 'helper.json');
  const timings = new Timings();
  let userHelperImages: string[] = [];
  /** Checks of the base image that the helpers started in the background. */
  const checks: Array<Promise<void>> = [];

  /** The helper image of a new window (HelperImages): nothing cached. */
  function newWindowHelper(): HelperImages {
    return new HelperImages({ docker, logger: log, dockerfilePath, statePath, baseDigest, onBaseImageCheck: (check) => checks.push(check) });
  }

  /** Waits for the checks of the base image in the background. */
  async function settled(): Promise<void> {
    await Promise.all(checks.splice(0));
  }

  /** IDs of the helper images that are not images of this run. */
  function otherHelperImages(): string[] {
    const own = new Set(cli.lines(['image', 'ls', '-a', '-q', '--no-trunc', '--filter', `label=${TEST_RUN_LABEL}=${run.runId}`]));
    const helpers = cli.lines(['image', 'ls', '-a', '-q', '--no-trunc', '--filter', `label=${LABEL_HELPER}=true`]);
    return [...new Set(helpers.filter((id) => !own.has(id)))].sort();
  }

  beforeAll(() => {
    fs.mkdirSync(path.dirname(dockerfilePath), { recursive: true });
    fs.writeFileSync(dockerfilePath, dockerfile);
    userHelperImages = otherHelperImages();
  });

  afterAll(() => {
    timings.print(`Timings of the helper image scenarios (${tag}):`);
    removeRunObjects(cli, run.runId);
    expect(cli.image(tag)).toBeUndefined();
    expect(otherHelperImages()).toEqual(userHelperImages);
  });

  it('a missing tag is built with --pull, and the digest of its base image is recorded', async () => {
    const started = Date.now();
    expect((await timings.measure('first build (--pull)', () => newWindowHelper().ensureImageUse())).tag).toBe(tag);

    expect(docker.builds).toEqual([{ tag, pull: true, noCache: false }]);
    expect(lookups).toEqual([TEST_BASE_IMAGE]);
    // The digest of the base image that the build pulled, which the Monitor compares (src/remoteMonitor/helperRefresh.ts).
    expect(cli.image(tag)?.Config.Labels).toMatchObject({
      [LABEL_HELPER]: 'true',
      [LABEL_HELPER_BASE_DIGEST]: await registryDigest(digestChecker, TEST_BASE_IMAGE),
      [TEST_RUN_LABEL]: run.runId,
    });
    const state = await readHelperState(statePath);
    expect(state.images[tag]).toMatchObject({
      baseImage: TEST_BASE_IMAGE,
      baseDigest: await registryDigest(digestChecker, TEST_BASE_IMAGE),
    });
    for (const time of [state.images[tag]?.builtAt, state.images[tag]?.checkedAt, state.images[tag]?.lastUsedAt]) {
      expect(Date.parse(time ?? '')).toBeGreaterThanOrEqual(started - 1000);
    }
    // The windows run no cleanup any more.
    expect(state.lastCleanupAt).toBeUndefined();
  });

  it('another window uses the image without a check and without a build', async () => {
    const imageId = cli.image(tag)?.Id;
    const state = await readHelperState(statePath);
    await timings.measure('ensure in a new window (nothing due)', () => newWindowHelper().ensureImageUse());

    expect(docker.builds).toHaveLength(1);
    expect(lookups).toHaveLength(1);
    expect(cli.image(tag)?.Id).toBe(imageId);
    expect(await readHelperState(statePath)).toEqual(state);
  });

  it('a changed digest of the base image rebuilds the same tag with --pull --no-cache at the next open, and keeps the previous image for the Monitor', async () => {
    const previousId = cli.image(tag)?.Id;
    expect(previousId).toBeDefined();
    await updateHelperState(statePath, (state) => {
      state.images[tag] = { ...state.images[tag], baseDigest: FAKE_DIGEST, checkedAt: ago(HELPER_CHECK_INTERVAL_MS + DAY_MS) };
    });
    // The weekly check runs in the background: the open does not wait for it, and it asks the next open for a rebuild.
    await timings.measure('weekly check, base image changed (in the background)', async () => {
      await newWindowHelper().ensureImageUse();
      await settled();
    });
    expect(docker.builds).toHaveLength(1);
    expect(lookups).toHaveLength(2);
    expect((await readHelperState(statePath)).images[tag]?.latestBaseDigest).toBe(await registryDigest(digestChecker, TEST_BASE_IMAGE));

    const started = Date.now();
    await timings.measure('next open: rebuild (--pull --no-cache)', () => newWindowHelper().ensureImageUse());
    await settled();

    expect(docker.builds).toEqual([
      { tag, pull: true, noCache: false },
      { tag, pull: true, noCache: true },
    ]);
    expect(lookups).toHaveLength(2);
    const currentId = cli.image(tag)?.Id;
    expect(currentId).toBeDefined();
    expect(currentId).not.toBe(previousId);
    expect(cli.image(tag)?.Config.Labels?.[LABEL_HELPER_BASE_DIGEST]).toBe(await registryDigest(digestChecker, TEST_BASE_IMAGE));
    // The windows remove no helper image: with the classic image store, the previous image stays without a tag, for the
    // cleanup of the Monitor (afterAll removes it with the objects of the run); the containerd image store removes it
    // itself when the tag moves.
    expect(cli.image(previousId!)?.RepoTags ?? []).toEqual([]);
    const record = (await readHelperState(statePath)).images[tag];
    expect(record?.baseDigest).toBe(await registryDigest(digestChecker, TEST_BASE_IMAGE));
    expect(record?.latestBaseDigest).toBeUndefined();
    expect(Date.parse(record?.builtAt ?? '')).toBeGreaterThanOrEqual(started - 1000);
    expect(Date.parse(record?.checkedAt ?? '')).toBeGreaterThanOrEqual(started - 1000);
  });

  it('a new tag that cannot be built fails with helperFailed and uses no other helper image', async () => {
    // No previous helper image: the helper image that this run built is not used in place of the new tag. The helper
    // Dockerfile of an "extension update" whose build fails (as offline), in its own folder, so its tag differs from
    // `tag`.
    const updatedPath = path.join(run.runDir, 'tiny-helper-update', 'Dockerfile');
    const updated = [`FROM ${TEST_BASE_IMAGE}`, 'RUN exit 1', `LABEL ${TEST_RUN_LABEL}=${run.runId}`, ''].join('\n');
    fs.mkdirSync(path.dirname(updatedPath), { recursive: true });
    fs.writeFileSync(updatedPath, updated);
    const updatedTag = helperImageTag(updated);
    expect(updatedTag).not.toBe(tag);
    const currentId = cli.image(tag)?.Id;
    expect((await readHelperState(statePath)).images[tag]?.imageId).toBe(currentId);
    // The registry is not part of this scenario: a fixed digest of the base image, so the build always starts with
    // `--pull`. A lookup that the registry does not answer in time would leave only the build without `--pull`.
    const fixedDigest: BaseDigestLookup = () => Promise.resolve(FAKE_DIGEST);
    const helper = new HelperImages({ docker, logger: log, dockerfilePath: updatedPath, statePath, baseDigest: fixedDigest, onBaseImageCheck: (check) => checks.push(check) });

    const failure = await timings.measure('failed build', () => helper.ensureImageUse().catch((error: unknown) => error));
    await settled();
    expect(failure).toMatchObject({ code: 'helperFailed' });
    expect(cli.image(updatedTag)).toBeUndefined();
    // The build with `--pull` fails, and so does the second build without it.
    expect(docker.builds.slice(-2)).toEqual([
      { tag: updatedTag, pull: true, noCache: false },
      { tag: updatedTag, pull: false, noCache: false },
    ]);
    const state = await readHelperState(statePath);
    expect(state).not.toHaveProperty('previousTag');
    expect(state.images[updatedTag]).toBeUndefined();
    expect(cli.image(tag)?.Id).toBe(currentId);
  });
});
