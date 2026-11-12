// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The objects on a Docker host, for the view "Docker Hosts" (docs/requirements.md R-ENG-008): all its containers,
// networks, images and volumes with their purpose, size and activity, and its build cache, read with the Docker CLI of Devspaces (BootstrapDocker.run, within an
// operation on that host: through the Docker pipe of the extension, as "Remove Devspaces from This Docker Engine…"
// reads), their Start and Stop, and their removal. The objects of Devspaces get their purpose: those with a label
// nimblescape.devspaces.*, the containers, images and volumes whose name starts with `devspaces-` (also the tags of the
// build image devspaces-buildx), the base images that the build record of a devspace of the host names, and the base
// image of the helper image (the first FROM of its Dockerfile). Every other
// object of the engine is listed too, as `notDevspaces` (for example the services of the host, which the user stops to
// free CPU and memory). The removal never uses force: Docker refuses a running container, and an image or a volume that
// a container uses, and the result says so. No `vscode`.
import { CommandError, errorMessage } from '../errors';
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  LABEL_BUILD_RUN,
  LABEL_CHANNEL_STEP,
  LABEL_COMPOSE_SERVICE,
  LABEL_DEVSPACE_ID,
  LABEL_HELPER,
  LABEL_HELPER_RUN,
  LABEL_IMAGE_KEY,
  LABEL_PREFIX,
  LABEL_REPOSITORY,
  LABEL_SERVICE_DATA,
  LABEL_VOLUME,
  PREPARED_IMAGE_TAG,
  RESOURCE_NAME_PREFIX,
  VOLUME_KIND_ADDITIONAL,
  VOLUME_KIND_COMPOSE,
  HELPER_CACHE_VOLUME,
  VSCODE_STORE_VOLUME,
  isDevspaceImageName,
  resourceName,
} from '../names';
import { isAbortError, type Logger, type RunResult } from '../ports';
import { LABEL_MONITOR, REMOTE_MONITOR_VOLUME } from '../remoteMonitor/protocol';
import type { Devspace } from '../types';
import { isRecord } from '../valueChecks';
import { IMAGE_IN_USE_PATTERN, commandText, parseJsonLines, parseJsonOutput, type BootstrapDocker } from '../docker/bootstrapDocker';
import { BUILDX_REPOSITORY } from '../docker/buildxImage';
import { isHelperImageTag, isMonitorImageTag } from '../helper/helperState';
import { baseImageOf } from '../helper/helperImage';
import { DOCKER_QUERY_TIMEOUT_MS } from '../docker/dockerTimeouts';
import { VOLUME_REMOVE_TIMEOUT_MS } from '../docker/engineRemoval';

export type HostObjectKind = 'container' | 'network' | 'image' | 'volume';

/**
 * What an object is for. `devspace`: an object of a devspace of this computer (its container, the containers of its
 * services, its images, its volumes), which gets the actions of the devspace (Stop, Delete…). `otherDevspace`: an object
 * of a devspace that this computer does not know (for example of another computer on a shared host). The others belong
 * to the helpers of Devspaces, or are other objects of Devspaces (`other`), or do not belong to Devspaces at all
 * (`notDevspaces`).
 */
export type HostObjectPurpose =
  | 'devspace'
  | 'otherDevspace'
  | 'monitor'
  | 'worker'
  | 'batchHelper'
  | 'buildContainer'
  | 'helperImage'
  | 'buildImage'
  | 'helperBaseImage'
  | 'baseImage'
  | 'sharedVolume'
  | 'other'
  | 'notDevspaces';

export interface HostObject {
  kind: HostObjectKind;
  /** The full ID of a container, a network or an image, the name of a volume. */
  id: string;
  /** The name of a container, a network or a volume; the first tag of an image, or its short ID when it has none. */
  name: string;
  /** All tags of an image (`repository:tag`). */
  tags?: string[];
  purpose: HostObjectPurpose;
  /** The devspace of an object of a devspace (also of one that this computer does not know). */
  devspaceId?: string;
  /** `owner/name` of the repository of the devspace, when known. */
  repository?: string;
  /**
   * The part of a devspace that the object is (`dev container`, `service db`, `image`, `prepared image`, `workspace`,
   * `additional volume`, `volume of Docker Compose`, `data of a service`), what a shared volume holds, or the service of
   * Docker Compose of a container that is not of Devspaces (`service web of shop`).
   */
  role?: string;
  /** A container: `running`, `exited`, `created`, `paused`, `restarting`, `removing` or `dead`. */
  state?: string;
  /** A container: the status of Docker, for example `Up 2 hours`. */
  status?: string;
  /** The size in bytes: the writable layer of a container, the size of an image, the data of a volume. */
  sizeBytes?: number;
  /** An image: the bytes that only this image uses (not shared with another image). */
  uniqueBytes?: number;
  /** The number of containers that use the image, the volume or the network. */
  usedBy?: number;
  /** A network: its driver (`bridge`, `overlay`, …). */
  driver?: string;
  /** A network that Docker creates itself and never removes (`bridge`, `host`, `none`). */
  builtIn?: boolean;
  /** When Docker created the container or the image, as Docker writes it. */
  createdAt?: string;
  /** A container: its image, as Docker names it (a tag, or an ID). */
  image?: string;
  /** A container: the names of its networks. */
  networks?: string[];
  /**
   * Active: a container that runs (also paused or restarting: it holds its memory), or an image, a volume or a network
   * that such a container uses. Only set when true. The view shows the other objects dimmed.
   */
  active?: boolean;
}

/** The build cache of the engine (BuildKit), as `docker system df` counts it. */
export interface BuildCacheSummary {
  /** The number of its records. */
  records: number;
  /** The size of all records. */
  bytes: number;
  /** What its removal frees (the reclaimable space of `docker system df`): the records that no build uses and no image shares. */
  unusedBytes: number;
}

export interface HostInventory {
  containers: HostObject[];
  networks: HostObject[];
  images: HostObject[];
  volumes: HostObject[];
  buildCache: BuildCacheSummary;
}

/** A devspace of this computer on the host, for the purpose of its objects (from the registry). */
export interface KnownDevspace {
  id: string;
  repository: string;
  /** The names of its objects start with one of these: its volume, its container, and its image repository. */
  names: string[];
  /** The named volumes of its configuration and of its services. */
  additionalVolumes: string[];
}

/** The KnownDevspace of a devspace of the registry. */
export function knownDevspace(devspace: Pick<Devspace, 'id' | 'repository' | 'volumeName' | 'containerName' | 'additionalVolumes' | 'serviceVolumes'>): KnownDevspace {
  const names = [...new Set([devspace.volumeName, devspace.containerName, resourceName(devspace.repository, devspace.id)].filter((name) => name !== ''))];
  return { id: devspace.id, repository: devspace.repository, names, additionalVolumes: [...(devspace.additionalVolumes ?? []), ...(devspace.serviceVolumes ?? [])] };
}

/**
 * The base images of the devspaces of the host that their build records name (the images of the configuration, the
 * default image), as normalized references (normalizedReference). The images of the other services of Docker Compose
 * are images of the user, not base images: not listed.
 */
export function baseImageReferences(devspaces: readonly Pick<Devspace, 'buildRecord' | 'defaultImage'>[]): Set<string> {
  const references = new Set<string>();
  for (const devspace of devspaces) {
    const record = devspace.buildRecord;
    const services = new Set(record?.compose?.serviceImages ?? []);
    for (const reference of Object.keys(record?.images ?? {})) {
      if (!services.has(reference)) references.add(normalizedReference(reference));
    }
    if (record?.defaultImage !== undefined) references.add(normalizedReference(record.defaultImage));
    if (devspace.defaultImage !== undefined) references.add(normalizedReference(devspace.defaultImage));
  }
  references.delete('');
  return references;
}

/**
 * An image reference as `docker image ls` names it, so that the reference of a configuration and the tag of an image
 * compare: without a digest, with the tag `latest` when it has none, without `docker.io/library/` and `docker.io/`.
 * Lower case for the name; the tag keeps its case.
 */
export function normalizedReference(reference: string): string {
  let text = reference.trim().split('@')[0];
  if (text === '') return '';
  const slash = text.lastIndexOf('/');
  const colon = text.lastIndexOf(':');
  let name = colon > slash ? text.slice(0, colon) : text;
  const tag = colon > slash ? text.slice(colon + 1) : 'latest';
  name = name.toLowerCase();
  for (const prefix of ['docker.io/library/', 'index.docker.io/library/', 'docker.io/', 'index.docker.io/']) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  text = `${name}:${tag}`;
  return text;
}

/** Decimal units of the Docker CLI (go-units HumanSize). */
const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15 };

/**
 * The bytes of a size as the Docker CLI writes it (`11.2kB`, `1.5GB`, `0B`, `4.1kB (virtual 11.2kB)`: the first
 * number); undefined for `N/A` or text without a size.
 */
export function parseDockerSize(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmMgGtTpP]?[bB])/.exec(text);
  if (match === null) return undefined;
  const unit = SIZE_UNITS[match[2].toLowerCase()];
  return unit === undefined ? undefined : Math.round(Number(match[1]) * unit);
}

/** A size for the user, in the decimal units of Docker: `0 B`, `840 kB`, `412 MB`, `3.1 GB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ['kB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1000;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[index]}`;
}

/** The sum of the sizes of `objects` (for images: the bytes that only they use), and whether every size was known. */
export function totalSize(objects: readonly HostObject[]): { bytes: number; complete: boolean } {
  let bytes = 0;
  let complete = true;
  for (const object of objects) {
    const size = object.kind === 'image' ? (object.uniqueBytes ?? object.sizeBytes) : object.sizeBytes;
    if (size === undefined) complete = false;
    else bytes += size;
  }
  return { bytes, complete };
}

/**
 * The labels of a container or a volume in `docker system df -v --format '{{json .}}'`: `key=value` pairs joined with
 * commas. A value with a comma (for example the JSON of `devcontainer.metadata`) is cut there; the labels that this
 * module reads have no comma.
 */
export function parseLabels(value: unknown): Map<string, string> {
  const labels = new Map<string, string>();
  if (typeof value !== 'string') return labels;
  for (const pair of value.split(',')) {
    const index = pair.indexOf('=');
    if (index > 0) labels.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return labels;
}

function hasDevspacesLabel(labels: ReadonlyMap<string, string>): boolean {
  for (const key of labels.keys()) if (key.startsWith(LABEL_PREFIX)) return true;
  return false;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function count(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** The known devspace whose names start the name `name` (`<name>`, `<name>-…`, `<name>_…`, `<name>:…`). */
function devspaceByName(name: string, known: readonly KnownDevspace[]): KnownDevspace | undefined {
  const lower = name.toLowerCase();
  return known.find((devspace) =>
    devspace.names.some((start) => {
      const prefix = start.toLowerCase();
      return lower === prefix || lower.startsWith(`${prefix}-`) || lower.startsWith(`${prefix}_`) || lower.startsWith(`${prefix}:`);
    }),
  );
}

/** The fields of an object of a devspace: known (`devspace`) or not (`otherDevspace`, with the ID of its label). */
function devspaceFields(id: string | undefined, byName: KnownDevspace | undefined, known: readonly KnownDevspace[], labelRepository: string | undefined): Pick<HostObject, 'purpose' | 'devspaceId' | 'repository'> {
  const devspace = (id !== undefined ? known.find((entry) => entry.id === id) : undefined) ?? byName;
  if (devspace !== undefined) return { purpose: 'devspace', devspaceId: devspace.id, repository: devspace.repository };
  return { purpose: 'otherDevspace', ...(id !== undefined ? { devspaceId: id } : {}), ...(labelRepository !== undefined ? { repository: labelRepository } : {}) };
}

/** What the shared volumes hold. */
const SHARED_VOLUME_ROLES: Readonly<Record<string, string>> = {
  [REMOTE_MONITOR_VOLUME]: 'Monitor',
  [HELPER_CACHE_VOLUME]: 'cache of the workers',
  [VSCODE_STORE_VOLUME]: 'VS Code Server and extensions',
};

function classifyContainer(item: Record<string, unknown>, known: readonly KnownDevspace[]): HostObject | undefined {
  const id = text(item.ID);
  // `Names` lists the names of a container with links, separated by commas.
  const name = text(item.Names)?.split(',')[0];
  if (id === undefined || name === undefined) return undefined;
  const labels = parseLabels(item.Labels);
  const devspaceId = text(labels.get(LABEL_DEVSPACE_ID));
  const ofDevspaces = devspaceId !== undefined || hasDevspacesLabel(labels) || name.toLowerCase().startsWith(RESOURCE_NAME_PREFIX);
  const base: HostObject = {
    kind: 'container',
    id,
    name,
    purpose: 'other',
    ...(text(item.State) !== undefined ? { state: text(item.State) } : {}),
    ...(text(item.Status) !== undefined ? { status: text(item.Status) } : {}),
    ...(parseDockerSize(item.Size) !== undefined ? { sizeBytes: parseDockerSize(item.Size) } : {}),
    ...(text(item.CreatedAt) !== undefined ? { createdAt: text(item.CreatedAt) } : {}),
    ...(text(item.Image) !== undefined ? { image: text(item.Image) } : {}),
    ...networksOf(item),
  };
  if (!ofDevspaces) {
    // A service of Docker Compose names its project and its service.
    const project = text(labels.get(COMPOSE_PROJECT_LABEL));
    const service = text(labels.get(COMPOSE_SERVICE_LABEL));
    return { ...base, purpose: 'notDevspaces', ...(project !== undefined && service !== undefined ? { role: `service ${service} of ${project}` } : {}) };
  }
  // The helpers first: a worker of a devspace window has a name that starts with the name of that devspace.
  if (labels.has(LABEL_MONITOR)) return { ...base, purpose: 'monitor' };
  if (labels.has(LABEL_BUILD_RUN)) return { ...base, purpose: 'buildContainer' };
  if (labels.has(LABEL_HELPER_RUN)) return { ...base, purpose: labels.has(LABEL_CHANNEL_STEP) ? 'batchHelper' : 'worker' };
  const byName = devspaceByName(text(labels.get(COMPOSE_PROJECT_LABEL)) ?? name, known);
  if (devspaceId === undefined && byName === undefined) return base;
  const service = text(labels.get(LABEL_COMPOSE_SERVICE));
  return { ...base, ...devspaceFields(devspaceId, byName, known, text(labels.get(LABEL_REPOSITORY))), role: service !== undefined ? `service ${service}` : 'dev container' };
}

function classifyVolume(item: Record<string, unknown>, known: readonly KnownDevspace[]): HostObject | undefined {
  const name = text(item.Name);
  if (name === undefined) return undefined;
  const labels = parseLabels(item.Labels);
  const devspaceId = text(labels.get(LABEL_DEVSPACE_ID));
  // A named volume of the configuration of a devspace of this computer, also one without the labels of Devspaces.
  const additionalOf = known.find((devspace) => devspace.additionalVolumes.includes(name));
  const ofDevspaces = devspaceId !== undefined || additionalOf !== undefined || hasDevspacesLabel(labels) || name.toLowerCase().startsWith(RESOURCE_NAME_PREFIX);
  const base: HostObject = {
    kind: 'volume',
    id: name,
    name,
    purpose: 'other',
    ...(parseDockerSize(item.Size) !== undefined ? { sizeBytes: parseDockerSize(item.Size) } : {}),
    ...(count(item.Links) !== undefined ? { usedBy: count(item.Links) } : {}),
  };
  if (!ofDevspaces) return { ...base, purpose: 'notDevspaces' };
  const shared = SHARED_VOLUME_ROLES[name];
  if (shared !== undefined) return { ...base, purpose: 'sharedVolume', role: shared };
  const byName = additionalOf ?? devspaceByName(name, known);
  if (devspaceId === undefined && byName === undefined) return base;
  const volumeKind = labels.get(LABEL_VOLUME);
  const role = labels.has(LABEL_SERVICE_DATA)
    ? 'data of a service'
    : volumeKind === VOLUME_KIND_ADDITIONAL || additionalOf !== undefined
      ? 'additional volume'
      : volumeKind === VOLUME_KIND_COMPOSE
        ? 'volume of Docker Compose'
        : 'workspace';
  return { ...base, ...devspaceFields(devspaceId, byName, known, text(labels.get(LABEL_REPOSITORY))), role };
}

/** The networks of a container of `docker system df -v` (its field `Networks`: names joined with commas). */
function networksOf(item: Record<string, unknown>): Pick<HostObject, 'networks'> {
  const networks = (text(item.Networks) ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return networks.length > 0 ? { networks } : {};
}

/** The networks that Docker creates itself on every engine and never removes. */
const BUILT_IN_NETWORKS = new Set(['bridge', 'host', 'none']);

/**
 * Whether `name` is a network of Docker Swarm, which Docker creates itself on a node of a swarm: `ingress` (its
 * removal asks a question that the closed input of the Docker CLI answers with No) and `docker_gwbridge`.
 */
function isSwarmNetwork(name: string, driver: string | undefined): boolean {
  return (name === 'ingress' && driver === 'overlay') || name === 'docker_gwbridge';
}

/**
 * Whether the networks of a container, joined with commas as Docker writes them (`Networks` of `docker system df -v`
 * and of `docker container ls`), hold the network `name`. A network name may hold a comma, and a space at its start or
 * end (Docker accepts both), so the name is looked for in the joined text as it is, and also with each part trimmed: a
 * container may count for a network that it does not use (a network `a` next to a network `a,b`), never the other way
 * around.
 */
function holdsNetwork(joined: string, name: string): boolean {
  const holds = (value: string): boolean => value === name || value.startsWith(`${name},`) || value.endsWith(`,${name}`) || value.includes(`,${name},`);
  return holds(joined) || holds(joined.split(',').map((part) => part.trim()).join(','));
}

/** The number of the containers of `docker system df -v` on the network `name` (holdsNetwork). */
function networkUsers(containers: readonly unknown[], name: string): number {
  return containers.filter((item) => isRecord(item) && holdsNetwork(text(item.Networks) ?? '', name)).length;
}

/** A network of `docker network ls --format '{{json .}}'`. */
function classifyNetwork(item: Record<string, unknown>, known: readonly KnownDevspace[], containers: readonly unknown[]): HostObject | undefined {
  const id = text(item.ID);
  const name = text(item.Name);
  if (id === undefined || name === undefined) return undefined;
  const labels = parseLabels(item.Labels);
  const base: HostObject = {
    kind: 'network',
    id,
    name,
    purpose: 'notDevspaces',
    usedBy: networkUsers(containers, name),
    ...(text(item.Driver) !== undefined ? { driver: text(item.Driver) } : {}),
    ...(text(item.CreatedAt) !== undefined ? { createdAt: text(item.CreatedAt) } : {}),
  };
  if (BUILT_IN_NETWORKS.has(name) || isSwarmNetwork(name, text(item.Driver))) return { ...base, builtIn: true, role: 'network of Docker' };
  const devspaceId = text(labels.get(LABEL_DEVSPACE_ID));
  const project = text(labels.get(COMPOSE_PROJECT_LABEL));
  const byName = devspaceByName(project ?? name, known);
  if (devspaceId !== undefined || byName !== undefined) return { ...base, ...devspaceFields(devspaceId, byName, known, text(labels.get(LABEL_REPOSITORY))), role: 'network' };
  if (hasDevspacesLabel(labels) || name.toLowerCase().startsWith(RESOURCE_NAME_PREFIX)) return { ...base, purpose: 'other' };
  return project !== undefined ? { ...base, role: `network of ${project}` } : base;
}

/**
 * The build cache of `docker system df -v` (its field `BuildCache`): `InUse`, `Shared` and `Size` as the Docker CLI
 * writes them (text), summed as `docker system df` sums its size and its reclaimable space (verified with Docker 29.9):
 * all records; and those that no build uses and that share their data with no image (a shared record keeps its data
 * on the disk after its removal, for example a layer of a base image).
 */
function buildCacheOf(items: readonly unknown[]): BuildCacheSummary {
  const yes = (value: unknown): boolean => value === true || value === 'true';
  let bytes = 0;
  let unusedBytes = 0;
  let records = 0;
  for (const item of items) {
    if (!isRecord(item)) continue;
    records += 1;
    const size = parseDockerSize(item.Size) ?? 0;
    bytes += size;
    if (!yes(item.InUse) && !yes(item.Shared)) unusedBytes += size;
  }
  return { records, bytes, unusedBytes };
}

/** `repository:tag` of an entry of `docker system df -v` or `docker image ls`; undefined for `<none>`. */
function referenceOf(item: Record<string, unknown>): string | undefined {
  const repository = text(item.Repository);
  const tag = text(item.Tag);
  return repository !== undefined && tag !== undefined && repository !== '<none>' && tag !== '<none>' ? `${repository}:${tag}` : undefined;
}

/**
 * The image entries of `docker system df -v`, merged by image ID, with every tag of each from `tagRows` (IMAGE_TAGS_ARGS).
 * The Docker CLI lists each image once in `docker system df -v`, with its first tag only, and `docker image ls` lists
 * one line per tag (verified with Docker 29.9). The images are those of `docker system df -v`.
 */
function mergedImages(items: readonly unknown[], tagRows: readonly unknown[] = []): Array<{ id: string; tags: string[]; item: Record<string, unknown> }> {
  const images = new Map<string, { id: string; tags: string[]; item: Record<string, unknown> }>();
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = text(item.ID);
    if (id === undefined) continue;
    let image = images.get(id);
    if (image === undefined) {
      image = { id, tags: [], item };
      images.set(id, image);
    }
    const reference = referenceOf(item);
    if (reference !== undefined && !image.tags.includes(reference)) image.tags.push(reference);
  }
  for (const row of tagRows) {
    if (!isRecord(row)) continue;
    const image = images.get(text(row.ID) ?? '');
    const reference = referenceOf(row);
    if (image !== undefined && reference !== undefined && !image.tags.includes(reference)) image.tags.push(reference);
  }
  return [...images.values()];
}

/** The short form of an image ID: its first 12 hex digits, as `docker image ls` shows it. */
function shortImageId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

/** The name of an image without a tag: `<none> (1a2b3c4d5e6f)`. */
function untaggedName(id: string): string {
  return `<none> (${shortImageId(id)})`;
}

/**
 * The name of an earlier build of the helper image (isEarlierHelperBuild): its helper tag `devspaces-worker:<hash>` was
 * taken by a newer build, and Docker keeps no record of the tag that an image had. It can still have its monitor tag
 * `devspaces-monitor:<hash>` while the Monitor runs from it, until the Monitor moves to the new build (its successor
 * tags it, src/remoteMonitor/selfUpgrade.ts) or the next open tags it.
 */
export function earlierHelperBuildName(id: string): string {
  return `devspaces-worker (earlier build, ${shortImageId(id)})`;
}

/**
 * True for an image with the label of the helper image whose tags are at most monitor tags `devspaces-monitor:<hash>`:
 * an earlier build of the helper image (earlierHelperBuildName). An image with any other tag keeps its tag as its name,
 * also a tagged image that the user built from the helper image (it has the label of the helper image too); such an
 * image without a tag cannot be told from an earlier build.
 */
export function isEarlierHelperBuild(object: Pick<HostObject, 'kind' | 'purpose' | 'tags'>): boolean {
  return object.kind === 'image' && object.purpose === 'helperImage' && (object.tags ?? []).every(isMonitorImageTag);
}

/**
 * The base image of the helper image: the first FROM of its Dockerfile `dockerfileText` (with the defaults of its ARGs),
 * as a normalized reference (normalizedReference) in a set; an empty set when the Dockerfile names none.
 */
export function helperBaseImageReferences(dockerfileText: string): Set<string> {
  const first = baseImageOf(dockerfileText);
  const reference = first === undefined ? '' : normalizedReference(first);
  return new Set(reference === '' ? [] : [reference]);
}

function classifyImage(
  image: { id: string; tags: string[]; item: Record<string, unknown> },
  input: Pick<InventoryInput, 'devspaceImageIds' | 'helperImageIds' | 'baseImages' | 'helperBaseImages' | 'known'>,
): HostObject {
  const { id, tags, item } = image;
  // The tags of Devspaces first, so that the name of the row is one of them, and of those the helper tag
  // devspaces-worker:<hash> first: a helper image that the Monitor runs from has its monitor tag
  // devspaces-monitor:<hash> too, which only names the image of the Monitor.
  const ordered = [
    ...tags.filter(isHelperImageTag),
    ...tags.filter((tag) => tag.startsWith(RESOURCE_NAME_PREFIX) && !isHelperImageTag(tag)),
    ...tags.filter((tag) => !tag.startsWith(RESOURCE_NAME_PREFIX)),
  ];
  const helper = input.helperImageIds.has(id);
  const earlier = helper && isEarlierHelperBuild({ kind: 'image', purpose: 'helperImage', tags: ordered });
  const base: HostObject = {
    kind: 'image',
    id,
    name: earlier ? earlierHelperBuildName(id) : (ordered[0] ?? untaggedName(id)),
    tags: ordered,
    purpose: 'other',
    ...(parseDockerSize(item.Size) !== undefined ? { sizeBytes: parseDockerSize(item.Size) } : {}),
    ...(parseDockerSize(item.UniqueSize) !== undefined ? { uniqueBytes: parseDockerSize(item.UniqueSize) } : {}),
    ...(count(item.Containers) !== undefined ? { usedBy: count(item.Containers) } : {}),
    ...(text(item.CreatedAt) !== undefined ? { createdAt: text(item.CreatedAt) } : {}),
  };
  if (helper) return { ...base, purpose: 'helperImage' };
  if (ordered.some((tag) => tag.startsWith(`${BUILDX_REPOSITORY}:`))) return { ...base, purpose: 'buildImage' };
  const byName = ordered.map((tag) => devspaceByName(tag, input.known)).find((devspace) => devspace !== undefined);
  if (input.devspaceImageIds.has(id) || byName !== undefined) {
    const prepared = ordered.some((tag) => tag.slice(tag.lastIndexOf(':') + 1).startsWith(PREPARED_IMAGE_TAG));
    return { ...base, ...devspaceFields(undefined, byName, input.known, undefined), role: prepared ? 'prepared image' : 'image' };
  }
  if (ordered.some((tag) => input.baseImages.has(normalizedReference(tag)))) return { ...base, purpose: 'baseImage' };
  if (ordered.some((tag) => input.helperBaseImages.has(normalizedReference(tag)))) return { ...base, purpose: 'helperBaseImage' };
  if (ordered.some((tag) => tag.toLowerCase().startsWith(RESOURCE_NAME_PREFIX))) return base;
  return { ...base, purpose: 'notDevspaces' };
}

export interface InventoryInput {
  /** The output of `docker system df -v --format '{{json .}}'`, parsed. */
  df: unknown;
  /**
   * The IDs of the images of the devspaces: those with the label nimblescape.devspaces.id, and the shared images (the
   * label nimblescape.devspaces.image-key and the tag of a devspace image, R-DS-010).
   */
  devspaceImageIds: ReadonlySet<string>;
  /** The IDs of the images with the label nimblescape.devspaces.worker=true (the helper images). */
  helperImageIds: ReadonlySet<string>;
  /** The devspaces of this computer on the host. */
  known: readonly KnownDevspace[];
  /** baseImageReferences of the devspaces of the host. */
  baseImages: ReadonlySet<string>;
  /**
   * helperBaseImageReferences: the base image of the current helper image. An image that is also in `baseImages` counts as
   * a base image of a devspace.
   */
  helperBaseImages: ReadonlySet<string>;
  /** The output of `docker network ls --no-trunc --format '{{json .}}'`, parsed (one entry per network). */
  networks?: readonly unknown[];
  /** The output of IMAGE_TAGS_ARGS, parsed: one entry per tag of an image, so that each image has all its tags. */
  imageTags?: readonly unknown[];
  /**
   * The output of runningUsesArgs for the running containers, parsed: one entry per container with the ID of its image,
   * its mounts and its networks. Undefined when it could not be read: then the fields of `docker system df -v` decide.
   */
  running?: readonly unknown[];
}

/**
 * The objects in the output of `docker system df -v` (see the module comment), each group with the objects of
 * Devspaces first, then the others, each part by name.
 */
export function buildInventory(input: InventoryInput): HostInventory {
  const df = isRecord(input.df) ? input.df : {};
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const containers = list(df.Containers).flatMap((item) => (isRecord(item) ? (classifyContainer(item, input.known) ?? []) : []));
  const volumes = list(df.Volumes).flatMap((item) => (isRecord(item) ? (classifyVolume(item, input.known) ?? []) : []));
  const images = mergedImages(list(df.Images), input.imageTags).map((image) => classifyImage(image, input));
  const networks = (input.networks ?? []).flatMap((item) => (isRecord(item) ? (classifyNetwork(item, input.known, list(df.Containers)) ?? []) : []));
  const active = activeOf(list(df.Containers), input.running);
  const order = (a: HostObject, b: HostObject): number => Number(a.purpose === 'notDevspaces') - Number(b.purpose === 'notDevspaces') || a.name.localeCompare(b.name);
  const marked = (objects: HostObject[]): HostObject[] => objects.map((object) => (active(object) ? { ...object, active: true } : object)).sort(order);
  return { containers: marked(containers), networks: marked(networks), images: marked(images), volumes: marked(volumes), buildCache: buildCacheOf(list(df.BuildCache)) };
}

/** The states of a container that runs: it uses CPU or holds memory, which a Stop frees. */
const ACTIVE_CONTAINER_STATES = new Set(['running', 'paused', 'restarting']);

/** The containers of `docker system df -v` that run (ACTIVE_CONTAINER_STATES). */
function runningContainers(containers: readonly unknown[]): Array<Record<string, unknown>> {
  return containers.filter((item): item is Record<string, unknown> => isRecord(item) && ACTIVE_CONTAINER_STATES.has(text(item.State) ?? ''));
}

/** What the running containers use, from runningUsesArgs: the IDs of their images, the names of their volumes and networks. */
interface RunningUses {
  imageIds: string[];
  volumes: Set<string>;
  networks: Set<string>;
}

function runningUsesOf(entries: readonly unknown[]): RunningUses {
  const uses: RunningUses = { imageIds: [], volumes: new Set(), networks: new Set() };
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const image = text(entry.image);
    if (image !== undefined) uses.imageIds.push(image);
    for (const mount of Array.isArray(entry.mounts) ? entry.mounts : []) {
      if (isRecord(mount) && mount.Type === 'volume' && typeof mount.Name === 'string') uses.volumes.add(mount.Name);
    }
    if (isRecord(entry.networks)) for (const name of Object.keys(entry.networks)) uses.networks.add(name);
  }
  return uses;
}

/** Whether two image IDs (`sha256:<hex>`, or the hex only) name the same image; a short ID of 12 or more digits counts. */
function sameImageId(a: string, b: string): boolean {
  const left = a.replace(/^sha256:/, '');
  const right = b.replace(/^sha256:/, '');
  return left.length >= 12 && right.length >= 12 && (left.startsWith(right) || right.startsWith(left));
}

/**
 * Whether an object is active (HostObject.active). A container by its state. An image, a volume or a network by what
 * the running containers use: exactly, from `running` (runningUsesArgs: the ID of the image, the volumes of the mounts,
 * the names of the networks). Without it (the read failed), by the fields of the running containers of `docker system df
 * -v` (verified with Docker 29.9): an image by the field `Image`, as namesImage compares it (the reference that created
 * the container, or the ID of its image once that reference names another image: Docker replaces it; with the classic
 * image store a reference with a digest misses the container); a volume by the field
 * `Mounts` (the names of the volumes and the paths of the bind mounts, joined with commas) when Docker counts a container
 * of it (a path with a comma could name it); a network by the field `Networks`, as networkUsers counts it.
 */
function activeOf(containers: readonly unknown[], running: readonly unknown[] | undefined): (object: HostObject) => boolean {
  const active = runningContainers(containers);
  if (running !== undefined) {
    const uses = runningUsesOf(running);
    return (object) => {
      switch (object.kind) {
        case 'container':
          return ACTIVE_CONTAINER_STATES.has(object.state ?? '');
        case 'image':
          return uses.imageIds.some((id) => sameImageId(id, object.id));
        case 'volume':
          return uses.volumes.has(object.name);
        case 'network':
          return uses.networks.has(object.name);
      }
    };
  }
  const images = active.flatMap((item) => text(item.Image) ?? []);
  const mounts = new Set(active.flatMap((item) => (text(item.Mounts) ?? '').split(',').map((mount) => mount.trim())));
  return (object) => {
    switch (object.kind) {
      case 'container':
        return ACTIVE_CONTAINER_STATES.has(object.state ?? '');
      case 'image':
        return images.some((image) => namesImage(image, object));
      case 'volume':
        return (object.usedBy ?? 1) > 0 && mounts.has(object.name);
      case 'network':
        return networkUsers(active, object.name) > 0;
    }
  };
}

/**
 * The format of runningUsesArgs: per container, one line of JSON with the ID of its image, its mounts (`Type`, `Name`,
 * `Source`, …) and its networks (an object by network name), as `docker container inspect` writes them.
 */
const RUNNING_USES_FORMAT = '{"image":{{json .Image}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}';

/** The containers that one `docker container inspect` of runningUsesArgs names at most, so that its command line stays short. */
export const RUNNING_USES_BATCH = 100;

/** The arguments of the read of what the running containers `ids` use (`docker container inspect`, GET /containers/<id>/json). */
export function runningUsesArgs(ids: readonly string[]): string[] {
  return ['container', 'inspect', '--format', RUNNING_USES_FORMAT, ...ids];
}

/** Each line of the standard error of a failed `docker container inspect` says that a container is gone. */
const MISSING_CONTAINER_LINE = /^Error(?: response from daemon)?: No such container/i;

/**
 * Reads what the running containers `ids` use (runningUsesArgs), in batches of RUNNING_USES_BATCH. A container that is
 * gone since `docker system df -v` is left out. Undefined when a read fails otherwise or does not end in time: then the
 * colors come from the fields of `docker system df -v` (activeOf).
 */
async function readRunningUses(docker: Pick<BootstrapDocker, 'run'>, ids: readonly string[], signal: AbortSignal | undefined): Promise<unknown[] | undefined> {
  const uses: unknown[] = [];
  for (let start = 0; start < ids.length; start += RUNNING_USES_BATCH) {
    const result = await docker.run(runningUsesArgs(ids.slice(start, start + RUNNING_USES_BATCH)), { timeoutMs: DOCKER_QUERY_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) });
    if (result.timedOut) return undefined;
    const errors = result.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (result.exitCode !== 0 && !(errors.length > 0 && errors.every((line) => MISSING_CONTAINER_LINE.test(line)))) return undefined;
    uses.push(...parseJsonLines(result.stdout));
  }
  return uses;
}

/** The arguments of the read of the networks of the engine. */
export const NETWORK_LS_ARGS: readonly string[] = ['network', 'ls', '--no-trunc', '--format', '{{json .}}'];

/** The time limit of `docker system df -v`: it sums the sizes of all volumes, which can take some time on a large engine. */
export const SYSTEM_DF_TIMEOUT_MS = 3 * 60_000;

/** The arguments of the read of the sizes and of the containers, images and volumes of the engine. */
export const SYSTEM_DF_ARGS: readonly string[] = ['system', 'df', '--verbose', '--format', '{{json .}}'];

/**
 * The arguments of the read of every tag of every image (`docker image ls`, GET /images/json): one line per tag, because
 * `docker system df -v` names the first tag of an image only, and a removal needs all of them (removeHostObjects).
 */
export const IMAGE_TAGS_ARGS: readonly string[] = ['image', 'ls', '--no-trunc', '--format', '{{json .}}'];

/**
 * Reads the objects on the engine of the operation (runWithDockerTarget): one `docker system df -v`, the IDs of the
 * images with the labels of Devspaces, `docker network ls`, every tag of every image (IMAGE_TAGS_ARGS), and, while
 * containers run, what they use (`docker container inspect` of them in batches of RUNNING_USES_BATCH, for
 * HostObject.active). Only calls that read. Throws CommandError when one of the reads before the inspect fails (a failed
 * inspect only makes the colors less exact), and an AbortError when `signal` aborts.
 */
export async function readHostInventory(
  docker: Pick<BootstrapDocker, 'run' | 'listImagesByLabel'>,
  options: { known: readonly KnownDevspace[]; baseImages: ReadonlySet<string>; helperBaseImages: ReadonlySet<string>; signal?: AbortSignal },
): Promise<HostInventory> {
  const { signal } = options;
  const result = await docker.run(SYSTEM_DF_ARGS, { timeoutMs: SYSTEM_DF_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new CommandError(commandText(SYSTEM_DF_ARGS), result.exitCode, result.stdout, result.timedOut ? `${result.stderr}\nThe command did not end within the time limit.`.trim() : result.stderr, result.timedOut);
  }
  const df = parseJsonOutput(result.stdout);
  if (!isRecord(df)) throw new CommandError(commandText(SYSTEM_DF_ARGS), result.exitCode, result.stdout, 'Unexpected output of docker system df.');
  const [devspaceImages, keyImages, helperImages] = await Promise.all([
    docker.listImagesByLabel(LABEL_DEVSPACE_ID),
    docker.listImagesByLabel(LABEL_IMAGE_KEY),
    docker.listImagesByLabel(`${LABEL_HELPER}=true`),
  ]);
  // The images built for one devspace (its ID), and the shared images (their key, R-DS-010) with the tag of a devspace
  // image, not another image with a key label (which a Dockerfile can write).
  const sharedImages = keyImages.filter((image) => image.tags.some(isDevspaceImageName));
  const devspaceImageIds = new Set([...devspaceImages, ...sharedImages].map((image) => image.id));
  const helperImageIds = new Set(helperImages.map((image) => image.id));
  const networkList = await docker.run(NETWORK_LS_ARGS, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) });
  if (networkList.exitCode !== 0 || networkList.timedOut) throw new CommandError(commandText(NETWORK_LS_ARGS), networkList.exitCode, networkList.stdout, networkList.stderr, networkList.timedOut);
  const tagList = await docker.run(IMAGE_TAGS_ARGS, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) });
  if (tagList.exitCode !== 0 || tagList.timedOut) throw new CommandError(commandText(IMAGE_TAGS_ARGS), tagList.exitCode, tagList.stdout, tagList.stderr, tagList.timedOut);
  const runningIds = runningContainers(Array.isArray(df.Containers) ? df.Containers : []).flatMap((item) => text(item.ID) ?? []);
  const running = runningIds.length > 0 ? await readRunningUses(docker, runningIds, signal) : [];
  return buildInventory({
    df,
    devspaceImageIds,
    helperImageIds,
    known: options.known,
    baseImages: options.baseImages,
    helperBaseImages: options.helperBaseImages,
    networks: parseJsonLines(networkList.stdout),
    imageTags: parseJsonLines(tagList.stdout),
    ...(running !== undefined ? { running } : {}),
  });
}

/** `docker ps` of the running dev containers and service containers of devspaces (label LABEL_DEVSPACE_ID). */
export const RUNNING_DEVSPACES_ARGS: readonly string[] = ['ps', '--no-trunc', '--filter', `label=${LABEL_DEVSPACE_ID}`, '--filter', 'status=running', '--format', '{{json .}}'];

/**
 * The devspaces whose containers run on the engine now, for the question of "Stop the VM…" (R-VM-010): the repository of
 * each devspace of this computer (`known`), else the name of its container; each devspace once, in the order of Docker.
 * Throws a CommandError when Docker fails.
 */
export async function runningDevspaces(docker: Pick<BootstrapDocker, 'run'>, known: readonly KnownDevspace[], signal?: AbortSignal): Promise<string[]> {
  const result = await docker.run(RUNNING_DEVSPACES_ARGS, { timeoutMs: DOCKER_QUERY_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) });
  if (result.exitCode !== 0 || result.timedOut) throw new CommandError(commandText(RUNNING_DEVSPACES_ARGS), result.exitCode, result.stdout, result.stderr);
  const names = new Map<string, string>();
  for (const line of parseJsonLines(result.stdout)) {
    if (!isRecord(line)) continue;
    const id = parseLabels(line.Labels).get(LABEL_DEVSPACE_ID);
    if (id === undefined || names.has(id)) continue;
    const name = typeof line.Names === 'string' ? line.Names.split(',')[0] : id;
    names.set(id, known.find((devspace) => devspace.id === id)?.repository ?? name);
  }
  return [...names.values()];
}

// ---------------------------------------------------------------------------------------------------------------------
// Stop and removal

/** What Docker says of an object that is not there (anymore). */
const MISSING_PATTERN = /no such (container|image|volume|object|network)|network \S+ not found/i;
/** What Docker says when another removal of the container runs already (for example the `--rm` of a closing worker). */
const REMOVAL_IN_PROGRESS_PATTERN = /removal of container .* is already in progress/i;
/** What Docker says of a running container that `docker rm` without force does not remove. */
const RUNNING_PATTERN = /cannot remove (a )?(running|paused|restarting) container|stop the container before|has active endpoints/i;

/**
 * `removed`, `stopped`, `started`; `missing`: it was not there anymore; `inUse`: a container uses it, or it runs;
 * `failed`: another error.
 */
export type ObjectOutcome = 'removed' | 'stopped' | 'started' | 'missing' | 'inUse' | 'failed';

export interface ObjectResult {
  object: Pick<HostObject, 'kind' | 'name'>;
  outcome: ObjectOutcome;
  /** What Docker said (the end of its error output) of an object that is left. */
  detail?: string;
}

/** What Docker says of a container that is not there (anymore), on a stop or a start. */
const MISSING_CONTAINER_PATTERN = /no such container/i;

/**
 * The outcome of a removal, a stop or a start call. A stop or a start that fails is `missing` only for a container
 * that is not there: its other errors (a network that is not there anymore, a port in use) are `failed`, with what
 * Docker said.
 */
function outcomeOf(result: RunResult | undefined, done: 'removed' | 'stopped' | 'started'): ObjectOutcome {
  if (result === undefined) return 'failed';
  if (result.exitCode === 0 && !result.timedOut) return done;
  if (result.timedOut) return 'failed';
  const output = `${result.stderr}\n${result.stdout}`;
  if (done !== 'removed') return MISSING_CONTAINER_PATTERN.test(output) ? 'missing' : 'failed';
  if (MISSING_PATTERN.test(output)) return 'missing';
  if (REMOVAL_IN_PROGRESS_PATTERN.test(output)) return 'removed';
  if (RUNNING_PATTERN.test(output) || IMAGE_IN_USE_PATTERN.test(output)) return 'inUse';
  return 'failed';
}

function detailOf(result: RunResult | undefined, error: unknown, timedOut = 'Docker did not answer in time.'): string {
  if (result === undefined) return errorMessage(error).slice(-500);
  if (result.timedOut) return timedOut;
  return (result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`).slice(-500);
}

/** What an object is, for the progress and the log: `the container devspaces-monitor`. */
export function objectText(object: Pick<HostObject, 'kind' | 'name'>): string {
  return `the ${object.kind} ${object.name}`;
}

/**
 * The time limit of `docker container stop`. Docker waits for the end of the container for its stop timeout, then kills
 * it: 10 seconds by default, but a service may set a longer one (`docker run --stop-timeout`, `stop_grace_period` of
 * Docker Compose).
 */
const STOP_TIMEOUT_MS = 5 * 60_000;

/** What a stop says when the Docker CLI did not end within STOP_TIMEOUT_MS: Docker may still stop the container. */
const STOP_TIMED_OUT = 'The stop did not end within 5 minutes. Docker may still be stopping the container: click Refresh to see its state.';

/** Runs one call; an AbortError is passed on. */
async function call(docker: Pick<BootstrapDocker, 'run'>, args: string[], timeoutMs: number, signal: AbortSignal | undefined): Promise<{ result?: RunResult; error?: unknown }> {
  try {
    return { result: await docker.run(args, { timeoutMs, ...(signal !== undefined ? { signal } : {}) }) };
  } catch (error) {
    if (isAbortError(error) || signal?.aborted === true) throw error;
    return { error };
  }
}

/** Logs the outcome of `entry`. */
function logResult(logger: Logger, entry: ObjectResult): void {
  const name = objectText(entry.object);
  switch (entry.outcome) {
    case 'removed':
      logger.info(`Removed ${name}.`);
      break;
    case 'stopped':
      logger.info(`Stopped ${name}.`);
      break;
    case 'started':
      logger.info(`Started ${name}.`);
      break;
    case 'missing':
      logger.info(`${capitalized(name)} was not there anymore.`);
      break;
    case 'inUse':
      logger.warn(`${capitalized(name)} is in use and was not removed: ${entry.detail ?? ''}`);
      break;
    case 'failed':
      logger.warn(`${capitalized(name)} could not be changed: ${entry.detail ?? ''}`);
      break;
  }
}

/** `docker container stop` of the container `object` (by its ID) on the engine of the operation. Throws only an AbortError. */
export async function stopHostContainer(docker: Pick<BootstrapDocker, 'run'>, object: Pick<HostObject, 'kind' | 'id' | 'name'>, logger: Logger, signal?: AbortSignal): Promise<ObjectResult> {
  const { result, error } = await call(docker, ['container', 'stop', object.id], STOP_TIMEOUT_MS, signal);
  const outcome = outcomeOf(result, 'stopped');
  const entry: ObjectResult = { object, outcome, ...(outcome === 'failed' ? { detail: detailOf(result, error, STOP_TIMED_OUT) } : {}) };
  logResult(logger, entry);
  return entry;
}

/** `docker builder prune --all --force`: the records of the build cache that no build uses now; `--force` only skips the question of the CLI. */
export const BUILD_CACHE_PRUNE_ARGS: readonly string[] = ['builder', 'prune', '--all', '--force'];

/** The time limit of the removal of the build cache, which can hold many gigabytes. */
const BUILD_CACHE_PRUNE_TIMEOUT_MS = 10 * 60_000;

/**
 * Removes the build cache that no build uses now on the engine of the operation, and logs the size of the removed
 * records that Docker counts (with the records that share their data with an image, which free no space). Throws a
 * CommandError when Docker fails, an AbortError when `signal` aborts.
 */
export async function pruneBuildCache(docker: Pick<BootstrapDocker, 'run'>, logger: Logger, signal?: AbortSignal): Promise<void> {
  const result = await docker.run(BUILD_CACHE_PRUNE_ARGS, { timeoutMs: BUILD_CACHE_PRUNE_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) });
  if (result.exitCode !== 0 || result.timedOut) throw new CommandError(commandText(BUILD_CACHE_PRUNE_ARGS), result.exitCode, result.stdout, result.stderr);
  // The last line of the CLI: `Total:\t1.2GB` (verified with Docker 29.9), or `Total reclaimed space: 1.2GB` of older versions.
  const match = /Total(?: reclaimed space)?:\s*(\S+)/i.exec(result.stdout);
  const removed = match === null ? undefined : parseDockerSize(match[1]);
  logger.info(`Removed the unused build cache${removed === undefined ? '' : `; Docker counts ${formatSize(removed)} of removed records`}.`);
}

/** The time limit of `docker container start`: the start of the process of the container, not of its service. */
const START_TIMEOUT_MS = 60_000;

/** `docker container start` of the container `object` (by its ID) on the engine of the operation. Throws only an AbortError. */
export async function startHostContainer(docker: Pick<BootstrapDocker, 'run'>, object: Pick<HostObject, 'kind' | 'id' | 'name'>, logger: Logger, signal?: AbortSignal): Promise<ObjectResult> {
  const { result, error } = await call(docker, ['container', 'start', object.id], START_TIMEOUT_MS, signal);
  const outcome = outcomeOf(result, 'started');
  const entry: ObjectResult = { object, outcome, ...(outcome === 'missing' || outcome === 'failed' ? { detail: detailOf(result, error) } : {}) };
  logResult(logger, entry);
  return entry;
}

/**
 * Removes `objects` on the engine of the operation, never with force: the containers first (by ID; a running one
 * stays), then the networks, then the images (removeImage), then the volumes, so that a network, an image or a volume
 * that only a removed container used goes too. Every object is logged with its outcome. Throws only an AbortError
 * (cancel); the objects before it are removed.
 */
export async function removeHostObjects(
  docker: Pick<BootstrapDocker, 'run'>,
  objects: readonly HostObject[],
  options: { logger: Logger; signal?: AbortSignal; onItem?: (text: string) => void },
): Promise<ObjectResult[]> {
  // The containers first, so that a network, an image or a volume that only they used goes too.
  const order: Record<HostObjectKind, number> = { container: 0, network: 1, image: 2, volume: 3 };
  const results: ObjectResult[] = [];
  for (const object of [...objects].sort((a, b) => order[a.kind] - order[b.kind])) {
    options.onItem?.(objectText(object));
    if (object.kind === 'image') {
      const removal = await removeImage(docker, object, options.signal);
      const entry: ObjectResult = { object: { kind: object.kind, name: object.name }, ...removal };
      logResult(options.logger, entry);
      results.push(entry);
      continue;
    }
    // A network that a container uses stays: Docker would remove it under a stopped container, which then cannot
    // start. Its containers are read now, not taken from the read of the view: a container may use it since then.
    // Docker keeps its own networks.
    const network = object.kind === 'network' && object.builtIn !== true ? await networkUsersNow(docker, object, options.signal) : undefined;
    if (network !== undefined && 'detail' in network) {
      const entry: ObjectResult = { object: { kind: object.kind, name: object.name }, outcome: 'failed', detail: network.detail };
      logResult(options.logger, entry);
      results.push(entry);
      continue;
    }
    const users = network?.users ?? 0;
    if (users > 0 || object.builtIn === true) {
      const detail = object.builtIn === true ? 'Docker keeps its own networks.' : `${users === 1 ? 'A container uses' : `${users} containers use`} this ${object.kind}.`;
      const entry: ObjectResult = { object: { kind: object.kind, name: object.name }, outcome: 'inUse', detail };
      logResult(options.logger, entry);
      results.push(entry);
      continue;
    }
    const last = await call(docker, [object.kind, 'rm', object.id], object.kind === 'volume' ? VOLUME_REMOVE_TIMEOUT_MS : DOCKER_QUERY_TIMEOUT_MS, options.signal);
    const outcome = outcomeOf(last.result, 'removed');
    const entry: ObjectResult = { object: { kind: object.kind, name: object.name }, outcome, ...(outcome === 'inUse' || outcome === 'failed' ? { detail: detailOf(last.result, last.error) } : {}) };
    logResult(options.logger, entry);
    results.push(entry);
  }
  return results;
}

/** What `docker image rm` writes for each image that it deletes; an untag writes only `Untagged: …`. */
const IMAGE_DELETED_LINE = /^Deleted: /m;

/** The read of the tags of the image `id` now (`docker image inspect`, GET /images/<id>/json), just before its removal. */
export function imageTagsNowArgs(id: string): string[] {
  return ['image', 'inspect', '--format', '{{json .RepoTags}}', id];
}

/**
 * The read of the containers of the image `id` now (`docker container ls --all`, GET /containers/json), just before its
 * removal. The filter `ancestor` also lists the containers of the images that have it as their parent (`docker commit`,
 * the classic builder; not an image that BuildKit built FROM it): a count can be too high, never too low.
 */
export function imageUsersNowArgs(id: string): string[] {
  return ['container', 'ls', '--all', '--no-trunc', '--filter', `ancestor=${id}`, '--format', '{{.ID}}'];
}

/** The references of the image `id` now (imageTagsNowArgs: RepoTags); `missing` when it is gone, `detail` when Docker could not say. Throws only an AbortError. */
async function imageTagsNow(docker: Pick<BootstrapDocker, 'run'>, id: string, signal: AbortSignal | undefined): Promise<{ tags: string[] } | { missing: true } | { detail: string }> {
  const { result, error } = await call(docker, imageTagsNowArgs(id), DOCKER_QUERY_TIMEOUT_MS, signal);
  if (result !== undefined && result.exitCode !== 0 && !result.timedOut && MISSING_PATTERN.test(`${result.stderr}\n${result.stdout}`)) return { missing: true };
  if (result === undefined || result.exitCode !== 0 || result.timedOut) return { detail: `The tags of this image could not be read: ${detailOf(result, error)}` };
  let tags: unknown;
  try {
    tags = JSON.parse(result.stdout.trim() || 'null');
  } catch {
    return { detail: `The tags of this image could not be read: Docker wrote ${result.stdout.trim().slice(0, 100)}` };
  }
  return { tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [] };
}

/** A reference with a digest (`repository@sha256:…`): the containerd image store lists it in RepoTags too. */
function hasDigest(reference: string): boolean {
  return reference.includes('@');
}

/**
 * Removes the image `object`, never with force. Its references and its containers are read now, not taken from the read
 * of the view, which can be old (the Monitor pulls images, the user tags and runs them):
 * - An image that a container uses stays without a call (`inUse`): Docker would untag its first tags and refuse only the
 *   last one. The containers of the same removal are gone by then.
 * - An image with a tag that the read did not show stays (`failed`): the user did not see that tag.
 * - Each tag of the read that still names the image is removed, then each reference with a digest that RepoTags lists
 *   (the containerd image store lists a pull by digest there, and `docker image ls` shows no such tag; it names only this
 *   image), so that the last one removes the image (Docker writes `Deleted:`). A tag that names another image since the
 *   read stays. An image without a reference goes by its ID (by its ID Docker refuses an image of several repositories).
 * - When Docker removed each reference but kept the image (no `Deleted:`), the image is read again: one with a tag again
 *   stays (`failed`); otherwise its new references with a digest, else its ID, are removed.
 * Throws only an AbortError.
 */
async function removeImage(docker: Pick<BootstrapDocker, 'run'>, object: HostObject, signal: AbortSignal | undefined): Promise<Pick<ObjectResult, 'outcome' | 'detail'>> {
  /**
   * Removes `references` in turn. It stops when Docker deleted the image (`deleted`: it wrote `Deleted:`), when the ID is
   * gone (`gone`: the image is gone), or at any other refusal (`refused`, with that step); a tag that is gone goes on to
   * the next reference. Else `{ deleted: false }`: each reference went, but Docker kept the image.
   */
  const removeReferences = async (references: readonly string[]): Promise<{ deleted: boolean; gone?: true; refused?: { result?: RunResult; error?: unknown } }> => {
    for (const reference of references) {
      const step = await call(docker, ['image', 'rm', reference], DOCKER_QUERY_TIMEOUT_MS, signal);
      if (step.result !== undefined && step.result.exitCode === 0 && IMAGE_DELETED_LINE.test(step.result.stdout)) return { deleted: true };
      const outcome = outcomeOf(step.result, 'removed');
      // A tag that is gone may have moved: the read afterwards decides. The ID that is gone is the image.
      if (outcome === 'missing' && reference === object.id) return { deleted: false, gone: true };
      if (outcome !== 'removed' && outcome !== 'missing') return { deleted: false, refused: step };
    }
    return { deleted: false };
  };
  const refusal = (step: { result?: RunResult; error?: unknown }): Pick<ObjectResult, 'outcome' | 'detail'> => {
    const outcome = outcomeOf(step.result, 'removed');
    return outcome === 'inUse' || outcome === 'failed' ? { outcome, detail: detailOf(step.result, step.error) } : { outcome };
  };
  const now = await imageTagsNow(docker, object.id, signal);
  if ('missing' in now) return { outcome: 'missing' };
  if ('detail' in now) return { outcome: 'failed', detail: now.detail };
  const shown = object.tags ?? [];
  const unseen = now.tags.filter((reference) => !hasDigest(reference) && !shown.includes(reference));
  if (unseen.length > 0) return { outcome: 'failed', detail: `The image has the tag ${unseen.join(', ')} now, which the view did not show. Click Refresh.` };
  const usersNow = await call(docker, imageUsersNowArgs(object.id), DOCKER_QUERY_TIMEOUT_MS, signal);
  if (usersNow.result === undefined || usersNow.result.exitCode !== 0 || usersNow.result.timedOut) {
    return { outcome: 'failed', detail: `The containers of this image could not be read: ${detailOf(usersNow.result, usersNow.error)}` };
  }
  const users = usersNow.result.stdout.split('\n').filter((line) => line.trim() !== '').length;
  if (users > 0) return { outcome: 'inUse', detail: `${users === 1 ? 'A container uses' : `${users} containers use`} this image.` };
  const references = [...now.tags.filter((reference) => !hasDigest(reference)), ...now.tags.filter(hasDigest)];
  const first = await removeReferences(references.length > 0 ? references : [object.id]);
  if (first.deleted) return { outcome: 'removed' };
  if (first.gone === true) return { outcome: 'missing' };
  if (first.refused !== undefined) return refusal(first.refused);
  const after = await imageTagsNow(docker, object.id, signal);
  if ('missing' in after) return { outcome: 'removed' };
  if ('detail' in after) return { outcome: 'failed', detail: after.detail };
  const tagsAfter = after.tags.filter((reference) => !hasDigest(reference));
  if (tagsAfter.length > 0) return { outcome: 'failed', detail: `Docker kept the image: it has the tag ${tagsAfter.join(', ')} now. Click Refresh.` };
  const digestsAfter = after.tags.filter(hasDigest);
  const second = await removeReferences(digestsAfter.length > 0 ? digestsAfter : [object.id]);
  if (second.deleted || second.gone === true) return { outcome: 'removed' };
  if (second.refused !== undefined) return refusal(second.refused);
  return { outcome: 'failed', detail: 'Docker kept the image. Click Refresh.' };
}

/**
 * `docker container ls --all` with the networks of each container (running or not), one JSON text per line, read just
 * before the removal of a network. Without a filter `network=`: the Docker CLI drops the spaces at the start and end of
 * its value, and Docker also matches it with the start of the ID of a network that a container ran on (verified with
 * Docker 29.9). By name, because Docker gives the network of a container that never ran no ID yet.
 */
export const NETWORK_USERS_ARGS: readonly string[] = ['container', 'ls', '--all', '--no-trunc', '--format', '{{json .Networks}}'];

/** The number of the containers on `network` now (holdsNetwork); `detail` when Docker could not say. Throws only an AbortError. */
async function networkUsersNow(docker: Pick<BootstrapDocker, 'run'>, network: HostObject, signal: AbortSignal | undefined): Promise<{ users: number } | { detail: string }> {
  const { result, error } = await call(docker, [...NETWORK_USERS_ARGS], DOCKER_QUERY_TIMEOUT_MS, signal);
  if (result === undefined || result.exitCode !== 0 || result.timedOut) return { detail: `The containers on this network could not be read: ${detailOf(result, error)}` };
  let users = 0;
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    let joined: unknown;
    try {
      joined = JSON.parse(line);
    } catch {
      return { detail: `The containers on this network could not be read: Docker wrote ${line.slice(0, 100)}` };
    }
    if (typeof joined === 'string' && holdsNetwork(joined, network.name)) users += 1;
  }
  return { users };
}

/**
 * Whether `name`, the image of a container as Docker names it (a tag, a full or short ID, a reference with a digest), is
 * `image`. A reference with a digest (`repository@sha256:…`, also after a tag) names the image of its digest, never the
 * image that its repository or tag names now: the digest is the ID of the image with the containerd image store; with
 * the classic image store it is a digest of the registry, and the container is missed.
 */
function namesImage(name: string, image: HostObject): boolean {
  const at = name.indexOf('@');
  if (at !== -1) return sameImageId(name.slice(at + 1), image.id);
  const hex = image.id.replace(/^sha256:/, '');
  const bare = name.replace(/^sha256:/, '');
  return (image.tags ?? []).some((tag) => normalizedReference(tag) === normalizedReference(name)) || (bare.length >= 12 && hex.startsWith(bare));
}

function capitalized(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
