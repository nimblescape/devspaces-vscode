// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Monitor merges really identical devspace images (docs/requirements.md R-DS-010, the decision D6 of Hannes on
// 2026-11-12: "if it is really identical images, monitor can update it when it is idle, so that we have a cleaned up
// state"). Since R-DS-010 an open and a prepare tag a shared image instead of building an image of the same inputs;
// a devspace image that was built for one devspace before (or without a key) stays until its next update. A pass of the
// Monitor finds such a duplicate and moves its devspace to the shared image:
// - Which: the newest devspace image `<resource>:<n>` of each devspace of the engine (by its workspace volume,
//   scanDevspaceVolumes) that was built for the devspace alone (its labels, hasDevspaceImageLabel; only tags of its
//   devspace image) and that is really identical to a shared image (isSharedImage: vouched by a dev container of the
//   extension or the record of a prepare): the same layers and the same settings, apart from the labels of Devspaces
//   (imageContent). Not a devspace of Docker Compose (its record names the images of its services).
// - When: its dev containers are all stopped, and no other container uses the image (a running devspace is never
//   touched: it is merged at a pass after it stopped); and the lock of the devspace is free (an open, a Stop, a Delete
//   hold it), taken without a wait for the whole move. A pass runs when the Monitor is idle (main.ts: between two ticks,
//   never during a background run), every MERGE_CHECK_MS, and before the Monitor ends when idle.
// - How, under the lock: the stopped dev containers are removed (without force: one that started meanwhile stays, and
//   nothing else changes); the build record of the duplicate, for the next build number, with the ID and the key of the
//   shared image (movedBuildRecord), is written as the merge record of the devspace (mergeRecords.ts), because a shared
//   image carries no build record and the dev container that carried it is gone; the shared image gets the tag
//   `<resource>:<n+1>`; then the tags of the duplicate are removed, and with its last tag the image. The next Start
//   takes the merge record (newestImageRecord) and creates the dev container from the shared image, as after an update:
//   the files of the workspace volume stay, changes outside it are lost, and the lifecycle commands run again.
// - Also: the merge records whose devspace has no volume any more, or whose tag no longer names their image (the
//   devspace was updated or deleted), are removed.
// Every request to the engine goes over the Engine API, each within its time limit. Never throws; each move and each
// problem is one line of the log (a reason why a devspace is not merged only once per image while the Monitor runs).
import { errorMessage } from '../core/errors';
import type { MergeRecords } from '../core/helperChannel/mergeRecords';
import type { SharedImageRecords } from '../core/helperChannel/sharedImageRecords';
import { chosenSharedImage, canonicalJson, isSharedImage, sameImageId } from '../core/pipeline/imageKey';
import { containerBuildRecord, fitsOnDevContainer, imageBuildRecord, movedBuildRecord } from '../core/pipeline/imageRecord';
import {
  LABEL_DEVSPACE_ID,
  LABEL_IMAGE_KEY,
  LABEL_OWNER_ID,
  LABEL_PREFIX,
  devspaceImageName,
  devspaceImageRepository,
  hasDevspaceImageLabel,
  isImageKey,
  isKeyOnlyImage,
  isSharedImageTag,
} from '../core/names';
import { isStorageId } from '../core/storage/paths';
import type { BuildRecord } from '../core/types';
import { isRecord } from '../core/valueChecks';
import type { EngineContainer, EngineImage } from '../core/worker/dockerEngine';
import { engineFailure, type MergeEngine } from './engine';
import { scanDevspaceVolumes, type PrepareDevspace } from './prepares';
import type { StopLocker } from './stopLock';

/** The time between two passes. */
export const MERGE_CHECK_MS = 15 * 60_000;
/** The time from the start of the Monitor to its first pass (after the first check of the background run). */
export const MERGE_FIRST_MS = 2 * 60_000;
/** The time limit of each request to the engine of a pass (a list, an inspect, a tag, a removal). */
export const MERGE_ENGINE_TIMEOUT_MS = 60_000;

/** The label of Docker Compose on the containers of a project. */
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
/**
 * The diff ID of an empty layer (the SHA-256 of an empty tar archive): it adds no file. A commit of a container that
 * changed nothing, as the labels of a devspace image are added (labelImage), can add one on an image store that does
 * not leave it out.
 */
const EMPTY_LAYER = 'sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfb3e10ce5a1b6';

export interface ImageMergeDeps {
  engine: MergeEngine;
  log: (message: string) => void;
  /** The monotonic clock of the passes (ms). */
  monotonic: () => number;
  /** Takes the lock of a devspace without a wait (the stop lock of the Monitor, stopLock.ts). */
  lockDevspace: StopLocker;
  /** The records of the shared images that a prepare built: they vouch for their images (isSharedImage). */
  sharedImageRecords: SharedImageRecords;
  /** The merge records (mergeRecords.ts) that this part writes and removes. */
  mergeRecords: MergeRecords;
  /** MERGE_CHECK_MS and MERGE_FIRST_MS (the tests give their own). */
  checkMs?: number;
  firstMs?: number;
}

/** A listed image as a pass knows it. */
interface ListedImage {
  id: string;
  tags: string[];
  labels: Record<string, string>;
  createdAt: string;
}

/** A shared image of a pass: its key, and what decides whether it is identical to a devspace image (imageContent). */
interface SharedCandidate extends ListedImage {
  key: string;
  content: string;
}

/** A devspace image of a pass that may be merged: the newest image of its devspace, built for it alone. */
interface MergeCandidate {
  devspace: PrepareDevspace;
  image: ListedImage;
  /** Its build number (the tag `<resource>:<buildNumber>`). */
  buildNumber: number;
}

/**
 * What decides whether two images are really identical (D6): the layers (without empty ones, EMPTY_LAYER), and the
 * settings of the image (its `Config`, the operating system and the architecture) without the labels of Devspaces
 * (LABEL_PREFIX), which make each devspace image an image of its own, and without `Image` (the parent image of the
 * classic builder, which no container uses). Settings without a value (null) count as missing. So a container created
 * from either image has the same files and the same settings. The canonical JSON of these, or `undefined` when the
 * inspect JSON `inspect` has no layers or no settings (such an image is identical to none).
 */
export function imageContent(inspect: unknown): string | undefined {
  if (!isRecord(inspect) || !isRecord(inspect.RootFS) || !isRecord(inspect.Config)) return undefined;
  const listed = inspect.RootFS.Layers;
  if (!Array.isArray(listed) || !listed.every((layer) => typeof layer === 'string')) return undefined;
  const layers = listed.filter((layer) => layer !== EMPTY_LAYER);
  if (layers.length === 0) return undefined;
  const { Labels: labels, Image: _parent, ...config } = inspect.Config;
  const settings = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== null && value !== undefined));
  const ownLabels = isRecord(labels) ? Object.fromEntries(Object.entries(labels).filter(([key]) => !key.startsWith(LABEL_PREFIX))) : {};
  return canonicalJson({
    layers,
    type: inspect.RootFS.Type ?? null,
    settings,
    labels: ownLabels,
    os: inspect.Os ?? null,
    architecture: inspect.Architecture ?? null,
    variant: inspect.Variant ?? null,
  });
}

/** Whether the container `container` is stopped (created or exited: Docker removes it without force). */
function isStopped(container: EngineContainer): boolean {
  return container.rawState === 'exited' || container.rawState === 'created';
}

/** The build number of `tag` when it is a tag `<repository>:<number>` of the devspace image `repository`, else undefined. */
function buildNumberOf(tag: string, repository: string): number | undefined {
  if (!tag.startsWith(`${repository}:`)) return undefined;
  const text = tag.slice(repository.length + 1);
  if (!/^[1-9][0-9]*$/.test(text)) return undefined;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : undefined;
}

/** The merge of identical devspace images (see the module comment). */
export class ImageMerge {
  private nextAt: number;
  /** The reasons that were logged, one line per image and reason while the Monitor runs. */
  private readonly logged = new Set<string>();
  /** The failure of the last pass, which a pass with the same failure does not log again. */
  private lastFailure: string | undefined;

  constructor(private readonly deps: ImageMergeDeps) {
    this.nextAt = deps.monotonic() + (deps.firstMs ?? MERGE_FIRST_MS);
  }

  /** Whether a pass is due (MERGE_CHECK_MS after the last one). */
  due(): boolean {
    return this.deps.monotonic() >= this.nextAt;
  }

  /** One pass (see the module comment); the next one is due MERGE_CHECK_MS after its end. Never throws. */
  async pass(): Promise<void> {
    try {
      await this.passOnce();
      this.lastFailure = undefined;
    } catch (error) {
      const failure = `The identical devspace images could not be merged: ${engineFailure(error, MERGE_ENGINE_TIMEOUT_MS)}`;
      if (failure !== this.lastFailure) this.deps.log(failure);
      this.lastFailure = failure;
    } finally {
      this.nextAt = this.deps.monotonic() + (this.deps.checkMs ?? MERGE_CHECK_MS);
    }
  }

  private async passOnce(): Promise<void> {
    const { engine } = this.deps;
    const volumes = await scanDevspaceVolumes(engine).catch((error: unknown) => {
      throw new Error(`the volumes of the devspaces could not be read: ${engineFailure(error, MERGE_ENGINE_TIMEOUT_MS)}`);
    });
    await this.removeStaleRecords(volumes.devspaces, volumes.complete);
    const shared = (await this.listImages(LABEL_IMAGE_KEY)).filter((image) => isKeyOnlyImage(image.labels) && isImageKey(image.labels[LABEL_IMAGE_KEY]) && image.tags.some(isSharedImageTag));
    if (shared.length === 0) return;
    const candidates = this.mergeCandidates(volumes.devspaces, await this.listImages(LABEL_DEVSPACE_ID), shared);
    if (candidates.length === 0) return;
    const containers = await engine.containers(LABEL_DEVSPACE_ID, this.limit());
    const vouched: SharedCandidate[] = [];
    for (const image of shared) {
      const key = image.labels[LABEL_IMAGE_KEY]!;
      if (!isSharedImage(image, key, containers, this.deps.sharedImageRecords.read(key))) continue;
      const content = imageContent(await engine.inspect('image', image.id, this.limit()));
      if (content !== undefined) vouched.push({ ...image, key, content });
    }
    if (vouched.length === 0) return;
    for (const candidate of candidates) {
      const content = imageContent(await engine.inspect('image', candidate.image.id, this.limit()));
      if (content === undefined) continue;
      const target = chosenSharedImage(vouched.filter((image) => image.content === content));
      if (target === undefined) continue;
      await this.merge(candidate, target);
    }
  }

  /** The images with the label `label` (each a ListedImage). Throws when the engine cannot list them. */
  private async listImages(label: string): Promise<ListedImage[]> {
    const images: EngineImage[] = await this.deps.engine.images({ label: [label] }, this.limit());
    return images.map((image) => ({ id: image.id, tags: image.repoTags, labels: image.labels, createdAt: image.created }));
  }

  /**
   * The newest devspace image of each devspace of `devspaces` (the highest build number of its devspace image) when it
   * was built for that devspace alone (its labels name it, it carries no key) and carries only tags of its devspace
   * image (no prepared tag, no name of a user, no tag of another repository).
   */
  private mergeCandidates(devspaces: readonly PrepareDevspace[], devspaceImages: readonly ListedImage[], shared: readonly ListedImage[]): MergeCandidate[] {
    const candidates: MergeCandidate[] = [];
    const all = [...devspaceImages, ...shared.filter((image) => !devspaceImages.some((other) => sameImageId(other.id, image.id)))];
    for (const devspace of devspaces) {
      const repository = devspaceImageRepository(devspace.repository, devspace.id);
      let newest: { image: ListedImage; buildNumber: number } | undefined;
      for (const image of all) {
        for (const tag of image.tags) {
          const buildNumber = buildNumberOf(tag, repository);
          if (buildNumber !== undefined && (newest === undefined || buildNumber > newest.buildNumber)) newest = { image, buildNumber };
        }
      }
      if (newest === undefined) continue;
      const { image, buildNumber } = newest;
      if (!hasDevspaceImageLabel(image.labels) || image.labels[LABEL_IMAGE_KEY] !== undefined || image.labels[LABEL_DEVSPACE_ID] !== devspace.id) continue;
      if (!image.tags.every((tag) => buildNumberOf(tag, repository) !== undefined)) {
        this.note(image.id, `The devspace image ${devspaceImageName(devspace.repository, devspace.id, buildNumber)} of ${devspace.repository} has a tag that is not of its devspace image; it is not merged with a shared image.`);
        continue;
      }
      candidates.push({ devspace, image, buildNumber });
    }
    return candidates;
  }

  /**
   * Moves the devspace of `candidate` to the shared image `target` (see the module comment), under the lock of the
   * devspace, after it looked again at its containers and its tag. Throws when the engine cannot list or inspect.
   */
  private async merge(candidate: MergeCandidate, target: SharedCandidate): Promise<void> {
    const { devspace, image, buildNumber } = candidate;
    const tag = devspaceImageName(devspace.repository, devspace.id, buildNumber);
    const lock = await this.deps.lockDevspace(devspace.id);
    // An open, a Stop or a Delete holds it: the devspace is merged at a later pass.
    if (lock.kind === 'busy') return;
    if (lock.kind === 'failed') {
      this.note(image.id, `The devspace image ${tag} of ${devspace.repository} is not merged with the identical shared image ${target.id}: the lock of the devspace could not be taken (${lock.detail}).`);
      return;
    }
    try {
      await this.mergeLocked(candidate, target, tag);
    } finally {
      lock.release();
    }
  }

  private async mergeLocked(candidate: MergeCandidate, target: SharedCandidate, tag: string): Promise<void> {
    const { engine, log } = this.deps;
    const { devspace, image, buildNumber } = candidate;
    const not = (reason: string) => this.note(image.id, `The devspace image ${tag} of ${devspace.repository} is not merged with the identical shared image ${target.id}: ${reason}.`);
    // Under the lock, again: the tag still names the image, and the next build number is free.
    const nextTag = devspaceImageName(devspace.repository, devspace.id, buildNumber + 1);
    if (!(await this.names(tag, image.id)) || (await this.imageIdOf(nextTag)) !== undefined) return;
    // The dev containers of the devspace: all of them created from the image and stopped; no other container uses it.
    const devContainers = await engine.containers(`${LABEL_DEVSPACE_ID}=${devspace.id}`, this.limit());
    if (devContainers.some((container) => !isStopped(container))) return;
    if (devContainers.some((container) => container.imageId === undefined || !sameImageId(container.imageId, image.id))) {
      return not('a container of the devspace was created from another image');
    }
    if (devContainers.some((container) => container.labels[COMPOSE_PROJECT_LABEL] !== undefined)) return not('it is a devspace of Docker Compose');
    const users = await engine.containerIds({ ancestor: [image.id] }, this.limit());
    if (users.some((id) => !devContainers.some((container) => sameImageId(container.id, id)))) return not('another container uses it');
    // The build record of the image: from its dev container (the labels of its devspace), else from the image.
    const ownerId = image.labels[LABEL_OWNER_ID];
    if (!isStorageId(ownerId)) return not('its labels name no owner');
    const env = { id: devspace.id, repository: devspace.repository, owner: { id: ownerId, login: '' } };
    const record: BuildRecord | undefined =
      devContainers.map((container) => containerBuildRecord(container.labels, env)).find((found) => found !== undefined && found.buildNumber === buildNumber) ??
      imageBuildRecord(image.labels, env, tag, buildNumber);
    if (record === undefined) return not('it has no build record of the devspace');
    if (record.compose !== undefined) return not('it is a devspace of Docker Compose');
    const moved = movedBuildRecord(record, devspace, buildNumber + 1, target.id, target.key);
    if (!fitsOnDevContainer(moved)) return not('its build record would not fit on the dev container');
    // The move. The stopped dev containers first: Docker refuses one that started meanwhile, and nothing else changes.
    for (const container of devContainers) {
      const removed = await engine.removeStoppedContainer(container.id, this.limit());
      if (removed === 'refused') return not(`Docker refused to remove its container ${container.name}, which started or is being removed`);
    }
    try {
      this.deps.mergeRecords.write(devspace.id, { ownerId, record: moved });
    } catch (error) {
      return not(`its merge record could not be written (${errorMessage(error)}); its stopped container was removed, so the next Start creates it from the devspace image again`);
    }
    try {
      await engine.tagImage(target.id, nextTag, this.limit());
      if (!(await this.names(nextTag, target.id))) throw new Error(`the tag ${nextTag} does not name it`);
    } catch (error) {
      await engine.removeImage(nextTag, this.limit()).catch(() => undefined);
      this.deps.mergeRecords.remove(devspace.id);
      return not(`the shared image could not be tagged ${nextTag} (${engineFailure(error, MERGE_ENGINE_TIMEOUT_MS)}); its stopped container was removed, so the next Start creates it from the devspace image again`);
    }
    for (const old of image.tags) {
      try {
        await engine.removeImage(old, this.limit());
      } catch (error) {
        log(`The tag ${old} of the merged devspace image ${image.id} could not be removed: ${engineFailure(error, MERGE_ENGINE_TIMEOUT_MS)}`);
      }
    }
    // Only the number of its tags: they name the devspaces of other repositories, also of other accounts.
    const count = `${target.tags.length} ${target.tags.length === 1 ? 'tag' : 'tags'}`;
    const containers = devContainers.length === 0 ? 'it had no container' : `its stopped container ${devContainers.map((container) => container.name).join(', ')} was removed`;
    log(
      `The devspace image ${tag} of ${devspace.repository} was identical to the shared image ${target.id} (${count}): the devspace image is now ${nextTag} on the shared image, and ${containers}. The next Start creates the dev container from it.`,
    );
  }

  /** Whether `reference` names the image `id` now. Throws when the engine cannot inspect. */
  private async names(reference: string, id: string): Promise<boolean> {
    const found = await this.imageIdOf(reference);
    return found !== undefined && sameImageId(found, id);
  }

  /** The ID of the image that `reference` names, or undefined. Throws when the engine cannot inspect. */
  private async imageIdOf(reference: string): Promise<string | undefined> {
    const inspect = await this.deps.engine.inspect('image', reference, this.limit());
    return isRecord(inspect) && typeof inspect.Id === 'string' ? inspect.Id : undefined;
  }

  /**
   * Removes the merge records whose devspace has no volume any more (only when every volume could be read: `complete`),
   * that are not valid, or whose tag no longer names their image. Never throws (a record that cannot be checked stays).
   */
  private async removeStaleRecords(devspaces: readonly PrepareDevspace[], complete: boolean): Promise<void> {
    const records = this.deps.mergeRecords;
    for (const id of records.list()) {
      const devspace = devspaces.find((entry) => entry.id === id);
      const merge = records.read(id);
      let stale: string | undefined;
      if (devspace === undefined) stale = complete ? 'its devspace has no volume' : undefined;
      else if (merge === undefined) stale = 'it is not valid';
      else {
        try {
          if (!(await this.names(merge.record.devspaceImage, merge.record.imageId))) stale = `its tag ${merge.record.devspaceImage} no longer names its image`;
        } catch {
          // Looked at again at the next pass.
        }
      }
      if (stale === undefined) continue;
      records.remove(id);
      this.deps.log(`The merge record of the devspace ${id} was removed: ${stale}.`);
    }
  }

  /** Logs `message` once per image and message while the Monitor runs. */
  private note(imageId: string, message: string): void {
    const key = `${imageId} ${message}`;
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.deps.log(message);
  }

  private limit(): AbortSignal {
    return AbortSignal.timeout(MERGE_ENGINE_TIMEOUT_MS);
  }
}
