// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The image key of a shared devspace image (R-DS-010): the hash of every input of `devcontainer build` for a
// configuration that names an image or builds a Dockerfile, so that devspaces whose builds have the same inputs use one
// image instead of one identical image each. Pure functions, no I/O.
//
// What `devcontainer build` of such a configuration reads (Dev Container CLI 0.90.0): the image and the Features (with
// their options) of the configuration with its variables resolved, the lockfile next to the configuration, and the
// properties of the configuration that it writes into the label devcontainer.metadata of the image. That label holds
// the properties as written, with their variables (the CLI resolves them at `up`), so the key holds the configuration
// both as written and as resolved: two configurations whose resolved values are the same, but whose text differs (a
// variable in one, its value in the other), give different images.
//
// A configuration with a Dockerfile builds that Dockerfile first, from its build context, then the Features on top. The
// key then holds the Dockerfile, its path in the build context, the hash of every file and folder of the build context
// (CONTEXT_TREE of the helper: names, modes, contents, and the targets of links; a superset of what Docker reads, so
// that the same hash always gives the same build context, whatever its .dockerignore says), and every image that the
// Dockerfile reads (keyedDockerfileImages). The build reads a copy of the build context whose hash it checked
// (WRITE_AND_RUN_SCRIPT), so a change of the working copy after the hash never goes into an image of that key.
import * as crypto from 'crypto';
import * as path from 'path';
import { buildArgumentTexts, keyedDockerfileImages } from '../imageCheck/dockerfile';
import { hasDigest, isOciFeatureReference } from '../imageCheck/reference';
import { LABEL_IMAGE_KEY, configurationFolder, hasDevspaceImageLabel, isSharedImageTag } from '../names';
import type { DevcontainerConfig } from '../types';
import { recordedImageKey } from './imageRecord';
import { isRecord } from '../valueChecks';

/** The version of the inputs of the key: a change gives every image a new key (none is shared with an older one). */
export const IMAGE_KEY_VERSION = 1;

/**
 * The properties of devcontainer.json that `devcontainer build` of a configuration with an image neither reads nor
 * writes into the label devcontainer.metadata (CLI 0.90.0 writes only the properties of its list of image metadata
 * properties there; imageKey.test.ts compares the two lists), and `configFilePath`, which read-configuration adds (the
 * path of the file in the helper, which names the repository). Every other property is part of the key: one that the
 * extension does not know only keeps an image from being shared.
 */
export const NOT_IN_IMAGE_PROPERTIES: readonly string[] = ['name', 'workspaceFolder', 'workspaceMount', 'runArgs', 'appPort', 'initializeCommand', 'configFilePath'];

/** The inputs of one build for imageKey. */
export interface ImageKeyInput {
  /** The version of the Dev Container CLI that builds (DEVCONTAINER_CLI_VERSION of the helper image). */
  cliVersion: string;
  /** devcontainer.json as written (parsed), or the synthesized configuration of the default image. */
  written: Readonly<Record<string, unknown>>;
  /** The configuration as read-configuration returned it, with its variables resolved. */
  resolved: Readonly<Record<string, unknown>>;
  /** Each image reference of the configuration → the ID of the local image that the build starts from. */
  images: Readonly<Record<string, string>>;
  /** Each Feature reference without a digest → the digest that the registry answered for it in this open. */
  features: Readonly<Record<string, string>>;
  /** The text of the lockfile next to the configuration; `null` without one. */
  lockfileText: string | null;
  /**
   * A build from a Dockerfile (SharedImageInputs.dockerfile): its text, its path in the build context, and the hash of
   * the build context (CONTEXT_TREE of the helper).
   */
  dockerfile?: { text: string; path: string; contextHash: string };
}

/** The image key (`sha256:<64 hex>`, isImageKey) of the build with the inputs `input`. */
export function imageKey(input: ImageKeyInput): string {
  const value = {
    v: IMAGE_KEY_VERSION,
    cli: input.cliVersion,
    written: inImage(input.written),
    resolved: inImage(input.resolved),
    images: input.images,
    features: input.features,
    lockfile: input.lockfileText,
    // Only for a Dockerfile: the key of a configuration with an image stays what it was.
    ...(input.dockerfile !== undefined ? { dockerfile: input.dockerfile } : {}),
  };
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

/** `config` without NOT_IN_IMAGE_PROPERTIES (own properties only, also one named `__proto__`). */
function inImage(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !NOT_IN_IMAGE_PROPERTIES.includes(key)));
}

/**
 * JSON of `value` with the keys of each object sorted, without spaces: the same text for the same value whatever the
 * order of its keys. A value that JSON has no text for (undefined, a function) is `null`.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What decides whether a build gives a shared image (sharedImageInputs). */
export interface SharedImageFacts {
  /** A Docker Compose configuration. */
  compose: boolean;
  /** devcontainer.json as written (parsed); `undefined` when it is no JSON object. */
  written: Readonly<Record<string, unknown>> | undefined;
  /** The configuration as read-configuration returned it. */
  resolved: DevcontainerConfig;
  /** The path of the configuration relative to the repository folder (the build context and the Dockerfile are resolved against its folder). */
  configPath: string;
  /** The text of the Dockerfile that the configuration names, when it was read. */
  dockerfileText?: string;
  /** The state of the host access checks of the repository. */
  hostAccessChecks: 'on' | 'off';
  /** The lockfile next to the configuration could not be read (no plain file of the repository, or too long). */
  lockfileUnreadable: boolean;
  /** Feature reference → the digest that the registry answered in this open; `undefined` without a check. */
  answeredFeatures: Readonly<Record<string, string>> | undefined;
}

/** What sharedImageInputs gives for a build that gives a shared image. */
export interface SharedImageInputs {
  /**
   * The image references whose local image IDs the caller reads: the image of the configuration (trimmed), or the
   * images that its Dockerfile reads (none for a Dockerfile of `scratch` only).
   */
  images: string[];
  /** Each Feature reference without a digest → the digest that the registry answered for it in this open. */
  features: Record<string, string>;
  /** SharedImageFacts.written (an object). */
  written: Readonly<Record<string, unknown>>;
  /**
   * A build from a Dockerfile: the build context relative to the repository folder (`.` for the folder itself), the
   * Dockerfile relative to the build context, and its text. The caller adds the hash of the build context.
   */
  dockerfile?: { context: string; path: string; text: string };
}

/**
 * The inputs of the key of a shared image for a build with the facts `facts` (SharedImageInputs); else why the build gives no shared image
 * (`reason`, for the log: the devspace builds an image of its own, as before R-DS-010). A shared image needs:
 * - a configuration with an image or a Dockerfile, not Docker Compose (its images stay those of the devspace); for a
 *   Dockerfile see dockerfileInputs;
 * - the host access checks on;
 * - a lockfile that can be read, or none;
 * - only Features of a registry (OCI references): a local Feature is read from the repository, a URL of a tarball has no
 *   digest; each without a digest as written, and with the digest that the registry answered in this open (a tag whose
 *   digest is not known may give another Feature; the answer shows that the account of the open can read the Feature,
 *   which a reference with a digest, never asked, does not).
 */
export function sharedImageInputs(facts: SharedImageFacts): SharedImageInputs | { reason: string } {
  if (facts.compose) return { reason: 'it is a Docker Compose configuration' };
  const config = facts.resolved;
  const build: Record<string, unknown> = isRecord(config.build) ? config.build : {};
  const raw = config as Record<string, unknown>;
  const named = typeof build.dockerfile === 'string' ? build.dockerfile : typeof raw.dockerFile === 'string' ? raw.dockerFile : undefined;
  let images: string[];
  let dockerfile: SharedImageInputs['dockerfile'];
  if (named !== undefined || build.dockerfile !== undefined || raw.dockerFile !== undefined || facts.dockerfileText !== undefined) {
    const found = dockerfileInputs(facts, build, raw, named);
    if ('reason' in found) return found;
    ({ images, dockerfile } = found);
  } else {
    if (typeof config.image !== 'string' || config.image.trim() === '') return { reason: 'its configuration names no image' };
    images = [config.image.trim()];
  }
  if (facts.hostAccessChecks !== 'on') return { reason: 'the host access checks are off for it' };
  if (facts.written === undefined) return { reason: 'its configuration is no JSON object' };
  if (facts.lockfileUnreadable) return { reason: 'its lockfile cannot be read' };
  const features: Record<string, string> = {};
  if (config.features !== undefined && config.features !== null) {
    if (!isRecord(config.features)) return { reason: 'its Features are not an object' };
    for (const reference of Object.keys(config.features)) {
      if (!isOciFeatureReference(reference)) return { reason: `its Feature ${reference} is not in a registry` };
      // The registry answers only a reference without a digest. That answer shows that the account of this open can read
      // the Feature; without it, a shared image could give it a Feature of a registry that it cannot read.
      if (hasDigest(reference)) return { reason: `its Feature ${reference} has a digest, so the registry was not asked for it in this open` };
      const digest = facts.answeredFeatures?.[reference];
      if (digest === undefined) return { reason: `the digest of its Feature ${reference} is not known in this open` };
      features[reference] = digest;
    }
  }
  return { images, features, written: facts.written, ...(dockerfile !== undefined ? { dockerfile } : {}) };
}

/**
 * sharedImageInputs of a configuration with a Dockerfile (`named`, the Dockerfile as the resolved configuration names
 * it; `build` and `raw` its `build` and the configuration): the images that the Dockerfile reads, and where the build
 * context and the Dockerfile are; else why it gives no shared image. The build context and the Dockerfile are resolved
 * as the Dev Container CLI 0.90.0 resolves them: against the folder of the configuration, and without a build context,
 * the folder of the Dockerfile. A shared image needs:
 * - a Dockerfile that was read, inside the build context, which is inside the repository (its files are hashed, and the
 *   build reads a copy of them), both named by relative paths;
 * - no options of `docker build` (`build.options`) and no import of a build cache (`build.cacheFrom`): they read what
 *   the key does not name;
 * - only images that the key can name (keyedDockerfileImages).
 */
function dockerfileInputs(
  facts: SharedImageFacts,
  build: Record<string, unknown>,
  raw: Record<string, unknown>,
  named: string | undefined,
): { images: string[]; dockerfile: NonNullable<SharedImageInputs['dockerfile']> } | { reason: string } {
  if (named === undefined || named === '' || facts.dockerfileText === undefined) return { reason: 'its Dockerfile could not be read' };
  if (build.options !== undefined && !(Array.isArray(build.options) && build.options.length === 0)) return { reason: 'its build passes options to Docker (build.options)' };
  if (build.cacheFrom !== undefined) return { reason: 'its build imports a build cache (build.cacheFrom)' };
  const contextValue = typeof build.context === 'string' ? build.context : typeof raw.context === 'string' ? raw.context : undefined;
  if (named.includes('${') || contextValue?.includes('${') === true) return { reason: 'its Dockerfile or its build context has a variable that is not resolved' };
  // Resolved against a folder that stands for the repository folder, so only relative paths.
  if (path.posix.isAbsolute(named) || (contextValue !== undefined && path.posix.isAbsolute(contextValue))) return { reason: 'its Dockerfile or its build context has an absolute path' };
  const repository = '/repository';
  const folder = path.posix.resolve(repository, configurationFolder(facts.configPath));
  const dockerfileFile = path.posix.resolve(folder, named);
  const contextFolder = contextValue === undefined || contextValue === '' ? path.posix.dirname(dockerfileFile) : path.posix.resolve(folder, contextValue);
  if (contextFolder !== repository && !contextFolder.startsWith(`${repository}/`)) return { reason: 'its build context is outside of the repository' };
  const inContext = path.posix.relative(contextFolder, dockerfileFile);
  if (inContext === '' || inContext === '..' || inContext.startsWith('../') || path.posix.isAbsolute(inContext)) return { reason: 'its Dockerfile is outside of its build context' };
  const read = keyedDockerfileImages(facts.dockerfileText, buildArgumentTexts(build.args), typeof build.target === 'string' ? { target: build.target } : {});
  if ('reason' in read) return read;
  return { images: read.images, dockerfile: { context: path.posix.relative(repository, contextFolder) || '.', path: inContext, text: facts.dockerfileText } };
}

/** Whether the image IDs `a` and `b` name the same image (without case). */
export function sameImageId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The checks of isSharedImage on the image alone (its key, its labels, its tags), before the dev containers that vouch
 * for it are listed.
 */
export function isSharedImageCandidate(image: { tags: readonly string[]; labels: Readonly<Record<string, string>> }, key: string): boolean {
  return image.labels[LABEL_IMAGE_KEY] === key && !hasDevspaceImageLabel(image.labels) && image.tags.some(isSharedImageTag);
}

/**
 * Whether the image `image` (listed by the label LABEL_IMAGE_KEY) is a shared devspace image of the key `key` that a
 * build or a prepare may tag instead of building:
 * - it carries the key, and none of the labels of an image built for one devspace (DEVSPACE_IMAGE_LABELS: such an
 *   image never got the key from the extension, a key label on it comes from its base image or its Dockerfile);
 * - it has the tag of a devspace image or of a prepared devspace image (isSharedImageTag);
 * - something that only the extension writes vouches for it: a dev container of `containers` (the dev containers of
 *   every devspace) that was created from it (its image ID) and carries a build record with the key
 *   (recordedImageKey), which the extension writes after it built or tagged the image as a shared image of the key; or
 *   the record of a background prepare that built it for the key (`recorded`: the image ID of the record of the key,
 *   sharedImageRecords.ts, in the volume of the Monitor), before any container was created from it. The label of the
 *   key and the tag are not enough: the Dockerfile of another repository can write the key into the image that it
 *   builds, which has the tag of its devspace image (or of its prepared image) from the end of its build until the
 *   extension adds the labels of the devspace.
 */
export function isSharedImage(
  image: { id: string; tags: readonly string[]; labels: Readonly<Record<string, string>> },
  key: string,
  containers: ReadonlyArray<{ imageId?: string; labels: Readonly<Record<string, string>> }>,
  recorded?: string,
): boolean {
  if (!isSharedImageCandidate(image, key)) return false;
  if (recorded !== undefined && sameImageId(recorded, image.id)) return true;
  return containers.some((container) => container.imageId !== undefined && sameImageId(container.imageId, image.id) && recordedImageKey(container.labels) === key);
}

/**
 * Of the shared images `images` (isSharedImage), the one that a build or a prepare tags: the image of the record of a
 * prepare for the key (`recorded`, its image ID), which the record keeps vouched after its dev containers are gone; else
 * the newest (the latest rebuild), then the smallest ID; so that every open and prepare of the same key takes the same
 * image.
 */
export function chosenSharedImage<T extends { id: string; createdAt: string }>(images: readonly T[], recorded?: string): T | undefined {
  const ofRecord = recorded !== undefined ? images.find((image) => sameImageId(image.id, recorded)) : undefined;
  return ofRecord ?? [...images].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt < b.createdAt ? 1 : -1))[0];
}
