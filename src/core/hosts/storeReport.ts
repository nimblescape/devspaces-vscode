// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reports of two shared volumes in the view Docker Hosts (docs/requirements.md R-ENG-008): the store of VS Code
// (devspaces-vscode: the server versions, the extension files, the failed downloads and the cleanup, each with the rule
// of the Monitor that keeps or removes it) and the cache of the workers (devspaces-worker-cache: its top level). From
// what the reader of the shared volumes read (volumeReader.ts) and the records of the Monitor (monitorRecords.ts); the
// rules are those of the Monitor (backgroundRules.ts, vscodeExtensions.ts). Pure; no I/O.
import { FETCH_RETRY_MS, KEPT_SERVER_VERSIONS, SERVER_UNUSED_MS, STORE_CLEANUP_INTERVAL_MS, serversToRemove } from '../remoteMonitor/backgroundRules';
import {
  EXTENSION_FOLDERS,
  EXTENSION_RETRY_MS,
  RECORDED_LIST_MS,
  compareVersions,
  dependencyIds,
  extensionEntryText,
  extensionFilesToRemove,
  parseCachedExtension,
  wantedExtensions,
  type ExtensionFolder,
} from '../vscodeExtensions';
import type { MonitorRecords } from './monitorRecords';
import { ageText, cell, chip, countText, fact, shortDigest, sizeText, spanText, timeText, type ReportCell, type ReportChip, type ReportClock, type ReportContent, type ReportSection } from './reportModel';
import type { StoredServer, VscodeStoreReading, WorkerCacheReading } from './volumeReader';

/** At most this many rows of extension files (the others are counted under the table). */
export const MAX_EXTENSION_ROWS = 300;
/** At most this many entries of the top level of the cache of the workers. */
export const MAX_CACHE_ROWS = 50;

/** The name of the marker of the use of a server version (used/QUALITY-PLATFORM-COMMIT). */
function markerName(server: Pick<StoredServer, 'quality' | 'platform' | 'commit'>): string {
  return `${server.quality}-${server.platform}-${server.commit}`;
}

/** Versions of VS Code (`1.141.0`, also `1.142.0-insider`) by their numbers, the newest first; one without a version last. */
function newerFirst(a: StoredServer, b: StoredServer): number {
  if (a.version === undefined || b.version === undefined) return a.version === undefined ? (b.version === undefined ? 0 : 1) : -1;
  return compareVersions(b.version.replace(/-.*$/, ''), a.version.replace(/-.*$/, ''));
}

/**
 * The rule of the cleanup of the Monitor for each server version (serversToRemove): the KEPT_SERVER_VERSIONS newest of
 * its quality and platform stay, and every version that an open used within SERVER_UNUSED_MS (without a marker: the
 * time of its folder, as the Monitor counts it); the others go at its next cleanup, unless a running container runs
 * them. The Monitor orders the versions by the releases of the update service; this report by their version numbers.
 */
function serverRules(servers: readonly StoredServer[], used: ReadonlyMap<string, number>, clock: ReportClock): Map<StoredServer, ReportChip> {
  const rules = new Map<StoredServer, ReportChip>();
  const groups = new Map<string, StoredServer[]>();
  for (const server of servers) {
    const key = `${server.quality}/${server.platform}`;
    groups.set(key, [...(groups.get(key) ?? []), server]);
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort(newerFirst);
    const usedAt = (server: StoredServer): number | undefined => used.get(markerName(server)) ?? server.modifiedAt;
    const removed = new Set(serversToRemove(ordered.map((server) => ({ commit: server.commit, usedAt: usedAt(server) })), ordered.map((server) => server.commit), clock.now));
    ordered.forEach((server, index) => {
      const at = usedAt(server);
      if (!server.node || !server.script) rules.set(server, chip('incomplete: no window uses it', 'warn'));
      else if (removed.has(server.commit)) rules.set(server, chip('removed at the next cleanup, unless a running container runs it', 'remove'));
      else if (index < KEPT_SERVER_VERSIONS) rules.set(server, chip(index === 0 ? 'kept: newest' : `kept: one of the ${KEPT_SERVER_VERSIONS} newest`, 'keep'));
      else rules.set(server, chip(`kept: used ${at !== undefined ? ageText(at, clock.now) : 'recently'}`, 'keep'));
    });
  }
  return rules;
}

/** The time of the next try of a failed download, in words. */
function nextTry(failedAt: number, waitMs: number, clock: ReportClock): ReportCell {
  const due = failedAt + waitMs;
  return due <= clock.now ? cell('with the next run') : cell(`with the first run after ${timeText(due, clock)}`);
}

/**
 * The report of the store of VS Code (devspaces-vscode). `records`: those of the volume of the Monitor, when it could be
 * read (the failed downloads, the time of the last cleanup, and the rule of each extension file need them).
 */
export function vscodeStoreReport(store: VscodeStoreReading, records: MonitorRecords | undefined, clock: ReportClock): ReportContent {
  const sections: ReportSection[] = [];
  const used = new Map(store.used.flatMap((marker) => (marker.at !== undefined ? [[marker.name, marker.at] as const] : [])));
  const rules = serverRules(store.servers, used, clock);
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
    from: `From the folders server/QUALITY/PLATFORM/COMMIT and their product.json, and the markers used/QUALITY-PLATFORM-COMMIT that a window writes when it starts a version. Rule of the cleanup of the Monitor: a version goes when no window started it for ${spanText(SERVER_UNUSED_MS)} (a version without a marker counts from its download), it is not one of the ${KEPT_SERVER_VERSIONS} newest of its quality and platform, and no running container runs it. The Monitor orders the versions by the releases of VS Code; this report orders them by their version numbers.`,
  });
  // The failed downloads: of server versions (cache-run.json) and of extensions (extensions/failures.json).
  const failures: ReportCell[][] = [];
  for (const [version, at] of Object.entries(records?.cacheRun?.failedFetches ?? {}).sort(([, a], [, b]) => b - a)) {
    const match = /^(stable|insider)-(linux-x64|linux-arm64)-([0-9a-f]{40})$/.exec(version);
    failures.push([cell(match !== null ? `VS Code Server ${match[3].slice(0, 7)} (${match[1]}, ${match[2]})` : version), cell(timeText(at, clock)), nextTry(at, FETCH_RETRY_MS, clock)]);
  }
  for (const [entry, at] of [...(records?.extensionFailures ?? new Map<string, number>())].sort(([, a], [, b]) => b - a)) {
    failures.push([cell(`Extension ${entry}`), cell(timeText(at, clock)), nextTry(at, EXTENSION_RETRY_MS, clock)]);
  }
  if (records !== undefined) {
    sections.push({
      title: 'Downloads that failed',
      ...(failures.length > 0 ? { chip: chip(countText(failures.length, 'failure'), 'warn') } : {}),
      body: { kind: 'table', columns: ['Item', 'Failed', 'Next try'], rows: failures, empty: 'None: the last downloads of the Monitor worked.' },
      from: 'From cache-run.json and extensions/failures.json in devspaces-monitor. The Monitor tries a failed download again after one day.',
    });
  }
  const extensions = extensionRows(store, records, clock);
  sections.push(extensions.section);
  const cleanupFacts = [];
  const lastCleanup = records?.cacheRun?.lastCleanupAt;
  if (records !== undefined) cleanupFacts.push(fact('Last cleanup', lastCleanup !== undefined ? `${timeText(lastCleanup, clock)} · at most once a day` : 'none yet'));
  if (lastCleanup !== undefined) cleanupFacts.push(fact('Next cleanup', lastCleanup + STORE_CLEANUP_INTERVAL_MS <= clock.now ? 'with the next run' : `with the first run after ${timeText(lastCleanup + STORE_CLEANUP_INTERVAL_MS, clock)}`));
  const downloads = store.temporary.files + store.extensionTemporary.files;
  cleanupFacts.push(fact('Downloads now', downloads === 0 ? 'none' : `${countText(downloads, 'temporary file')} (${sizeText(store.temporary.bytes + store.extensionTemporary.bytes, !store.temporary.cut && !store.extensionTemporary.cut)}): a download runs, or the cleanup removes what an ended one left`));
  cleanupFacts.push(fact('Lock files', `${store.locks}: one for each server version and extension file that a download or a cleanup used; they stay`));
  sections.push({ title: 'Cleanup and downloads', body: { kind: 'facts', facts: cleanupFacts }, from: 'From cache-run.json in devspaces-monitor, and the folders tmp/, extensions/tmp/ and locks/ of the store.' });
  const summary: ReportChip[] = [chip(countText(store.servers.length, 'server version'), 'info'), chip(countText(store.extensions.length, 'extension file'), 'info')];
  const removedSoon = [...rules.values()].filter((rule) => rule.tone === 'remove').length + extensions.removed;
  if (removedSoon > 0) summary.push(chip(`${removedSoon} removed at the next cleanup`, 'remove'));
  if (failures.length > 0) summary.push(chip(countText(failures.length, 'download failed', 'downloads failed'), 'warn'));
  const notices: string[] = [];
  if (store.cut) notices.push('The store holds more entries than the reader lists: some lists are incomplete.');
  if (records === undefined) notices.push('The volume devspaces-monitor could not be read: the failed downloads, the last cleanup and the rules of the extension files are missing.');
  return { summary, sections, notices, monitorLog: false };
}

/** The rows of the extension files with the rule of the cleanup of the Monitor (cleanupExtensions of the Monitor). */
function extensionRows(store: VscodeStoreReading, records: MonitorRecords | undefined, clock: ReportClock): { section: ReportSection; removed: number } {
  const lists = (records?.extensionLists ?? []).flatMap((list) => (list.record !== undefined ? [list.record] : []));
  const wanted = wantedExtensions(lists, clock.now);
  const pinned = new Set(wanted.filter((ref) => ref.version !== undefined).map(extensionEntryText));
  // As the Monitor: a list that is there but cannot be read keeps the files of the IDs that no list names.
  const unreadable = (records?.extensionLists ?? []).some((list) => list.record === undefined);
  const named = !unreadable ? new Set([...wanted.map((ref) => ref.id), ...dependencyIds(wanted, records?.extensionDependencies ?? new Map())]) : undefined;
  const chosen = new Set((records?.extensionChoices ?? new Map<string, string>()).values());
  const removedNames = new Set<string>();
  const newest = new Map<string, string>();
  for (const folder of EXTENSION_FOLDERS) {
    const names = store.extensions.filter((file) => file.folder === folder).map((file) => file.name);
    if (records !== undefined) for (const name of extensionFilesToRemove(folder, names, pinned, { ...(named !== undefined ? { named } : {}), chosen })) removedNames.add(`${folder}/${name}`);
    for (const name of names) {
      const parsed = parseCachedExtension(name, folder);
      if (parsed === undefined) continue;
      const key = `${folder}/${parsed.id}`;
      const known = newest.get(key);
      if (known === undefined || compareVersions(parsed.version, known) > 0) newest.set(key, parsed.version);
    }
  }
  const rows = store.extensions
    .map((file) => ({ file, parsed: EXTENSION_FOLDERS.includes(file.folder as ExtensionFolder) ? parseCachedExtension(file.name, file.folder as ExtensionFolder) : undefined }))
    .sort((a, b) => (a.parsed?.id ?? a.file.name).localeCompare(b.parsed?.id ?? b.file.name) || compareVersions(b.parsed?.version ?? '0.0.0', a.parsed?.version ?? '0.0.0') || a.file.folder.localeCompare(b.file.folder));
  const ruleOf = (file: (typeof rows)[number]): ReportChip | undefined => {
    const key = `${file.file.folder}/${file.file.name}`;
    if (file.parsed === undefined) return chip('no file of the Monitor: left alone', 'info');
    if (records === undefined) return undefined;
    if (removedNames.has(key)) return chip(named !== undefined && !named.has(file.parsed.id) ? 'removed at the next cleanup: no list of the last 14 days names it' : 'removed at the next cleanup: an older version', 'remove');
    if (chosen.has(key)) return chip('kept: the version that the runs chose', 'keep');
    if (pinned.has(`${file.parsed.id}@${file.parsed.version}`)) return chip(`kept: a list pins @${file.parsed.version}`, 'info');
    if (newest.get(`${file.file.folder}/${file.parsed.id}`) === file.parsed.version) return chip('kept: newest', 'keep');
    return chip('kept', 'keep');
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
          ...(entries.length > MAX_CACHE_ROWS || cache.more ? { more: cache.more ? 'It holds more entries than the reader lists.' : `${entries.length - MAX_CACHE_ROWS} more entries` } : {}),
        },
        from: 'From the top level of the volume, the largest first.',
      },
    ],
    notices: [],
    monitorLog: false,
  };
}

/** The short form of an image ID or digest for a table (`sha256:` and 12 hex digits). */
export function digestCell(value: string): ReportCell {
  return cell(`sha256:${shortDigest(value)}…`);
}
