// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The content of the report of one resource of the view Docker Hosts (docs/requirements.md R-ENG-008, R-ENG-010): what
// the rules of Devspaces say about it, then the facts of Docker. The shared volumes devspaces-vscode, devspaces-monitor
// and devspaces-worker-cache report what they contain (read by the reader of the shared volumes, volumeReader.ts), the
// container of the Monitor reports its mode and its last runs (from the records in its volume), the objects of a
// devspace report their devspace and the rules of Devspaces for them (devspaceReport.ts; the dev container also the
// windows of the heartbeat records in the volume of the Monitor), the images of Devspaces their build, version and
// rules (imageReport.ts, with the answers of the registries and the other records of the Monitor), the helper
// containers what they serve and when they end (helperReport.ts), and every object reports the facts of Docker
// (objectDetails.ts); an object that is not of Devspaces reports only those, and Devspaces never reads the content of
// its volume. Pure; no I/O.
import type { VscodePlatform } from '../helperChannel/protocol';
import { HELPER_CACHE_VOLUME, VSCODE_STORE_VOLUME } from '../names';
import { REMOTE_MONITOR_VOLUME } from '../remoteMonitor/protocol';
import { devspaceReport, isDevspaceObject } from './devspaceReport';
import { helperReport, isHelperContainer } from './helperReport';
import { imageReport, imageReportNeedsRecords, isImageReportObject } from './imageReport';
import type { HostObject } from './hostObjects';
import { isLogContainer } from './monitorLog';
import { monitorRecords, type MonitorRecords } from './monitorRecords';
import { monitorContainerReport, monitorVolumeReport, type ReportComputer, type ReportDevspace } from './monitorReport';
import { dockerFactsSections, type ObjectDetails } from './objectDetails';
import { countText, optional, type ReportClock, type ReportContent } from './reportModel';
import { vscodeStoreReport, workerCacheReport } from './storeReport';
import type { ReaderVolumeNames, VolumeReadOutcome, VolumeReading } from './volumeReader';

/**
 * The shared volumes that the reader reads for the report of `object` (none: the report needs no reader): the store of
 * VS Code with the volume of the Monitor (its rules need the records of the Monitor), the volume of the Monitor, the
 * cache of the workers; the container of the Monitor, the dev container of a devspace, a devspace image, a base image
 * and the helper image need the volume of the Monitor. The caller mounts only those that exist.
 */
export function reportVolumes(object: Pick<HostObject, 'kind' | 'name' | 'purpose' | 'role'>): ReaderVolumeNames {
  if (object.kind === 'container' && object.purpose === 'monitor') return { monitor: REMOTE_MONITOR_VOLUME };
  // The dev container of a devspace: the windows that use it, from the heartbeat records of the Monitor.
  if (object.kind === 'container' && (object.purpose === 'devspace' || object.purpose === 'otherDevspace') && object.role === 'dev container') return { monitor: REMOTE_MONITOR_VOLUME };
  // A devspace image, a base image and the helper image: the answers of the registries, the older versions, the check
  // of the helper image.
  if (imageReportNeedsRecords(object)) return { monitor: REMOTE_MONITOR_VOLUME };
  if (object.kind !== 'volume' || object.purpose !== 'sharedVolume') return {};
  switch (object.name) {
    case VSCODE_STORE_VOLUME:
      return { vscode: VSCODE_STORE_VOLUME, monitor: REMOTE_MONITOR_VOLUME };
    case REMOTE_MONITOR_VOLUME:
      return { monitor: REMOTE_MONITOR_VOLUME };
    case HELPER_CACHE_VOLUME:
      return { 'worker-cache': HELPER_CACHE_VOLUME };
    default:
      return {};
  }
}

export interface ResourceReportInput {
  object: HostObject;
  /** The facts of Docker read now (readObjectDetails); undefined when they could not be read (`detailsProblem`). */
  details?: ObjectDetails;
  detailsProblem?: string;
  /** The outcome of the reader for the volumes of reportVolumes; undefined when the report needs none. */
  volumes?: VolumeReadOutcome;
  /** The platform of the engine (serverPlatform of its architecture), when it is known: for the rules of the store of VS Code. */
  platform?: VscodePlatform;
  /** The helper tag of this version of Devspaces (helperImageTag), when it is known: for the helper image and the helper containers. */
  currentHelperTag?: string;
  computer: ReportComputer;
  clock: ReportClock;
}

/**
 * What could not be read, in words, for the notes of a report. `ofVolume`: the report is the one of the shared volume
 * that the reader reads; else it is of an object that needs the records of the Monitor.
 */
function readNotices(outcome: VolumeReadOutcome | undefined, ofVolume: boolean): string[] {
  if (outcome === undefined) return [];
  const subject = ofVolume ? 'What the volume contains' : `The records of the Monitor in ${REMOTE_MONITOR_VOLUME}`;
  switch (outcome.kind) {
    case 'read':
      return readingNotices(outcome.reading);
    case 'noImage':
      return [`${subject} could not be read: the host has no helper image of Devspaces, which the reader needs (it never downloads one). The next start of a devspace on this host builds it.`];
    case 'noVolume':
      return [ofVolume ? 'What the volume contains could not be read: the volume is not there anymore.' : `The volume ${REMOTE_MONITOR_VOLUME} is not there: the records of the Monitor are missing from this report.`];
    case 'failed':
      return [`${subject} could not be read: ${outcome.detail}`];
  }
}

function readingNotices(reading: VolumeReading): string[] {
  const notices: string[] = [];
  if (reading.tooLong) notices.push('The volumes hold too much for one read: their content is left out.');
  if (reading.monitor?.textsDropped === true) notices.push('The records of the Monitor are too large for one read: their texts are left out.');
  if (reading.monitor?.cut === true) notices.push('The volume devspaces-monitor holds more files than the reader lists: some records are missing.');
  if (reading.stopped) notices.push('The reader reached its limit of time or of entries: some sizes and lists are incomplete.');
  if (reading.unreadable > 0) notices.push(`${countText(reading.unreadable, 'folder')} could not be read: some sizes are incomplete.`);
  return notices;
}

/** The entry of the devspace of an object of a devspace of this computer in its registry. */
function devspaceOf(object: HostObject, computer: ReportComputer): ReportDevspace | undefined {
  return object.purpose === 'devspace' && object.devspaceId !== undefined ? computer.devspaces?.get(object.devspaceId) : undefined;
}

/** The content of the report of `input.object`. */
export function resourceReport(input: ResourceReportInput): ReportContent {
  const { object, details, computer, clock } = input;
  const reading = input.volumes?.kind === 'read' ? input.volumes.reading : undefined;
  const records: MonitorRecords | undefined = reading?.monitor !== undefined ? monitorRecords(reading.monitor) : undefined;
  let own: ReportContent | undefined;
  const volumes = reportVolumes(object);
  if (object.kind === 'container' && object.purpose === 'monitor') {
    own = monitorContainerReport(details?.kind === 'container' ? details : undefined, records, computer, clock);
    // A read without the volume of the Monitor: the volume is not there (the reader mounts only the volumes that are).
    // A read that was too long has no parts at all, which its own notice says.
    if (reading !== undefined && !reading.tooLong && records === undefined) own.notices.push('The volume devspaces-monitor is not there: the background run and the last runs are missing.');
  } else if (volumes.vscode !== undefined) {
    if (reading?.vscode !== undefined) own = vscodeStoreReport(reading.vscode, records, clock, input.platform);
  } else if (isDevspaceObject(object)) {
    own = devspaceReport({ object, ...optional('details', details), ...optional('devspace', devspaceOf(object, computer)), ...optional('records', records), computer, clock });
  } else if (isImageReportObject(object)) {
    own = imageReport({ object, ...optional('details', details), ...optional('devspace', devspaceOf(object, computer)), ...optional('records', records), computer, ...optional('currentHelperTag', input.currentHelperTag), clock });
  } else if (isHelperContainer(object)) {
    own = helperReport({ object, ...optional('details', details), computer, ...optional('currentHelperTag', input.currentHelperTag) });
  } else if (volumes.monitor !== undefined) {
    if (records !== undefined) own = monitorVolumeReport(records, computer, clock);
  } else if (volumes['worker-cache'] !== undefined) {
    if (reading?.workerCache !== undefined) own = workerCacheReport(reading.workerCache, clock);
  }
  const notices = [...readNotices(input.volumes, object.kind === 'volume'), ...(own?.notices ?? [])];
  if (input.detailsProblem !== undefined) notices.push(`Docker could not give the facts of this object: ${input.detailsProblem}`);
  const monitorLog = own?.monitorLog ?? false;
  // Show Log of every other container, by its full ID; not when Docker says that its log driver keeps no log. A worker
  // has no log of Docker (`none`): its Show Log reads the log that it writes itself (workerLogRead.ts).
  const logDriver = details?.kind === 'container' ? details.logDriver : undefined;
  const worker = object.kind === 'container' && object.purpose === 'worker' && isLogContainer(object.id);
  const containerLog = object.kind === 'container' && !monitorLog && !worker && logDriver !== 'none' && isLogContainer(object.id) ? object.id : undefined;
  return {
    summary: own?.summary ?? [],
    sections: [...(own?.sections ?? []), ...dockerFactsSections(object, details, clock)],
    notices,
    monitorLog,
    ...optional('containerLog', containerLog),
    ...optional('workerLog', worker ? object.id : undefined),
  };
}
