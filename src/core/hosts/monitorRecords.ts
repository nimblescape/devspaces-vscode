// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The records of the Monitor in its volume devspaces-monitor, as the reader of the shared volumes read them
// (volumeReader.ts, MonitorStateReading), each parsed with the parser that the Monitor and the windows use for it: the
// settings and the state of the background run, the heartbeats, the image references in use, the answers of the
// registries, the check of the helper image, the reports of the last runs, the last use, the older image versions, the
// extension lists and the choices of the runs, and the stored worker scripts. For the reports of the view Docker Hosts
// (resourceReport.ts, docs/requirements.md R-ENG-008). A record that is there but has no text or does not parse is
// named in `unreadable` (one without a text also in `textless`); a file that is no record of these is named in
// `others`. A record that the Monitor reads leniently (an invalid one counts as empty) gets the value that the Monitor
// gets, and is named in `unreadable` when its text is no JSON object. Pure; no I/O.
import { parseCacheRunState, type CacheRunState } from '../remoteMonitor/backgroundRules';
import { HELPER_CHECK_FILE, parseEngineHelperRecordText, type EngineHelperRecord } from '../remoteMonitor/helperCheck';
import {
  CACHE_RUN_FILE,
  HEARTBEAT_FOLDER,
  IMAGE_SETTINGS_FILE,
  LAST_USE_FILE,
  parseHeartbeatFileName,
  parseHeartbeatRecord,
  parseImageSettingsInput,
  parseImagesInUseFileName,
  parseImagesInUseRecord,
  parseLastUse,
  type HeartbeatRecord,
  type ImageSettings,
  type ImagesInUseRecord,
  type LastUse,
} from '../remoteMonitor/protocol';
import { REGISTRY_ANSWERS_FILE, parseRegistryAnswers, type RegistryAnswers } from '../remoteMonitor/registryAnswers';
import { PULLED_OVER_IMAGES_FILE, REPLACED_IMAGES_FILE, parseReplacedImages, type ReplacedImages } from '../remoteMonitor/replacedImages';
import { RUN_REPORTS_FILE, parseRunReports, type RunReport } from '../remoteMonitor/runReport';
import { WORKER_SCRIPT_FOLDER, isWorkerScriptHash, parseWorkerScriptRecord, type WorkerScriptRecord } from '../remoteMonitor/workerScript';
import { parseExtensionChoices, parseExtensionDependencies, parseExtensionFailures, parseExtensionRecord, type ExtensionRecord } from '../vscodeExtensions';
import { EXTENSION_CHOICES_FILE, EXTENSION_DEPENDENCIES_FILE, EXTENSION_FAILURES_FILE, EXTENSION_WANTED_FOLDER, STATE_EXTENSION_FOLDER } from '../worker/vscodeExtensionStore';
import { isRecord } from '../valueChecks';
import { optional } from './reportModel';
import type { MonitorFile, MonitorStateReading } from './volumeReader';

/** A heartbeat record (`heartbeats/COMPUTER.DEVSPACE-ID.json`): the computer, the devspace, and its record when it parses. */
export interface HeartbeatFile {
  source: string;
  devspaceId: string;
  record?: HeartbeatRecord;
}

/** The image references in use that a computer sent (`images-in-use.SOURCE.json`). */
export interface ImagesInUseFile {
  source: string;
  record?: ImagesInUseRecord;
}

/** The extension list of the last open of a devspace (`extensions/wanted/DEVSPACE-ID.json`). */
export interface ExtensionListFile {
  devspaceId: string;
  record?: ExtensionRecord;
}

/** A stored worker script (`worker-scripts/HASH.js`) and its record (`HASH.json`), when there is one. */
export interface WorkerScriptFile {
  hash: string;
  /** The size of the script; undefined when only its record is there. */
  scriptBytes?: number;
  /** The time of the script (or of its record, without a script). */
  modifiedAt?: number;
  record?: WorkerScriptRecord;
}

/** The records of the Monitor, parsed. */
export interface MonitorRecords {
  /** The settings of the background run (IMAGE_SETTINGS_FILE). */
  settings?: ImageSettings;
  /**
   * The state of the background run (CACHE_RUN_FILE); an empty state when the file is there but does not parse (as the
   * Monitor reads it); none when it is missing or the reader left out its text.
   */
  cacheRun?: CacheRunState;
  heartbeats: HeartbeatFile[];
  imagesInUse: ImagesInUseFile[];
  registry?: RegistryAnswers;
  helper?: EngineHelperRecord;
  /** The reports of the last runs, the newest first (RUN_REPORTS_FILE); none when the file is missing. */
  runs: RunReport[];
  lastUse?: LastUse;
  replaced: ReplacedImages;
  pulledOver: ReplacedImages;
  extensionLists: ExtensionListFile[];
  /** The extension entries whose last download failed, with the time of the failure. */
  extensionFailures: Map<string, number>;
  /** The files that the runs chose, by entry (`FOLDER/NAME`). */
  extensionChoices: Map<string, string>;
  /** The dependencies of the chosen versions, by entry. */
  extensionDependencies: Map<string, string[]>;
  workerScripts: WorkerScriptFile[];
  /** The paths of the records that are there but whose text the reader left out, or that do not parse. */
  unreadable: string[];
  /** The paths of the records whose text the reader left out (READER_MAX_FILE and the other limits of the reader). */
  textless: string[];
  /** The list of the volume stopped at a limit of the reader: some records can be missing. */
  cut: boolean;
  /** The other files (for example temporary files of a write, or the cleanup record of the helper images). */
  others: MonitorFile[];
}

const EXTENSIONS = `${STATE_EXTENSION_FOLDER}/`;
const WANTED = `${STATE_EXTENSION_FOLDER}/${EXTENSION_WANTED_FOLDER}/`;
const WORKER_SCRIPTS = `${WORKER_SCRIPT_FOLDER}/`;
const HEARTBEATS = `${HEARTBEAT_FOLDER}/`;
const WANTED_NAME = /^(.+)\.json$/;
const WORKER_SCRIPT_NAME = /^([0-9a-f]{64})\.(js|json)$/;

/** The records of the reading of the volume of the Monitor. */
export function monitorRecords(reading: MonitorStateReading): MonitorRecords {
  const records: MonitorRecords = {
    heartbeats: [],
    imagesInUse: [],
    runs: [],
    replaced: {},
    pulledOver: {},
    extensionLists: [],
    extensionFailures: new Map(),
    extensionChoices: new Map(),
    extensionDependencies: new Map(),
    workerScripts: [],
    unreadable: [],
    textless: [],
    cut: reading.cut,
    others: [],
  };
  const scripts = new Map<string, WorkerScriptFile>();
  /**
   * The parse of the text of `file`, or undefined (and the file is unreadable) when it has none or `parse` gives none.
   * `valid`: for a lenient parse, whether the text is valid (else the file is unreadable, and the value stays).
   */
  const parsed: RecordParser = (file, parse, valid) => {
    if (file.text === undefined) {
      records.unreadable.push(file.path);
      records.textless.push(file.path);
      return undefined;
    }
    const value = parse(file.text);
    if (value === undefined || (valid !== undefined && !valid(file.text))) records.unreadable.push(file.path);
    return value;
  };
  for (const file of reading.files) {
    const { path } = file;
    if (path.startsWith(HEARTBEATS)) {
      const name = parseHeartbeatFileName(path.slice(HEARTBEATS.length));
      if (name === undefined) records.others.push(file);
      else records.heartbeats.push({ ...name, ...optional('record', parsed(file, parseHeartbeatRecord)) });
    } else if (path.startsWith(WANTED)) {
      const devspaceId = WANTED_NAME.exec(path.slice(WANTED.length))?.[1];
      if (devspaceId === undefined) records.others.push(file);
      else records.extensionLists.push({ devspaceId, ...optional('record', parsed(file, parseExtensionRecord)) });
    } else if (path.startsWith(WORKER_SCRIPTS)) {
      const match = WORKER_SCRIPT_NAME.exec(path.slice(WORKER_SCRIPTS.length));
      if (match === null || !isWorkerScriptHash(match[1])) {
        records.others.push(file);
        continue;
      }
      const entry = scripts.get(match[1]) ?? { hash: match[1] };
      scripts.set(match[1], entry);
      if (match[2] === 'js') {
        entry.scriptBytes = file.bytes;
        if (file.modifiedAt !== undefined) entry.modifiedAt = file.modifiedAt;
      } else {
        const record = parsed(file, parseWorkerScriptRecord);
        if (record !== undefined) entry.record = record;
        if (entry.modifiedAt === undefined && file.modifiedAt !== undefined) entry.modifiedAt = file.modifiedAt;
      }
    } else if (path.startsWith(EXTENSIONS)) {
      switch (path.slice(EXTENSIONS.length)) {
        case EXTENSION_FAILURES_FILE:
          records.extensionFailures = parsed(file, parseExtensionFailures, isObjectText) ?? new Map();
          break;
        case EXTENSION_CHOICES_FILE:
          records.extensionChoices = parsed(file, parseExtensionChoices, isObjectText) ?? new Map();
          break;
        case EXTENSION_DEPENDENCIES_FILE:
          records.extensionDependencies = parsed(file, parseExtensionDependencies, isObjectText) ?? new Map();
          break;
        default:
          records.others.push(file);
      }
    } else {
      topLevel(file, records, parsed);
    }
  }
  records.workerScripts = [...scripts.values()].sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) || a.hash.localeCompare(b.hash));
  return records;
}

type RecordParser = <T>(file: MonitorFile, parse: (text: string) => T | undefined, valid?: (text: string) => boolean) => T | undefined;

/** The JSON object of `text`; undefined when it is no JSON or no object. */
function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isObjectText(text: string): boolean {
  return jsonObject(text) !== undefined;
}

/** A record at the top level of the volume. */
function topLevel(file: MonitorFile, records: MonitorRecords, parsed: RecordParser): void {
  const source = parseImagesInUseFileName(file.path);
  if (source !== undefined) {
    records.imagesInUse.push({ source, ...optional('record', parsed(file, parseImagesInUseRecord)) });
    return;
  }
  switch (file.path) {
    case IMAGE_SETTINGS_FILE:
      assign(records, 'settings', parsed(file, (text) => parseImageSettingsInput(text, { ignoreUnknownKeys: true })));
      return;
    case CACHE_RUN_FILE:
      // An invalid state counts as an empty one, as the Monitor reads it; one without its text is not known.
      assign(records, 'cacheRun', parsed(file, parseCacheRunState, isObjectText));
      return;
    case REGISTRY_ANSWERS_FILE:
      assign(records, 'registry', parsed(file, parseRegistryAnswers));
      return;
    case HELPER_CHECK_FILE:
      assign(records, 'helper', parsed(file, parseEngineHelperRecordText));
      return;
    case RUN_REPORTS_FILE:
      // A run that is not valid is left out, as the Monitor reads the file; a text without the list `runs` is unreadable.
      records.runs = parsed(file, parseRunReports, (text) => Array.isArray(jsonObject(text)?.runs)) ?? [];
      return;
    case LAST_USE_FILE:
      assign(records, 'lastUse', parsed(file, parseLastUse));
      return;
    case REPLACED_IMAGES_FILE:
      records.replaced = parsed(file, parseReplacedImages, isObjectText) ?? {};
      return;
    case PULLED_OVER_IMAGES_FILE:
      records.pulledOver = parsed(file, parseReplacedImages, isObjectText) ?? {};
      return;
    default:
      records.others.push(file);
  }
}

function assign<K extends keyof MonitorRecords>(records: MonitorRecords, key: K, value: MonitorRecords[K] | undefined): void {
  if (value !== undefined) records[key] = value;
}
