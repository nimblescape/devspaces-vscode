// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reports of the Monitor (docs/requirements.md R-ENG-008, R-DS-003): its volume (the background run, the windows,
// the image references in use with the answers of the registries, the check of the helper image, the extension lists,
// the older image versions) and its container (its mode, its version, and what its last runs did).
import { describe, expect, it } from 'vitest';
import { LABEL_MONITOR_OWNER, LABEL_MONITOR_VERSION } from '../remoteMonitor/protocol';
import { monitorRecords } from './monitorRecords';
import { monitorContainerReport, monitorVolumeReport, scheduleText, type ReportComputer } from './monitorReport';
import type { ContainerDetails } from './objectDetails';
import { CLOCK, DAY, DEVSPACE, HASH, HELPER, HOUR, NOW, OTHER_DEVSPACE, OTHER_SOURCE, SOURCE, monitorFile } from './reportFixtures.testkit';
import type { MonitorFile } from './volumeReader';
import type { ReportBody, ReportCell, ReportSection } from './reportModel';

const DIGEST = `sha256:${'d'.repeat(64)}`;
const COMPUTER: ReportComputer = { id: SOURCE, repositories: new Map([[DEVSPACE, 'majikmate/module-ts']]), version: '0.4.1' };
const iso = (at: number): string => new Date(at).toISOString();
/** Today 06:19 in Vienna. */
const LAST_END = Date.UTC(2026, 10, 12, 5, 19);

const records = monitorRecords({
  cut: false,
  textsDropped: false,
  files: [
    monitorFile('image-settings.json', { schedule: '7 6 * * *', timeZone: 'Europe/Vienna' }),
    monitorFile('cache-run.json', { lastEndAt: LAST_END, lastCleanupAt: LAST_END - 7 * 60_000 }),
    monitorFile(`heartbeats/${SOURCE}.${DEVSPACE}.json`, { at: NOW - 20_000, keepRunning: false, limitSeconds: 600, seq: 1 }),
    monitorFile(`heartbeats/${OTHER_SOURCE}.${OTHER_DEVSPACE}.json`, { at: NOW - 3 * HOUR, keepRunning: true, limitSeconds: 600, seq: 1 }),
    monitorFile(`images-in-use.${SOURCE}.json`, { at: NOW - HOUR, references: ['ghcr.io/a/b:1', `postgres:16@${DIGEST}`, 'ghcr.io/private/x:1'] }),
    monitorFile(`images-in-use.${OTHER_SOURCE}.json`, { at: NOW - 31 * DAY, references: ['ghcr.io/a/b:1', 'old/image:1'] }),
    monitorFile('registry-digests.json', { digests: { 'ghcr.io/a/b:1': { digest: DIGEST, at: NOW - 2 * HOUR } }, schedule: '7 6 * * *', timeZone: 'Europe/Vienna' }),
    monitorFile('helper-image.json', { tag: HELPER, baseImage: 'node:24-trixie-slim', baseDigest: DIGEST, checkedAt: iso(NOW - 3 * HOUR), attemptedAt: iso(NOW - HOUR), builtAt: iso(NOW - 4 * DAY) }),
    monitorFile(`extensions/wanted/${DEVSPACE}.json`, { at: NOW - DAY, configuration: ['dbaeumer.vscode-eslint', 'golang.go'], defaults: ['esbenp.prettier-vscode'] }),
    monitorFile(`extensions/wanted/${OTHER_DEVSPACE}.json`, { at: NOW - 15 * DAY, configuration: [], defaults: [] }),
    monitorFile('replaced-images.json', { 'ghcr.io/a/b': ['sha256:1', 'sha256:2'] }),
    monitorFile('pulled-over-images.json', { 'ghcr.io/a/b': ['sha256:2'] }),
    monitorFile('last-use.json', { at: NOW - 20_000 }),
    { path: `worker-scripts/${HASH}.js`, bytes: 100, modifiedAt: NOW - DAY },
    monitorFile(`worker-scripts/${HASH}.json`, { version: '0.4.1', helperTag: HELPER }),
    monitorFile('runs.json', {
      runs: [
        {
          startedAt: iso(LAST_END - 12 * 60_000),
          endedAt: iso(LAST_END),
          reachedNetwork: true,
          events: {
            imagePulled: { count: 1, items: ['ghcr.io/a/b:1'] },
            imageRemoved: { count: 1, items: ['ghcr.io/a/b (sha256:1)'] },
            serverAdded: { count: 1, items: [`${'a'.repeat(40)} (stable, linux-x64)`] },
            extensionDownloaded: { count: 3, items: ['a', 'b', 'c'] },
            extensionRemoved: { count: 1, items: ['d'] },
            devspacePrepared: { count: 1, items: ['majikmate/module-ts'] },
            extensionDownloadFailed: { count: 1, items: ['ms-python.python: no answer'] },
          },
        },
        { startedAt: iso(LAST_END - DAY - 30 * 60_000), endedAt: iso(LAST_END - DAY), reachedNetwork: false, attempts: 3, events: {} },
      ],
    }),
  ],
});

function body(sections: readonly ReportSection[], title: string): ReportBody {
  const found = sections.find((candidate) => candidate.title === title);
  if (found === undefined) throw new Error(`No section ${title}`);
  return found.body;
}

function rows(value: ReportBody): ReportCell[][] {
  if (value.kind !== 'table') throw new Error('No table');
  return value.rows;
}

function facts(value: ReportBody): Record<string, ReportCell> {
  if (value.kind !== 'facts') throw new Error('No facts');
  return Object.fromEntries(value.facts.map((entry) => [entry.label, entry.value]));
}

const details: ContainerDetails = { kind: 'container', labels: new Map([[LABEL_MONITOR_VERSION, '0.4.1']]), restartPolicy: 'on-failure', env: new Map(), mounts: [], ports: [], networks: [] };

describe('the schedule in words', () => {
  it('names a daily time, an interval, another cron schedule and the default', () => {
    expect(scheduleText('7 6 * * *', 'Europe/Vienna')).toBe('daily at 06:07 · Europe/Vienna');
    expect(scheduleText('360', 'Europe/Vienna')).toBe('every 360 minutes after the end of the last run');
    expect(scheduleText('0 */6 * * *', undefined)).toBe('cron 0 */6 * * *');
    expect(scheduleText(undefined, undefined)).toBe('the default schedule of Devspaces');
  });
});

describe('the report of the volume of the Monitor', () => {
  const report = monitorVolumeReport(records, COMPUTER, CLOCK);

  it('gives the background run with its next time', () => {
    expect(Object.fromEntries(Object.entries(facts(body(report.sections, 'Background run'))).map(([label, value]) => [label, value.text]))).toEqual({
      Schedule: 'daily at 06:07 · Europe/Vienna · sent by the last start of a window',
      'Last run ended': 'today 06:19',
      'Next run': 'tomorrow 06:07',
      'Last cleanup of the store': 'today 06:12',
    });
  });

  it('gives a retry that waits as the next run', () => {
    const retrying = monitorRecords({ cut: false, textsDropped: false, files: [monitorFile('cache-run.json', { lastEndAt: LAST_END, retryAt: NOW + 10 * 60_000, retries: 2 })] });
    expect(facts(body(monitorVolumeReport(retrying, COMPUTER, CLOCK).sections, 'Background run'))['Next run']).toEqual({ text: 'a retry today 09:10', chip: { text: 'the last 2 runs did not reach the network', tone: 'warn' } });
  });

  it('gives the time of the schedule after the last attempt when it comes before the retry, as the Monitor runs', () => {
    const next = (state: Record<string, number>): string | undefined => {
      const retrying = monitorRecords({ cut: false, textsDropped: false, files: [monitorFile('image-settings.json', { schedule: '120', timeZone: 'Europe/Vienna' }), monitorFile('cache-run.json', { lastEndAt: LAST_END, ...state })] });
      return facts(body(monitorVolumeReport(retrying, COMPUTER, CLOCK).sections, 'Background run'))['Next run']?.text;
    };
    // Every 2 hours: after the attempt at 08:30, the schedule runs at 10:30, before the retry at 11:00.
    expect(next({ retryAt: NOW + 2 * HOUR, retries: 6, lastAttemptAt: NOW - 30 * 60_000 })).toBe('today 10:30 by the schedule, before the retry today 11:00');
    expect(next({ retryAt: NOW + 10 * 60_000, retries: 1, lastAttemptAt: NOW - 30 * 60_000 })).toBe('a retry today 09:10');
    // A retry whose time has passed, or a time of the schedule that has passed, runs at the next check.
    expect(next({ retryAt: NOW - 60_000, retries: 1, lastAttemptAt: NOW - 30 * 60_000 })).toBe('now: it runs at the next check of the Monitor');
    expect(next({ retryAt: NOW + 2 * HOUR, retries: 6, lastAttemptAt: NOW - 3 * HOUR })).toBe('now: it runs at the next check of the Monitor');
  });

  it('names the schedule of the container when no window has sent one, and a run that is due at once', () => {
    const unsent = monitorRecords({ cut: false, textsDropped: false, files: [monitorFile('cache-run.json', { lastEndAt: LAST_END })] });
    const background = facts(body(monitorVolumeReport(unsent, COMPUTER, CLOCK).sections, 'Background run'));
    expect([background.Schedule?.text, background['Next run']?.text]).toEqual([
      'the one of the container of the Monitor: no window has sent one since its start',
      'at the next time of the schedule of the container of the Monitor (its report gives it)',
    ]);
    const textless = monitorRecords({ cut: false, textsDropped: true, files: [{ path: 'cache-run.json', bytes: 10, omitted: 'output' }] });
    const unknown = facts(body(monitorVolumeReport(textless, COMPUTER, CLOCK).sections, 'Background run'));
    expect([unknown['Last run ended']?.text, unknown['Next run']]).toEqual(['not known: the reader left out the text of cache-run.json', undefined]);
    const settingsTextless = monitorRecords({ cut: false, textsDropped: false, files: [{ path: 'image-settings.json', bytes: 10, omitted: 'budget' }, monitorFile('cache-run.json', { lastEndAt: LAST_END })] });
    const settings = facts(body(monitorContainerReport(details, settingsTextless, COMPUTER, CLOCK).sections, 'The Monitor'));
    expect([settings.Schedule?.text, settings['Next run']?.text]).toEqual(['not known: the reader left out the text of image-settings.json', 'not known: the schedule is not known']);
    const invalid = monitorRecords({ cut: false, textsDropped: false, files: [monitorFile('image-settings.json', 'no json'), monitorFile('cache-run.json', { lastEndAt: LAST_END })] });
    const kept = facts(body(monitorContainerReport(details, invalid, COMPUTER, CLOCK).sections, 'The Monitor'));
    expect([kept.Schedule?.text, kept['Next run']?.text]).toEqual(['not known: image-settings.json cannot be read, and the Monitor keeps the schedule that it had', 'not known: the schedule is not known']);
    const backgroundOf = (files: MonitorFile[], cut = false) => facts(body(monitorVolumeReport(monitorRecords({ cut, textsDropped: false, files }), COMPUTER, CLOCK).sections, 'Background run'));
    const settingsFile = monitorFile('image-settings.json', { schedule: '7 6 * * *', timeZone: 'Europe/Vienna' });
    // A clock that was 3 days ahead and then corrected: the Monitor starts the schedule again from now.
    expect(backgroundOf([settingsFile, monitorFile('cache-run.json', { lastEndAt: NOW + 3 * DAY })])['Next run']?.text).toBe('tomorrow 06:07');
    // A Monitor that no window used for 30 days ends, and starts no run that is only due.
    expect(backgroundOf([settingsFile, monitorFile('cache-run.json', { lastEndAt: NOW - 2 * DAY }), monitorFile('last-use.json', { at: NOW - 31 * DAY })])['Next run']?.text).toBe(
      'not now: no window used this engine for 30 days, so the Monitor ends; the next start of a window starts it again',
    );
    // A list of the volume that stopped early can miss cache-run.json.
    expect(backgroundOf([settingsFile], true)['Last run ended']?.text).toBe('not known: the reader did not list all the files of the volume');
    const none = monitorRecords({ cut: false, textsDropped: false, files: [] });
    expect(facts(body(monitorVolumeReport(none, COMPUTER, CLOCK).sections, 'Background run'))['Next run']?.text).toBe('at the next check of the Monitor: no run is known');
  });

  it('gives the windows of this computer and of others', () => {
    expect(rows(body(report.sections, 'Devspaces with a window')).map((row) => [...row.map((entry) => entry.text), row[3].chip?.text])).toEqual([
      ['majikmate/module-ts', 'this computer', '20 s ago', 'stops after 10 minutes without a sign', undefined],
      ['a devspace of another computer or profile (66666666)', 'another computer', '3 hours ago', 'keeps running', 'Keep Running When Closed'],
    ]);
  });

  it('gives the image references in use with the answers of the registries and their rule', () => {
    expect(rows(body(report.sections, 'Image references in use')).map((row) => [row[0].text, row[1].text, row[2].text, row[4].chip?.tone])).toEqual([
      ['ghcr.io/a/b:1', '2 computers', 'sha256:dddddddddddd… · asked today 07:00', 'keep'],
      ['ghcr.io/private/x:1', 'this computer', '', 'info'],
      ['old/image:1', 'another computer', '', 'remove'],
      [`postgres:16@${DIGEST}`, 'this computer', '', 'info'],
    ]);
  });

  it('takes an old answer of the registry as no longer kept up to date, as the opens take it', () => {
    const old = monitorRecords({
      cut: false,
      textsDropped: false,
      files: [monitorFile(`images-in-use.${SOURCE}.json`, { at: NOW - HOUR, references: ['ghcr.io/a/b:1'] }), monitorFile('registry-digests.json', { digests: { 'ghcr.io/a/b:1': { digest: DIGEST, at: NOW - 3 * DAY } }, schedule: '7 6 * * *', timeZone: 'Europe/Vienna' })],
    });
    expect(rows(body(monitorVolumeReport(old, COMPUTER, CLOCK).sections, 'Image references in use'))[0][4].chip).toEqual({ text: 'the last answer of the registry is old: the opens check it themselves', tone: 'warn' });
  });

  it('names an extension list whose time lies ahead of the clock as one that does not count, as the Monitor reads it', () => {
    const ahead = monitorRecords({ cut: false, textsDropped: false, files: [monitorFile(`extensions/wanted/${DEVSPACE}.json`, { at: NOW + 3 * DAY, configuration: ['golang.go'], defaults: [] })] });
    expect(rows(body(monitorVolumeReport(ahead, COMPUTER, CLOCK).sections, 'Extension lists of the starts'))[0][4].chip).toEqual({ text: 'does not count: its time lies ahead of the clock of the host', tone: 'warn' });
  });

  it('keeps a list of image references for exactly 30 days, as the Monitor does', () => {
    const at = (age: number) => monitorRecords({ cut: false, textsDropped: false, files: [monitorFile(`images-in-use.${SOURCE}.json`, { at: NOW - age, references: [`postgres:16@${DIGEST}`] })] });
    const tone = (age: number) => rows(body(monitorVolumeReport(at(age), COMPUTER, CLOCK).sections, 'Image references in use'))[0][4].chip?.tone;
    expect([tone(30 * DAY), tone(30 * DAY + 1)]).toEqual(['info', 'remove']);
  });

  it('gives the check of the helper image, the extension lists, the older images and the other records', () => {
    const helper = facts(body(report.sections, 'Check of the helper image'));
    expect(helper['Last check']).toEqual({ text: 'today 06:00', chip: { text: 'built from the current base image', tone: 'keep' } });
    expect(helper['Last attempt']?.chip?.tone).toBe('warn');
    expect(helper['Last build by the Monitor']?.text).toBe('2026-11-08 09:00');
    expect(rows(body(report.sections, 'Extension lists of the starts')).map((row) => [...row.map((entry) => entry.text), row[4].chip?.text])).toEqual([
      ['majikmate/module-ts', '2', '1', 'yesterday 09:00', '2026-11-25 09:00', undefined],
      ['a devspace of another computer or profile (66666666)', '0', '0', '2026-10-28 09:00', 'yesterday 09:00', 'no longer counts'],
    ]);
    expect(rows(body(report.sections, 'Older image versions')).map((row) => row.map((entry) => entry.text))).toEqual([['ghcr.io/a/b', '2', '1']]);
    const others = facts(body(report.sections, 'Other records'));
    expect(others['Last use by a window']?.text).toBe('20 s ago');
    expect(others['Stored worker scripts']?.text).toBe('1 · of the versions 0.4.1 of Devspaces');
    expect(report.summary).toEqual([{ text: '1 failure in the last run', tone: 'warn' }]);
    expect(report.monitorLog).toBe(true);
  });
});

describe('the report of the container of the Monitor', () => {

  it('gives its mode and version, and what its last runs did', () => {
    const report = monitorContainerReport(details, records, COMPUTER, CLOCK);
    const monitor = facts(body(report.sections, 'The Monitor'));
    expect(monitor.Mode).toEqual({ text: 'ends when idle', chip: { text: 'a window starts it again when it needs it', tone: 'info' } });
    expect(monitor['Version of Devspaces']).toEqual({ text: '0.4.1', chip: { text: 'this version', tone: 'keep' } });
    expect(monitor['Next run']?.text).toBe('tomorrow 06:07');
    const runs = rows(body(report.sections, 'What it did: the last runs'));
    expect(runs[0].map((entry) => entry.text)).toEqual([
      'today 06:07 to 06:19',
      '1 pulled: ghcr.io/a/b:1 · 1 older removed',
      `1 added: ${'a'.repeat(40)} (stable, linux-x64)`,
      '3 downloaded · 1 removed',
      'prepared: majikmate/module-ts',
      'ms-python.python: no answer',
    ]);
    expect(runs[0][5].chip).toEqual({ text: '1', tone: 'warn' });
    expect(runs[1].map((entry) => entry.text)).toEqual(['yesterday 05:49 to 06:19', 'no change', 'no change', 'no change', 'no change', 'none']);
    expect(runs[1][0].chip).toEqual({ text: 'did not reach the network (3 tries)', tone: 'warn' });
    expect(report.summary).toEqual([{ text: '1 failure in the last run', tone: 'warn' }]);
    expect(report.monitorLog).toBe(true);
  });

  it('takes the schedule of its container until a window sends one, as the Monitor does', () => {
    const unsent = monitorRecords({ cut: false, textsDropped: false, files: [monitorFile('cache-run.json', { lastEndAt: LAST_END })] });
    const schedule = (env: Map<string, string>): [string | undefined, string | undefined] => {
      const monitor = facts(body(monitorContainerReport({ ...details, env }, unsent, COMPUTER, CLOCK).sections, 'The Monitor'));
      return [monitor.Schedule?.text, monitor['Next run']?.text];
    };
    expect(schedule(new Map([['DEVSPACE_IMAGE_SCHEDULE', '360'], ['DEVSPACE_IMAGE_TZ', 'UTC']]))).toEqual(['every 360 minutes after the end of the last run · of its container: no window has sent one since its start', 'today 12:19']);
    // Without its variables (or with invalid ones): daily at 06:07 in Europe/Vienna.
    expect(schedule(new Map([['DEVSPACE_IMAGE_TZ', 'Not/AZone']]))).toEqual(['daily at 06:07 · Europe/Vienna · of its container: no window has sent one since its start', 'tomorrow 06:07']);
  });

  it('names a Monitor that keeps running, one of another version, and one of an earlier extension', () => {
    const permanent = monitorContainerReport({ ...details, restartPolicy: 'unless-stopped', labels: new Map([[LABEL_MONITOR_VERSION, '0.5.0'], [LABEL_MONITOR_OWNER, OTHER_SOURCE]]) }, undefined, COMPUTER, CLOCK);
    const monitor = facts(body(permanent.sections, 'The Monitor'));
    expect(monitor.Mode?.text).toBe('keeps running, created by another computer');
    expect(monitor['Version of Devspaces']?.chip?.text).toBe('newer than this extension: the windows of this version keep it');
    const earlierVersion = monitorContainerReport({ ...details, labels: new Map([[LABEL_MONITOR_VERSION, '0.3.9']]) }, undefined, COMPUTER, CLOCK);
    expect(facts(body(earlierVersion.sections, 'The Monitor'))['Version of Devspaces']?.chip?.text).toBe('an earlier version: it moves to the script of a newer one that a window stored');
    const otherText = monitorContainerReport({ ...details, labels: new Map([[LABEL_MONITOR_VERSION, '0.4.1-dev']]) }, undefined, COMPUTER, CLOCK);
    expect(facts(body(otherText.sections, 'The Monitor'))['Version of Devspaces']?.chip?.text).toBe('another version');
    expect(permanent.sections.map((section) => section.title)).toEqual(['The Monitor']);
    // Why the records are missing is a notice of the read (resourceReport).
    expect(permanent.notices).toEqual([]);
    const earlier = monitorContainerReport({ ...details, labels: new Map() }, records, COMPUTER, CLOCK);
    expect(facts(body(earlier.sections, 'The Monitor'))['Version of Devspaces']?.chip?.tone).toBe('remove');
  });
});
