// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The short report of each background run of the Monitor (docs/requirements.md R-DS-003): the collection of the events
// with its limits, the file of the last runs, and its check, which leaves out what a newer version wrote and this one
// does not know.
import { describe, expect, it } from 'vitest';
import {
  MAX_MERGED_RUN_MS,
  MAX_RUN_FAILURE_ITEMS,
  MAX_RUN_ITEMS,
  MAX_RUN_ITEMS_PER_EVENT,
  MAX_RUN_ITEM_LENGTH,
  MAX_RUN_REPORTS,
  MAX_RUN_REPORTS_FILE_BYTES,
  RUN_EVENTS,
  RUN_FAILURE_EVENTS,
  RunReportBuilder,
  mergeRunReports,
  parseRunReport,
  parseRunReports,
  runItemText,
  runReportsText,
  type RunReport,
} from './runReport';

const START = Date.parse('2026-11-12T06:07:00Z');
const END = Date.parse('2026-11-12T06:19:30Z');

function report(n: number, events: RunReport['events'] = {}): RunReport {
  return { startedAt: new Date(START + n * 60_000).toISOString(), endedAt: new Date(END + n * 60_000).toISOString(), reachedNetwork: true, events };
}

describe('the report of a run', () => {
  it('counts each kind of event and keeps the names of the first ones, in the order of the parts', () => {
    const notes = new RunReportBuilder(START);
    notes.note('extensionDownloaded', 'redhat.vscode-yaml-1.24.0');
    notes.note('imagePulled', 'node:24');
    notes.note('engineObjectRemoved', '3 stopped helper containers', 3);
    notes.note('imagePulled', 'mcr.microsoft.com/devcontainers/base:ubuntu');
    notes.note('partFailed');
    const made = notes.finish(END, false);
    expect(made).toEqual({
      startedAt: '2026-11-12T06:07:00.000Z',
      endedAt: '2026-11-12T06:19:30.000Z',
      reachedNetwork: false,
      events: {
        imagePulled: { count: 2, items: ['node:24', 'mcr.microsoft.com/devcontainers/base:ubuntu'] },
        engineObjectRemoved: { count: 3, items: ['3 stopped helper containers'] },
        extensionDownloaded: { count: 1, items: ['redhat.vscode-yaml-1.24.0'] },
        partFailed: { count: 1, items: [] },
      },
    });
    expect(Object.keys(made.events)).toEqual(['imagePulled', 'engineObjectRemoved', 'extensionDownloaded', 'partFailed']);
  });

  it('keeps at most MAX_RUN_ITEMS_PER_EVENT names of a kind, MAX_RUN_ITEMS of the other events and MAX_RUN_FAILURE_ITEMS of the failures; the counts go on', () => {
    const notes = new RunReportBuilder(START);
    for (let i = 0; i < 25; i++) notes.note('extensionDownloaded', `ext.e${i}-1.0.0`);
    for (const event of RUN_EVENTS) for (let i = 0; i < 8; i++) notes.note(event, `${event} ${i}`);
    const { events } = notes.finish(END, true);
    expect(events.extensionDownloaded).toEqual({ count: 33, items: Array.from({ length: MAX_RUN_ITEMS_PER_EVENT }, (_, i) => `ext.e${i}-1.0.0`) });
    const names = (failures: boolean) => RUN_EVENTS.filter((event) => RUN_FAILURE_EVENTS.has(event) === failures).reduce((sum, event) => sum + events[event]!.items.length, 0);
    expect(names(false)).toBe(MAX_RUN_ITEMS);
    expect(names(true)).toBe(MAX_RUN_FAILURE_ITEMS);
    for (const event of RUN_EVENTS) expect(events[event]!.count).toBe(event === 'extensionDownloaded' ? 33 : 8);
  });

  it('a large run never leaves its failures without names', () => {
    const notes = new RunReportBuilder(START);
    for (const event of RUN_EVENTS.filter((kind) => !RUN_FAILURE_EVENTS.has(kind))) for (let i = 0; i < MAX_RUN_ITEMS_PER_EVENT; i++) notes.note(event, `${event} ${i}`);
    notes.note('partFailed', 'the prepares of the devspace images: the engine broke');
    const report = notes.finish(END, true);
    expect(report.events.partFailed).toEqual({ count: 1, items: ['the prepares of the devspace images: the engine broke'] });
    // The check of the file keeps them too.
    expect(parseRunReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  it('a name is one line of at most MAX_RUN_ITEM_LENGTH characters; an empty name and a count below 1 are left out', () => {
    expect(runItemText('  a\nb\u001b[31m  c\t ')).toBe('a b [31m c');
    const long = runItemText('x'.repeat(500));
    expect(long).toHaveLength(MAX_RUN_ITEM_LENGTH);
    expect(long.endsWith('…')).toBe(true);
    // A character outside the Basic Multilingual Plane at the cut is left out whole, never half of it.
    const emoji = runItemText(`${'x'.repeat(MAX_RUN_ITEM_LENGTH - 2)}😀${'y'.repeat(10)}`);
    expect(emoji).toBe(`${'x'.repeat(MAX_RUN_ITEM_LENGTH - 2)}…`);
    expect(/[\ud800-\udfff]/.test(emoji)).toBe(false);
    const notes = new RunReportBuilder(START);
    notes.note('imagePulled', ' \n ');
    notes.note('imageRemoved', 'a', 0);
    notes.note('imageRemoved', 'b', 1.5);
    expect(notes.finish(END, true).events).toEqual({ imagePulled: { count: 1, items: [] } });
  });

  it('an event after the report is made is left out', () => {
    const notes = new RunReportBuilder(START);
    notes.note('imagePulled', 'node:24');
    const made = notes.finish(END, true);
    notes.note('imagePulled', 'later:1');
    expect(made.events.imagePulled).toEqual({ count: 1, items: ['node:24'] });
    expect(notes.finish(END, true).events.imagePulled).toEqual({ count: 1, items: ['node:24'] });
  });

  it('the failures are the events of a failure', () => {
    expect([...RUN_FAILURE_EVENTS].every((event) => RUN_EVENTS.includes(event))).toBe(true);
    expect(RUN_FAILURE_EVENTS.has('partFailed')).toBe(true);
    expect(RUN_FAILURE_EVENTS.has('imagePulled')).toBe(false);
  });
});

describe('the file of the last runs', () => {
  it('puts the newest run first and keeps MAX_RUN_REPORTS', () => {
    let text = JSON.stringify({ runs: [] });
    for (let n = 0; n < MAX_RUN_REPORTS + 3; n++) text = runReportsText(report(n), parseRunReports(text));
    const reports = parseRunReports(text);
    expect(reports).toHaveLength(MAX_RUN_REPORTS);
    expect(reports.map((entry) => entry.startedAt)).toEqual(Array.from({ length: MAX_RUN_REPORTS }, (_, i) => report(MAX_RUN_REPORTS + 2 - i).startedAt));
  });

  it('a full file of runs with all their names stays below MAX_RUN_REPORTS_FILE_BYTES', () => {
    const notes = new RunReportBuilder(START);
    // Each name of 3 bytes per character in UTF-8, the most that a character of the Basic Multilingual Plane takes.
    for (const event of RUN_EVENTS) for (let i = 0; i < MAX_RUN_ITEMS_PER_EVENT; i++) notes.note(event, `${i} ${'€'.repeat(MAX_RUN_ITEM_LENGTH)}`);
    const full = notes.finish(END, true);
    const text = runReportsText(full, Array.from({ length: MAX_RUN_REPORTS }, () => full));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(MAX_RUN_REPORTS_FILE_BYTES);
    expect(parseRunReports(text)).toHaveLength(MAX_RUN_REPORTS);
  });

  it('the runs in a row that did not reach the network share one report, so the last run that reached it stays', () => {
    const offline = (n: number, events: RunReport['events'] = {}): RunReport => ({ ...report(n, events), reachedNetwork: false });
    let text = runReportsText(report(0, { imagePulled: { count: 1, items: ['node:24'] } }), []);
    for (let n = 1; n <= 12; n++) {
      text = runReportsText(offline(n, n === 1 ? { engineObjectRemoved: { count: 2, items: ['2 stopped helper containers'] } } : { serverCheckFailed: { count: 1, items: ['stable (linux-x64): getaddrinfo ENOTFOUND'] } }), parseRunReports(text));
    }
    const reports = parseRunReports(text);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toEqual({
      startedAt: report(1).startedAt,
      endedAt: report(12).endedAt,
      reachedNetwork: false,
      attempts: 12,
      events: {
        engineObjectRemoved: { count: 2, items: ['2 stopped helper containers'] },
        serverCheckFailed: { count: 11, items: ['stable (linux-x64): getaddrinfo ENOTFOUND'] },
      },
    });
    expect(reports[1]).toEqual(report(0, { imagePulled: { count: 1, items: ['node:24'] } }));
    // The next run that reaches the network gets its own report.
    expect(parseRunReports(runReportsText(report(13), reports)).map((entry) => entry.attempts)).toEqual([undefined, 12, undefined]);
  });

  it('a report of runs that did not reach the network spans at most MAX_MERGED_RUN_MS', () => {
    const at = (ms: number) => new Date(START + ms).toISOString();
    const offline = (from: number, to: number): RunReport => ({ startedAt: at(from), endedAt: at(to), reachedNetwork: false, events: {} });
    const hour = 60 * 60_000;
    let reports: RunReport[] = [];
    // An outage of 3 days, with a retry every hour.
    for (let n = 0; n < 72; n++) reports = parseRunReports(runReportsText(offline(n * hour, n * hour + 60_000), reports));
    expect(reports.map((entry) => [entry.startedAt, entry.attempts])).toEqual([
      [at(48 * hour), 24],
      [at(24 * hour), 24],
      [at(0), 24],
    ]);
    expect(MAX_MERGED_RUN_MS).toBe(24 * hour);
  });

  it('the last run that reached the network stays, also after an outage of more than 7 days', () => {
    const hour = 60 * 60_000;
    const at = (ms: number) => new Date(START + ms).toISOString();
    const reached: RunReport = { startedAt: at(0), endedAt: at(60_000), reachedNetwork: true, events: { imagePulled: { count: 1, items: ['node:24'] } } };
    let reports = [reached];
    for (let n = 1; n <= 10 * 24; n++) reports = parseRunReports(runReportsText({ startedAt: at(n * hour), endedAt: at(n * hour + 60_000), reachedNetwork: false, events: {} }, reports));
    expect(reports).toHaveLength(MAX_RUN_REPORTS);
    expect(reports.slice(0, -1).every((entry) => !entry.reachedNetwork)).toBe(true);
    expect(reports.at(-1)).toEqual(reached);
    // The next run that reaches the network replaces it as the last one that did.
    const next: RunReport = { ...reached, startedAt: at(241 * hour), endedAt: at(241 * hour + 60_000) };
    const after = parseRunReports(runReportsText(next, reports));
    expect(after[0]).toEqual(next);
    expect(after.filter((entry) => entry.reachedNetwork)).toEqual([next]);
  });

  it('a merge keeps the names within the limits', () => {
    const names = (prefix: string) => Array.from({ length: MAX_RUN_ITEMS_PER_EVENT }, (_, i) => `${prefix}${i}`);
    const merged = mergeRunReports(
      { ...report(1, { imageRemoved: { count: 10, items: names('a') }, partFailed: { count: 1, items: ['same'] } }), reachedNetwork: false, attempts: 3 },
      { ...report(2, { imageRemoved: { count: 10, items: names('b') }, partFailed: { count: 1, items: ['same'] } }), reachedNetwork: false },
    );
    expect(merged.attempts).toBe(4);
    // The names of the later run first: the reasons of the last attempt stay.
    expect(merged.events.imageRemoved).toEqual({ count: 20, items: names('b') });
    expect(merged.events.partFailed).toEqual({ count: 2, items: ['same'] });
  });

  it('a text that is no file of runs holds none', () => {
    for (const text of ['', 'not json', '[]', '{"runs":{}}', 'null', JSON.stringify({ runs: [report(1)] }) + ' '.repeat(MAX_RUN_REPORTS_FILE_BYTES)]) {
      expect(parseRunReports(text)).toEqual([]);
    }
  });

  it('leaves out a run that is not valid and keeps the others', () => {
    const valid = report(1, { imagePulled: { count: 1, items: ['node:24'] } });
    const invalid = [
      { ...report(2), startedAt: 'yesterday' },
      { ...report(2), reachedNetwork: 'yes' },
      { ...report(2), events: [] },
      { ...report(2), attempts: 1 },
      { ...report(2), attempts: '2' },
      report(2, { imagePulled: { count: 0, items: [] } }),
      report(2, { imagePulled: { count: 1, items: ['a', 'b'] } }),
      report(2, { imagePulled: { count: 2, items: ['a', 3] as unknown as string[] } }),
      'a run',
    ];
    expect(parseRunReports(JSON.stringify({ runs: [...invalid, valid] }))).toEqual([valid]);
  });

  it('leaves out the keys and the events that a newer version wrote, and cuts the names to the limits of this one', () => {
    const newer = {
      ...report(1),
      trigger: 'schedule',
      events: {
        imagePulled: { count: 12, items: Array.from({ length: 12 }, (_, i) => `image${i}:1`), sizes: [1] },
        volumeChecked: { count: 1, items: ['x'] },
        partFailed: { count: 1, items: ['y'.repeat(MAX_RUN_ITEM_LENGTH + 10)] },
      },
    };
    const parsed = parseRunReport(newer);
    expect(parsed).toEqual({
      ...report(1),
      events: {
        imagePulled: { count: 12, items: Array.from({ length: MAX_RUN_ITEMS_PER_EVENT }, (_, i) => `image${i}:1`) },
        partFailed: { count: 1, items: [runItemText('y'.repeat(MAX_RUN_ITEM_LENGTH + 10))] },
      },
    });
    expect(parseRunReports(JSON.stringify({ version: 2, runs: [newer] }))).toEqual([parsed]);
  });
});
