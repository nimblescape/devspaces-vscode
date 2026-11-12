// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The cleanup of the Docker engine by the Monitor (docs/requirements.md R-DS-007): a part of its background run
// (background.ts), right after the check of the workspace helper image. The Monitor is the only part of Devspaces that
// removes these objects; the windows do not remove them anymore. It removes what no container uses, never with force,
// in this order:
//   1. The stopped helper containers older than 10 minutes (the channels and the batch helpers of the workers, never the
//      Monitor: the prune with SWEEP_FILTERS, as the sweep of a window at the open of its channel).
//   2. The monitor tags `devspaces-monitor:<hash>` whose helper tag is not on the same image (a rebuild moved it, or it
//      was removed), the helper tags `devspaces-worker:<hash>` that no running container used for 7 days (never the
//      helper tag of the Monitor; its monitor tag first), and then the helper images without any tag: the earlier
//      builds of a helper tag.
//   3. The tags of the build image `devspaces-buildx:<version>` of a version older than the pin of the Monitor.
//   4. The older base images of the helper image: an image that was the direct base image of a helper image (its
//      layers are the start of the layers of the helper image, CleanupState.helperBases), when it is not the image of
//      the base image of the Dockerfile of the Monitor's helper image, no image reference in use points to it, no other
//      image is built on it, and it has at most one tag (a second tag may be a name that a user gave it).
//   5. On the VM of Devspaces only: the records of the build cache that no build used for 7 days.
// Docker refuses to remove an image that a container uses (also a stopped one): such an image stays, and the log names
// it. When the Monitor moved to a newer helper build (selfUpgrade.ts), its successor removes the container of the earlier
// Monitor and its build; the next cleanup removes that build when a worker still used it then.
// Which helper tags running containers use is looked at every HELPER_USE_OBSERVE_MS while the Monitor runs (observe),
// and kept in the volume (CLEANUP_FILE). Never throws; each problem is one line of the log. No `vscode`.
import { BUILDX_PIN, BUILDX_REPOSITORY, isOlderBuildxTag, type BuildxPin } from '../core/docker/buildxImage';
import { errorMessage } from '../core/errors';
import { isHelperImageTag, monitorImageTag } from '../core/helper/helperState';
import { SWEEP_FILTERS } from '../core/helperChannel/protocol';
import { LABEL_HELPER } from '../core/names';
import { parseImageReference } from '../core/remoteMonitor/protocol';
import { referenceText } from '../core/remoteMonitor/registryAnswers';
import { isRecord } from '../core/valueChecks';
import {
  BUILD_CACHE_UNUSED_FILTER,
  cleanupStateText,
  directBaseIds,
  isBuiltOn,
  observedHelperTags,
  parseCleanupState,
  staleMonitorTags,
  unusedHelperTags,
  type CleanupState,
  type TaggedImage,
} from './cleanupRules';
import { engineFailure, type CleanupEngine } from './engine';
import { IMAGE_LIST_TIMEOUT_MS, IMAGE_REMOVE_TIMEOUT_MS, type ReferencesInUse } from './images';

/** The time limit of the prune of the stopped helper containers. */
export const CONTAINER_PRUNE_TIMEOUT_MS = 60_000;
/** The time limit of the prune of the build cache, which can hold many gigabytes. */
export const BUILD_CACHE_PRUNE_TIMEOUT_MS = 10 * 60_000;

export interface EngineCleanupDeps {
  engine: CleanupEngine;
  log: (message: string) => void;
  now: () => number;
  /** The text of the record in the volume (CLEANUP_FILE), undefined when there is none; and its atomic write. */
  record: { read(): Promise<string | undefined>; write(text: string): Promise<void> };
  /**
   * The helper tag of the Monitor and the base image of its helper image (ownHelperImage of helperRefresh.ts); undefined
   * when they are not known: then no helper tag and no base image is removed.
   */
  ownHelper: () => Promise<{ tag: string; baseImage: string | undefined } | undefined>;
  /** The image references in use that the computers sent (readImagesInUse of main.ts): their images stay. */
  referencesInUse: () => Promise<ReferencesInUse>;
  /** The Monitor runs on the VM of Devspaces (DEVSPACE_MONITOR_VM): only there the build cache is pruned. */
  vm: boolean;
  /** The pin of the build image (default BUILDX_PIN, the one of the Monitor's script; the tests give their own). */
  buildx?: BuildxPin;
}

/** The outcome of one removal; `failed` was logged. */
type Removal = 'removed' | 'missing' | 'inUse' | 'failed';

/** The cleanup of the engine (see the module comment). */
export class EngineCleanup {
  /** A look and a pass never run at the same time (both write the record). */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: EngineCleanupDeps) {}

  /** Records which helper tags running containers use now. Never throws. */
  observe(): Promise<void> {
    return this.serial(async () => {
      const helpers = await this.helperImages(false);
      if (helpers === undefined) return;
      const state = await this.readState();
      if (await this.observeInto(state, helpers)) await this.writeState(state);
    });
  }

  /** One cleanup (see the module comment). Never throws. */
  pass(): Promise<void> {
    return this.serial(() => this.passOnce());
  }

  private serial(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work).catch((error: unknown) => {
      this.deps.log(`The cleanup of the engine failed: ${errorMessage(error)}`);
    });
    this.queue = next;
    return next;
  }

  private async passOnce(): Promise<void> {
    const { log } = this.deps;
    const inUse: string[] = [];
    await this.pruneHelperContainers();
    const state = await this.readState();
    const own = await this.deps.ownHelper().catch(() => undefined);
    // The layers of every image before the removals, so that the base images of the helper images that this pass removes
    // are known too.
    const before = await this.helperImages(true);
    const layers = before === undefined ? undefined : await this.layersById();
    if (before !== undefined && layers !== undefined) {
      const now = this.deps.now();
      for (const id of directBaseIds(layers, new Set(before.map((image) => image.id)))) state.helperBases[id] = now;
    }
    if (before !== undefined) {
      // Without a look at the running containers now, no helper tag counts as unused.
      const observed = await this.observeInto(state, before);
      await this.removeHelperTags(before, state, observed ? own?.tag : undefined, inUse);
      await this.removeEarlierBuilds(inUse);
    }
    await this.removeOlderBuildImages(inUse);
    if (layers !== undefined && own !== undefined) await this.removeOlderBases(state, layers, own.baseImage, inUse);
    await this.writeState(state);
    if (this.deps.vm) await this.pruneBuildCache();
    if (inUse.length > 0) log(`A container uses these, so they stay: ${inUse.join('; ')}.`);
  }

  /** The prune of the stopped helper containers older than 10 minutes (SWEEP_FILTERS). */
  private async pruneHelperContainers(): Promise<void> {
    try {
      const removed = await this.deps.engine.pruneContainers(SWEEP_FILTERS, AbortSignal.timeout(CONTAINER_PRUNE_TIMEOUT_MS));
      if (removed.length > 0) this.deps.log(`Removed ${removed.length} stopped helper ${removed.length === 1 ? 'container' : 'containers'}.`);
    } catch (error) {
      this.deps.log(`The stopped helper containers could not be removed: ${engineFailure(error, CONTAINER_PRUNE_TIMEOUT_MS)}`);
    }
  }

  /**
   * The images with the label of a helper image (LABEL_HELPER), with their tags; undefined (logged in a pass, `logged`)
   * when the list fails.
   */
  private async helperImages(logged: boolean): Promise<TaggedImage[] | undefined> {
    try {
      const images = await this.deps.engine.images({ label: [`${LABEL_HELPER}=true`] }, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS));
      return images.map((image) => ({ id: image.id, tags: image.repoTags }));
    } catch (error) {
      if (logged) this.deps.log(`The workspace helper images could not be listed, so none is removed: ${engineFailure(error, IMAGE_LIST_TIMEOUT_MS)}`);
      return undefined;
    }
  }

  /**
   * Takes the helper tags that running containers use now into `state` (observedHelperTags). False, with `state`
   * unchanged, when the containers of an image could not be listed.
   */
  private async observeInto(state: CleanupState, helpers: readonly TaggedImage[]): Promise<boolean> {
    const used = new Set<string>();
    for (const image of helpers) {
      if (!image.tags.some(isHelperImageTag)) continue;
      try {
        const running = await this.deps.engine.containerIds({ ancestor: [image.id], status: ['running'] }, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS));
        if (running.length > 0) used.add(image.id);
      } catch {
        return false;
      }
    }
    state.helperTags = observedHelperTags(state.helperTags, helpers, used, this.deps.now());
    return true;
  }

  /**
   * The monitor tags without their helper tag, then the helper tags that no running container used for 7 days (never
   * `ownTag`; none when it is undefined: not known, or the running containers could not be listed), each after its
   * monitor tag.
   */
  private async removeHelperTags(helpers: readonly TaggedImage[], state: CleanupState, ownTag: string | undefined, inUse: string[]): Promise<void> {
    for (const tag of staleMonitorTags(helpers)) {
      await this.remove(tag, `the tag ${tag} of the image of a Monitor, which is no longer on the image of its helper tag`, inUse);
    }
    if (ownTag === undefined) return;
    for (const tag of unusedHelperTags(state.helperTags, ownTag, this.deps.now())) {
      const image = helpers.find((candidate) => candidate.tags.includes(tag));
      const monitorTag = monitorImageTag(tag);
      // The monitor tag first: Docker refuses only the removal of the last tag of an image that a container uses, so the
      // helper tag, removed last, stays while a container runs from its image.
      if (image !== undefined && monitorTag !== undefined && image.tags.includes(monitorTag)) {
        const outcome = await this.remove(monitorTag, `the tag ${monitorTag} of the image of a Monitor`, inUse);
        if (outcome !== 'removed' && outcome !== 'missing') continue;
      }
      const outcome = await this.remove(tag, `the workspace helper image ${tag}, which no running container used for 7 days`, inUse);
      if (outcome === 'removed' || outcome === 'missing') delete state.helperTags[tag];
    }
  }

  /** The helper images without any tag (a fresh list, after the removals of the tags): the earlier builds. */
  private async removeEarlierBuilds(inUse: string[]): Promise<void> {
    const helpers = await this.helperImages(true);
    for (const image of helpers ?? []) {
      if (image.tags.length > 0) continue;
      await this.remove(image.id, `the earlier build ${shortId(image.id)} of the workspace helper image`, inUse);
    }
  }

  /** The tags of the build image of an older version than the pin (isOlderBuildxTag). */
  private async removeOlderBuildImages(inUse: string[]): Promise<void> {
    let tags: string[];
    try {
      const images = await this.deps.engine.images({ reference: [BUILDX_REPOSITORY] }, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS));
      tags = images.flatMap((image) => image.repoTags);
    } catch (error) {
      this.deps.log(`The build images could not be listed, so none is removed: ${engineFailure(error, IMAGE_LIST_TIMEOUT_MS)}`);
      return;
    }
    for (const tag of [...new Set(tags)].sort()) {
      if (isOlderBuildxTag(tag, this.deps.buildx ?? BUILDX_PIN)) await this.remove(tag, `the build image ${tag} of an older version`, inUse);
    }
  }

  /**
   * The recorded base images of helper images that no rule keeps (see the module comment, part 4), by their tags, or by
   * their ID when they have none. `layers`: the layers of every image at the start of the pass. A record of an image that
   * does not exist anymore goes.
   */
  private async removeOlderBases(state: CleanupState, layers: ReadonlyMap<string, readonly string[]>, baseImage: string | undefined, inUse: string[]): Promise<void> {
    const { log } = this.deps;
    let images: Array<{ id: string; tags: string[]; helper: boolean }>;
    try {
      images = (await this.deps.engine.images({}, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS))).map((image) => ({
        id: image.id,
        tags: image.repoTags,
        helper: image.labels[LABEL_HELPER] === 'true',
      }));
    } catch (error) {
      log(`The images could not be listed, so no older base image of the helper image is removed: ${engineFailure(error, IMAGE_LIST_TIMEOUT_MS)}`);
      return;
    }
    const present = new Map(images.map((image) => [image.id, image]));
    for (const id of Object.keys(state.helperBases)) if (!present.has(id)) delete state.helperBases[id];
    // The layers of the images that are left (an image that came during the pass has none: it keeps nothing).
    const left = new Map([...layers].filter(([id]) => present.has(id)));
    const candidates = Object.keys(state.helperBases)
      .map((id) => present.get(id)!)
      // An image with more than one tag stays: a user may have given it a name of their own.
      .filter((image) => !image.helper && image.tags.length <= 1 && !isBuiltOn(image.id, left));
    if (candidates.length === 0) return;
    // The image of the base image of the Monitor's own helper image, and the images of the references in use, stay.
    const kept = await this.keptIds(baseImage);
    if (kept === undefined) return;
    for (const image of candidates) {
      if (kept.has(image.id)) continue;
      const name = image.tags.length > 0 ? `${image.tags.join(', ')} (${shortId(image.id)})` : shortId(image.id);
      const what = `the image ${name}, an older base image of the workspace helper image`;
      // By its tag, so that its last name goes with it; by its ID when it has none.
      const outcome = await this.remove(image.tags[0] ?? image.id, what, inUse);
      if (outcome === 'removed' || outcome === 'missing') delete state.helperBases[image.id];
    }
  }

  /**
   * The IDs of the image of `baseImage` and of the images of the references in use. Undefined (logged) when the
   * references in use are not complete or an inspect fails: then no base image is removed.
   */
  private async keptIds(baseImage: string | undefined): Promise<Set<string> | undefined> {
    const { log } = this.deps;
    let inUse: ReferencesInUse;
    try {
      inUse = await this.deps.referencesInUse();
    } catch (error) {
      log(`The image references in use could not be read, so no older base image of the helper image is removed: ${errorMessage(error)}`);
      return undefined;
    }
    if (!inUse.complete) {
      log('The image references in use could not all be read, so no older base image of the helper image is removed.');
      return undefined;
    }
    const kept = new Set<string>();
    const references = new Set<string>();
    for (const reference of [...(baseImage !== undefined ? [baseImage] : []), ...inUse.references]) {
      const parts = parseImageReference(reference);
      if (parts !== undefined) references.add(referenceText(parts));
    }
    for (const reference of references) {
      try {
        const inspected = await this.deps.engine.inspect('image', reference, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS));
        if (isRecord(inspected) && typeof inspected.Id === 'string') kept.add(inspected.Id);
      } catch (error) {
        log(`The image of ${reference} could not be inspected, so no older base image of the helper image is removed: ${engineFailure(error, IMAGE_LIST_TIMEOUT_MS)}`);
        return undefined;
      }
    }
    return kept;
  }

  /**
   * The layers of every image of the engine, by ID (the list, then the inspect of each); undefined when they cannot be
   * read.
   */
  private async layersById(): Promise<Map<string, string[]> | undefined> {
    const { log } = this.deps;
    let ids: string[];
    try {
      ids = [...new Set((await this.deps.engine.images({}, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS))).map((image) => image.id))];
    } catch (error) {
      log(`The images could not be listed, so the base images of the helper images are not known: ${engineFailure(error, IMAGE_LIST_TIMEOUT_MS)}`);
      return undefined;
    }
    const byId = new Map<string, string[]>();
    for (const id of ids) {
      let inspected: unknown;
      try {
        inspected = await this.deps.engine.inspect('image', id, AbortSignal.timeout(IMAGE_LIST_TIMEOUT_MS));
      } catch (error) {
        log(`The image ${shortId(id)} could not be inspected, so the base images of the helper images are not known: ${engineFailure(error, IMAGE_LIST_TIMEOUT_MS)}`);
        return undefined;
      }
      // An image that was removed meanwhile has none.
      if (!isRecord(inspected)) continue;
      const rootFs = isRecord(inspected.RootFS) ? inspected.RootFS : undefined;
      const layers = rootFs?.Layers;
      if (Array.isArray(layers) && layers.every((layer) => typeof layer === 'string')) byId.set(id, layers as string[]);
    }
    return byId;
  }

  /** On the VM of Devspaces: the records of the build cache that no build used for 7 days. */
  private async pruneBuildCache(): Promise<void> {
    try {
      const { records, bytes } = await this.deps.engine.pruneBuildCache({ until: [BUILD_CACHE_UNUSED_FILTER] }, AbortSignal.timeout(BUILD_CACHE_PRUNE_TIMEOUT_MS));
      if (records > 0) this.deps.log(`Removed ${records} ${records === 1 ? 'record' : 'records'} of the build cache that no build used for 7 days (Docker counts ${Math.round(bytes / 1_000_000)} MB).`);
    } catch (error) {
      this.deps.log(`The build cache could not be pruned: ${engineFailure(error, BUILD_CACHE_PRUNE_TIMEOUT_MS)}`);
    }
  }

  /** `DELETE /images/<reference>` without force. `removed` and a failure are logged, `inUse` goes into `inUse`. */
  private async remove(reference: string, what: string, inUse: string[]): Promise<Removal> {
    try {
      const outcome = await this.deps.engine.removeImage(reference, AbortSignal.timeout(IMAGE_REMOVE_TIMEOUT_MS));
      if (outcome === 'removed') this.deps.log(`Removed ${what}.`);
      if (outcome === 'inUse') inUse.push(what);
      return outcome;
    } catch (error) {
      this.deps.log(`Could not remove ${what}: ${engineFailure(error, IMAGE_REMOVE_TIMEOUT_MS)}`);
      return 'failed';
    }
  }

  private async readState(): Promise<CleanupState> {
    return parseCleanupState(await this.deps.record.read().catch(() => undefined));
  }

  private async writeState(state: CleanupState): Promise<void> {
    try {
      await this.deps.record.write(cleanupStateText(state));
    } catch (error) {
      this.deps.log(`The record of the cleanup could not be written in the volume: ${errorMessage(error)}`);
    }
  }
}

/** The first 12 hexadecimal digits of an image ID, as `docker image ls` shows it. */
function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}
