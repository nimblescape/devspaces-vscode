// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reports of the objects of a devspace in the view Docker Hosts (docs/requirements.md R-ENG-010): the dev container
// (its devspace, its image and build, the labels that decide whether the next Start creates it again, and the windows
// that use it now from the heartbeat records of the Monitor), a container of another service of Docker Compose, the
// workspace volume (its devspace and the Git record of this computer), the other volumes of a devspace (what Delete
// does with them), and the network of its Docker Compose project. The values come from the labels of the object, its
// facts of Docker, and the registry of this computer; a devspace that this computer does not know has only its labels.
// Before the facts of Docker (resourceReport.ts). Pure; no I/O.
import {
  COMPOSE_PROJECT_LABEL,
  CONTAINER_CONFIG_UNKNOWN,
  CONTAINER_VERSION,
  HOST_ACCESS_UNRESTRICTED,
  LABEL_BUILD_RECORD,
  LABEL_COMPOSE_SERVICE,
  LABEL_CONFIG_PATH,
  LABEL_CONTAINER_CONFIG,
  LABEL_CONTAINER_VERSION,
  LABEL_DEFAULT_IMAGE,
  LABEL_HOST_ACCESS,
  LABEL_OWNER_ID,
  LABEL_SERVICE_DATA,
  LABEL_VOLUME,
  MAX_BUILD_RECORD_LABEL_LENGTH,
  VOLUME_KIND_COMPOSE,
  composeProjectName,
} from '../names';
import { isBuildRecord } from '../storage/registry';
import type { BuildRecord, GitSummary } from '../types';
import { normalizedReference, type HostObject } from './hostObjects';
import type { MonitorRecords } from './monitorRecords';
import { windowCells, type ReportComputer, type ReportDevspace } from './monitorReport';
import type { ObjectDetails } from './objectDetails';
import { chip, dockerTimeText, fact, itemsText, type ReportChip, type ReportClock, type ReportContent, type ReportFact, type ReportSection } from './reportModel';

export interface DevspaceReportInput {
  object: HostObject;
  details?: ObjectDetails;
  /** The entry of the devspace of the object in the registry of this computer; undefined for a devspace that it does not know. */
  devspace?: ReportDevspace;
  /** The records of the Monitor (for the dev container: the heartbeats), when they were read. */
  records?: MonitorRecords;
  computer: ReportComputer;
  clock: ReportClock;
}

/** The roles of the volumes of a devspace other than its workspace (HostObject.role, classifyVolume). */
const DATA_VOLUME_ROLES: readonly string[] = ['data of a service', 'volume of Docker Compose', 'additional volume'];

/** The rule of Devspaces for a devspace that this computer does not know. */
const UNKNOWN_DEVSPACE = chip('a devspace that this computer does not know: of another computer or another VS Code profile', 'info');

/** Whether the report of `object` has a part of this module (devspaceReport gives it). */
export function isDevspaceObject(object: Pick<HostObject, 'kind' | 'purpose' | 'role'>): boolean {
  if (object.purpose !== 'devspace' && object.purpose !== 'otherDevspace') return false;
  return object.kind === 'container' || object.kind === 'network' || (object.kind === 'volume' && (object.role === 'workspace' || DATA_VOLUME_ROLES.includes(object.role ?? '')));
}

/** The labels of the details (none without them). */
function labelsOf(details: ObjectDetails | undefined): ReadonlyMap<string, string> {
  return details?.labels ?? new Map<string, string>();
}

/** A label that is not empty. */
function label(labels: ReadonlyMap<string, string>, key: string): string | undefined {
  const value = labels.get(key);
  return value !== undefined && value !== '' ? value : undefined;
}

/** The build record in the label nimblescape.devspaces.build-record, when it is a valid record (the labels prove nothing). */
export function labelBuildRecord(labels: ReadonlyMap<string, string>): BuildRecord | undefined {
  const text = labels.get(LABEL_BUILD_RECORD);
  if (text === undefined || text === '' || text.length > MAX_BUILD_RECORD_LABEL_LENGTH) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isBuildRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A build in words: `build 2 of 2026-11-10 14:22`. */
function buildText(record: Pick<BuildRecord, 'buildNumber' | 'builtAt'>, clock: ReportClock): string {
  const built = dockerTimeText(record.builtAt, clock);
  return `build ${record.buildNumber}${built !== undefined ? ` of ${built}` : ''}`;
}

/** The fact "Devspace": its repository, with its owner on this computer, or the tag of a devspace that it does not know. */
function devspaceFact(object: HostObject, devspace: ReportDevspace | undefined): ReportFact {
  if (devspace === undefined) return fact('Devspace', object.repository ?? 'not known: the object has no label of its repository', UNKNOWN_DEVSPACE);
  return fact('Devspace', `${devspace.repository} · owner ${devspace.owner.login !== '' ? devspace.owner.login : `GitHub user ${devspace.owner.id}`}`);
}

/** Where the configuration of a devspace comes from: the default image, or a configuration of the repository. */
function sourceText(devspace: ReportDevspace | undefined, labels: ReadonlyMap<string, string>): string | undefined {
  const defaultImage = devspace?.defaultImage ?? label(labels, LABEL_DEFAULT_IMAGE);
  if (defaultImage !== undefined) return `the default image ${defaultImage}`;
  return label(labels, LABEL_CONFIG_PATH) ?? devspace?.configPath;
}

/** The report of a container of a devspace: the dev container, or a container of another service of Docker Compose. */
function containerReport(input: DevspaceReportInput): ReportContent {
  const { object, details, devspace, records, computer, clock } = input;
  const labels = labelsOf(details);
  // The service of a container of another service: its label, else its role in the view (its details may be missing).
  const service = label(labels, LABEL_COMPOSE_SERVICE) ?? (object.role?.startsWith('service ') === true ? object.role.slice('service '.length) : undefined);
  const image = (details?.kind === 'container' ? details.image : undefined) ?? object.image;
  if (service !== undefined) return serviceReport(input, service, image);
  const facts: ReportFact[] = [devspaceFact(object, devspace)];
  const summary: ReportChip[] = [];
  // The image, with the build of the record on the container; the record of this computer when it names another image.
  const record = labelBuildRecord(labels);
  if (image !== undefined) facts.push(fact('Image', `${image}${record !== undefined && record.devspaceImage === image ? ` · ${buildText(record, clock)}` : ''}`));
  const recorded = devspace?.buildRecord;
  if (recorded !== undefined && image !== undefined && recorded.devspaceImage !== image) facts.push(fact('Build record of this computer', `${recorded.devspaceImage} · ${buildText(recorded, clock)}`, chip('another image than the one of the container', 'info')));
  // The labels by which the next Start decides whether it creates the container again (containerIsCurrent).
  const source = sourceText(devspace, labels);
  const unknownConfig = labels.get(LABEL_CONTAINER_CONFIG) === CONTAINER_CONFIG_UNKNOWN;
  if (source !== undefined || unknownConfig) {
    facts.push(
      fact(
        'Configuration',
        source ?? 'not known',
        unknownConfig ? chip('created without the configuration of the repository: the next Start that can read it creates the container again', 'warn') : undefined,
      ),
    );
  }
  if (details !== undefined) {
    const text = labels.get(LABEL_CONTAINER_VERSION);
    const version = text !== undefined && /^\d{1,6}$/.test(text) ? Number(text) : 0;
    const current = version >= CONTAINER_VERSION;
    facts.push(
      fact(
        'Container setup',
        version > 0 ? `version ${version}` : 'no version: older than the versions of the container setup',
        current ? chip('current', 'keep') : chip('older: the next Start creates the container again from its image; the files of the workspace stay', 'remove'),
      ),
    );
    if (!current) summary.push(chip('created again at the next Start', 'remove'));
    const unrestricted = labels.get(LABEL_HOST_ACCESS) === HOST_ACCESS_UNRESTRICTED;
    facts.push(
      unrestricted
        ? fact('Host access checks', 'off when it was created', chip('when the checks are on again, the next Start creates it again once they pass', 'warn'))
        : fact('Host access checks', 'on when it was created'),
    );
  }
  if (devspace !== undefined) {
    facts.push(
      devspace.keepRunning === true
        ? fact('Keep Running When Closed', 'on: the Monitor never stops it; only Stop or Delete does', chip('rule of the devspace', 'info'))
        : devspace.keepRunningOnce === true
          ? fact('Keep Running When Closed', 'off, but this time it keeps running: its window was closed with Close and Keep Running')
          : fact('Keep Running When Closed', 'off'),
    );
  }
  const sections: ReportSection[] = [
    {
      title: 'The devspace',
      body: { kind: 'facts', facts },
      from: 'From the labels build-record, config-path, container-config, container-version and host-access of the container, and the registry of this computer.',
    },
  ];
  if (records !== undefined && object.devspaceId !== undefined) {
    const heartbeats = records.heartbeats.filter((heartbeat) => heartbeat.devspaceId === object.devspaceId).sort((a, b) => (b.record?.at ?? 0) - (a.record?.at ?? 0));
    sections.push({
      title: 'Windows now',
      body: { kind: 'table', columns: ['Computer', 'Last sign', 'When the last window closes'], rows: heartbeats.map((heartbeat) => windowCells(heartbeat, computer, clock)), empty: 'No window has sent a sign for this devspace.' },
      from: 'From the heartbeat records in devspaces-monitor. A window sends a sign every 30 seconds; the Monitor stops the devspace when no sign came within its time.',
    });
  }
  return { summary, sections, notices: [], monitorLog: false };
}

/** The report of a container of another service of Docker Compose of a devspace. */
function serviceReport(input: DevspaceReportInput, service: string, image: string | undefined): ReportContent {
  const { object, details, devspace } = input;
  const facts: ReportFact[] = [devspaceFact(object, devspace), fact('Service', service)];
  if (image !== undefined) {
    // The build record of this computer names the images of the services: pulled ones, and those that Compose built.
    const compose = devspace?.buildRecord?.compose;
    const pulled = compose?.serviceImages.some((reference) => normalizedReference(reference) === normalizedReference(image)) === true;
    const built = compose?.images.includes(image) === true;
    facts.push(
      fact(
        'Image',
        image,
        pulled ? chip('an image of the service, pulled and not built: Delete does not remove it', 'info') : built ? chip('built by Docker Compose for this devspace: Delete removes it', 'info') : undefined,
      ),
    );
  }
  const volumes = details?.kind === 'container' ? details.mounts.filter((mount) => mount.type === 'volume').map((mount) => mount.source) : [];
  if (volumes.length > 0) facts.push(fact('Volumes', itemsText(volumes, 10)));
  facts.push(fact('Stop and Delete', 'with the devspace', chip('Stop, the Monitor and Delete find it by the label of the devspace', 'info')));
  return {
    summary: [],
    sections: [{ title: 'The service', body: { kind: 'facts', facts }, from: 'From the labels id and compose-service of the container, docker container inspect, and the build record of this computer (the images of the services).' }],
    notices: [],
    monitorLog: false,
  };
}

/** The facts of the Git record of this computer (GitSummary). */
function gitFacts(summary: GitSummary, clock: ReportClock): ReportFact[] {
  const recorded = dockerTimeText(summary.recordedAt, clock);
  const risk = (count: number): ReportChip | undefined => (count > 0 ? chip('not on GitHub', 'warn') : undefined);
  return [
    fact('Branch', summary.branch ?? 'not known, or a detached HEAD'),
    fact('Uncommitted files', String(summary.uncommittedFiles), risk(summary.uncommittedFiles)),
    fact('Unpushed commits', String(summary.unpushedCommits), risk(summary.unpushedCommits)),
    fact('Stashes', String(summary.stashes), risk(summary.stashes)),
    fact('Recorded', recorded ?? 'not known'),
  ];
}

/** The report of the workspace volume of a devspace. */
function workspaceReport(input: DevspaceReportInput): ReportContent {
  const { object, details, devspace, clock } = input;
  const labels = labelsOf(details);
  const facts: ReportFact[] = [devspaceFact(object, devspace)];
  const source = sourceText(devspace, labels);
  if (source !== undefined) facts.push(fact('Source', source));
  const owner = label(labels, LABEL_OWNER_ID);
  if (devspace === undefined && owner !== undefined) facts.push(fact('Owner', `GitHub user ${owner}`));
  const created = dockerTimeText(devspace?.createdAt, clock);
  if (created !== undefined) facts.push(fact('Created', created));
  const opened = dockerTimeText(devspace?.lastUsedAt, clock);
  if (opened !== undefined) facts.push(fact('Last open', opened));
  const seen = dockerTimeText(devspace?.lastSeenInUseAt, clock);
  if (seen !== undefined) facts.push(fact('Last seen in use', seen));
  const sections: ReportSection[] = [{ title: 'The devspace', body: { kind: 'facts', facts }, from: 'From the labels of the volume and the registry of this computer.' }];
  const summary: ReportChip[] = [];
  if (devspace === undefined) {
    sections.push({
      title: 'Git',
      body: { kind: 'facts', facts: [fact('Changes', 'not known on this computer', chip('Remove… in this view deletes the changes that were not pushed', 'warn'))] },
      from: 'Only the computer that uses the devspace records its Git state.',
    });
  } else if (devspace.gitSummary === undefined) {
    sections.push({
      title: 'Git at the last record',
      body: { kind: 'facts', facts: [fact('Changes', 'not known: this computer has no record of the Git state yet')] },
      from: 'From the Git record of this computer. Delete… reads the Git state in the running dev container before it asks.',
    });
  } else {
    const git = devspace.gitSummary;
    const changes = git.uncommittedFiles + git.unpushedCommits + git.stashes;
    if (changes > 0) summary.push(chip('changes that are not on GitHub', 'warn'));
    sections.push({
      title: 'Git at the last record',
      chip: changes > 0 ? chip('changes that are not on GitHub', 'warn') : chip('nothing that is not on GitHub', 'keep'),
      body: { kind: 'facts', facts: gitFacts(git, clock) },
      from: 'From the Git record of this computer: a window records it when it leaves the devspace, and Delete… records it again in the running dev container before it asks. Devspaces does not read Git again for this report.',
    });
  }
  return { summary, sections, notices: [], monitorLog: false };
}

/** The report of a volume of a devspace other than its workspace: the data of a service, a volume of Docker Compose, an additional volume. */
function dataVolumeReport(input: DevspaceReportInput): ReportContent {
  const { object, details, devspace } = input;
  const labels = labelsOf(details);
  const serviceData = labels.has(LABEL_SERVICE_DATA) || labels.get(LABEL_VOLUME) === VOLUME_KIND_COMPOSE || devspace?.serviceVolumes?.includes(object.name) === true;
  const kind =
    object.role === 'data of a service'
      ? 'the data of a service of Docker Compose (other than the dev service)'
      : object.role === 'volume of Docker Compose'
        ? 'a volume of the Docker Compose project of the devspace'
        : 'an additional volume that the configuration mounts';
  const facts: ReportFact[] = [devspaceFact(object, devspace), fact('Kind', kind)];
  if (devspace === undefined) {
    facts.push(fact('At Delete…', 'not asked on this computer: only the computer of the devspace deletes it', chip('Remove… in this view deletes its data', 'warn')));
  } else if (devspace.additionalVolumes?.includes(object.name) !== true) {
    facts.push(fact('At Delete…', 'kept: the registry of this computer does not list it as a volume of the devspace', chip('rule of Delete', 'info')));
  } else if (serviceData) {
    facts.push(fact('At Delete…', 'listed in the question "Remove the data of the services too?", not ticked', chip('kept unless you tick it', 'keep')));
  } else {
    facts.push(fact('At Delete…', 'Delete… asks "Remove them too?" with Remove and Keep', chip('rule of Delete', 'info')));
  }
  return {
    summary: [],
    sections: [{ title: 'The volume', body: { kind: 'facts', facts }, from: 'From the labels id, volume and service-data of the volume, and the registry of this computer. Delete… lists a volume that a container of another service mounts at that time with the data of the services.' }],
    notices: [],
    monitorLog: false,
  };
}

/** The report of a network of a devspace (of its Docker Compose project). */
function networkReport(input: DevspaceReportInput): ReportContent {
  const { object, details, devspace } = input;
  const facts: ReportFact[] = [devspaceFact(object, devspace)];
  const project = label(labelsOf(details), COMPOSE_PROJECT_LABEL);
  if (devspace !== undefined && project !== undefined && project === composeProjectName(devspace.repository, devspace.id)) {
    facts.push(fact('At Delete…', 'removed with the containers of the Docker Compose project of the devspace', chip('rule of Delete', 'info')));
  }
  return {
    summary: [],
    sections: [{ title: 'The network', body: { kind: 'facts', facts }, from: 'From the labels of Docker Compose of the network and the registry of this computer.' }],
    notices: [],
    monitorLog: false,
  };
}

/** The part of the report of an object of a devspace (isDevspaceObject); undefined for another object. */
export function devspaceReport(input: DevspaceReportInput): ReportContent | undefined {
  const { object } = input;
  if (!isDevspaceObject(object)) return undefined;
  switch (object.kind) {
    case 'container':
      return containerReport(input);
    case 'network':
      return networkReport(input);
    case 'volume':
      return object.role === 'workspace' ? workspaceReport(input) : dataVolumeReport(input);
    default:
      return undefined;
  }
}

