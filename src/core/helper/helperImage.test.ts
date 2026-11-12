// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { devcontainerCliVersion } from '../../../scripts/cliVersion.mjs';
import { CommandError } from '../errors';
import type { HttpTransport } from '../http';
import { RegistryClient, type DigestResult, IMAGE_CHECK_TIMEOUT_MS } from '../imageCheck/registryClient';
import type { ImageReference } from '../imageCheck/reference';
import { abortError, type Logger } from '../ports';
import {
  DEVCONTAINER_CLI_VERSION,
  HELPER_CHECK_INTERVAL_MS,
  HELPER_GENERATION,
  HELPER_LAST_USED_INTERVAL_MS,
  HELPER_RETRY_INTERVAL_MS,
  ensureHelperImageUse,
  helperImageTag,
  recordHelperImageUse,
  registryBaseDigest,
  type BaseDigestLookup,
  type EnsureHelperImageOptions,
  type HelperImageDocker,
} from './helperImage';
import type { HelperImageRecord, HelperState } from './helperState';

const ROOT = path.resolve(__dirname, '../../..');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function dockerfile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-test-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'Dockerfile');
  fs.writeFileSync(file, content);
  return file;
}

type BuildOptions = Parameters<HelperImageDocker['buildImage']>[0];

interface FakeImage {
  id: string;
  tags: string[];
  /** Carries the label nimblescape.devspaces.worker=true. */
  helper: boolean;
}

/** Local images by ID, with the tag and removal rules of Docker. */
class FakeDocker implements HelperImageDocker {
  readonly images = new Map<string, FakeImage>();
  readonly builds: BuildOptions[] = [];
  buildHandler: (options: BuildOptions) => Promise<void> = async () => undefined;
  imageIdError: Error | undefined;
  /**
   * The build returns the ID of its image, as BootstrapDocker.buildImage finds it by its build label; with this flag it
   * returns none (a lookup that failed).
   */
  builtIdMissing = false;
  /** Runs after a successful build (after the tag moved), before buildImage returns. */
  afterBuild: () => void = () => undefined;
  private counter = 0;

  /** Adds an image with these tags (moving them from other images, as a build does) and returns its ID. */
  addImage(tags: string[], options: { helper?: boolean } = {}): string {
    const id = `sha256:${(++this.counter).toString(16).padStart(64, '0')}`;
    for (const image of this.images.values()) image.tags = image.tags.filter((tag) => !tags.includes(tag));
    this.images.set(id, { id, tags: [...tags], helper: options.helper ?? true });
    return id;
  }

  idOf(reference: string): string | undefined {
    if (this.images.has(reference)) return reference;
    for (const image of this.images.values()) if (image.tags.includes(reference)) return image.id;
    return undefined;
  }

  async imageExists(reference: string): Promise<boolean> {
    return this.idOf(reference) !== undefined;
  }

  async imageId(reference: string): Promise<string | undefined> {
    if (this.imageIdError) throw this.imageIdError;
    return this.idOf(reference);
  }

  async buildImage(options: BuildOptions): Promise<string | undefined> {
    this.builds.push(options);
    // Docker moves the tag only after a successful build.
    await this.buildHandler(options);
    const id = this.addImage([options.tag], { helper: options.labels?.['nimblescape.devspaces.worker'] === 'true' });
    this.afterBuild();
    return this.builtIdMissing ? undefined : id;
  }
}

class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
  output(text: string): void {
    this.lines.push(`output ${text}`);
  }
}

describe('DEVCONTAINER_CLI_VERSION', () => {
  const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

  it('is the exact devDependency of package.json and the version of the installed CLI package', () => {
    expect(DEVCONTAINER_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(DEVCONTAINER_CLI_VERSION).toBe(readJson(path.join(ROOT, 'package.json')).devDependencies['@devcontainers/cli']);
    // The contract tests (devcontainerCli.contract.test.ts) check this package, so it must be the same version.
    expect(DEVCONTAINER_CLI_VERSION).toBe(readJson(path.join(ROOT, 'node_modules/@devcontainers/cli/package.json')).version);
    expect(devcontainerCliVersion()).toBe(DEVCONTAINER_CLI_VERSION);
  });

  it('must be pinned: devcontainerCliVersion refuses a missing entry and a range', () => {
    const manifest = (devDependencies?: Record<string, string>) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-test-'));
      tempDirs.push(dir);
      const file = path.join(dir, 'package.json');
      fs.writeFileSync(file, JSON.stringify({ name: 'x', devDependencies }));
      return file;
    };
    expect(devcontainerCliVersion(manifest({ '@devcontainers/cli': '0.90.1' }))).toBe('0.90.1');
    expect(() => devcontainerCliVersion(manifest())).toThrow(/"@devcontainers\/cli" with an exact version x\.y\.z.*it is missing/);
    expect(() => devcontainerCliVersion(manifest({ typescript: '5.9.3' }))).toThrow(/it is missing/);
    for (const range of ['^0.89.0', '~0.89.0', '0.89', 'latest', '>=0.89.0', '0.89.0-beta.1', '01.2.3']) {
      expect(() => devcontainerCliVersion(manifest({ '@devcontainers/cli': range }))).toThrow(`found "${range}"`);
    }
  });
});

describe('helperImageTag', () => {
  it('is devspaces-worker:<12 hex characters>', () => {
    expect(helperImageTag('FROM x\n')).toMatch(/^devspaces-worker:[0-9a-f]{12}$/);
  });

  it('depends on the Dockerfile and the CLI version, not on line endings', () => {
    const tag = helperImageTag('FROM x\nRUN y\n', '0.89.0');
    expect(helperImageTag('FROM x\nRUN y\n', '0.89.0')).toBe(tag);
    expect(helperImageTag('FROM x\r\nRUN y\r\n', '0.89.0')).toBe(tag);
    expect(helperImageTag('FROM x\nRUN z\n', '0.89.0')).not.toBe(tag);
    expect(helperImageTag('FROM x\nRUN y\n', '0.90.0')).not.toBe(tag);
    expect(helperImageTag('FROM x\nRUN y\n')).toBe(helperImageTag('FROM x\nRUN y\n', DEVCONTAINER_CLI_VERSION));
  });

  it('matches the hash of the file content plus the version plus the helper generation', () => {
    // The helper generation is part of the hash. sha256('abc' + '1' + '\ngeneration 1')
    expect(helperImageTag('abc', '1', 1)).toBe('devspaces-worker:cdcde07033de');
    expect(helperImageTag('abc', '1')).toBe(helperImageTag('abc', '1', HELPER_GENERATION));
  });

  it('changes with the helper generation, so raising it builds a new current tag', () => {
    expect(helperImageTag('FROM x\n', '0.89.0', 2)).not.toBe(helperImageTag('FROM x\n', '0.89.0', 1));
    expect(helperImageTag('FROM x\n', '0.89.0', HELPER_GENERATION + 1)).not.toBe(helperImageTag('FROM x\n', '0.89.0'));
  });
});

describe('ensureHelperImageUse', () => {
  it('builds the image when the tag is missing', async () => {
    const file = dockerfile('FROM node:22-bookworm-slim\n');
    const docker = new FakeDocker();
    const output: string[] = [];
    const { tag } = await ensureHelperImageUse(docker, file, { onOutput: (text) => output.push(text) });
    expect(tag).toBe(helperImageTag('FROM node:22-bookworm-slim\n'));
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatchObject({
      tag,
      dockerfile: file,
      context: path.dirname(file),
      labels: { 'nimblescape.devspaces.worker': 'true' },
      buildArgs: { DEVCONTAINER_CLI_VERSION },
    });
    expect(docker.builds[0].onOutput).toBeTypeOf('function');
    // Without a state file, a plain build: no --pull, no --no-cache.
    expect(docker.builds[0].pull).toBeUndefined();
    expect(docker.builds[0].noCache).toBeUndefined();
  });

  it('does not build when the tag exists', async () => {
    const file = dockerfile('FROM x\n');
    const docker = new FakeDocker();
    docker.addImage([helperImageTag('FROM x\n')]);
    await ensureHelperImageUse(docker, file);
    expect(docker.builds).toHaveLength(0);
  });

  it('builds the real Dockerfile of the extension with a stable tag', async () => {
    const file = path.resolve(__dirname, '../../../resources/helper/Dockerfile');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toMatch(/^ARG BASE_IMAGE=node:26-trixie-slim$/m);
    expect(content).toMatch(/^FROM \$\{BASE_IMAGE\}$/m);
    expect(content).toMatch(/^ARG DEVCONTAINER_CLI_VERSION$/m);
    expect(content).toMatch(/^LABEL nimblescape\.devspaces\.worker=true$/m);
    // The image holds its own Dockerfile, for the rebuild of the Monitor (src/remoteMonitor/helperRefresh.ts).
    expect(content).toMatch(/^COPY Dockerfile \/usr\/local\/share\/devspaces\/helper\/Dockerfile$/m);
    // The Docker CLI with the buildx and the Compose plugins from download.docker.com (Compose configurations).
    expect(content).toMatch(/apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin;/);
    expect(content).toMatch(/^\s*docker compose version; \\$/m);
    // Classic builder compatibility: no syntax directive, no heredoc, no RUN --mount.
    expect(content).not.toMatch(/^#\s*syntax=/m);
    expect(content).not.toMatch(/^[^#]*<</m);
    expect(content).not.toMatch(/^\s*RUN\s+--mount/m);
    const docker = new FakeDocker();
    expect((await ensureHelperImageUse(docker, file)).tag).toBe(helperImageTag(content));
  });
});

const BASE = 'node:24-trixie-slim';
const HELPER_DOCKERFILE = `ARG BASE_IMAGE=${BASE}\nFROM \${BASE_IMAGE}\nLABEL nimblescape.devspaces.worker=true\n`;
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const START = Date.parse('2026-09-24T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OLD_TAG = 'devspaces-worker:0123456789ab';
const OTHER_TAG = 'devspaces-worker:abcdef012345';

type LookupAnswer = string | 'unreachable' | undefined;

/** ensureHelperImageUse with a state file, a fake Docker, a fake clock, and a fake digest lookup. */
class Harness {
  readonly docker = new FakeDocker();
  readonly logger = new RecordingLogger();
  readonly file = dockerfile(HELPER_DOCKERFILE);
  readonly statePath = path.join(path.dirname(this.file), 'storage', 'helper.json');
  readonly tag = helperImageTag(HELPER_DOCKERFILE);
  readonly lookups: Array<{ reference: string; signal?: AbortSignal }> = [];
  /** Checks of the base image that ensure started in the background, not awaited yet. */
  readonly checks: Array<Promise<void>> = [];
  now = START;
  answer: (signal?: AbortSignal) => Promise<LookupAnswer> = async () => DIGEST_A;
  readonly clock = { now: () => this.now };
  readonly baseDigest: BaseDigestLookup = (reference, signal) => {
    this.lookups.push({ reference, signal });
    return this.answer(signal);
  };

  /** The tag that ensureHelperImageUse resolved. */
  async ensure(options: Partial<EnsureHelperImageOptions> = {}): Promise<string> {
    const use = await ensureHelperImageUse(this.docker, this.file, {
      statePath: this.statePath,
      baseDigest: this.baseDigest,
      clock: this.clock,
      logger: this.logger,
      onBaseImageCheck: (check) => this.checks.push(check),
      ...options,
    });
    return use.tag;
  }

  /** Waits for the checks of the base image that ensure started in the background. */
  async settled(): Promise<void> {
    await Promise.all(this.checks.splice(0));
  }

  advance(ms: number): void {
    this.now += ms;
  }

  /** ISO time `offsetMs` from now. */
  iso(offsetMs = 0): string {
    return new Date(this.now + offsetMs).toISOString();
  }

  state(): HelperState {
    return JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as HelperState;
  }

  writeState(state: HelperState): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state));
  }

  warnings(): string[] {
    return this.logger.lines.filter((line) => line.startsWith('warn'));
  }
}

describe('ensureHelperImageUse with a state file: new helper image', () => {
  it('builds a missing tag with --pull and records the digest of the base image read before the build', async () => {
    const h = new Harness();
    expect(await h.ensure()).toBe(h.tag);
    expect(h.lookups.map((lookup) => lookup.reference)).toEqual([BASE]);
    expect(h.docker.builds).toHaveLength(1);
    // With the digest that the build pulls as its label, for the check of the Monitor.
    expect(h.docker.builds[0]).toMatchObject({ tag: h.tag, pull: true });
    expect(h.docker.builds[0].labels).toEqual({ 'nimblescape.devspaces.worker': 'true', 'nimblescape.devspaces.worker-base-digest': DIGEST_A });
    expect(h.docker.builds[0].noCache).toBeUndefined();
    // The ID of the image that this build made, found by its build label (for diagnosis). The build records the helper
    // generation.
    expect(h.state()).toEqual({
      version: 1,
      images: {
        [h.tag]: {
          baseImage: BASE,
          baseDigest: DIGEST_A,
          builtAt: h.iso(),
          checkedAt: h.iso(),
          lastUsedAt: h.iso(),
          imageId: h.docker.idOf(h.tag),
          generation: HELPER_GENERATION,
        },
      },
    });
  });

  it('builds without --pull when the registry does not answer, and builds again from the current base image after the next check', async () => {
    const h = new Harness();
    h.answer = async () => 'unreachable';
    await h.ensure();
    expect(h.docker.builds[0].pull).toBe(false);
    // No label of a base digest: the Monitor builds such an image again (helperRefresh.ts).
    expect(h.docker.builds[0].labels).toEqual({ 'nimblescape.devspaces.worker': 'true' });
    // No digest and no checkedAt, but the mark: the image may come from an old local base image. The ID of the image
    // that this build made, found by its build label (for diagnosis). The build records the helper generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      builtAt: h.iso(),
      builtWithoutPull: h.iso(),
      attemptedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
      generation: HELPER_GENERATION,
    });
    const firstId = h.docker.idOf(h.tag);

    // The registry answers again: the check is tried again after a day.
    h.answer = async () => DIGEST_A;
    h.advance(HOUR);
    await h.ensure();
    expect(h.lookups).toHaveLength(1);
    h.advance(HELPER_RETRY_INTERVAL_MS);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(2);
    // The digest is not taken over as the digest of the image: the next ensure builds it again.
    expect(h.docker.builds).toHaveLength(1);
    expect(h.state().images[h.tag]).toMatchObject({ latestBaseDigest: DIGEST_A, checkedAt: h.iso(), builtWithoutPull: h.iso(-DAY - HOUR) });
    expect(h.state().images[h.tag].baseDigest).toBeUndefined();

    h.advance(HOUR);
    await h.ensure();
    expect(h.docker.builds).toHaveLength(2);
    expect(h.docker.builds[1]).toMatchObject({ pull: true, noCache: true });
    expect(h.docker.idOf(h.tag)).not.toBe(firstId);
    expect(h.logger.lines.join('\n')).toContain('was built from the local base image. It is built again from the current base image');
    // The ID of the image that this build made, found by its build label (for diagnosis). The build and the rebuild
    // record the helper generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
      generation: HELPER_GENERATION,
    });
    await h.ensure();
    await h.settled();
    expect(h.docker.builds).toHaveLength(2);
    expect(h.lookups).toHaveLength(2);
  });

  it('keeps the mark of a build without --pull when the rebuild fails, and tries again after the next weekly check', async () => {
    const h = new Harness();
    h.answer = async () => 'unreachable';
    await h.ensure();
    const firstId = h.docker.idOf(h.tag);
    h.answer = async () => DIGEST_A;
    h.advance(DAY);
    await h.ensure();
    await h.settled();
    h.docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'toomanyrequests: You have reached your pull rate limit');
    };
    h.advance(HOUR);
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.builds.map((build) => [build.pull, build.noCache])).toEqual([
      [false, undefined],
      [true, true],
    ]);
    expect(h.docker.idOf(h.tag)).toBe(firstId);
    const record = h.state().images[h.tag];
    expect(record).toMatchObject({ builtWithoutPull: h.iso(-DAY - HOUR), checkedAt: h.iso() });
    expect(record.latestBaseDigest).toBeUndefined();
    expect(record.baseDigest).toBeUndefined();

    // No new attempt at each open; the next weekly check asks for the rebuild again.
    h.docker.buildHandler = async () => undefined;
    h.advance(HOUR);
    await h.ensure();
    expect(h.docker.builds).toHaveLength(2);
    h.advance(HELPER_CHECK_INTERVAL_MS);
    await h.ensure();
    await h.settled();
    await h.ensure();
    expect(h.docker.builds).toHaveLength(3);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_A });
    expect(h.state().images[h.tag].builtWithoutPull).toBeUndefined();
  });

  it('builds with --pull without a digest lookup', async () => {
    const h = new Harness();
    await h.ensure({ baseDigest: undefined });
    expect(h.docker.builds[0]).toMatchObject({ pull: true });
    // The ID of the image that this build made, found by its build label (for diagnosis). The build records the helper
    // generation.
    expect(h.state().images[h.tag]).toEqual({ baseImage: BASE, builtAt: h.iso(), lastUsedAt: h.iso(), imageId: h.docker.idOf(h.tag), generation: HELPER_GENERATION });
  });

  it('replaces the record of a tag whose image was removed', async () => {
    const h = new Harness();
    h.writeState({
      version: 1,
      images: { [h.tag]: { baseImage: BASE, baseDigest: DIGEST_B, builtAt: h.iso(-30 * DAY), checkedAt: h.iso(-DAY) } },
    });
    await h.ensure();
    expect(h.docker.builds).toHaveLength(1);
    // The ID of the image that this build made, found by its build label (for diagnosis). The build and the rebuild
    // record the helper generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
      generation: HELPER_GENERATION,
    });
  });

  it('throws when a missing tag cannot be built, also not without --pull, and records nothing', async () => {
    const h = new Harness();
    h.docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'network error');
    };
    await expect(h.ensure()).rejects.toBeInstanceOf(CommandError);
    expect(h.docker.builds.map((build) => build.pull)).toEqual([true, false]);
    expect(fs.existsSync(h.statePath)).toBe(false);
  });

  it('builds a missing tag from the local base image when the build with --pull fails', async () => {
    // The request of the extension host got a digest, but the pull of the daemon fails (for example the pull limit).
    const h = new Harness();
    h.docker.buildHandler = async (options) => {
      if (options.pull) throw new CommandError('docker build', 1, '', 'toomanyrequests: You have reached your pull rate limit');
    };
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.builds.map((build) => build.pull)).toEqual([true, false]);
    // Only the build with --pull names the digest of the registry; the build from the local base image names none.
    expect(h.docker.builds.map((build) => build.labels?.['nimblescape.devspaces.worker-base-digest'])).toEqual([DIGEST_A, undefined]);
    expect(h.docker.idOf(h.tag)).toBeDefined();
    expect(h.warnings().join('\n')).toMatch(/could not be built with a fresh base image\. It is built from the local base image: .*toomanyrequests/);
    // The digest of the registry is not the digest of the image, so it is not recorded; the mark asks for a rebuild.
    // The ID of the image that this build made, found by its build label (for diagnosis). The build records the helper
    // generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      builtAt: h.iso(),
      builtWithoutPull: h.iso(),
      attemptedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
      generation: HELPER_GENERATION,
    });

    // The next check (a day later) asks for a build with a fresh base image, and the next ensure runs it.
    h.docker.buildHandler = async () => undefined;
    h.advance(HELPER_RETRY_INTERVAL_MS);
    await h.ensure();
    await h.settled();
    await h.ensure();
    expect(h.docker.builds).toHaveLength(3);
    expect(h.docker.builds[2]).toMatchObject({ pull: true, noCache: true });
    // The ID of the image that this build made, found by its build label (for diagnosis). The build and the rebuild
    // record the helper generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
      generation: HELPER_GENERATION,
    });
  });

  it('does not build again without --pull after an abort, or after a build that already ran without --pull', async () => {
    const h = new Harness();
    h.docker.buildHandler = async () => {
      throw abortError();
    };
    await expect(h.ensure()).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.docker.builds).toHaveLength(1);

    const offline = new Harness();
    offline.answer = async () => 'unreachable';
    offline.docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'pull access denied');
    };
    await expect(offline.ensure()).rejects.toBeInstanceOf(CommandError);
    expect(offline.docker.builds.map((build) => build.pull)).toEqual([false]);
    expect(fs.existsSync(offline.statePath)).toBe(false);
  });

  it('rejects with an AbortError when the signal aborts during the lookup before the build of a missing tag', async () => {
    const h = new Harness();
    const controller = new AbortController();
    // The abort comes from inside the lookup (it has started for sure), not from a timer that could fire before the
    // lookup starts (the per-engine step before it takes a variable time).
    h.answer = () => {
      setTimeout(() => controller.abort(), 0);
      return new Promise<LookupAnswer>(() => {});
    };
    await expect(h.ensure({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.lookups[0].signal?.aborted).toBe(true);
    expect(h.docker.builds).toHaveLength(0);
    expect(fs.existsSync(h.statePath)).toBe(false);
  });

  it('rejects with an AbortError without a lookup and without a build when the signal aborted before the lookup', async () => {
    const h = new Harness();
    const controller = new AbortController();
    controller.abort();
    await expect(h.ensure({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.lookups).toHaveLength(0);
    expect(h.docker.builds).toHaveLength(0);
    expect(fs.existsSync(h.statePath)).toBe(false);
  });

  it('builds a missing tag with --pull and without a lookup when the check of the base image is off', async () => {
    const h = new Harness();
    await h.ensure({ checkBaseImage: false });
    await h.settled();
    expect(h.lookups).toHaveLength(0);
    expect(h.docker.builds[0]).toMatchObject({ pull: true });
    // The ID of the image that this build made, found by its build label (for diagnosis). The build records the helper
    // generation.
    expect(h.state().images[h.tag]).toEqual({ baseImage: BASE, builtAt: h.iso(), lastUsedAt: h.iso(), imageId: h.docker.idOf(h.tag), generation: HELPER_GENERATION });
  });

  it('checks the base image of the real Dockerfile of the extension', async () => {
    const h = new Harness();
    const file = path.resolve(__dirname, '../../../resources/helper/Dockerfile');
    const docker = new FakeDocker();
    await ensureHelperImageUse(docker, file, { statePath: h.statePath, baseDigest: h.baseDigest, clock: h.clock });
    expect(h.lookups.map((lookup) => lookup.reference)).toEqual(['node:26-trixie-slim']);
  });
});

describe('ensureHelperImageUse with a state file: weekly check of the base image', () => {
  /** An existing helper image whose base image digest was recorded `checkedAgoMs` ago. */
  function existing(checkedAgoMs: number): { h: Harness; oldId: string } {
    const h = new Harness();
    const oldId = h.docker.addImage([h.tag]);
    h.writeState({
      version: 1,
      images: {
        [h.tag]: {
          baseImage: BASE,
          baseDigest: DIGEST_A,
          builtAt: h.iso(-30 * DAY),
          checkedAt: h.iso(-checkedAgoMs),
          lastUsedAt: h.iso(-2 * HOUR),
          // The ID that the build of this installation recorded (the ensure never fills it in for a record without
          // one).
          imageId: oldId,
        },
      },
    });
    return { h, oldId };
  }

  /** An existing helper image whose check (8 days ago) is due, and whose base image changed to DIGEST_B. */
  async function changed(): Promise<{ h: Harness; oldId: string }> {
    const result = existing(8 * DAY);
    result.h.answer = async () => DIGEST_B;
    await result.h.ensure();
    await result.h.settled();
    return result;
  }

  it('does not check within 7 days', async () => {
    const { h } = existing(HELPER_CHECK_INTERVAL_MS - HOUR);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(0);
    expect(h.docker.builds).toHaveLength(0);
  });

  it('only updates checkedAt when the digest is unchanged', async () => {
    const { h, oldId } = existing(HELPER_CHECK_INTERVAL_MS);
    await h.ensure();
    await h.settled();
    expect(h.lookups.map((lookup) => lookup.reference)).toEqual([BASE]);
    expect(h.docker.builds).toHaveLength(0);
    expect(h.docker.idOf(h.tag)).toBe(oldId);
    // The record keeps the ID of the image of the earlier build of this installation (for diagnosis).
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(-30 * DAY),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
    });

    h.advance(HELPER_CHECK_INTERVAL_MS - HOUR);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(1);
  });

  it('records the digest of a helper image built before the state existed, without a rebuild', async () => {
    const h = new Harness();
    const id = h.docker.addImage([h.tag]);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(1);
    expect(h.docker.builds).toHaveLength(0);
    expect(h.docker.idOf(h.tag)).toBe(id);
    expect(h.state().images[h.tag]).toEqual({ baseImage: BASE, baseDigest: DIGEST_A, checkedAt: h.iso(), lastUsedAt: h.iso() });
  });

  it('does not wait for the check: a registry that does not answer never delays the ensure', async () => {
    const { h } = existing(8 * DAY);
    h.answer = () => new Promise<LookupAnswer>(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      expect(await h.ensure()).toBe(h.tag);
      // The ensure returned while the lookup still runs: it waited neither for the registry nor for the time limit.
      expect(h.lookups).toHaveLength(1);
      expect(h.lookups[0].signal?.aborted).toBe(false);
      expect(h.checks).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(IMAGE_CHECK_TIMEOUT_MS);
      await h.settled();
    } finally {
      vi.useRealTimers();
    }
    // The time limit of the check ended the lookup.
    expect(h.lookups[0].signal?.aborted).toBe(true);
    expect(h.docker.builds).toHaveLength(0);
    expect(h.state().images[h.tag]).toMatchObject({ checkedAt: h.iso(-8 * DAY), attemptedAt: h.iso() });
  });

  it('asks the next ensure to rebuild the same tag with --pull --no-cache when the base image changed, and keeps the previous image for the cleanup of the Monitor', async () => {
    const { h, oldId } = await changed();
    // The check itself builds nothing: the ensure that started it did not wait for it.
    expect(h.docker.builds).toHaveLength(0);
    // The rebuild runs at the next maintaining ensure: the background prebuild when a window starts, or the preparation
    // of a new worker for an open.
    expect(h.logger.lines.join('\n')).toContain(`has changed. The image ${h.tag} is built again when a window starts or a worker is set up for an open.`);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_A, latestBaseDigest: DIGEST_B, checkedAt: h.iso() });

    const output: string[] = [];
    const builds: string[] = [];
    h.docker.buildHandler = async (options) => options.onOutput?.('#1 building\n');
    expect(await h.ensure({ onOutput: (text) => output.push(text), onBuild: (kind) => builds.push(kind) })).toBe(h.tag);

    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.builds[0]).toMatchObject({ tag: h.tag, pull: true, noCache: true });
    // With the new digest as the label of the base image, for the check of the Monitor.
    expect(h.docker.builds[0].labels).toEqual({ 'nimblescape.devspaces.worker': 'true', 'nimblescape.devspaces.worker-base-digest': DIGEST_B });
    // The build output reaches onOutput, and onBuild tells that an existing helper is updated.
    expect(output).toEqual(['#1 building\n']);
    expect(builds).toEqual(['refresh']);
    const newId = h.docker.idOf(h.tag);
    expect(newId).toBeDefined();
    expect(newId).not.toBe(oldId);
    // The windows remove no helper image: the previous image stays without a tag, for the cleanup of the Monitor.
    expect(h.docker.images.get(oldId)?.tags).toEqual([]);
    // The ID of the image that this build made, found by its build label (for diagnosis). The rebuild records the
    // helper generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_B,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
      generation: HELPER_GENERATION,
    });
    await h.settled();
    expect(h.lookups).toHaveLength(1);
  });

  it('drops the recorded image ID when the ID of the rebuilt image cannot be read', async () => {
    const { h, oldId } = await changed();
    expect(h.state().images[h.tag]?.imageId).toBe(oldId);
    // The build succeeds, but Docker does not answer for the ID of the new image. The ID comes from the build (its
    // build label); it is unavailable here too.
    h.docker.builtIdMissing = true;
    h.docker.buildHandler = async () => {
      h.docker.imageIdError = new CommandError('docker image inspect', 1, '', 'Cannot connect to the Docker daemon');
    };
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.builds).toHaveLength(1);
    // The old ID is not the image of the tag any more: no ID is better than a wrong one. The rebuild records the helper
    // generation.
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_B,
      builtAt: h.iso(),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      generation: HELPER_GENERATION,
    });
  });

  it('records the ID of the rebuilt image from the build, not the image that the tag has afterwards', async () => {
    const { h } = await changed();
    let builtId: string | undefined;
    let otherId: string | undefined;
    h.docker.afterBuild = () => {
      h.docker.afterBuild = () => undefined;
      builtId = h.docker.idOf(h.tag);
      // Another installation on the same engine builds the tag right after this build.
      otherId = h.docker.addImage([h.tag]);
    };
    const use = await ensureHelperImageUse(h.docker, h.file, { statePath: h.statePath, baseDigest: h.baseDigest, clock: h.clock, logger: h.logger });
    expect(builtId).toBeDefined();
    expect(otherId).not.toBe(builtId);
    expect(h.state().images[h.tag]?.imageId).toBe(builtId);
    expect(use).toEqual({ tag: h.tag, id: builtId });
  });

  it('records no image ID read back by the tag when the build gave none', async () => {
    const { h } = await changed();
    h.docker.builtIdMissing = true;
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.builds).toHaveLength(1);
    // The tag has an image, but it may be one of another build: it is no image ID of this installation.
    expect(h.docker.idOf(h.tag)).toBeDefined();
    expect(h.state().images[h.tag]?.imageId).toBeUndefined();
    const fresh = new Harness();
    fresh.docker.builtIdMissing = true;
    const use = await ensureHelperImageUse(fresh.docker, fresh.file, { statePath: fresh.statePath, clock: fresh.clock, logger: fresh.logger });
    expect(fresh.state().images[fresh.tag]?.imageId).toBeUndefined();
    // The open still runs the image of the tag by its ID.
    expect(use).toEqual({ tag: fresh.tag, id: fresh.docker.idOf(fresh.tag) });
  });

  it('runs the rebuilt image by the ID of its tag when the rebuild gave no ID', async () => {
    const { h, oldId } = await changed();
    h.docker.builtIdMissing = true;
    const use = await ensureHelperImageUse(h.docker, h.file, { statePath: h.statePath, baseDigest: h.baseDigest, clock: h.clock, logger: h.logger });
    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.builds[0]).toMatchObject({ pull: true, noCache: true });
    // The open runs the image by its ID, so a rebuild by another window cannot change it mid-open.
    expect(use).toEqual({ tag: h.tag, id: h.docker.idOf(h.tag) });
    expect(use.id).not.toBe(oldId);
    // The ID read back by the tag is not recorded.
    expect(h.state().images[h.tag]?.imageId).toBeUndefined();
  });

  it('keeps the previous image when it still has another tag', async () => {
    const { h, oldId } = await changed();
    h.docker.images.get(oldId)!.tags.push('mine:backup');
    await h.ensure();
    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.images.get(oldId)?.tags).toEqual(['mine:backup']);
  });

  it('keeps the existing image when the rebuild fails, and checks again in a week', async () => {
    const { h, oldId } = await changed();
    h.docker.buildHandler = async () => {
      throw new CommandError('docker build', 1, '', 'Temporary failure resolving deb.debian.org');
    };
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.idOf(h.tag)).toBe(oldId);
    expect(h.warnings().join('\n')).toMatch(/could not be built again\. The existing image is used: .*Temporary failure/);
    // The record keeps the ID of the image of the earlier build of this installation (for diagnosis).
    expect(h.state().images[h.tag]).toEqual({
      baseImage: BASE,
      baseDigest: DIGEST_A,
      builtAt: h.iso(-30 * DAY),
      checkedAt: h.iso(),
      lastUsedAt: h.iso(),
      imageId: h.docker.idOf(h.tag),
    });

    // Not at each open: the next check, a week later, asks for the rebuild again.
    h.docker.buildHandler = async () => undefined;
    h.advance(HELPER_CHECK_INTERVAL_MS - HOUR);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(1);
    expect(h.docker.builds).toHaveLength(1);
    h.advance(HOUR);
    await h.ensure();
    await h.settled();
    await h.ensure();
    expect(h.lookups).toHaveLength(2);
    expect(h.docker.builds).toHaveLength(2);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_B });
  });

  it('keeps the image and tries again after a day, not at each open, when the registry cannot be reached', async () => {
    const { h, oldId } = existing(8 * DAY);
    h.answer = async () => 'unreachable';
    expect(await h.ensure()).toBe(h.tag);
    await h.settled();
    expect(h.docker.builds).toHaveLength(0);
    expect(h.docker.idOf(h.tag)).toBe(oldId);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_A, checkedAt: h.iso(-8 * DAY), attemptedAt: h.iso() });
    expect(h.logger.lines.join('\n')).toContain('the registry did not answer. It is checked again in a day.');

    // Opens within the day do not check again.
    h.answer = async () => DIGEST_A;
    h.advance(HELPER_RETRY_INTERVAL_MS - HOUR);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(1);

    h.advance(HOUR);
    await h.ensure();
    await h.settled();
    expect(h.lookups).toHaveLength(2);
    expect(h.state().images[h.tag].checkedAt).toBe(h.iso());
    expect(h.state().images[h.tag].attemptedAt).toBeUndefined();
  });

  it('counts a lookup without an answer in time as unreachable', async () => {
    const { h } = existing(8 * DAY);
    h.answer = () => new Promise<LookupAnswer>(() => {});
    expect(await h.ensure({ baseDigestTimeoutMs: 20 })).toBe(h.tag);
    await h.settled();
    expect(h.lookups[0].signal?.aborted).toBe(true);
    expect(h.docker.builds).toHaveLength(0);
    expect(h.state().images[h.tag]).toMatchObject({ checkedAt: h.iso(-8 * DAY), attemptedAt: h.iso() });
  });

  it('counts a failing lookup as unreachable, also one that throws at once', async () => {
    const { h } = existing(8 * DAY);
    h.answer = async () => {
      throw new Error('socket hang up');
    };
    expect(await h.ensure()).toBe(h.tag);
    await h.settled();
    expect(h.docker.builds).toHaveLength(0);
    expect(h.state().images[h.tag]).toMatchObject({ checkedAt: h.iso(-8 * DAY), attemptedAt: h.iso() });
    expect(h.warnings().join('\n')).toContain('socket hang up');

    const throwing: BaseDigestLookup = () => {
      throw new Error('not a promise');
    };
    h.advance(HELPER_RETRY_INTERVAL_MS);
    expect(await h.ensure({ baseDigest: throwing })).toBe(h.tag);
    await h.settled();
    expect(h.docker.builds).toHaveLength(0);
    expect(h.warnings().join('\n')).toContain('not a promise');
  });

  it('checks again in a week when the registry returns no digest (for example a sign-in is required)', async () => {
    const { h } = existing(8 * DAY);
    h.answer = async () => undefined;
    await h.ensure();
    await h.settled();
    expect(h.docker.builds).toHaveLength(0);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_A, checkedAt: h.iso() });
  });

  it('is not stopped by an abort of the open: the check runs in the background with its own time limit', async () => {
    const { h } = existing(8 * DAY);
    let answer: (value: LookupAnswer) => void = () => undefined;
    h.answer = () => new Promise<LookupAnswer>((resolve) => (answer = resolve));
    const controller = new AbortController();
    expect(await h.ensure({ signal: controller.signal })).toBe(h.tag);
    controller.abort();
    expect(h.lookups[0].signal).not.toBe(controller.signal);
    expect(h.lookups[0].signal?.aborted).toBe(false);
    answer(DIGEST_A);
    await h.settled();
    expect(h.state().images[h.tag].checkedAt).toBe(h.iso());
  });

  it('passes an abort during the rebuild through, and builds again at the next ensure', async () => {
    const { h, oldId } = await changed();
    const abort = new Error('The operation was cancelled.');
    abort.name = 'AbortError';
    h.docker.buildHandler = async () => {
      throw abort;
    };
    await expect(h.ensure()).rejects.toBe(abort);
    expect(h.docker.idOf(h.tag)).toBe(oldId);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_A, latestBaseDigest: DIGEST_B });

    h.docker.buildHandler = async () => undefined;
    await h.ensure();
    expect(h.docker.builds).toHaveLength(2);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_B });
  });

  it('neither checks nor rebuilds when the check of the base image is off, and rebuilds when it is on again', async () => {
    const { h } = existing(8 * DAY);
    await h.ensure({ checkBaseImage: false });
    await h.settled();
    expect(h.lookups).toHaveLength(0);

    // A rebuild that an earlier check asked for waits, too.
    const pending = await changed();
    await pending.h.ensure({ checkBaseImage: false });
    expect(pending.h.docker.builds).toHaveLength(0);
    await pending.h.ensure();
    expect(pending.h.docker.builds).toHaveLength(1);
  });

  it('leaves the check and the rebuild to the next ensure with maintenance when `maintain` is false', async () => {
    const { h } = await changed();
    h.advance(HELPER_CHECK_INTERVAL_MS);
    await h.ensure({ maintain: false });
    await h.settled();
    expect(h.lookups).toHaveLength(1);
    expect(h.docker.builds).toHaveLength(0);
    expect(h.state().images[h.tag].lastUsedAt).toBe(h.iso());

    await h.ensure();
    expect(h.docker.builds).toHaveLength(1);
  });

  it('builds a missing tag also when `maintain` is false', async () => {
    const h = new Harness();
    await h.ensure({ maintain: false });
    expect(h.docker.builds).toHaveLength(1);
    expect(h.docker.builds[0]).toMatchObject({ pull: true });
  });
});

describe('ensureHelperImageUse with a state file: lastUsedAt and the state file', () => {
  it('writes lastUsedAt at most once per hour', async () => {
    const h = new Harness();
    h.docker.addImage([h.tag]);
    h.writeState({
      version: 1,
      images: { [h.tag]: { baseImage: BASE, baseDigest: DIGEST_A, checkedAt: h.iso(), lastUsedAt: h.iso(-2 * HOUR) } },
    });
    await h.ensure();
    expect(h.state().images[h.tag].lastUsedAt).toBe(h.iso());
    const written = h.iso();

    h.advance(HELPER_LAST_USED_INTERVAL_MS / 2);
    await h.ensure();
    expect(h.state().images[h.tag].lastUsedAt).toBe(written);

    h.advance(HELPER_LAST_USED_INTERVAL_MS / 2);
    await h.ensure();
    expect(h.state().images[h.tag].lastUsedAt).toBe(h.iso());
  });

  it('treats an invalid state file as empty', async () => {
    const h = new Harness();
    fs.mkdirSync(path.dirname(h.statePath), { recursive: true });
    fs.writeFileSync(h.statePath, '{ not json');
    h.docker.addImage([h.tag]);
    expect(await h.ensure()).toBe(h.tag);
    await h.settled();
    expect(h.docker.builds).toHaveLength(0);
    expect(h.state().images[h.tag]).toMatchObject({ baseDigest: DIGEST_A, checkedAt: h.iso() });
  });

  it('works when the state file cannot be written', async () => {
    const h = new Harness();
    const blocker = path.join(path.dirname(h.file), 'not-a-folder');
    fs.writeFileSync(blocker, '');
    const statePath = path.join(blocker, 'helper.json');
    expect(await h.ensure({ statePath })).toBe(h.tag);
    expect(h.docker.builds).toHaveLength(1);
    expect(h.warnings().join('\n')).toContain('could not be written');
  });

  it('recordHelperImageUse writes lastUsedAt at most once per hour and never throws', async () => {
    const h = new Harness();
    await recordHelperImageUse(h.statePath, OTHER_TAG, { clock: h.clock });
    expect(h.state().images[OTHER_TAG]).toEqual({ lastUsedAt: h.iso() });
    const written = h.iso();
    h.advance(HELPER_LAST_USED_INTERVAL_MS - 1);
    await recordHelperImageUse(h.statePath, OTHER_TAG, { clock: h.clock });
    expect(h.state().images[OTHER_TAG].lastUsedAt).toBe(written);
    h.advance(1);
    await recordHelperImageUse(h.statePath, OTHER_TAG, { clock: h.clock });
    expect(h.state().images[OTHER_TAG].lastUsedAt).toBe(h.iso());

    const blocker = path.join(path.dirname(h.file), 'not-a-folder');
    fs.writeFileSync(blocker, '');
    await expect(
      recordHelperImageUse(path.join(blocker, 'helper.json'), OTHER_TAG, { clock: h.clock, logger: h.logger }),
    ).resolves.toBeUndefined();
    expect(h.warnings().join('\n')).toContain('could not be written');
  });
});

describe('ensureHelperImageUse with a state file: no previous helper image', () => {
  const offline = async (): Promise<void> => {
    throw new CommandError('docker build', 1, '', 'Temporary failure resolving deb.debian.org');
  };

  /** A helper image that this installation built for `tag` `builtAgoMs` ago, as recorded in the state. Returns its ID. */
  function ownOlder(h: Harness, tag: string, builtAgoMs: number, extra: Partial<HelperImageRecord> = {}): string {
    const id = h.docker.addImage([tag]);
    const state: HelperState = fs.existsSync(h.statePath) ? h.state() : { version: 1, images: {} };
    state.images[tag] = { builtAt: h.iso(-builtAgoMs), imageId: id, lastUsedAt: h.iso(-builtAgoMs), generation: HELPER_GENERATION, ...extra };
    h.writeState(state);
    return id;
  }

  it('fails when the current tag cannot be built, also when older helper images of this installation exist, and builds the current tag at the next ensure', async () => {
    const h = new Harness();
    ownOlder(h, OTHER_TAG, 60 * DAY);
    ownOlder(h, OLD_TAG, 10 * DAY);
    const before = h.state();
    h.docker.buildHandler = offline;
    await expect(h.ensure()).rejects.toBeInstanceOf(CommandError);
    // The build was tried with --pull and again without it.
    expect(h.docker.builds.map((build) => [build.tag, build.pull])).toEqual([
      [h.tag, true],
      [h.tag, false],
    ]);
    expect(h.warnings().join('\n')).not.toContain('previous helper');
    expect(h.state()).toEqual(before);

    // Online again: the next ensure builds the current tag. The older tags stay: the cleanup of the Monitor removes
    // them when no container used them for 7 days.
    h.docker.buildHandler = async () => undefined;
    h.advance(HOUR);
    expect(await h.ensure()).toBe(h.tag);
    expect(h.docker.builds).toHaveLength(3);
    expect(h.state().images[h.tag]?.imageId).toBe(h.docker.idOf(h.tag));
    expect(h.docker.idOf(OLD_TAG)).toBeDefined();
    expect(h.docker.idOf(OTHER_TAG)).toBeDefined();
  });

  it('throws the error of the build or the abort, with and without a state file', async () => {
    const h = new Harness();
    ownOlder(h, OLD_TAG, DAY);
    h.docker.buildHandler = offline;
    // There is no previous helper image: no warning about one.
    await expect(h.ensure()).rejects.toBeInstanceOf(CommandError);
    expect(h.warnings().join('\n')).not.toContain('there is no previous helper image');
    await expect(ensureHelperImageUse(h.docker, h.file, { logger: h.logger })).rejects.toBeInstanceOf(CommandError);

    h.docker.buildHandler = async () => {
      throw abortError();
    };
    await expect(h.ensure()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('records no image ID for a current tag whose record is of another installation', async () => {
    const h = new Harness();
    h.docker.addImage([h.tag]);
    h.writeState({ version: 1, images: { [h.tag]: { builtAt: h.iso(-DAY), foreignSince: h.iso(-DAY), lastUsedAt: h.iso(-DAY) } } });
    await h.ensure({ baseDigest: undefined });
    expect(h.state().images[h.tag]).toEqual({ builtAt: h.iso(-DAY), lastUsedAt: h.iso() });
  });

  it('gives an older record without an image ID none', async () => {
    const h = new Harness();
    h.docker.addImage([h.tag]);
    h.writeState({ version: 1, images: { [h.tag]: { builtAt: h.iso(-DAY), lastUsedAt: h.iso(-10 * HOUR) } } });
    await h.ensure({ baseDigest: undefined });
    // Another installation may have built the image of the tag, so the record gets no ID.
    expect(h.state().images[h.tag]).toEqual({ builtAt: h.iso(-DAY), lastUsedAt: h.iso() });

    const other = new Harness();
    other.docker.addImage([other.tag]);
    other.writeState({ version: 1, images: { [other.tag]: { lastUsedAt: other.iso(-10 * HOUR) } } });
    await other.ensure({ baseDigest: undefined });
    expect(other.state().images[other.tag]).toEqual({ lastUsedAt: other.iso() });
  });
});

describe('ensureHelperImageUse: the tag and the ID of the image', () => {
  const offline = async (): Promise<void> => {
    throw new CommandError('docker build', 1, '', 'Temporary failure resolving deb.debian.org');
  };

  function use(h: Harness, options: Partial<EnsureHelperImageOptions> = {}) {
    return ensureHelperImageUse(h.docker, h.file, { statePath: h.statePath, clock: h.clock, logger: h.logger, ...options });
  }

  it('returns the current tag with the ID of its image, and the ID of a build from the build, also when the tag moved right after it', async () => {
    const h = new Harness();
    let builtId: string | undefined;
    h.docker.afterBuild = () => {
      h.docker.afterBuild = () => undefined;
      builtId = h.docker.idOf(h.tag);
      h.docker.addImage([h.tag]);
    };
    expect(await use(h)).toEqual({ tag: h.tag, id: builtId });
    // helper.json records the ID of the build, never the one that the tag has now.
    expect(h.state().images[h.tag]?.imageId).toBe(builtId);
    expect(h.docker.idOf(h.tag)).not.toBe(builtId);
    // An existing tag: the ID of its image.
    expect(await use(h)).toEqual({ tag: h.tag, id: h.docker.idOf(h.tag) });
  });

  it('fails instead of returning an older helper image when the current tag cannot be built', async () => {
    const h = new Harness();
    const oldId = h.docker.addImage([OLD_TAG]);
    h.writeState({ version: 1, images: { [OLD_TAG]: { builtAt: h.iso(-DAY), imageId: oldId, lastUsedAt: h.iso(-DAY), generation: HELPER_GENERATION } } });
    h.docker.buildHandler = offline;
    await expect(use(h)).rejects.toBeInstanceOf(CommandError);
  });

  it('returns the existing image with its ID when the rebuild that a check asked for fails', async () => {
    const h = new Harness();
    const oldId = h.docker.addImage([h.tag]);
    h.writeState({
      version: 1,
      images: {
        [h.tag]: {
          baseImage: BASE,
          baseDigest: DIGEST_A,
          latestBaseDigest: DIGEST_B,
          builtAt: h.iso(-30 * DAY),
          checkedAt: h.iso(-DAY),
          lastUsedAt: h.iso(-HOUR),
          imageId: oldId,
          generation: HELPER_GENERATION,
        },
      },
    });
    h.docker.buildHandler = offline;
    expect(await use(h)).toEqual({ tag: h.tag, id: oldId });
    expect(h.docker.builds).toEqual([expect.objectContaining({ pull: true, noCache: true })]);
  });

  it('without a state file: the ID of the build, or of the existing tag, and the tag alone when the ID cannot be read', async () => {
    const h = new Harness();
    let builtId: string | undefined;
    h.docker.afterBuild = () => {
      builtId = h.docker.idOf(h.tag);
    };
    expect(await ensureHelperImageUse(h.docker, h.file)).toEqual({ tag: h.tag, id: builtId });
    expect(await ensureHelperImageUse(h.docker, h.file)).toEqual({ tag: h.tag, id: h.docker.idOf(h.tag) });
    h.docker.imageIdError = new CommandError('docker image inspect', 1, '', 'Cannot connect to the Docker daemon');
    expect(await ensureHelperImageUse(h.docker, h.file, { logger: h.logger })).toEqual({ tag: h.tag });
    expect(h.warnings().join('\n')).toContain(`The ID of the workspace helper image ${h.tag} could not be read`);
  });
});

describe('registryBaseDigest', () => {
  it('maps the results of the registry client', async () => {
    const results: Record<string, DigestResult> = {
      'node:24-trixie-slim': { kind: 'digest', digest: DIGEST_A },
      'offline.example.com/a:1': { kind: 'unreachable', registry: 'offline.example.com', error: 'ENOTFOUND' },
      'ghcr.io/private/a:1': { kind: 'authRequired', registry: 'ghcr.io' },
      'ghcr.io/gone/a:1': { kind: 'notFound', registry: 'ghcr.io' },
      'ghcr.io/broken/a:1': { kind: 'error', registry: 'ghcr.io', error: 'HTTP 400' },
    };
    const requested: ImageReference[] = [];
    const lookup = registryBaseDigest({
      getDigest: async (reference) => {
        requested.push(reference);
        return results[reference.original];
      },
    });
    expect(await lookup('node:24-trixie-slim')).toBe(DIGEST_A);
    expect(requested[0]).toMatchObject({ registry: 'registry-1.docker.io', repository: 'library/node', tag: '24-trixie-slim' });
    expect(await lookup('offline.example.com/a:1')).toBe('unreachable');
    expect(await lookup('ghcr.io/private/a:1')).toBeUndefined();
    expect(await lookup('ghcr.io/gone/a:1')).toBeUndefined();
    expect(await lookup('ghcr.io/broken/a:1')).toBeUndefined();
    expect(await lookup('Not A Reference')).toBeUndefined();
    expect(requested).toHaveLength(5);
  });

  it('gives unreachable after the time limit, and when the signal aborts', async () => {
    const hanging: HttpTransport = { request: () => new Promise(() => {}) };
    const client = new RegistryClient(hanging, async () => undefined);
    const started = Date.now();
    expect(await registryBaseDigest(client, 20)('node:24-trixie-slim')).toBe('unreachable');
    expect(Date.now() - started).toBeLessThan(2000);

    const controller = new AbortController();
    const pending = registryBaseDigest(client, 60_000)('node:24-trixie-slim', controller.signal);
    controller.abort();
    expect(await pending).toBe('unreachable');
  });
});
