// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reports of the Monitor in the view Docker Hosts (docs/requirements.md R-ENG-008, R-DS-003): of its volume
// devspaces-monitor (the background run, the windows, the image references in use and the answers of the registries,
// the check of the helper image, the extension lists, the older image versions, the other records) and of its container
// devspaces-monitor (its mode and version, and what its last runs did). From the records of the Monitor
// (monitorRecords.ts) and the facts of Docker of its container (objectDetails.ts). Pure; no I/O.
import { CACHE_RUN_FILE, IMAGES_IN_USE_MAX_AGE_MS, IMAGE_SETTINGS_FILE, LABEL_MONITOR_OWNER, LABEL_MONITOR_VERSION, UNUSED_END_MS } from '../remoteMonitor/protocol';
import { DEFAULT_CACHE_UPDATE_SCHEDULE, IDLE_MONITOR_RESTART_POLICY, PERMANENT_MONITOR_RESTART_POLICY, cacheScheduleFromEnv, parseCacheSchedule, type CacheSchedule } from '../remoteMonitor/cacheSettings';
import { freshRegistryDigests, registryReferenceKey } from '../remoteMonitor/registryAnswers';
import { nextBackgroundRunAt } from '../remoteMonitor/backgroundRules';
import { RUN_FAILURE_EVENTS, type RunEvent, type RunReport } from '../remoteMonitor/runReport';
import { compareDevspacesVersions, isDevspacesVersion } from '../http';
import { RECORDED_LIST_MS, RECORD_AHEAD_MS } from '../vscodeExtensions';
import type { Devspace } from '../types';
import { cacheRunKnown, type HeartbeatFile, type MonitorRecords } from './monitorRecords';
import type { ContainerDetails } from './objectDetails';
import { ageText, cell, chip, countText, dockerTimeText, fact, itemsText, shortDigest, spanText, timeText, type ReportCell, type ReportChip, type ReportClock, type ReportContent, type ReportFact, type ReportSection } from './reportModel';

/** The entry of a devspace in the registry of this computer, as far as the reports need it. */
export type ReportDevspace = Pick<
  Devspace,
  'id' | 'repository' | 'configPath' | 'defaultImage' | 'createdAt' | 'lastUsedAt' | 'lastSeenInUseAt' | 'gitSummary' | 'buildRecord' | 'owner' | 'keepRunning' | 'keepRunningOnce' | 'additionalVolumes' | 'serviceVolumes'
>;

/**
 * What the report knows of this computer: its ID (the source of its heartbeats), the repositories of its devspaces, and
 * the entries of its devspaces on the host of the report.
 */
export interface ReportComputer {
  /** The ID of this computer (computer.id), the source of its records. */
  id: string;
  /** The repository (`owner/name`) of each devspace of this computer, by its ID. */
  repositories: ReadonlyMap<string, string>;
  /** The entries of the devspaces of this computer in its registry, by their ID (for the reports of their objects). */
  devspaces?: ReadonlyMap<string, ReportDevspace>;
  /** The version of this extension (x.y.z). */
  version: string;
}

/** The schedule of the background run in words: `daily at 06:07`, `every 360 minutes`, or the cron text. */
export function scheduleText(schedule: string | undefined, timeZone: string | undefined): string {
  const parsed = parseCacheSchedule(schedule);
  if (parsed === undefined) return 'the default schedule of Devspaces';
  const zone = timeZone !== undefined ? ` · ${timeZone}` : '';
  if (parsed.kind === 'interval') return `every ${parsed.minutes} minutes after the end of the last run`;
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(parsed.text);
  return daily !== null ? `daily at ${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')}${zone}` : `cron ${parsed.text}${zone}`;
}

/**
 * The schedule that the Monitor runs with, as it takes it (CurrentCacheSettings of the Monitor): the settings that the
 * last start of a window stored in its volume, else those of its container (cacheScheduleFromEnv: its variables, else
 * the defaults). Undefined when it is not known: the settings are there but cannot be read (the Monitor then keeps the
 * schedule that it had), the reader did not list all the files of the volume (it can have left them out), or there are
 * none and the report does not know the variables of its container (the report of its volume).
 */
function activeSchedule(records: MonitorRecords, containerEnv: ReadonlyMap<string, string> | undefined): { schedule: CacheSchedule; timeZone: string; from: string } | undefined {
  if (records.unreadable.includes(IMAGE_SETTINGS_FILE)) return undefined;
  const settings = records.settings;
  // The parse of the settings takes only a schedule that parseCacheSchedule takes.
  if (settings !== undefined) return { schedule: parseCacheSchedule(settings.schedule)!, timeZone: settings.timeZone, from: 'sent by the last start of a window' };
  if (records.cut || containerEnv === undefined) return undefined;
  return { ...cacheScheduleFromEnv(Object.fromEntries(containerEnv)), from: 'of its container: no window has sent one since its start' };
}

/** The schedule in words when activeSchedule does not know it. */
function unknownScheduleFact(records: MonitorRecords): ReportFact {
  if (records.textless.includes(IMAGE_SETTINGS_FILE)) return fact('Schedule', 'not known: the reader left out the text of image-settings.json', chip('too large for one read', 'warn'));
  if (records.unreadable.includes(IMAGE_SETTINGS_FILE)) return fact('Schedule', 'not known: image-settings.json cannot be read, and the Monitor keeps the schedule that it had', chip('the record cannot be read', 'warn'));
  if (records.cut) return fact('Schedule', 'not known: the reader did not list all the files of the volume', chip('the record cannot be read', 'warn'));
  return fact('Schedule', 'the one of the container of the Monitor: no window has sent one since its start');
}

/**
 * The facts of the background run: its schedule, the last end, the next run (when the Monitor runs it,
 * backgroundRunDue), a retry that waits, the last cleanup. `containerEnv`: the variables of the container of the
 * Monitor (its schedule), when the report knows them.
 */
function backgroundFacts(records: MonitorRecords, clock: ReportClock, containerEnv?: ReadonlyMap<string, string>): ReportFact[] {
  const facts: ReportFact[] = [];
  const active = activeSchedule(records, containerEnv);
  facts.push(active !== undefined ? fact('Schedule', `${scheduleText(active.schedule.text, active.timeZone)} · ${active.from}`) : unknownScheduleFact(records));
  if (!cacheRunKnown(records)) {
    facts.push(fact('Last run ended', records.textless.includes(CACHE_RUN_FILE) ? 'not known: the reader left out the text of cache-run.json' : 'not known: the reader did not list all the files of the volume', chip('the record cannot be read', 'warn')));
    return facts;
  }
  const state = records.cacheRun ?? {};
  facts.push(fact('Last run ended', state.lastEndAt !== undefined ? timeText(state.lastEndAt, clock) : 'no run ended yet'));
  const retries = state.retryAt !== undefined ? chip(`the last ${countText(state.retries ?? 1, 'run')} did not reach the network`, 'warn') : undefined;
  const nextFact = (text: string): ReportFact => fact('Next run', text, retries);
  const times = { lastEndAt: state.lastEndAt, retryAt: state.retryAt, lastAttemptAt: state.lastAttemptAt };
  // Without the schedule, only a retry without a last attempt, or a first run, has a known time (nextBackgroundRunAt).
  const known = active !== undefined || (state.retryAt !== undefined && state.lastAttemptAt === undefined) || (state.retryAt === undefined && state.lastEndAt === undefined);
  const next = known ? nextBackgroundRunAt(times, active?.schedule ?? DEFAULT_SCHEDULE, active?.timeZone ?? 'UTC', clock.now) : undefined;
  // A Monitor that no window used for UNUSED_END_MS ends, and starts no run that is only due (UnusedEnd.paused).
  const unused = records.lastUse !== undefined && clock.now - records.lastUse.at >= UNUSED_END_MS;
  if (!known) {
    if (state.retryAt !== undefined) facts.push(nextFact(`a retry ${timeText(state.retryAt, clock)}, or before it by the schedule`));
    else facts.push(nextFact(records.unreadable.includes(IMAGE_SETTINGS_FILE) || records.cut ? 'not known: the schedule is not known' : 'at the next time of the schedule of the container of the Monitor (its report gives it)'));
  } else if (next === undefined) {
    facts.push(nextFact('none: the schedule has no time'));
  } else if (next <= clock.now) {
    facts.push(nextFact(unused ? `not now: no window used this engine for ${spanText(UNUSED_END_MS)}, so the Monitor ends; the next start of a window starts it again` : state.retryAt === undefined && state.lastEndAt === undefined ? 'at the next check of the Monitor: no run is known' : 'now: it runs at the next check of the Monitor'));
  } else if (state.retryAt !== undefined && next < state.retryAt) {
    facts.push(nextFact(`${timeText(next, clock)} by the schedule, before the retry ${timeText(state.retryAt, clock)}`));
  } else {
    facts.push(nextFact(state.retryAt !== undefined ? `a retry ${timeText(next, clock)}` : timeText(next, clock)));
  }
  if (state.lastCleanupAt !== undefined) facts.push(fact('Last cleanup of the store', timeText(state.lastCleanupAt, clock)));
  return facts;
}

/** A schedule for nextBackgroundRunAt where its time does not depend on the schedule (a retry without a last attempt, a first run). */
const DEFAULT_SCHEDULE = parseCacheSchedule(DEFAULT_CACHE_UPDATE_SCHEDULE)!;

/** The computer of a record: this one, or another one. */
function computerText(source: string, computer: ReportComputer): string {
  return source === computer.id ? 'this computer' : 'another computer';
}

/**
 * The cells of a heartbeat record: its computer, its last sign, and what the Monitor does when the last window of that
 * computer closes (its rule of the stop: Keep Running When Closed, a manual Stop, or the time without a sign).
 */
export function windowCells(heartbeat: HeartbeatFile, computer: ReportComputer, clock: ReportClock): ReportCell[] {
  const record = heartbeat.record;
  const closes: ReportCell =
    record === undefined
      ? cell('', chip('the record cannot be read', 'warn'))
      : record.keepRunning
        ? cell('keeps running', chip('Keep Running When Closed', 'info'))
        : record.stopNow === true
          ? cell('stopped by Stop')
          : cell(`stops after ${spanText(record.limitSeconds * 1000)} without a sign${record.release === true ? ' · the window left' : ''}`);
  return [cell(computerText(heartbeat.source, computer)), cell(record !== undefined ? ageText(record.at, clock.now) : ''), closes];
}

/** A devspace by its repository on this computer, else as one of another computer or profile. */
function devspaceText(id: string, computer: ReportComputer): string {
  return computer.repositories.get(id) ?? `a devspace of another computer or profile (${id.slice(0, 8)})`;
}

/** The report of the volume of the Monitor (devspaces-monitor). */
export function monitorVolumeReport(records: MonitorRecords, computer: ReportComputer, clock: ReportClock): ReportContent {
  const sections: ReportSection[] = [{ title: 'Background run', body: { kind: 'facts', facts: backgroundFacts(records, clock) }, from: 'From image-settings.json and cache-run.json.' }];
  // The windows: one row per computer and devspace.
  const heartbeats = [...records.heartbeats].sort((a, b) => (b.record?.at ?? 0) - (a.record?.at ?? 0));
  sections.push({
    title: 'Devspaces with a window',
    body: {
      kind: 'table',
      columns: ['Devspace', 'Computer', 'Last sign', 'When the last window closes'],
      rows: heartbeats.map((heartbeat) => [cell(devspaceText(heartbeat.devspaceId, computer)), ...windowCells(heartbeat, computer, clock)]),
      empty: 'No window has sent a sign.',
    },
    from: 'From the heartbeat records heartbeats/COMPUTER.DEVSPACE-ID.json. A window sends a sign every 30 seconds; the Monitor stops a devspace when no sign came within its time.',
  });
  sections.push(imagesInUseSection(records, computer, clock));
  sections.push(helperSection(records, clock));
  sections.push(extensionListsSection(records, computer, clock));
  sections.push(replacedSection(records));
  const others: ReportFact[] = [];
  others.push(fact('Last use by a window', records.lastUse !== undefined ? ageText(records.lastUse.at, clock.now) : 'none recorded'));
  const versions = [...new Set(records.workerScripts.flatMap((script) => (script.record !== undefined ? [script.record.version] : [])))];
  others.push(fact('Stored worker scripts', records.workerScripts.length === 0 ? 'none' : `${records.workerScripts.length}${versions.length > 0 ? ` · of the versions ${versions.join(', ')} of Devspaces` : ''}`));
  if (records.others.length > 0) others.push(fact('Other files', itemsText(records.others.map((file) => file.path), 5)));
  if (records.unreadable.length > 0) others.push(fact('Records that cannot be read', itemsText(records.unreadable, 5), chip('left out of this report', 'warn')));
  sections.push({
    title: 'Other records',
    body: { kind: 'facts', facts: others },
    from: `From last-use.json, worker-scripts/ and the other files of the volume. A Monitor that keeps running ends itself after ${spanText(UNUSED_END_MS)} without a use by a window.`,
  });
  const summary: ReportChip[] = [];
  if (records.cacheRun?.retryAt !== undefined) summary.push(chip('the last run did not reach the network', 'warn'));
  const failed = records.runs[0] !== undefined ? failureCount(records.runs[0]) : 0;
  if (failed > 0) summary.push(chip(`${countText(failed, 'failure')} in the last run`, 'warn'));
  if (records.unreadable.length > 0) summary.push(chip(`${countText(records.unreadable.length, 'record')} cannot be read`, 'warn'));
  return { summary, sections, notices: [], monitorLog: true };
}

/** The image references in use that the computers sent, with the answers of the registries to the Monitor. */
function imagesInUseSection(records: MonitorRecords, computer: ReportComputer, clock: ReportClock): ReportSection {
  const byReference = new Map<string, { sources: Set<string>; at: number }>();
  for (const file of records.imagesInUse) {
    if (file.record === undefined) continue;
    for (const reference of file.record.references) {
      const known = byReference.get(reference) ?? { sources: new Set<string>(), at: 0 };
      known.sources.add(file.source);
      known.at = Math.max(known.at, file.record.at);
      byReference.set(reference, known);
    }
  }
  // An answer counts only while it is fresh, as the opens take it.
  const fresh = freshRegistryDigests(records.registry, [...byReference.keys()], clock.now).digests;
  const rows = [...byReference.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reference, { sources, at }]): ReportCell[] => {
      const sentBy = sources.size === 1 ? computerText([...sources][0], computer) : `${sources.size} computers`;
      const key = registryReferenceKey(reference);
      const answer = key !== undefined && records.registry !== undefined && Object.hasOwn(records.registry.digests, key) ? records.registry.digests[key] : undefined;
      const registry = answer !== undefined ? `sha256:${shortDigest(answer.digest)}… · asked ${timeText(answer.at, clock)}` : '';
      const rule: ReportChip =
        clock.now - at > IMAGES_IN_USE_MAX_AGE_MS
          ? chip(`sent more than ${spanText(IMAGES_IN_USE_MAX_AGE_MS)} ago: no longer kept up to date`, 'remove')
          : key === undefined
            ? // The record holds only references that the grammar takes (parseImagesInUseRecord): no key means a digest.
              chip('pinned by a digest: never pulled', 'info')
            : answer !== undefined && Object.hasOwn(fresh, reference)
              ? chip('kept up to date by the Monitor', 'keep')
              : answer !== undefined
                ? chip('the last answer of the registry is old: the opens check it themselves', 'warn')
                : chip('no answer of the registry yet: a private image, or not asked yet', 'info');
      return [cell(reference), cell(sentBy), cell(registry), cell(timeText(at, clock)), cell('', rule)];
    });
  return {
    title: 'Image references in use',
    body: { kind: 'table', columns: ['Reference', 'Sent by', 'Registry', 'Sent', 'Rule'], rows, empty: 'No computer has sent image references.' },
    from: `From images-in-use.COMPUTER.json (each computer sends the images of its devspaces at each start; kept for ${spanText(IMAGES_IN_USE_MAX_AGE_MS)}) and registry-digests.json (the answers of the registries to the Monitor, without a sign-in).`,
  };
}

/** The check of the helper image by the Monitor. */
function helperSection(records: MonitorRecords, clock: ReportClock): ReportSection {
  const helper = records.helper;
  const facts: ReportFact[] = [];
  if (helper === undefined) {
    facts.push(fact('Check', 'no check recorded yet'));
  } else {
    facts.push(fact('Tag', helper.tag));
    facts.push(fact('Base image', `${helper.baseImage}${helper.baseDigest !== undefined ? ` · sha256:${shortDigest(helper.baseDigest)}…` : ''}`));
    const checked = helper.checkedAt !== undefined ? Date.parse(helper.checkedAt) : undefined;
    const attempted = helper.attemptedAt !== undefined ? Date.parse(helper.attemptedAt) : undefined;
    if (checked !== undefined) facts.push(fact('Last check', timeText(checked, clock), chip('built from the current base image', 'keep')));
    if (attempted !== undefined && (checked === undefined || attempted > checked)) facts.push(fact('Last attempt', timeText(attempted, clock), chip('the check or the build failed: the image stayed as it was', 'warn')));
    const built = dockerTimeText(helper.builtAt, clock);
    facts.push(fact('Last build by the Monitor', built ?? 'none'));
  }
  return { title: 'Check of the helper image', body: { kind: 'facts', facts }, from: 'From helper-image.json. The Monitor builds the helper image again when its base image has a new version.' };
}

/** The extension lists of the last starts of the devspaces. */
function extensionListsSection(records: MonitorRecords, computer: ReportComputer, clock: ReportClock): ReportSection {
  const lists = [...records.extensionLists].sort((a, b) => (b.record?.at ?? 0) - (a.record?.at ?? 0));
  return {
    title: 'Extension lists of the starts',
    body: {
      kind: 'table',
      columns: ['Devspace', 'Of its configuration', 'Defaults of the user', 'Recorded', 'Counts until'],
      rows: lists.map((list) => {
        const record = list.record;
        if (record === undefined) return [cell(devspaceText(list.devspaceId, computer)), cell(''), cell(''), cell(''), cell('', chip('the record cannot be read', 'warn'))];
        const until = record.at + RECORDED_LIST_MS;
        // As wantedExtensions: a list whose time lies more than RECORD_AHEAD_MS ahead of the clock does not count.
        if (record.at - clock.now > RECORD_AHEAD_MS) return [cell(devspaceText(list.devspaceId, computer)), cell(String(record.configuration.length)), cell(String(record.defaults.length)), cell(timeText(record.at, clock)), cell('', chip('does not count: its time lies ahead of the clock of the host', 'warn'))];
        return [
          cell(devspaceText(list.devspaceId, computer)),
          cell(String(record.configuration.length)),
          cell(String(record.defaults.length)),
          cell(timeText(record.at, clock)),
          until <= clock.now ? cell(timeText(until, clock), chip('no longer counts', 'remove')) : cell(timeText(until, clock)),
        ];
      }),
      empty: 'No start has recorded an extension list.',
    },
    from: `From extensions/wanted/DEVSPACE-ID.json. The Monitor downloads the extensions of the lists of the last ${spanText(RECORDED_LIST_MS)}, and keeps only those in the store.`,
  };
}

/** The older image versions that pulls replaced. */
function replacedSection(records: MonitorRecords): ReportSection {
  const repositories = [...new Set([...Object.keys(records.replaced), ...Object.keys(records.pulledOver)])].sort();
  return {
    title: 'Older image versions',
    body: {
      kind: 'table',
      columns: ['Repository', 'Older versions', 'Of them replaced by a pull of the Monitor'],
      rows: repositories.map((repository) => [cell(repository), cell(String(records.replaced[repository]?.length ?? 0)), cell(String(records.pulledOver[repository]?.length ?? 0))]),
      empty: 'None recorded.',
    },
    from: 'From replaced-images.json and pulled-over-images.json. Rule of the Monitor: of a repository of an image in use, the image that the reference names now stays, every image that a container uses, and every image that another image is built on; the others go at its next run.',
  };
}

/** The number of the failures of a run. */
function failureCount(run: RunReport): number {
  return Object.entries(run.events).reduce((sum, [event, note]) => sum + (RUN_FAILURE_EVENTS.has(event as RunEvent) && note !== undefined ? note.count : 0), 0);
}

/** The parts of a cell of a run: `N word` for each event that happened, with its names. */
function eventsText(run: RunReport, parts: readonly [RunEvent, (count: number) => string, boolean][]): string {
  const texts: string[] = [];
  for (const [event, words, named] of parts) {
    const note = run.events[event];
    if (note === undefined || note.count === 0) continue;
    texts.push(named && note.items.length > 0 ? `${words(note.count)}: ${itemsText(note.items)}` : words(note.count));
  }
  return texts.length > 0 ? texts.join(' · ') : 'no change';
}

/** The row of a run in the table of the last runs. */
function runRow(run: RunReport, clock: ReportClock): ReportCell[] {
  // The end without its day when it is the day of the start.
  const start = timeText(Date.parse(run.startedAt), clock);
  const end = timeText(Date.parse(run.endedAt), clock);
  const day = (text: string): string => text.slice(0, text.lastIndexOf(' '));
  const when = `${start} to ${day(start) === day(end) ? end.slice(end.lastIndexOf(' ') + 1) : end}`;
  const failures: string[] = [];
  for (const [event, note] of Object.entries(run.events)) if (RUN_FAILURE_EVENTS.has(event as RunEvent) && note !== undefined) failures.push(...note.items);
  const failed = failureCount(run);
  return [
    run.reachedNetwork ? cell(when) : cell(when, chip(`did not reach the network${run.attempts !== undefined ? ` (${run.attempts} tries)` : ''}`, 'warn')),
    cell(eventsText(run, [
      ['imagePulled', (count) => `${count} pulled`, true],
      ['imageRemoved', (count) => `${count} older removed`, false],
      ['helperImageBuilt', () => 'helper image built again', false],
      ['engineObjectRemoved', (count) => `${countText(count, 'object')} of Devspaces removed`, false],
    ])),
    cell(eventsText(run, [
      ['serverAdded', (count) => `${count} added`, true],
      ['serverRemoved', (count) => `${count} removed`, false],
      ['serverLinked', (count) => `linked into ${countText(count, 'container')}`, false],
    ])),
    cell(eventsText(run, [
      ['extensionDownloaded', (count) => `${count} downloaded`, false],
      ['extensionRemoved', (count) => `${count} removed`, false],
    ])),
    cell(eventsText(run, [
      ['devspacePrepared', () => 'prepared', true],
      ['devspacePrepareSkipped', (count) => `${count} skipped`, true],
    ])),
    failed > 0 ? cell(itemsText(failures, 2), chip(String(failed), 'warn')) : cell('none'),
  ];
}

/**
 * The rule of the version of a Monitor (R-DS-011): the newest version runs it, so one of an earlier version moves to the
 * script of a newer one that a window stored, and a window of this version keeps one of a newer version.
 */
function versionChip(version: string, own: string): ReportChip {
  if (!isDevspacesVersion(version) || !isDevspacesVersion(own)) return chip('another version', 'info');
  const order = compareDevspacesVersions(version, own);
  if (order === 0) return chip('this version', 'keep');
  if (order < 0) return chip('an earlier version: it moves to the script of a newer one that a window stored', 'info');
  return chip('newer than this extension: the windows of this version keep it', 'info');
}

/** The report of the container of the Monitor (devspaces-monitor). `records`: those of its volume, when it could be read. */
export function monitorContainerReport(details: ContainerDetails | undefined, records: MonitorRecords | undefined, computer: ReportComputer, clock: ReportClock): ReportContent {
  const facts: ReportFact[] = [];
  const policy = details?.restartPolicy;
  if (policy === PERMANENT_MONITOR_RESTART_POLICY) {
    const owner = details?.labels.get(LABEL_MONITOR_OWNER);
    facts.push(fact('Mode', `keeps running${owner !== undefined ? `, created by ${owner === computer.id ? 'this computer' : 'another computer'}` : ''}`, chip(`ends itself after ${spanText(UNUSED_END_MS)} without a use`, 'info')));
  } else if (policy === IDLE_MONITOR_RESTART_POLICY) {
    facts.push(fact('Mode', 'ends when idle', chip('a window starts it again when it needs it', 'info')));
  }
  const version = details?.labels.get(LABEL_MONITOR_VERSION);
  if (details !== undefined) {
    facts.push(
      version === undefined
        ? fact('Version of Devspaces', 'unknown: an earlier extension created it', chip('the next start of a window replaces it', 'remove'))
        : fact('Version of Devspaces', version, versionChip(version, computer.version)),
    );
  }
  if (records !== undefined) facts.push(...backgroundFacts(records, clock, details?.env));
  if (records?.lastUse !== undefined) facts.push(fact('Last use by a window', ageText(records.lastUse.at, clock.now)));
  const sections: ReportSection[] = [{ title: 'The Monitor', body: { kind: 'facts', facts }, from: 'From the labels, the restart policy and the schedule of the container (docker container inspect), and image-settings.json, cache-run.json and last-use.json in devspaces-monitor.' }];
  const summary: ReportChip[] = [];
  if (records !== undefined) {
    sections.push({
      title: 'What it did: the last runs',
      body: { kind: 'table', columns: ['Run', 'Images', 'VS Code Server', 'Extensions', 'Next devspace images', 'Failures'], rows: records.runs.map((run) => runRow(run, clock)), empty: 'No run has ended since this version of the Monitor keeps its reports.' },
      from: 'From runs.json in devspaces-monitor: a short report that the Monitor writes at the end of each run, of its last 7 runs. The details of each step are in its log (Show Log of the Monitor).',
    });
    const failed = records.runs[0] !== undefined ? failureCount(records.runs[0]) : 0;
    if (failed > 0) summary.push(chip(`${countText(failed, 'failure')} in the last run`, 'warn'));
  }
  // Why the records are missing is a notice of the read (resourceReport).
  return { summary, sections, notices: [], monitorLog: true };
}
