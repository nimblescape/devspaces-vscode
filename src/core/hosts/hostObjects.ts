// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The objects of Devspaces on a Docker host, for the view "Docker Hosts" (docs/requirements.md R-ENG-008): its
// containers, images and volumes with their purpose and size, read with the Docker CLI of Devspaces (BootstrapDocker.run,
// within an operation on that host: through the Docker pipe of the extension, as "Remove Devspaces from This Docker
// Engine…" reads), and their removal. Only the objects of Devspaces: those with a label nimblescape.devspaces.*, the
// containers, images and volumes whose name starts with `devspaces-` (also the tags of the build image
// devspaces-buildx), and the base images that the build record of a devspace of the host names. Every other object of
// the engine stays hidden. The removal never uses force: Docker refuses a running container, and an image or a volume
// that a container uses, and the result says so. No `vscode`.
import { CommandError, errorMessage } from '../errors';
import {
  COMPOSE_PROJECT_LABEL,
  LABEL_BUILD_RUN,
  LABEL_CHANNEL_STEP,
  LABEL_COMPOSE_SERVICE,
  LABEL_DEVSPACE_ID,
  LABEL_HELPER,
  LABEL_HELPER_RUN,
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
  resourceName,
} from '../names';
import { isAbortError, type Logger, type RunResult } from '../ports';
import { LABEL_MONITOR, REMOTE_MONITOR_VOLUME } from '../remoteMonitor/protocol';
import type { Devspace } from '../types';
import { isRecord } from '../valueChecks';
import { IMAGE_IN_USE_PATTERN, commandText, parseJsonLines, parseJsonOutput, type BootstrapDocker } from '../docker/bootstrapDocker';
import { BUILDX_REPOSITORY } from '../docker/buildxImage';
import { DOCKER_QUERY_TIMEOUT_MS } from '../docker/dockerTimeouts';
import { VOLUME_REMOVE_TIMEOUT_MS } from '../docker/engineRemoval';

export type HostObjectKind = 'container' | 'image' | 'volume';

/**
 * What an object is for. `devspace`: an object of a devspace of this computer (its container, the containers of its
 * services, its images, its volumes), which gets the actions of the devspace (Stop, Delete…). `otherDevspace`: an object
 * of a devspace that this computer does not know (for example of another computer on a shared host). The others belong
 * to the helpers of Devspaces, or are other objects of Devspaces (`other`).
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
  | 'baseImage'
  | 'sharedVolume'
  | 'other';

export interface HostObject {
  kind: HostObjectKind;
  /** The full ID of a container or an image, the name of a volume. */
  id: string;
  /** The name of a container or a volume; the first tag of an image, or its short ID when it has none. */
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
   * `additional volume`, `volume of Docker Compose`, `data of a service`), or what a shared volume holds.
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
  /** The number of containers that use the image or the volume. */
  usedBy?: number;
  /** When Docker created the container or the image, as Docker writes it. */
  createdAt?: string;
  /** A container: its image, as Docker names it (a tag, or an ID). */
  image?: string;
}

export interface HostInventory {
  containers: HostObject[];
  images: HostObject[];
  volumes: HostObject[];
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
  if (devspaceId === undefined && !hasDevspacesLabel(labels) && !name.toLowerCase().startsWith(RESOURCE_NAME_PREFIX)) return undefined;
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
  };
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
  if (devspaceId === undefined && additionalOf === undefined && !hasDevspacesLabel(labels) && !name.toLowerCase().startsWith(RESOURCE_NAME_PREFIX)) return undefined;
  const base: HostObject = {
    kind: 'volume',
    id: name,
    name,
    purpose: 'other',
    ...(parseDockerSize(item.Size) !== undefined ? { sizeBytes: parseDockerSize(item.Size) } : {}),
    ...(count(item.Links) !== undefined ? { usedBy: count(item.Links) } : {}),
  };
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

/** The image entries of `docker system df -v` (one per tag), merged by image ID. */
function mergedImages(items: readonly unknown[]): Array<{ id: string; tags: string[]; item: Record<string, unknown> }> {
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
    const repository = text(item.Repository);
    const tag = text(item.Tag);
    if (repository !== undefined && tag !== undefined && repository !== '<none>' && tag !== '<none>') {
      const reference = `${repository}:${tag}`;
      if (!image.tags.includes(reference)) image.tags.push(reference);
    }
  }
  return [...images.values()];
}

/** The short form of an image ID for its name when it has no tag: `<none> (1a2b3c4d5e6f)`. */
function untaggedName(id: string): string {
  return `<none> (${id.replace(/^sha256:/, '').slice(0, 12)})`;
}

function classifyImage(
  image: { id: string; tags: string[]; item: Record<string, unknown> },
  input: { devspaceImageIds: ReadonlySet<string>; helperImageIds: ReadonlySet<string>; baseImages: ReadonlySet<string>; known: readonly KnownDevspace[] },
): HostObject | undefined {
  const { id, tags, item } = image;
  // The tags of Devspaces first, so that the name of the row is one of them.
  const ordered = [...tags.filter((tag) => tag.startsWith(RESOURCE_NAME_PREFIX)), ...tags.filter((tag) => !tag.startsWith(RESOURCE_NAME_PREFIX))];
  const base: HostObject = {
    kind: 'image',
    id,
    name: ordered[0] ?? untaggedName(id),
    tags: ordered,
    purpose: 'other',
    ...(parseDockerSize(item.Size) !== undefined ? { sizeBytes: parseDockerSize(item.Size) } : {}),
    ...(parseDockerSize(item.UniqueSize) !== undefined ? { uniqueBytes: parseDockerSize(item.UniqueSize) } : {}),
    ...(count(item.Containers) !== undefined ? { usedBy: count(item.Containers) } : {}),
    ...(text(item.CreatedAt) !== undefined ? { createdAt: text(item.CreatedAt) } : {}),
  };
  if (input.helperImageIds.has(id)) return { ...base, purpose: 'helperImage' };
  if (ordered.some((tag) => tag.startsWith(`${BUILDX_REPOSITORY}:`))) return { ...base, purpose: 'buildImage' };
  const byName = ordered.map((tag) => devspaceByName(tag, input.known)).find((devspace) => devspace !== undefined);
  if (input.devspaceImageIds.has(id) || byName !== undefined) {
    const prepared = ordered.some((tag) => tag.slice(tag.lastIndexOf(':') + 1).startsWith(PREPARED_IMAGE_TAG));
    return { ...base, ...devspaceFields(undefined, byName, input.known, undefined), role: prepared ? 'prepared image' : 'image' };
  }
  if (ordered.some((tag) => input.baseImages.has(normalizedReference(tag)))) return { ...base, purpose: 'baseImage' };
  if (ordered.some((tag) => tag.toLowerCase().startsWith(RESOURCE_NAME_PREFIX))) return base;
  return undefined;
}

export interface InventoryInput {
  /** The output of `docker system df -v --format '{{json .}}'`, parsed. */
  df: unknown;
  /** The IDs of the images with the label nimblescape.devspaces.id (the images of the devspaces). */
  devspaceImageIds: ReadonlySet<string>;
  /** The IDs of the images with the label nimblescape.devspaces.worker=true (the helper images). */
  helperImageIds: ReadonlySet<string>;
  /** The devspaces of this computer on the host. */
  known: readonly KnownDevspace[];
  /** baseImageReferences of the devspaces of the host. */
  baseImages: ReadonlySet<string>;
}

/** The objects of Devspaces in the output of `docker system df -v` (see the module comment), each group by name. */
export function buildInventory(input: InventoryInput): HostInventory {
  const df = isRecord(input.df) ? input.df : {};
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const containers = list(df.Containers).flatMap((item) => (isRecord(item) ? (classifyContainer(item, input.known) ?? []) : []));
  const volumes = list(df.Volumes).flatMap((item) => (isRecord(item) ? (classifyVolume(item, input.known) ?? []) : []));
  const images = mergedImages(list(df.Images)).flatMap((image) => classifyImage(image, input) ?? []);
  const byName = (a: HostObject, b: HostObject): number => a.name.localeCompare(b.name);
  return { containers: containers.sort(byName), images: images.sort(byName), volumes: volumes.sort(byName) };
}

/** The time limit of `docker system df -v`: it sums the sizes of all volumes, which can take some time on a large engine. */
export const SYSTEM_DF_TIMEOUT_MS = 3 * 60_000;

/** The arguments of the read of the sizes and of the containers, images and volumes of the engine. */
export const SYSTEM_DF_ARGS: readonly string[] = ['system', 'df', '--verbose', '--format', '{{json .}}'];

/**
 * Reads the objects of Devspaces on the engine of the operation (runWithDockerTarget): one `docker system df -v` and the
 * IDs of the images with the labels of Devspaces. Only calls that read. Throws CommandError when a call fails, and an
 * AbortError when `signal` aborts.
 */
export async function readHostInventory(
  docker: Pick<BootstrapDocker, 'run' | 'listImagesByLabel'>,
  options: { known: readonly KnownDevspace[]; baseImages: ReadonlySet<string>; signal?: AbortSignal },
): Promise<HostInventory> {
  const { signal } = options;
  const result = await docker.run(SYSTEM_DF_ARGS, { timeoutMs: SYSTEM_DF_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new CommandError(commandText(SYSTEM_DF_ARGS), result.exitCode, result.stdout, result.timedOut ? `${result.stderr}\nThe command did not end within the time limit.`.trim() : result.stderr);
  }
  const df = parseJsonOutput(result.stdout);
  if (!isRecord(df)) throw new CommandError(commandText(SYSTEM_DF_ARGS), result.exitCode, result.stdout, 'Unexpected output of docker system df.');
  const devspaceImageIds = new Set((await docker.listImagesByLabel(LABEL_DEVSPACE_ID)).map((image) => image.id));
  const helperImageIds = new Set((await docker.listImagesByLabel(`${LABEL_HELPER}=true`)).map((image) => image.id));
  return buildInventory({ df, devspaceImageIds, helperImageIds, known: options.known, baseImages: options.baseImages });
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
const MISSING_PATTERN = /no such (container|image|volume|object)/i;
/** What Docker says when another removal of the container runs already (for example the `--rm` of a closing worker). */
const REMOVAL_IN_PROGRESS_PATTERN = /removal of container .* is already in progress/i;
/** What Docker says of a running container that `docker rm` without force does not remove. */
const RUNNING_PATTERN = /cannot remove (a )?(running|paused|restarting) container|stop the container before/i;

/** `removed`; `missing`: it was not there anymore; `inUse`: a container uses it, or it runs; `failed`: another error. */
export type ObjectOutcome = 'removed' | 'stopped' | 'missing' | 'inUse' | 'failed';

export interface ObjectResult {
  object: Pick<HostObject, 'kind' | 'name'>;
  outcome: ObjectOutcome;
  /** What Docker said (the end of its error output) of an object that is left. */
  detail?: string;
}

/** The outcome of a removal or a stop call. */
function outcomeOf(result: RunResult | undefined, done: 'removed' | 'stopped'): ObjectOutcome {
  if (result === undefined) return 'failed';
  if (result.exitCode === 0 && !result.timedOut) return done;
  if (result.timedOut) return 'failed';
  const output = `${result.stderr}\n${result.stdout}`;
  if (MISSING_PATTERN.test(output)) return 'missing';
  if (REMOVAL_IN_PROGRESS_PATTERN.test(output)) return 'removed';
  if (RUNNING_PATTERN.test(output) || IMAGE_IN_USE_PATTERN.test(output)) return 'inUse';
  return 'failed';
}

function detailOf(result: RunResult | undefined, error: unknown): string {
  if (result === undefined) return errorMessage(error).slice(-500);
  if (result.timedOut) return 'Docker did not answer in time.';
  return (result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`).slice(-500);
}

/** What an object is, for the progress and the log: `the container devspaces-monitor`. */
export function objectText(object: Pick<HostObject, 'kind' | 'name'>): string {
  return `the ${object.kind} ${object.name}`;
}

/** The time limit of `docker container stop`: Docker waits 10 seconds for the end of the container, then kills it. */
const STOP_TIMEOUT_MS = 60_000;

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
  const entry: ObjectResult = { object, outcome, ...(outcome === 'inUse' || outcome === 'failed' ? { detail: detailOf(result, error) } : {}) };
  logResult(logger, entry);
  return entry;
}

/**
 * Removes `objects` on the engine of the operation, never with force: the containers first (by ID; a running one
 * stays), then the images (each tag, so that the last tag removes the image; an image without a tag by its ID), then
 * the volumes, so that an image or a volume that only a removed container used goes too. Every object is logged with its
 * outcome. Throws only an AbortError (cancel); the objects before it are removed.
 */
export async function removeHostObjects(
  docker: Pick<BootstrapDocker, 'run'>,
  objects: readonly HostObject[],
  options: { logger: Logger; signal?: AbortSignal; onItem?: (text: string) => void },
): Promise<ObjectResult[]> {
  const order: Record<HostObjectKind, number> = { container: 0, image: 1, volume: 2 };
  const results: ObjectResult[] = [];
  for (const object of [...objects].sort((a, b) => order[a.kind] - order[b.kind])) {
    options.onItem?.(objectText(object));
    // An image that a container uses keeps all its tags: Docker would untag the first tags and refuse only the last one.
    // A container of this removal does not count (it goes first).
    const users = object.kind === 'image' ? (object.usedBy ?? 0) - removedUsers(object, objects, results) : 0;
    if (users > 0) {
      const entry: ObjectResult = { object: { kind: object.kind, name: object.name }, outcome: 'inUse', detail: `${users === 1 ? 'A container uses' : `${users} containers use`} this image.` };
      logResult(options.logger, entry);
      results.push(entry);
      continue;
    }
    const references = object.kind === 'image' && (object.tags?.length ?? 0) > 0 ? (object.tags ?? []) : [object.id];
    let last: { result?: RunResult; error?: unknown } = {};
    for (const reference of references) {
      const args = object.kind === 'container' ? ['container', 'rm', reference] : object.kind === 'image' ? ['image', 'rm', reference] : ['volume', 'rm', reference];
      last = await call(docker, args, object.kind === 'volume' ? VOLUME_REMOVE_TIMEOUT_MS : DOCKER_QUERY_TIMEOUT_MS, options.signal);
      const step = outcomeOf(last.result, 'removed');
      if (step !== 'removed' && step !== 'missing') break;
    }
    const outcome = outcomeOf(last.result, 'removed');
    const entry: ObjectResult = { object: { kind: object.kind, name: object.name }, outcome, ...(outcome === 'inUse' || outcome === 'failed' ? { detail: detailOf(last.result, last.error) } : {}) };
    logResult(options.logger, entry);
    results.push(entry);
  }
  return results;
}

/**
 * The containers of `objects` that this removal removed and that used `image` (by the image of the container in
 * `docker system df`), so that an image whose only containers went is removed too.
 */
function removedUsers(image: HostObject, objects: readonly HostObject[], results: readonly ObjectResult[]): number {
  const removed = new Set(results.filter((result) => result.object.kind === 'container' && (result.outcome === 'removed' || result.outcome === 'missing')).map((result) => result.object.name));
  return objects.filter((object) => object.kind === 'container' && removed.has(object.name) && object.image !== undefined && namesImage(object.image, image)).length;
}

/** Whether `name`, the image of a container as Docker names it (a tag, a full or short ID), is `image`. */
function namesImage(name: string, image: HostObject): boolean {
  const hex = image.id.replace(/^sha256:/, '');
  const bare = name.replace(/^sha256:/, '');
  return (image.tags ?? []).some((tag) => normalizedReference(tag) === normalizedReference(name)) || (bare.length >= 12 && hex.startsWith(bare));
}

function capitalized(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
