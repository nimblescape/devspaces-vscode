// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The image key of a shared devspace image (R-DS-010): the hash of every input of `devcontainer build` for a
// configuration that names an image, so that devspaces whose builds have the same inputs use one image instead of one
// identical image each. Pure functions, no I/O.
//
// What `devcontainer build` of such a configuration reads (Dev Container CLI 0.90.0): the image and the Features (with
// their options) of the configuration with its variables resolved, the lockfile next to the configuration, and the
// properties of the configuration that it writes into the label devcontainer.metadata of the image. That label holds
// the properties as written, with their variables (the CLI resolves them at `up`), so the key holds the configuration
// both as written and as resolved: two configurations whose resolved values are the same, but whose text differs (a
// variable in one, its value in the other), give different images.
import * as crypto from 'crypto';
import { hasDigest, isOciFeatureReference } from '../imageCheck/reference';
import { LABEL_IMAGE_KEY, hasDevspaceImageLabel, isSharedImageTag } from '../names';
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
  /** The Dockerfile of the configuration was read (its text). */
  dockerfile: boolean;
  /** The state of the host access checks of the repository. */
  hostAccessChecks: 'on' | 'off';
  /** The lockfile next to the configuration could not be read (no plain file of the repository, or too long). */
  lockfileUnreadable: boolean;
  /** Feature reference → the digest that the registry answered in this open; `undefined` without a check. */
  answeredFeatures: Readonly<Record<string, string>> | undefined;
}

/** What sharedImageInputs gives for a build that gives a shared image. */
export interface SharedImageInputs {
  /** The image reference of the configuration (trimmed), whose local image ID the caller reads. */
  image: string;
  /** Each Feature reference without a digest → the digest that the registry answered for it in this open. */
  features: Record<string, string>;
  /** SharedImageFacts.written (an object). */
  written: Readonly<Record<string, unknown>>;
}

/**
 * The inputs of the key of a shared image for a build with the facts `facts` (SharedImageInputs); else why the build gives no shared image
 * (`reason`, for the log: the devspace builds an image of its own, as before R-DS-010). A shared image needs:
 * - a configuration with an image: not Docker Compose (its images stay those of the devspace), and no Dockerfile (the
 *   build context of the repository is not part of the key);
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
  if (facts.dockerfile || config.dockerFile !== undefined || (isRecord(config.build) && config.build.dockerfile !== undefined)) {
    return { reason: 'its configuration builds a Dockerfile' };
  }
  if (typeof config.image !== 'string' || config.image.trim() === '') return { reason: 'its configuration names no image' };
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
  return { image: config.image.trim(), features, written: facts.written };
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
