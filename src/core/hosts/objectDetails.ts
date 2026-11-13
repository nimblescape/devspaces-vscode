// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The facts of Docker about one object of a host, for its report in the view Docker Hosts (docs/requirements.md
// R-ENG-008): `docker <kind> inspect` of the object, and for a volume the containers that use it (`docker container
// ls --filter volume=…`, then their inspect for the place of the mount). Only read-only calls, each on the shared shell
// of the host (isShellCall). The sections "Facts of Docker", "Mounts", "Used by" and "Containers" of its report. No
// `vscode`.
import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from '../names';
import { MONITOR_SCHEDULE_ENV, MONITOR_TIME_ZONE_ENV } from '../remoteMonitor/cacheSettings';
import { CommandError } from '../errors';
import { isRecord } from '../valueChecks';
import { commandText, parseJsonLines, type BootstrapDocker } from '../docker/bootstrapDocker';
import { DOCKER_QUERY_TIMEOUT_MS } from '../docker/dockerTimeouts';
import { nonEmptyText, onlyMissingContainers, type HostObject, type HostObjectKind } from './hostObjects';
import { cell, chip, countText, dockerTimeText, fact, itemsText, optional, shortDigest, sizeText, type ReportClock, type ReportFact, type ReportSection } from './reportModel';

/** The label of Docker Compose on a volume: its name in the Compose file. */
export const COMPOSE_VOLUME_LABEL = 'com.docker.compose.volume';
/** The labels of an image after the Open Container Initiative: its version, its revision, when it was built, its source. */
const OCI_VERSION = 'org.opencontainers.image.version';
const OCI_REVISION = 'org.opencontainers.image.revision';
const OCI_CREATED = 'org.opencontainers.image.created';
const OCI_SOURCE = 'org.opencontainers.image.source';
/** At most this many containers that use a volume are inspected for the place of their mount. */
export const MAX_VOLUME_USERS = 20;
/** At most this many rows of mounts, ports, networks or containers. */
const MAX_LIST = 50;
/**
 * The only environment variables of a container that its details keep: the schedule of the Monitor and its time zone.
 * The others can hold secrets, and no report needs them.
 */
const KEPT_ENV: readonly string[] = [MONITOR_SCHEDULE_ENV, MONITOR_TIME_ZONE_ENV];
/** The states of Docker of a container whose last run ended: its report gives the end and the exit code. */
const ENDED_STATES: readonly string[] = ['exited', 'dead', 'restarting'];

/** A mount of a container. */
export interface MountDetail {
  /** `volume`, `bind`, `tmpfs` or another type of Docker. */
  type: string;
  /** The name of a volume, the path of a bind mount on the host; empty for tmpfs. */
  source: string;
  destination: string;
  readOnly: boolean;
}

export interface ContainerDetails {
  kind: 'container';
  labels: Map<string, string>;
  createdAt?: string;
  image?: string;
  imageId?: string;
  /** Its state of Docker: `created`, `running`, `paused`, `restarting`, `exited`, `removing` or `dead`. */
  state?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  restartPolicy?: string;
  /** Its log driver (`json-file`, `local`, `none`, …): `none` keeps no log that Show Log could read. */
  logDriver?: string;
  /** Its environment variables of KEPT_ENV. */
  env: Map<string, string>;
  mounts: MountDetail[];
  /** `HOST_PORT → CONTAINER_PORT/PROTOCOL`, or `CONTAINER_PORT/PROTOCOL` when it is not published. */
  ports: string[];
  networks: string[];
}

export interface ImageDetails {
  kind: 'image';
  labels: Map<string, string>;
  createdAt?: string;
  repoDigests: string[];
  architecture?: string;
  os?: string;
}

/** A container that uses a volume, with the place and the mode of its mount when its inspect found them. */
export interface VolumeUser {
  id: string;
  name: string;
  state?: string;
  destination?: string;
  readOnly?: boolean;
}

export interface VolumeDetails {
  kind: 'volume';
  labels: Map<string, string>;
  createdAt?: string;
  driver?: string;
  scope?: string;
  users: VolumeUser[];
  /** More containers use it than `users` holds (MAX_VOLUME_USERS). */
  moreUsers: boolean;
  /** Why the containers that use it could not be listed (its other details stay). */
  usersProblem?: string;
}

export interface NetworkDetails {
  kind: 'network';
  labels: Map<string, string>;
  createdAt?: string;
  driver?: string;
  scope?: string;
  internal: boolean;
  subnets: string[];
  /** The names of the containers that are connected to it now. */
  containers: string[];
}

export type ObjectDetails = ContainerDetails | ImageDetails | VolumeDetails | NetworkDetails;

/** `docker <kind> inspect` of one object, one JSON line per object. */
export function inspectArgs(kind: HostObjectKind, ids: readonly string[]): string[] {
  return [kind, 'inspect', '--format', '{{json .}}', ...ids];
}

/** The containers that use the volume `name`, also stopped ones. */
export function volumeUsersArgs(name: string): string[] {
  return ['container', 'ls', '--all', '--no-trunc', '--filter', `volume=${name}`, '--format', '{{json .}}'];
}

function labelsOf(value: unknown): Map<string, string> {
  const labels = new Map<string, string>();
  if (!isRecord(value)) return labels;
  for (const [key, label] of Object.entries(value)) if (typeof label === 'string') labels.set(key, label);
  return labels;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : [];
}

/** The variables of KEPT_ENV of `Config.Env` (`NAME=VALUE`). */
function keptEnv(value: unknown): Map<string, string> {
  const env = new Map<string, string>();
  for (const entry of texts(value)) {
    const equals = entry.indexOf('=');
    const name = equals > 0 ? entry.slice(0, equals) : '';
    if (KEPT_ENV.includes(name)) env.set(name, entry.slice(equals + 1));
  }
  return env;
}

function parseMounts(value: unknown): MountDetail[] {
  if (!Array.isArray(value)) return [];
  const mounts: MountDetail[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const destination = nonEmptyText(entry.Destination);
    if (destination === undefined) continue;
    const type = nonEmptyText(entry.Type) ?? 'unknown';
    mounts.push({ type, source: (type === 'volume' ? nonEmptyText(entry.Name) : nonEmptyText(entry.Source)) ?? '', destination, readOnly: entry.RW === false });
  }
  return mounts;
}

function parsePorts(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const ports: string[] = [];
  for (const [port, bindings] of Object.entries(value)) {
    const published = Array.isArray(bindings) ? bindings.flatMap((binding) => (isRecord(binding) && nonEmptyText(binding.HostPort) !== undefined ? [nonEmptyText(binding.HostPort)!] : [])) : [];
    if (published.length === 0) ports.push(port);
    else for (const host of [...new Set(published)]) ports.push(`${host} → ${port}`);
  }
  return ports;
}

/** The details of the inspect output of one object of `kind`; undefined for anything else. */
export function parseObjectDetails(kind: HostObjectKind, value: unknown): ObjectDetails | undefined {
  if (!isRecord(value)) return undefined;
  switch (kind) {
    case 'container': {
      const config = isRecord(value.Config) ? value.Config : {};
      const state = isRecord(value.State) ? value.State : {};
      const host = isRecord(value.HostConfig) ? value.HostConfig : {};
      const restart = isRecord(host.RestartPolicy) ? nonEmptyText(host.RestartPolicy.Name) : undefined;
      const logDriver = isRecord(host.LogConfig) ? nonEmptyText(host.LogConfig.Type) : undefined;
      const network = isRecord(value.NetworkSettings) ? value.NetworkSettings : {};
      const exitCode = typeof state.ExitCode === 'number' ? state.ExitCode : undefined;
      return {
        kind,
        labels: labelsOf(config.Labels),
        ...optional('createdAt', nonEmptyText(value.Created)),
        ...optional('image', nonEmptyText(config.Image)),
        ...optional('imageId', nonEmptyText(value.Image)),
        ...optional('state', nonEmptyText(state.Status)),
        ...optional('startedAt', nonEmptyText(state.StartedAt)),
        ...optional('finishedAt', nonEmptyText(state.FinishedAt)),
        ...optional('exitCode', exitCode),
        ...optional('restartPolicy', restart),
        ...optional('logDriver', logDriver),
        env: keptEnv(config.Env),
        mounts: parseMounts(value.Mounts),
        ports: parsePorts(network.Ports),
        networks: isRecord(network.Networks) ? Object.keys(network.Networks).sort() : [],
      };
    }
    case 'image': {
      const config = isRecord(value.Config) ? value.Config : {};
      return {
        kind,
        labels: labelsOf(config.Labels),
        ...optional('createdAt', nonEmptyText(value.Created)),
        repoDigests: texts(value.RepoDigests),
        ...optional('architecture', nonEmptyText(value.Architecture)),
        ...optional('os', nonEmptyText(value.Os)),
      };
    }
    case 'volume':
      return {
        kind,
        labels: labelsOf(value.Labels),
        ...optional('createdAt', nonEmptyText(value.CreatedAt)),
        ...optional('driver', nonEmptyText(value.Driver)),
        ...optional('scope', nonEmptyText(value.Scope)),
        users: [],
        moreUsers: false,
      };
    case 'network': {
      const ipam = isRecord(value.IPAM) ? value.IPAM : {};
      const subnets = Array.isArray(ipam.Config) ? ipam.Config.flatMap((entry) => (isRecord(entry) && nonEmptyText(entry.Subnet) !== undefined ? [nonEmptyText(entry.Subnet)!] : [])) : [];
      const containers = isRecord(value.Containers)
        ? Object.values(value.Containers)
            .flatMap((entry) => (isRecord(entry) && nonEmptyText(entry.Name) !== undefined ? [nonEmptyText(entry.Name)!] : []))
            .sort()
        : [];
      return {
        kind,
        labels: labelsOf(value.Labels),
        ...optional('createdAt', nonEmptyText(value.Created)),
        ...optional('driver', nonEmptyText(value.Driver)),
        ...optional('scope', nonEmptyText(value.Scope)),
        internal: value.Internal === true,
        subnets,
        containers,
      };
    }
  }
}

/**
 * The details of `object` read now on the host: its inspect, for a volume also the containers that use it (at most
 * MAX_VOLUME_USERS of them inspected). Throws a CommandError when Docker fails, also when the object is not there
 * anymore, and an AbortError when `signal` aborts.
 */
export async function readObjectDetails(docker: Pick<BootstrapDocker, 'run'>, object: Pick<HostObject, 'kind' | 'id'>, signal?: AbortSignal): Promise<ObjectDetails> {
  const options = { timeoutMs: DOCKER_QUERY_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) };
  // `containers`: an inspect of several containers gives those that are there, also when others are gone (it prints the
  // found ones and ends with exit code 1, onlyMissingContainers).
  const run = async (args: string[], containers = false): Promise<unknown[]> => {
    const result = await docker.run(args, options);
    if ((result.exitCode !== 0 && !(containers && onlyMissingContainers(result.stderr))) || result.timedOut) {
      const stderr = result.timedOut ? `${result.stderr.trimEnd()}\nThe command did not end within the time limit.`.trim() : result.stderr;
      throw new CommandError(commandText(args), result.exitCode, result.stdout, stderr, result.timedOut);
    }
    return parseJsonLines(result.stdout);
  };
  const args = inspectArgs(object.kind, [object.id]);
  const details = parseObjectDetails(object.kind, (await run(args))[0]);
  if (details === undefined) throw new CommandError(commandText(args), 0, '', `Unexpected output of docker ${object.kind} inspect.`);
  if (details.kind !== 'volume') return details;
  let listed: Record<string, unknown>[];
  try {
    listed = (await run(volumeUsersArgs(object.id))).filter(isRecord);
  } catch (error) {
    // The inspect of the volume stays; only the containers that use it are not known.
    if (signal?.aborted === true) throw error;
    return { ...details, usersProblem: error instanceof Error ? error.message : String(error) };
  }
  const users: VolumeUser[] = listed.flatMap((entry) => {
    const id = nonEmptyText(entry.ID);
    return id === undefined ? [] : [{ id, name: (nonEmptyText(entry.Names) ?? id).split(',')[0], ...optional('state', nonEmptyText(entry.State)) }];
  });
  const shown = users.slice(0, MAX_VOLUME_USERS);
  if (shown.length > 0) {
    // The place and the mode of the mount; a container that went meanwhile keeps its row without them, and the others
    // keep theirs.
    const inspected = await run(inspectArgs('container', shown.map((user) => user.id)), true).catch((error: unknown) => {
      if (signal?.aborted === true) throw error;
      return [];
    });
    for (const entry of inspected) {
      if (!isRecord(entry)) continue;
      const user = shown.find((candidate) => candidate.id === entry.Id);
      const mount = parseMounts(entry.Mounts).find((candidate) => candidate.type === 'volume' && candidate.source === object.id);
      if (user === undefined || mount === undefined) continue;
      user.destination = mount.destination;
      user.readOnly = mount.readOnly;
    }
  }
  return { ...details, users: shown, moreUsers: users.length > shown.length };
}

/** The project of Docker Compose of the labels, with the service or the volume of its Compose file. */
function composeFact(labels: ReadonlyMap<string, string>, part: 'service' | 'volume' | undefined): ReportFact | undefined {
  const project = labels.get(COMPOSE_PROJECT_LABEL);
  if (project === undefined || project === '') return undefined;
  const name = part === 'service' ? labels.get(COMPOSE_SERVICE_LABEL) : part === 'volume' ? labels.get(COMPOSE_VOLUME_LABEL) : undefined;
  return fact('Docker Compose', name !== undefined && name !== '' ? `${part} ${name} of the project ${project}` : `project ${project}`);
}

/** What a restart policy of Docker does, in words. */
function restartFact(policy: string | undefined): ReportFact | undefined {
  if (policy === undefined || policy === 'no') return policy === 'no' ? fact('Restart policy', 'no: Docker does not start it again') : undefined;
  if (policy === 'always' || policy === 'unless-stopped') return fact('Restart policy', policy, chip('Docker starts it again after a restart of the engine', 'info'));
  if (policy === 'on-failure') return fact('Restart policy', policy, chip('Docker starts it again only after a failure', 'info'));
  return fact('Restart policy', policy);
}

/** The text of a list, at most MAX_LIST entries. */
function listText(values: readonly string[]): string {
  return itemsText(values, MAX_LIST);
}

/**
 * The sections of the facts of Docker about `object`: "Facts of Docker" from the inventory of the host and from
 * `details` (when its inspect worked), and the mounts of a container, the containers that use a volume, and the
 * containers of a network.
 */
export function dockerFactsSections(object: HostObject, details: ObjectDetails | undefined, clock: ReportClock): ReportSection[] {
  const facts: ReportFact[] = [];
  const push = (value: ReportFact | undefined): void => {
    if (value !== undefined) facts.push(value);
  };
  const created = dockerTimeText(details?.createdAt ?? object.createdAt, clock);
  const sections: ReportSection[] = [];
  switch (details?.kind ?? object.kind) {
    case 'container': {
      const container = details?.kind === 'container' ? details : undefined;
      push(object.image !== undefined || container?.image !== undefined ? fact('Image', container?.image ?? object.image ?? '') : undefined);
      push(object.status !== undefined ? fact('Status', object.status) : undefined);
      push(created !== undefined ? fact('Created', created) : undefined);
      const started = dockerTimeText(container?.startedAt, clock);
      push(started !== undefined ? fact('Last start', started) : undefined);
      // The end of the last run and its exit code only for a container that ended (a paused one runs, and a new one never
      // ran); its state of the inspect is newer than the one of the list.
      const state = container?.state ?? object.state;
      const finished = state !== undefined && ENDED_STATES.includes(state) ? dockerTimeText(container?.finishedAt, clock) : undefined;
      push(finished !== undefined ? fact('Last end', `${finished}${container?.exitCode !== undefined ? ` · exit code ${container.exitCode}` : ''}`) : undefined);
      push(restartFact(container?.restartPolicy));
      push(container?.logDriver !== undefined ? fact('Log driver', container.logDriver === 'none' ? 'none (Docker keeps no log of it)' : container.logDriver) : undefined);
      push(composeFact(container?.labels ?? new Map(), 'service'));
      push(container !== undefined && container.ports.length > 0 ? fact('Ports', listText(container.ports)) : undefined);
      const networks = container?.networks ?? object.networks ?? [];
      push(networks.length > 0 ? fact('Networks', listText(networks)) : undefined);
      push(fact('ID', object.id));
      sections.push({ title: 'Facts of Docker', body: { kind: 'facts', facts }, from: 'From docker container inspect.' });
      if (container !== undefined && container.mounts.length > 0) {
        sections.push({
          title: 'Mounts',
          body: {
            kind: 'table',
            columns: ['Source', 'Mounted at', 'Mode'],
            rows: container.mounts.slice(0, MAX_LIST).map((mount) => [cell(mount.source === '' ? mount.type : mount.type === 'volume' ? mount.source : `${mount.source} (${mount.type})`), cell(mount.destination), cell(mount.readOnly ? 'read-only' : 'read-write')]),
            ...(container.mounts.length > MAX_LIST ? { more: `${container.mounts.length - MAX_LIST} more mounts` } : {}),
          },
          from: 'From docker container inspect.',
        });
      }
      break;
    }
    case 'image': {
      const image = details?.kind === 'image' ? details : undefined;
      const tags = object.tags ?? [];
      push(fact('Tags', tags.length > 0 ? listText(tags) : 'none: an image without a tag'));
      const labels = image?.labels ?? new Map<string, string>();
      const version = labels.get(OCI_VERSION);
      const revision = labels.get(OCI_REVISION);
      if (version !== undefined || revision !== undefined) push(fact('Version', [version, revision !== undefined ? `revision ${revision.slice(0, 12)}` : undefined].filter((part) => part !== undefined).join(' · ')));
      const built = dockerTimeText(labels.get(OCI_CREATED), clock);
      push(built !== undefined ? fact('Built by its publisher', built) : undefined);
      push(labels.get(OCI_SOURCE) !== undefined ? fact('Source', labels.get(OCI_SOURCE)!) : undefined);
      push(image !== undefined && image.repoDigests.length > 0 ? fact('Digests', listText(image.repoDigests.map((digest) => `${digest.slice(0, digest.indexOf('@') + 1)}sha256:${shortDigest(digest.slice(digest.indexOf('@') + 1))}…`))) : undefined);
      push(created !== undefined ? fact('Created', created) : undefined);
      push(image?.os !== undefined ? fact('Platform', [image.os, image.architecture].filter((part) => part !== undefined).join('/')) : undefined);
      push(object.sizeBytes !== undefined ? fact('Size', `${sizeText(object.sizeBytes)}${object.uniqueBytes !== undefined ? ` · ${sizeText(object.uniqueBytes)} only for this image` : ''}`) : undefined);
      push(object.usedBy !== undefined ? fact('Used by', object.usedBy === 0 ? 'no container' : countText(object.usedBy, 'container')) : undefined);
      push(fact('ID', object.id));
      sections.push({ title: 'Facts of Docker', body: { kind: 'facts', facts }, from: 'From docker image inspect. Version, revision and the time of the build from the labels org.opencontainers.image.*, only when the image has them.' });
      break;
    }
    case 'volume': {
      const volume = details?.kind === 'volume' ? details : undefined;
      push(composeFact(volume?.labels ?? new Map(), 'volume'));
      push(volume?.driver !== undefined ? fact('Driver', volume.driver) : undefined);
      push(created !== undefined ? fact('Created', created) : undefined);
      push(object.sizeBytes !== undefined ? fact('Size', sizeText(object.sizeBytes)) : undefined);
      push(object.usedBy !== undefined ? fact('Used by', object.usedBy === 0 ? 'no container' : countText(object.usedBy, 'container')) : undefined);
      sections.push({ title: 'Facts of Docker', body: { kind: 'facts', facts }, from: 'From docker volume inspect and docker system df.' });
      if (volume !== undefined) {
        sections.push({
          title: 'Used by',
          body: {
            kind: 'table',
            columns: ['Container', 'State', 'Mounted at', 'Mode'],
            rows: volume.users.map((user) => [cell(user.name), cell(user.state ?? ''), cell(user.destination ?? ''), cell(user.readOnly === undefined ? '' : user.readOnly ? 'read-only' : 'read-write')]),
            empty: volume.usersProblem !== undefined ? `Not known: Docker could not list them (${volume.usersProblem}).` : 'No container uses it now.',
            ...(volume.moreUsers ? { more: `More containers use it; the first ${volume.users.length} are shown.` } : {}),
          },
          from: 'From docker container ls and docker container inspect of the containers that use it.',
        });
      }
      break;
    }
    case 'network': {
      const network = details?.kind === 'network' ? details : undefined;
      push(composeFact(network?.labels ?? new Map(), undefined));
      const driver = network?.driver ?? object.driver;
      push(driver !== undefined ? fact('Driver', driver) : undefined);
      push(network?.scope !== undefined ? fact('Scope', network.scope) : undefined);
      push(network !== undefined && network.subnets.length > 0 ? fact('Subnets', listText(network.subnets)) : undefined);
      push(network?.internal === true ? fact('Internal', 'yes: no connection to the outside') : undefined);
      push(object.builtIn === true ? fact('Created by', 'Docker itself', chip('Devspaces does not remove it', 'info')) : created !== undefined ? fact('Created', created) : undefined);
      push(fact('ID', object.id));
      sections.push({ title: 'Facts of Docker', body: { kind: 'facts', facts }, from: 'From docker network inspect.' });
      if (network !== undefined) {
        sections.push({
          title: 'Containers',
          body: { kind: 'table', columns: ['Container'], rows: network.containers.slice(0, MAX_LIST).map((name) => [cell(name)]), empty: 'No running container is connected to it.', ...(network.containers.length > MAX_LIST ? { more: `${network.containers.length - MAX_LIST} more containers` } : {}) },
          from: 'From docker network inspect: the running containers that are connected to it.',
        });
      }
      break;
    }
  }
  return sections;
}
