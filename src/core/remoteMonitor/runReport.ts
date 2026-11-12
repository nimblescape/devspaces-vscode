// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The short report of each background run of the Monitor (docs/requirements.md R-DS-003): at the end of a run, the
// Monitor writes what it did into its volume (RUN_REPORTS_FILE, the last MAX_RUN_REPORTS runs, the newest first):
// the times of the run, whether it reached the network, and for each kind of event (RUN_EVENTS) how often it happened
// and the names of the first ones (an image reference, a server commit, an extension file, a repository). The details
// of each step stay in the log of the Monitor. The report of the Monitor container in the view Docker Hosts shows it
// (R-ENG-010).
// The file is written by the Monitor of the newest version of Devspaces that started it (R-DS-011) and read by windows
// of other versions, so its check leaves out what this version does not know (a key, an event, a run that is not
// valid) and keeps the rest; the keys that it knows keep their strict checks. It is information for the user, not an
// input of any decision. No `vscode`.
import { isRecord } from '../valueChecks';

/** The file of the reports in the volume of the Monitor (REMOTE_MONITOR_STATE_DIR). */
export const RUN_REPORTS_FILE = 'runs.json';
/** The number of runs that the file keeps (the newest). */
export const MAX_RUN_REPORTS = 7;
/** The names that a report keeps of one kind of event (its count goes on counting). */
export const MAX_RUN_ITEMS_PER_EVENT = 10;
/** The names that a report keeps of all its events together. */
export const MAX_RUN_ITEMS = 60;
/** The longest name of an event, in characters (a longer one is cut, with "…"). */
export const MAX_RUN_ITEM_LENGTH = 200;
/** The largest file of the reports, in bytes (a larger file holds no report). */
export const MAX_RUN_REPORTS_FILE_BYTES = 256 * 1024;

/**
 * The kinds of events of a run, in the order of its parts. The names of an event:
 *  - imagePulled: the reference of an image in use whose pull brought a new version;
 *  - imagePullFailed: the reference and the reason;
 *  - imageRemoved: an older or unused version of an image in use, as "<repository> (<tags or ID>)";
 *  - helperImageBuilt: the tag of the workspace helper image built again from a new base image;
 *  - helperImageFailed: why its check or its build failed;
 *  - engineObjectRemoved: an object of Devspaces that the cleanup of the engine removed, in words;
 *  - serverDownloaded, serverDownloadFailed, serverRemoved: a VS Code server as "<commit> (<quality>, <platform>)";
 *  - serverCheckFailed: the quality and why the update service gave no releases;
 *  - serverLinked: "<commit> into <container>";
 *  - extensionDownloaded, extensionRemoved: the file of an extension in the shared cache;
 *  - extensionDownloadFailed: the extension and the reason;
 *  - devspacePrepared: the repository of a devspace whose next image was built in advance;
 *  - devspacePrepareSkipped, devspacePrepareFailed: the repository and the reason;
 *  - partFailed: a part of the run that failed as a whole, and the reason.
 */
export const RUN_EVENTS = [
  'imagePulled',
  'imagePullFailed',
  'imageRemoved',
  'helperImageBuilt',
  'helperImageFailed',
  'engineObjectRemoved',
  'serverDownloaded',
  'serverDownloadFailed',
  'serverCheckFailed',
  'serverLinked',
  'serverRemoved',
  'extensionDownloaded',
  'extensionDownloadFailed',
  'extensionRemoved',
  'devspacePrepared',
  'devspacePrepareSkipped',
  'devspacePrepareFailed',
  'partFailed',
] as const;
export type RunEvent = (typeof RUN_EVENTS)[number];

/** The events that are failures (the column "Failures" of the report page). */
export const RUN_FAILURE_EVENTS: ReadonlySet<RunEvent> = new Set<RunEvent>([
  'imagePullFailed',
  'helperImageFailed',
  'serverDownloadFailed',
  'serverCheckFailed',
  'extensionDownloadFailed',
  'devspacePrepareFailed',
  'partFailed',
]);

/** How often one kind of event happened in a run, and the names of the first ones (at most MAX_RUN_ITEMS_PER_EVENT). */
export interface RunEventNote {
  count: number;
  items: string[];
}

/** The report of one run. Times are ISO 8601. */
export interface RunReport {
  startedAt: string;
  endedAt: string;
  /** False when the run reached no server and failed for the network (the schedule tries it again). */
  reachedNetwork: boolean;
  /** The events that happened, by kind (a kind that did not happen has no entry). */
  events: Partial<Record<RunEvent, RunEventNote>>;
}

/** A name for the report: one line, without control characters, at most MAX_RUN_ITEM_LENGTH characters. */
export function runItemText(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length <= MAX_RUN_ITEM_LENGTH ? line : `${line.slice(0, MAX_RUN_ITEM_LENGTH - 1)}…`;
}

/** Collects the events of one run (noteRun of the Monitor) and makes its report. */
export class RunReportBuilder {
  private readonly events: Partial<Record<RunEvent, RunEventNote>> = {};
  private items = 0;

  constructor(private readonly startedAt: number) {}

  /** One event, or `count` events of one kind (a removal of several objects at once); `item` names it, when given. */
  note(event: RunEvent, item?: string, count = 1): void {
    if (!Number.isSafeInteger(count) || count < 1) return;
    const note = (this.events[event] ??= { count: 0, items: [] });
    note.count += count;
    if (item === undefined || note.items.length >= MAX_RUN_ITEMS_PER_EVENT || this.items >= MAX_RUN_ITEMS) return;
    const text = runItemText(item);
    if (text === '') return;
    note.items.push(text);
    this.items++;
  }

  /** The report of the run that ended at `endedAt`. */
  finish(endedAt: number, reachedNetwork: boolean): RunReport {
    const events: Partial<Record<RunEvent, RunEventNote>> = {};
    for (const event of RUN_EVENTS) {
      const note = this.events[event];
      if (note !== undefined) events[event] = { count: note.count, items: [...note.items] };
    }
    return { startedAt: new Date(this.startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), reachedNetwork, events };
  }
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

/**
 * The check of one note: a whole count of at least 1 and of at least its names, which are texts. Names beyond
 * MAX_RUN_ITEMS_PER_EVENT or `room` are left out, and each is cut to MAX_RUN_ITEM_LENGTH (runItemText), so that the
 * limits of a newer version never refuse its runs.
 */
function parseNote(value: unknown, room: number): RunEventNote | undefined {
  if (!isRecord(value)) return undefined;
  const { count, items } = value;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return undefined;
  if (!Array.isArray(items) || items.length > count || !items.every((item) => typeof item === 'string')) return undefined;
  const kept = (items as string[])
    .map(runItemText)
    .filter((item) => item !== '')
    .slice(0, Math.max(0, Math.min(MAX_RUN_ITEMS_PER_EVENT, room)));
  return { count, items: kept };
}

/**
 * The check of one report: undefined when a key that this version knows is not valid. A key or an event that it does
 * not know is left out.
 */
export function parseRunReport(value: unknown): RunReport | undefined {
  if (!isRecord(value)) return undefined;
  const { startedAt, endedAt, reachedNetwork, events } = value;
  if (!isTime(startedAt) || !isTime(endedAt) || typeof reachedNetwork !== 'boolean' || !isRecord(events)) return undefined;
  const notes: Partial<Record<RunEvent, RunEventNote>> = {};
  let items = 0;
  // Only the events that this version knows (RUN_EVENTS); those of a newer version are left out.
  for (const event of RUN_EVENTS) {
    if (!Object.prototype.hasOwnProperty.call(events, event)) continue;
    const note = parseNote(events[event], MAX_RUN_ITEMS - items);
    if (note === undefined) return undefined;
    items += note.items.length;
    notes[event] = note;
  }
  return { startedAt, endedAt, reachedNetwork, events: notes };
}

/**
 * The reports of the text of the file, the newest first (as written), at most MAX_RUN_REPORTS. A text that is too
 * long or no JSON object with a list `runs` holds none; a run that is not valid is left out.
 */
export function parseRunReports(text: string): RunReport[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_RUN_REPORTS_FILE_BYTES) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(value) || !Array.isArray(value.runs)) return [];
  const reports: RunReport[] = [];
  for (const entry of value.runs) {
    const report = parseRunReport(entry);
    if (report !== undefined) reports.push(report);
    if (reports.length >= MAX_RUN_REPORTS) break;
  }
  return reports;
}

/** The text of the file with `report` first, then the newest of `earlier`, MAX_RUN_REPORTS in all. */
export function runReportsText(report: RunReport, earlier: readonly RunReport[]): string {
  return JSON.stringify({ runs: [report, ...earlier].slice(0, MAX_RUN_REPORTS) });
}
