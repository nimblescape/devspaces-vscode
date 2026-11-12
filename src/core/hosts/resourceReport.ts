// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The content of the report of one resource of the view Docker Hosts (docs/requirements.md R-ENG-008): what the rules of
// Devspaces say about it, then the facts of Docker. The shared volumes devspaces-vscode, devspaces-monitor and
// devspaces-worker-cache report what they contain (read by the reader of the shared volumes, volumeReader.ts), the
// container of the Monitor reports its mode and its last runs (from the records in its volume), and every object
// reports the facts of Docker (objectDetails.ts); an object that is not of Devspaces reports only those, and Devspaces
// never reads the content of its volume. Pure; no I/O.
import type { VscodePlatform } from '../helperChannel/protocol';
import { HELPER_CACHE_VOLUME, VSCODE_STORE_VOLUME } from '../names';
import { REMOTE_MONITOR_VOLUME } from '../remoteMonitor/protocol';
import type { HostObject } from './hostObjects';
import { monitorRecords, type MonitorRecords } from './monitorRecords';
import { monitorContainerReport, monitorVolumeReport, type ReportComputer } from './monitorReport';
import { dockerFactsSections, type ObjectDetails } from './objectDetails';
import { countText, type ReportClock, type ReportContent } from './reportModel';
import { vscodeStoreReport, workerCacheReport } from './storeReport';
import type { ReaderVolumeNames, VolumeReadOutcome, VolumeReading } from './volumeReader';

/**
 * The shared volumes that the reader reads for the report of `object` (none: the report needs no reader): the store of
 * VS Code with the volume of the Monitor (its rules need the records of the Monitor), the volume of the Monitor, the
 * cache of the workers; the container of the Monitor needs its volume. The caller mounts only those that exist.
 */
export function reportVolumes(object: Pick<HostObject, 'kind' | 'name' | 'purpose'>): ReaderVolumeNames {
  if (object.kind === 'container' && object.purpose === 'monitor') return { monitor: REMOTE_MONITOR_VOLUME };
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
  computer: ReportComputer;
  clock: ReportClock;
}

/** What could not be read, in words, for the notes of a report. */
function readNotices(outcome: VolumeReadOutcome | undefined): string[] {
  if (outcome === undefined) return [];
  switch (outcome.kind) {
    case 'read':
      return readingNotices(outcome.reading);
    case 'noImage':
      return ['What the volume contains could not be read: the host has no helper image of Devspaces, which the reader needs (it never downloads one). The next start of a devspace on this host builds it.'];
    case 'noVolume':
      return ['What the volume contains could not be read: the volume is not there anymore.'];
    case 'failed':
      return [`What the volume contains could not be read: ${outcome.detail}`];
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
  } else if (volumes.monitor !== undefined) {
    if (records !== undefined) own = monitorVolumeReport(records, computer, clock);
  } else if (volumes['worker-cache'] !== undefined) {
    if (reading?.workerCache !== undefined) own = workerCacheReport(reading.workerCache, clock);
  }
  const notices = [...readNotices(input.volumes), ...(own?.notices ?? [])];
  if (input.detailsProblem !== undefined) notices.push(`Docker could not give the facts of this object: ${input.detailsProblem}`);
  return {
    summary: own?.summary ?? [],
    sections: [...(own?.sections ?? []), ...dockerFactsSections(object, details, clock)],
    notices,
    monitorLog: own?.monitorLog ?? false,
  };
}
