// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reports of two shared volumes in the view Docker Hosts (docs/requirements.md R-ENG-008): the store of VS Code
// (devspaces-vscode: the server versions, the extension files, the failed downloads and the cleanup, each with the rule
// of the Monitor that keeps or removes it) and the cache of the workers (devspaces-worker-cache: its top level). From
// what the reader of the shared volumes read (volumeReader.ts) and the records of the Monitor (monitorRecords.ts); the
// rules are those of the Monitor (backgroundRules.ts, vscodeExtensions.ts). Pure; no I/O.
import { VSCODE_QUALITIES, type VscodePlatform, type VscodeQuality } from '../helperChannel/protocol';
import { FETCH_RETRY_MS, KEPT_SERVER_VERSIONS, SERVER_UNUSED_MS, SERVER_VERSION_NAME, STORE_CLEANUP_INTERVAL_MS, cleanupDue, fetchRetryDue, serversToRemove } from '../remoteMonitor/backgroundRules';
import {
  EXTENSION_FOLDERS,
  EXTENSION_RETRY_MS,
  RECORDED_LIST_MS,
  extensionRetryWaits,
  compareVersions,
  dependencyIds,
  extensionEntryText,
  extensionFilesToRemove,
  parseCachedExtension,
  wantedExtensions,
  type ExtensionFolder,
} from '../vscodeExtensions';
import { EXTENSION_CHOICES_FILE, EXTENSION_DEPENDENCIES_FILE, EXTENSION_FAILURES_FILE, EXTENSION_WANTED_FOLDER, STATE_EXTENSION_FOLDER } from '../worker/vscodeExtensionStore';
import { serverVersionName } from '../worker/vscodeServerStore';
import { cacheRunKnown, type MonitorRecords } from './monitorRecords';
import { ageText, cell, chip, countText, fact, sizeText, spanText, timeText, type ReportCell, type ReportChip, type ReportClock, type ReportContent, type ReportSection } from './reportModel';
import type { StoredServer, VscodeStoreReading, WorkerCacheReading } from './volumeReader';

/** The folder name of a server version: its commit (removeOldServers of the Monitor). */
const COMMIT = /^[0-9a-f]{40}$/;

/** At most this many rows of extension files (the others are counted under the table). */
export const MAX_EXTENSION_ROWS = 300;
/** At most this many entries of the top level of the cache of the workers. */
export const MAX_CACHE_ROWS = 50;

/** The name of the marker of the use of a server version (used/QUALITY-PLATFORM-COMMIT, serverVersionName). */
function markerName(server: Pick<StoredServer, 'quality' | 'platform' | 'commit'>): string {
  // The reader lists any folder name; the casts only give serverVersionName its types.
  return serverVersionName({ commit: server.commit, quality: server.quality as VscodeQuality }, server.platform as VscodePlatform);
}

/**
 * Versions of VS Code (`1.141.0`, also `1.142.0-insider`) by their numbers, the newest first; one without a version
 * last, as one with another text. The builds of one version (Insiders builds share the version of their iteration) by
 * the time of their download, the newest first.
 */
function newerFirst(a: StoredServer, b: StoredServer): number {
  const byDownload = (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) || a.commit.localeCompare(b.commit);
  const left = releaseVersion(a.version);
  const right = releaseVersion(b.version);
  if (left === undefined || right === undefined) return left === undefined ? (right === undefined ? byDownload : 1) : -1;
  return compareVersions(right, left) || byDownload;
}

/** The numbers x.y.z of the version of a product.json (1.141.0, or 1.142.0-insider), or undefined for any other text. */
function releaseVersion(version: string | undefined): string | undefined {
  return version !== undefined ? /^(\d{1,9}\.\d{1,9}\.\d{1,9})(?:-.*)?$/.exec(version)?.[1] : undefined;
}

/**
 * The rule of the cleanup of the Monitor for each server version (serversToRemove): of the platform of the engine
 * (`platform`; the Monitor leaves the versions of other platforms alone), the KEPT_SERVER_VERSIONS newest of its quality
 * stay, and every version that an open used within SERVER_UNUSED_MS (without a marker: the time of its folder, as the
 * Monitor counts it); the others go at its next cleanup, unless a running container runs them. The Monitor orders the
 * versions by the releases of the update service; this report by their version numbers (newerFirst). `complete`: the reader listed
 * the whole store (else a marker that it did not list can keep a version, so a removal is not certain).
 */
function serverRules(servers: readonly StoredServer[], used: ReadonlyMap<string, number>, platform: VscodePlatform | undefined, complete: boolean, clock: ReportClock): Map<StoredServer, ReportChip> {
  const rules = new Map<StoredServer, ReportChip>();
  const groups = new Map<string, StoredServer[]>();
  for (const server of servers) {
    // As the Monitor (removeOldServers): only the folders of a commit under a quality of VS Code are its versions.
    if (!(VSCODE_QUALITIES as readonly string[]).includes(server.quality) || !COMMIT.test(server.commit)) {
      rules.set(server, chip('no version of the Monitor: left alone', 'info'));
      continue;
    }
    const key = `${server.quality}/${server.platform}`;
    const group = groups.get(key) ?? [];
    group.push(server);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort(newerFirst);
    const usedAt = (server: StoredServer): number | undefined => used.get(markerName(server)) ?? server.modifiedAt;
    const removed = new Set(serversToRemove(ordered.map((server) => ({ commit: server.commit, usedAt: usedAt(server) })), ordered.map((server) => server.commit), clock.now));
    ordered.forEach((server, index) => {
      const at = usedAt(server);
      const incomplete = !server.node || !server.script;
      if (platform !== undefined && server.platform !== platform) rules.set(server, chip(`kept: the Monitor cleans only the versions for ${platform}, the platform of this engine`, 'info'));
      else if (removed.has(server.commit)) {
        // The cleanup of the Monitor removes an incomplete version as any other.
        if (platform === undefined) rules.set(server, chip('not known: the platform of the engine is not known, and the Monitor cleans only the versions for it', 'warn'));
        else if (!complete) rules.set(server, chip('not known: the list of the store is incomplete', 'warn'));
        else rules.set(server, chip(`removed at the next cleanup${incomplete ? ' (incomplete)' : ''}, unless a running container runs it`, 'remove'));
      } else if (incomplete) rules.set(server, chip('incomplete: no window uses it', 'warn'));
      else if (index < KEPT_SERVER_VERSIONS) rules.set(server, chip(index === 0 ? 'kept: newest' : `kept: one of the ${KEPT_SERVER_VERSIONS} newest`, 'keep'));
      else rules.set(server, chip(`kept: used ${at !== undefined ? ageText(at, clock.now) : 'recently'}`, 'keep'));
    });
  }
  return rules;
}

/**
 * The time of the next try of a failed download, in words: with the next run when the rule of the Monitor (`due`) says
 * so (also for a time far ahead of the clock, a clock that was corrected), else after `waitMs`.
 */
function nextTry(failedAt: number, waitMs: number, due: boolean, clock: ReportClock): ReportCell {
  return due ? cell('with the next run') : cell(`with the first run after ${timeText(failedAt + waitMs, clock)}`);
}

/**
 * The report of the store of VS Code (devspaces-vscode). `records`: those of the volume of the Monitor, when it is
 * there (the failed downloads, the time of the last cleanup, and the rule of each extension file need them). `platform`:
 * the platform of the engine (serverPlatform of its architecture), when it is known: the Monitor cleans only its server
 * versions.
 */
export function vscodeStoreReport(store: VscodeStoreReading, records: MonitorRecords | undefined, clock: ReportClock, platform?: VscodePlatform): ReportContent {
  const sections: ReportSection[] = [];
  const used = new Map(store.used.flatMap((marker) => (marker.at !== undefined ? [[marker.name, marker.at] as const] : [])));
  const rules = serverRules(store.servers, used, platform, !store.cut, clock);
  const servers = [...store.servers].sort((a, b) => a.quality.localeCompare(b.quality) || a.platform.localeCompare(b.platform) || newerFirst(a, b));
  sections.push({
    title: 'VS Code Server',
    body: {
      kind: 'table',
      columns: ['Version', 'Quality', 'Platform', 'Commit', 'Size', 'Last start by a window', 'Rule'],
      rows: servers.map((server) => {
        const marker = used.get(markerName(server));
        return [
          cell(server.version ?? 'unknown'),
          cell(server.quality),
          cell(server.platform),
          cell(server.commit.slice(0, 7)),
          cell(sizeText(server.usage.bytes, !server.usage.cut)),
          cell(marker !== undefined ? ageText(marker, clock.now) : server.modifiedAt !== undefined ? `none · downloaded ${ageText(server.modifiedAt, clock.now)}` : 'none'),
          cell('', rules.get(server)),
        ];
      }),
      empty: 'No server version is stored.',
    },
    from: `From the folders server/QUALITY/PLATFORM/COMMIT and their product.json, and the markers used/QUALITY-PLATFORM-COMMIT that a window writes when it starts a version. Rule of the cleanup of the Monitor, for the platform of the engine only: a version goes when no window started it for ${spanText(SERVER_UNUSED_MS)} (a version without a marker counts from its download), it is not one of the ${KEPT_SERVER_VERSIONS} newest of its quality, and no running container runs it. The Monitor orders the versions by the releases of VS Code; this report orders them by their version numbers, and the builds of one version by the time of their download.`,
  });
  // The failed downloads: of server versions (cache-run.json) and of extensions (extensions/failures.json).
  const failures: ReportCell[][] = [];
  for (const [version, at] of Object.entries(records?.cacheRun?.failedFetches ?? {}).sort(([, a], [, b]) => b - a)) {
    const match = SERVER_VERSION_NAME.exec(version);
    failures.push([cell(match !== null ? `VS Code Server ${match[3].slice(0, 7)} (${match[1]}, ${match[2]})` : version), cell(timeText(at, clock)), nextTry(at, FETCH_RETRY_MS, fetchRetryDue(at, clock.now), clock)]);
  }
  for (const [entry, at] of [...(records?.extensionFailures ?? new Map<string, number>())].sort(([, a], [, b]) => b - a)) {
    failures.push([cell(`Extension ${entry}`), cell(timeText(at, clock)), nextTry(at, EXTENSION_RETRY_MS, !extensionRetryWaits(at, clock.now), clock)]);
  }
  // A record of the failures whose text the reader left out, or a list of the volume that stopped early (it can miss
  // extensions/failures.json): the failures are not known.
  const failuresKnown = records !== undefined && cacheRunKnown(records) && !records.cut && !records.textless.includes(`${STATE_EXTENSION_FOLDER}/${EXTENSION_FAILURES_FILE}`);
  if (records !== undefined) {
    sections.push({
      title: 'Downloads that failed',
      ...(failures.length > 0 ? { chip: chip(countText(failures.length, 'failure'), 'warn') } : !failuresKnown ? { chip: chip('not known', 'warn') } : {}),
      body: { kind: 'table', columns: ['Item', 'Failed', 'Next try'], rows: failures, empty: failuresKnown ? 'None: the last downloads of the Monitor worked.' : 'Not known: the reader could not read cache-run.json or extensions/failures.json whole.' },
      from: 'From cache-run.json and extensions/failures.json in devspaces-monitor. The Monitor tries a failed download again after one day.',
    });
  }
  const extensions = extensionRows(store, records, clock);
  sections.push(extensions.section);
  const cleanupFacts = [];
  const lastCleanup = records?.cacheRun?.lastCleanupAt;
  if (records !== undefined && !cacheRunKnown(records)) cleanupFacts.push(fact('Last cleanup', 'not known: the reader could not read cache-run.json whole', chip('the record cannot be read', 'warn')));
  else if (records !== undefined) {
    cleanupFacts.push(fact('Last cleanup', lastCleanup !== undefined ? `${timeText(lastCleanup, clock)} · at most once a day` : 'none yet'));
    // A store that was never cleaned is cleaned with the next run (cleanupDue).
    cleanupFacts.push(fact('Next cleanup', cleanupDue(lastCleanup, clock.now) ? 'with the next run' : `with the first run after ${timeText(lastCleanup! + STORE_CLEANUP_INTERVAL_MS, clock)}`));
  }
  const downloads = store.temporary.files + store.extensionTemporary.files;
  cleanupFacts.push(fact('Downloads now', downloads === 0 ? 'none' : `${countText(downloads, 'temporary file')} (${sizeText(store.temporary.bytes + store.extensionTemporary.bytes, !store.temporary.cut && !store.extensionTemporary.cut)}): a download runs, or the cleanup removes what an ended one left`));
  cleanupFacts.push(fact('Lock files', `${store.locks}: one for each server version and extension file that a download or a cleanup used; they stay`));
  sections.push({ title: 'Cleanup and downloads', body: { kind: 'facts', facts: cleanupFacts }, from: 'From cache-run.json in devspaces-monitor, and the folders tmp/, extensions/tmp/ and locks/ of the store.' });
  const summary: ReportChip[] = [chip(countText(store.servers.length, 'server version'), 'info'), chip(countText(store.extensions.length, 'extension file'), 'info')];
  const removedSoon = [...rules.values()].filter((rule) => rule.tone === 'remove').length + extensions.removed;
  if (removedSoon > 0) summary.push(chip(`${removedSoon} removed at the next cleanup`, 'remove'));
  if (failures.length > 0) summary.push(chip(countText(failures.length, 'download failed', 'downloads failed'), 'warn'));
  const notices: string[] = [];
  if (store.cut) notices.push('The store holds more entries than the reader lists: some lists are incomplete, and the rules of the extension files are missing.');
  if (records === undefined) notices.push('The volume devspaces-monitor is not there: the failed downloads, the last cleanup and the rules of the extension files are missing.');
  else if (!extensionRecordsKnown(records)) notices.push('Some records of the Monitor that the rules of the extension files need could not be read whole: these rules are missing.');
  if (platform === undefined && store.servers.length > 0) notices.push('The platform of the engine is not known: the server versions that the next cleanup removes are not known.');
  return { summary, sections, notices, monitorLog: false };
}

/** The records of the Monitor that the rules of the extension files need: the lists, the choices and the dependencies. */
function isExtensionRuleRecord(path: string): boolean {
  return path.startsWith(`${STATE_EXTENSION_FOLDER}/${EXTENSION_WANTED_FOLDER}/`) || path === `${STATE_EXTENSION_FOLDER}/${EXTENSION_CHOICES_FILE}` || path === `${STATE_EXTENSION_FOLDER}/${EXTENSION_DEPENDENCIES_FILE}`;
}

/** The records of the Monitor were read whole for the rules of the extension files: their list and the texts that they need. */
function extensionRecordsKnown(records: MonitorRecords): boolean {
  return !records.cut && !records.textless.some(isExtensionRuleRecord);
}

/**
 * The rows of the extension files with the rule of the cleanup of the Monitor (cleanupExtensions of the Monitor). The
 * rules are known when the records of the Monitor were read whole (extensionRecordsKnown) and the list of the store is
 * complete (the newest file of an extension needs all of its files).
 */
function extensionRows(store: VscodeStoreReading, records: MonitorRecords | undefined, clock: ReportClock): { section: ReportSection; removed: number } {
  const known = records !== undefined && extensionRecordsKnown(records) && !store.cut;
  const lists = (records?.extensionLists ?? []).flatMap((list) => (list.record !== undefined ? [list.record] : []));
  const wanted = wantedExtensions(lists, clock.now);
  const pinned = new Set(wanted.filter((ref) => ref.version !== undefined).map(extensionEntryText));
  // As the Monitor: a list that is there but cannot be read keeps the files of the IDs that no list names, unless its
  // file is older than RECORDED_LIST_MS: the cleanup removes such a list first (removeStaleExtensionStateFiles).
  const unreadable = (records?.extensionLists ?? []).some((list) => list.record === undefined && !(list.modifiedAt !== undefined && clock.now - list.modifiedAt >= RECORDED_LIST_MS));
  const named = !unreadable ? new Set([...wanted.map((ref) => ref.id), ...dependencyIds(wanted, records?.extensionDependencies ?? new Map())]) : undefined;
  const chosen = new Set((records?.extensionChoices ?? new Map<string, string>()).values());
  const removedNames = new Set<string>();
  if (known) {
    for (const folder of EXTENSION_FOLDERS) {
      const names = store.extensions.filter((file) => file.folder === folder).map((file) => file.name);
      for (const name of extensionFilesToRemove(folder, names, pinned, { ...(named !== undefined ? { named } : {}), chosen })) removedNames.add(`${folder}/${name}`);
    }
  }
  const rows = store.extensions
    .map((file) => ({ file, parsed: EXTENSION_FOLDERS.includes(file.folder as ExtensionFolder) ? parseCachedExtension(file.name, file.folder as ExtensionFolder) : undefined }))
    .sort((a, b) => (a.parsed?.id ?? a.file.name).localeCompare(b.parsed?.id ?? b.file.name) || compareVersions(b.parsed?.version ?? '0.0.0', a.parsed?.version ?? '0.0.0') || a.file.folder.localeCompare(b.file.folder));
  const ruleOf = (file: (typeof rows)[number]): ReportChip | undefined => {
    const key = `${file.file.folder}/${file.file.name}`;
    if (file.parsed === undefined) return chip('no file of the Monitor: left alone', 'info');
    if (!known) return undefined;
    if (removedNames.has(key)) return chip(named !== undefined && !named.has(file.parsed.id) ? `removed at the next cleanup: no list of the last ${spanText(RECORDED_LIST_MS)} names it` : 'removed at the next cleanup: an older version', 'remove');
    if (chosen.has(key)) return chip('kept: the version that the runs chose', 'keep');
    if (pinned.has(`${file.parsed.id}@${file.parsed.version}`)) return chip(`kept: a list pins @${file.parsed.version}`, 'info');
    // extensionFilesToRemove keeps a file that is not chosen and not pinned only when it is the newest of its extension.
    return chip('kept: newest', 'keep');
  };
  return {
    removed: removedNames.size,
    section: {
      title: 'Extensions',
      body: {
        kind: 'table',
        columns: ['Extension', 'Version', 'Platform', 'Size', 'Downloaded', 'Rule'],
        rows: rows.slice(0, MAX_EXTENSION_ROWS).map((row) => [
          cell(row.parsed?.id ?? row.file.name),
          cell(row.parsed?.version ?? ''),
          cell(row.file.folder),
          cell(sizeText(row.file.bytes)),
          cell(row.file.modifiedAt !== undefined ? timeText(row.file.modifiedAt, clock) : ''),
          cell('', ruleOf(row)),
        ]),
        empty: 'No extension file is stored.',
        ...(rows.length > MAX_EXTENSION_ROWS ? { more: `${rows.length - MAX_EXTENSION_ROWS} more files, sorted by extension` } : {}),
      },
      from: `From the files extensions/universal|linux-x64|linux-arm64/PUBLISHER.NAME-VERSION, and chosen.json, dependencies.json and the lists extensions/wanted in devspaces-monitor. Rule of the cleanup of the Monitor: a file goes when no list of the last ${spanText(RECORDED_LIST_MS)} names its extension (nor a dependency of one), or when it is not the newest of its extension, no list pins it and the runs did not choose it.`,
    },
  };
}

/** The report of the cache of the workers (devspaces-worker-cache): what its top level holds. */
export function workerCacheReport(cache: WorkerCacheReading, clock: ReportClock): ReportContent {
  const entries = [...cache.entries].sort((a, b) => b.usage.bytes - a.usage.bytes || a.name.localeCompare(b.name));
  return {
    summary: [],
    sections: [
      {
        title: 'The volume',
        body: { kind: 'facts', facts: [fact('Content', 'the files that the Dev Container CLI keeps between its runs (its folder of user data); Devspaces keeps no records of its own here'), fact('Used', 'by the batch helpers of the workers and of the Monitor, during a step')] },
        from: 'From the rules of the workers of Devspaces.',
      },
      {
        title: 'Top level',
        body: {
          kind: 'table',
          columns: ['Name', 'Kind', 'Size', 'Files', 'Last change'],
          rows: entries.slice(0, MAX_CACHE_ROWS).map((entry) => [cell(entry.name), cell(entry.kind), cell(sizeText(entry.usage.bytes, !entry.usage.cut)), cell(String(entry.usage.files)), cell(entry.modifiedAt !== undefined ? timeText(entry.modifiedAt, clock) : '')]),
          empty: 'The volume is empty.',
          ...(entries.length > MAX_CACHE_ROWS || cache.more ? { more: [entries.length > MAX_CACHE_ROWS ? `${entries.length - MAX_CACHE_ROWS} more entries.` : '', cache.more ? 'It holds more entries than the reader lists.' : ''].filter((part) => part !== '').join(' ') } : {}),
        },
        from: 'From the top level of the volume, the largest first.',
      },
    ],
    notices: [],
    monitorLog: false,
  };
}
