// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The short report of each background run of the Monitor (docs/requirements.md R-DS-003): the collection of the events
// with its limits, the file of the last runs, and its check, which leaves out what a newer version wrote and this one
// does not know.
import { describe, expect, it } from 'vitest';
import {
  MAX_RUN_ITEMS,
  MAX_RUN_ITEMS_PER_EVENT,
  MAX_RUN_ITEM_LENGTH,
  MAX_RUN_REPORTS,
  MAX_RUN_REPORTS_FILE_BYTES,
  RUN_EVENTS,
  RUN_FAILURE_EVENTS,
  RunReportBuilder,
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

  it('keeps at most MAX_RUN_ITEMS_PER_EVENT names of a kind and MAX_RUN_ITEMS in all; the counts go on', () => {
    const notes = new RunReportBuilder(START);
    for (let i = 0; i < 25; i++) notes.note('extensionDownloaded', `ext.e${i}-1.0.0`);
    for (const event of RUN_EVENTS) for (let i = 0; i < 5; i++) notes.note(event, `${event} ${i}`);
    const { events } = notes.finish(END, true);
    expect(events.extensionDownloaded).toEqual({ count: 30, items: Array.from({ length: MAX_RUN_ITEMS_PER_EVENT }, (_, i) => `ext.e${i}-1.0.0`) });
    const names = Object.values(events).reduce((sum, note) => sum + note.items.length, 0);
    expect(names).toBe(MAX_RUN_ITEMS);
    for (const event of RUN_EVENTS) expect(events[event]!.count).toBe(event === 'extensionDownloaded' ? 30 : 5);
  });

  it('a name is one line of at most MAX_RUN_ITEM_LENGTH characters; an empty name and a count below 1 are left out', () => {
    expect(runItemText('  a\nb\u001b[31m  c\t ')).toBe('a b [31m c');
    const long = runItemText('x'.repeat(500));
    expect(long).toHaveLength(MAX_RUN_ITEM_LENGTH);
    expect(long.endsWith('…')).toBe(true);
    const notes = new RunReportBuilder(START);
    notes.note('imagePulled', ' \n ');
    notes.note('imageRemoved', 'a', 0);
    notes.note('imageRemoved', 'b', 1.5);
    expect(notes.finish(END, true).events).toEqual({ imagePulled: { count: 1, items: [] } });
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
    for (const event of RUN_EVENTS) for (let i = 0; i < MAX_RUN_ITEMS_PER_EVENT; i++) notes.note(event, `${i} ${'é'.repeat(MAX_RUN_ITEM_LENGTH)}`);
    const full = notes.finish(END, true);
    const text = runReportsText(full, Array.from({ length: MAX_RUN_REPORTS }, () => full));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(MAX_RUN_REPORTS_FILE_BYTES);
    expect(parseRunReports(text)).toHaveLength(MAX_RUN_REPORTS);
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
