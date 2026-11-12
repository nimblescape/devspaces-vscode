// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The part "the workspace helper image" of the background run of the Monitor (background.ts; docs/requirements.md
// R-DS-003): the Monitor keeps the image of its own helper tag up to date, the image that the workers of the windows
// and the Monitor itself run from. The helper image holds its own Dockerfile (HELPER_DOCKERFILE_COPY, a COPY of
// resources/helper/Dockerfile), so the Monitor reads it in its own container; its helper tag is the tag of that
// Dockerfile with the version of the Dev Container CLI and the helper generation of the Monitor's script
// (helperImageTag), which is the script of the worker that created the Monitor. Each run:
//   1. The image of the tag (an inspect over the Engine API). None on the engine: nothing is done (a window builds a
//      missing tag when it needs it).
//   2. The registry digest of the base image (the first FROM, with its ARG defaults), anonymously, over the HTTPS of
//      the proxy of the daemon, with the registry client of the image pass (images.ts).
//   3. The label LABEL_HELPER_BASE_DIGEST of the image (the digest that its build pulled) equals that digest: the image
//      is current. Else (another digest, or no label: a build without `--pull`, or one of an older version) the tag is
//      built again with `--pull --no-cache` and that label, by the Docker CLI of the Monitor's container over the
//      socket of the engine (cliHelperBuild), within HELPER_REBUILD_TIMEOUT_MS. A failed build keeps the existing image.
//   4. The record of the check in the volume (helperCheck.ts): `checkedAt` with the digest when the image is current
//      after the run, `attemptedAt` when the registry gave no digest or the build failed (the windows then check and
//      build it as before). The windows read it through the answers of their heartbeats.
// The previous image is not removed here: the Monitor still runs from it (its monitor tag) until it moves to the new
// build at its next check (selfUpgrade.ts, docs/requirements.md R-DS-009), and its successor or the cleanup of the
// Monitor removes it when no container uses it anymore (engineCleanup.ts, R-DS-007). The output of the build stays out
// of the log of the Monitor, except the last lines of a failed build. Never throws. No `vscode`.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { errorMessage } from '../core/errors';
import type { HttpTransport } from '../core/http';
import { DEVCONTAINER_CLI_VERSION, HELPER_REBUILD_TIMEOUT_MS, helperImageTag } from '../core/helper/helperImageBuild';
import { extractBaseImages } from '../core/imageCheck/dockerfile';
import { parseImageReference } from '../core/imageCheck/reference';
import { RegistryClient } from '../core/imageCheck/registryClient';
import { HELPER_DOCKER_SOCKET, LABEL_HELPER, LABEL_HELPER_BASE_DIGEST } from '../core/names';
import { NodeProcessRunner } from '../core/process';
import type { ProcessRunner } from '../core/ports';
import { engineHelperRecordText, parseEngineHelperRecordText, type EngineHelperRecord } from '../core/remoteMonitor/helperCheck';
import { isRecord } from '../core/valueChecks';
import type { NetworkContact } from './backgroundRules';
import { engineFailure, type ImageEngine } from './engine';
import { REGISTRY_TIMEOUT_MS, requestsWithin } from './images';
import { PREPARE_WORKER_PATH } from './prepares';
import { noteRun } from './runNotes';

/** The copy of the Dockerfile of the helper image in that image (the COPY of resources/helper/Dockerfile). */
export const HELPER_DOCKERFILE_COPY = '/usr/local/share/devspaces/helper/Dockerfile';
/** The time limit of the inspect of the helper image. */
export const HELPER_INSPECT_TIMEOUT_MS = 60_000;
/** The largest Dockerfile that the part reads. */
const MAX_DOCKERFILE_BYTES = 64 * 1024;
/** The last lines of the output of a failed build that the log shows. */
const FAILED_BUILD_LINES = 5;
/** The longest line of the output of a failed build in the log. */
const MAX_FAILED_BUILD_LINE = 400;

/** One build of the helper image: its tag, its Dockerfile (in its folder, the context), and the digest of its base. */
export interface HelperBuild {
  tag: string;
  dockerfile: string;
  baseDigest: string;
}

export interface HelperRefreshDeps {
  log: (message: string) => void;
  now: () => number;
  engine: Pick<ImageEngine, 'inspect'>;
  /** The HTTPS of the registry request (the monitor's: the proxy of the daemon), made afresh for each run. */
  registryTransport: () => HttpTransport;
  /** The text of the record in the volume (HELPER_CHECK_FILE), undefined when there is none; and its atomic write. */
  record: { read(): Promise<string | undefined>; write(text: string): Promise<void> };
  /** The Dockerfile of the helper image (default HELPER_DOCKERFILE_COPY; the tests give their own). */
  dockerfile?: string;
  /** The build (default cliHelperBuild; the tests give their own). Rejects when it fails or `signal` aborts. */
  build?: (build: HelperBuild, signal: AbortSignal) => Promise<void>;
}

/**
 * One check of the helper image, and its rebuild when its base image changed (see the module comment). Resolves what
 * it found of the network (NetworkContact): `reached` when the registry answered, `offline` when it did not, `none`
 * when it asked no registry. Never throws.
 */
export async function refreshHelperImage(deps: HelperRefreshDeps): Promise<NetworkContact> {
  const { log } = deps;
  const dockerfile = deps.dockerfile ?? HELPER_DOCKERFILE_COPY;
  const content = await readDockerfile(dockerfile);
  if (content === undefined) {
    log(`The image of the Monitor holds no Dockerfile of the workspace helper at ${dockerfile}, so the background run leaves the helper image out.`);
    return 'none';
  }
  const tag = helperImageTag(content);
  const baseImage = firstBaseImage(content);
  const reference = baseImage === undefined ? undefined : parseImageReference(baseImage);
  if (baseImage === undefined || reference === undefined) {
    log(`The Dockerfile of the workspace helper image ${tag} names no base image that a registry can check, so the background run leaves the helper image out.`);
    return 'none';
  }
  let image: CurrentImage | undefined;
  try {
    image = currentImageOf(await deps.engine.inspect('image', tag, AbortSignal.timeout(HELPER_INSPECT_TIMEOUT_MS)));
  } catch (error) {
    const reason = engineFailure(error, HELPER_INSPECT_TIMEOUT_MS);
    noteRun('helperImageFailed', `${tag}: it could not be read: ${reason}`);
    log(`The workspace helper image ${tag} could not be read: ${reason}`);
    return 'none';
  }
  if (image === undefined) {
    log(`The workspace helper image ${tag} is not on this engine. A window builds it when it needs it.`);
    return 'none';
  }

  // The record of another tag (a Monitor of another version wrote it) starts again.
  const stored = parseEngineHelperRecordText((await deps.record.read().catch(() => undefined)) ?? '');
  const base: EngineHelperRecord = stored?.tag === tag && stored.baseImage === baseImage ? stored : { tag, baseImage };
  const write = async (record: EngineHelperRecord): Promise<void> => {
    try {
      await deps.record.write(engineHelperRecordText(record));
    } catch (error) {
      log(`The check of the workspace helper image could not be recorded in the volume: ${errorMessage(error)}`);
    }
  };

  // The registry client of the image pass: anonymous (no credentials), each request within REGISTRY_TIMEOUT_MS.
  const registry = new RegistryClient(requestsWithin(deps.registryTransport(), REGISTRY_TIMEOUT_MS), async () => undefined, {
    info: log,
    warn: log,
    error: log,
    output: () => {},
  });
  const answer = await registry.getDigest(reference);
  const now = new Date(deps.now()).toISOString();
  if (answer.kind !== 'digest') {
    noteRun('helperImageFailed', answer.kind === 'unreachable' ? `${tag}: the registry of ${baseImage} did not answer (${answer.error})` : `${tag}: the registry gave no digest for ${baseImage} (${answer.kind})`);
    log(
      answer.kind === 'unreachable'
        ? `The base image ${baseImage} of the workspace helper could not be checked: its registry did not answer (${answer.error}).`
        : `The registry gave no digest for the base image ${baseImage} of the workspace helper (${answer.kind}). The windows check it.`,
    );
    await write({ ...base, attemptedAt: now });
    return answer.kind === 'unreachable' ? 'offline' : 'reached';
  }
  const digest = answer.digest;
  if (image.baseDigest !== undefined && image.baseDigest.toLowerCase() === digest.toLowerCase()) {
    log(`The workspace helper image ${tag} is built from the current base image ${baseImage}.`);
    await write({ ...base, baseDigest: digest, checkedAt: now });
    return 'reached';
  }

  log(
    image.baseDigest === undefined
      ? `The workspace helper image ${tag} does not name the digest of its base image ${baseImage}. It is built again from the current base image.`
      : `The base image ${baseImage} of the workspace helper has changed. The image ${tag} is built again.`,
  );
  const started = deps.now();
  const limit = AbortSignal.timeout(HELPER_REBUILD_TIMEOUT_MS);
  try {
    await (deps.build ?? cliHelperBuild)({ tag, dockerfile, baseDigest: digest }, limit);
  } catch (error) {
    const reason = limit.aborted ? `it did not end within ${HELPER_REBUILD_TIMEOUT_MS / 60_000} minutes` : errorMessage(error);
    noteRun('helperImageFailed', `${tag}: the build failed: ${reason}`);
    log(`The workspace helper image ${tag} could not be built again, so the existing image stays and the windows check it: ${reason}`);
    await write({ ...base, attemptedAt: now });
    return 'reached';
  }
  const ended = deps.now();
  const builtAt = new Date(ended).toISOString();
  noteRun('helperImageBuilt', tag);
  log(`The workspace helper image ${tag} was built again from the current base image ${baseImage} in ${Math.round((ended - started) / 1000)} s.`);
  await write({ ...base, baseDigest: digest, checkedAt: builtAt, builtAt });
  return 'reached';
}

/**
 * The helper tag of the Monitor and the base image of its helper image, from the copy of the Dockerfile in the image of
 * the Monitor (`dockerfile`, default HELPER_DOCKERFILE_COPY); undefined when the image holds no such Dockerfile. The
 * base image is undefined when the Dockerfile names none. Never throws.
 */
export async function ownHelperImage(dockerfile: string = HELPER_DOCKERFILE_COPY): Promise<{ tag: string; baseImage: string | undefined } | undefined> {
  const content = await readDockerfile(dockerfile);
  return content === undefined ? undefined : { tag: helperImageTag(content), baseImage: firstBaseImage(content) };
}

/** The image of the helper tag: its ID and the digest of the base image that its build pulled (its label). */
interface CurrentImage {
  id: string;
  baseDigest?: string;
}

/** The image of the inspect JSON, undefined when the image does not exist. */
function currentImageOf(inspect: unknown): CurrentImage | undefined {
  if (inspect === undefined) return undefined;
  if (!isRecord(inspect) || typeof inspect.Id !== 'string') throw new Error('Docker answered the inspect of the image without its ID.');
  const config = isRecord(inspect.Config) ? inspect.Config : undefined;
  const labels = config !== undefined && isRecord(config.Labels) ? config.Labels : undefined;
  const label = labels?.[LABEL_HELPER_BASE_DIGEST];
  return { id: inspect.Id, ...(typeof label === 'string' && label !== '' ? { baseDigest: label } : {}) };
}

/** The first base image of the Dockerfile (with its ARG defaults), undefined when it has none. */
function firstBaseImage(content: string): string | undefined {
  try {
    return extractBaseImages(content)[0];
  } catch {
    return undefined;
  }
}

/** The text of the plain file `file` of at most MAX_DOCKERFILE_BYTES; undefined for anything else. Never throws. */
async function readDockerfile(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_DOCKERFILE_BYTES) return undefined;
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The build of the helper image by the Docker CLI of the Monitor's container (the helper image has it) over the socket
 * of the engine: `docker build --pull --no-cache` with the labels of a helper image (LABEL_HELPER, and
 * LABEL_HELPER_BASE_DIGEST with the digest of the check) and the version of the Dev Container CLI, from the folder of the
 * Dockerfile. Its environment holds only PATH, the socket, and a configuration folder of its own (removed after it).
 * Rejects with the last lines of its output when it fails, and with an AbortError when `signal` aborts (the CLI ends,
 * and so does the build).
 */
export async function cliHelperBuild(build: HelperBuild, signal: AbortSignal, runner: ProcessRunner = new NodeProcessRunner()): Promise<void> {
  const config = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devspaces-helper-build-'));
  try {
    const args = [
      'build',
      '--pull',
      '--no-cache',
      '--tag',
      build.tag,
      '--file',
      build.dockerfile,
      '--label',
      `${LABEL_HELPER}=true`,
      '--label',
      `${LABEL_HELPER_BASE_DIGEST}=${build.baseDigest}`,
      '--build-arg',
      `DEVCONTAINER_CLI_VERSION=${DEVCONTAINER_CLI_VERSION}`,
      path.posix.dirname(build.dockerfile),
    ];
    const env = { PATH: PREPARE_WORKER_PATH, DOCKER_HOST: `unix://${HELPER_DOCKER_SOCKET}`, DOCKER_CONFIG: config, HOME: config };
    const result = await runner.run('docker', args, { env, signal });
    if (result.exitCode !== 0) {
      const tail = lastLines(`${result.stdout}\n${result.stderr}`);
      throw new Error(tail !== '' ? tail : `docker build ended with the exit code ${String(result.exitCode)}.`);
    }
  } finally {
    await fs.promises.rm(config, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The last FAILED_BUILD_LINES lines of `text` that are not empty, each cut at MAX_FAILED_BUILD_LINE characters. */
function lastLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-FAILED_BUILD_LINES)
    .map((line) => (line.length > MAX_FAILED_BUILD_LINE ? `${line.slice(0, MAX_FAILED_BUILD_LINE - 1)}…` : line))
    .join(' | ');
}
