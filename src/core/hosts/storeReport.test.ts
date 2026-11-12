// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reports of the store of VS Code and of the cache of the workers (docs/requirements.md R-ENG-008): each server
// version and each extension file with the rule of the cleanup of the Monitor that keeps or removes it, the failed
// downloads with their next try, the cleanup, and the top level of the cache.
import { describe, expect, it } from 'vitest';
import { monitorRecords } from './monitorRecords';
import { CLOCK, DAY, DEVSPACE, HOUR, NOW, OTHER_DEVSPACE, monitorFile } from './reportFixtures.testkit';
import type { ReportBody, ReportCell, ReportSection } from './reportModel';
import { MAX_CACHE_ROWS, MAX_EXTENSION_ROWS, vscodeStoreReport, workerCacheReport } from './storeReport';
import type { StoredServer, VscodeStoreReading } from './volumeReader';

const [A, B, C, D, E, F] = ['a', 'b', 'c', 'd', 'e', 'f'].map((digit) => digit.repeat(40));

function server(commit: string, version: string, overrides: Partial<StoredServer> = {}): StoredServer {
  return { quality: 'stable', platform: 'linux-x64', commit, version, modifiedAt: NOW - 30 * DAY, node: true, script: true, usage: { bytes: 230_000_000, files: 1000, cut: false }, ...overrides };
}

const empty = { bytes: 0, files: 0, cut: false };

function store(overrides: Partial<VscodeStoreReading> = {}): VscodeStoreReading {
  return {
    servers: [server(C, '1.139.1'), server(A, '1.141.0'), server(D, '1.138.0'), server(B, '1.140.2'), server(F, '1.137.0', { node: false })],
    used: [
      { name: `stable-linux-x64-${A}`, at: NOW - HOUR },
      { name: `stable-linux-x64-${B}`, at: NOW - 9 * DAY },
      { name: `stable-linux-x64-${C}`, at: NOW - 16 * DAY },
      { name: `stable-linux-x64-${D}`, at: NOW - 3 * DAY },
    ],
    extensions: [
      { folder: 'universal', name: 'dbaeumer.vscode-eslint-3.0.10', bytes: 1_700_000, modifiedAt: NOW - 20 * DAY },
      { folder: 'universal', name: 'dbaeumer.vscode-eslint-3.0.16', bytes: 1_700_000, modifiedAt: NOW - DAY },
      { folder: 'linux-x64', name: 'golang.go-0.48.0-linux-x64', bytes: 14_000_000 },
      { folder: 'linux-x64', name: 'golang.go-0.47.2-linux-x64', bytes: 14_000_000 },
      { folder: 'universal', name: 'some.unlisted-1.0.0', bytes: 1000 },
      { folder: 'universal', name: 'README', bytes: 10 },
    ],
    temporary: empty,
    extensionTemporary: { bytes: 4096, files: 1, cut: false },
    locks: 7,
    cut: false,
    ...overrides,
  };
}

const records = monitorRecords({
  cut: false,
  textsDropped: false,
  files: [
    monitorFile('cache-run.json', { lastEndAt: NOW - 2 * HOUR, lastCleanupAt: NOW - 3 * HOUR, failedFetches: { [`stable-linux-x64-${E}`]: NOW - 30 * HOUR } }),
    monitorFile('extensions/failures.json', { 'ms-python.python': NOW - 2 * HOUR }),
    monitorFile('extensions/chosen.json', { 'dbaeumer.vscode-eslint': 'universal/dbaeumer.vscode-eslint-3.0.16' }),
    monitorFile(`extensions/wanted/${DEVSPACE}.json`, { at: NOW - DAY, configuration: ['dbaeumer.vscode-eslint', 'golang.go'], defaults: [] }),
    monitorFile(`extensions/wanted/${OTHER_DEVSPACE}.json`, { at: NOW - 2 * DAY, configuration: ['golang.go@0.47.2'], defaults: [] }),
  ],
});

function section(sections: readonly ReportSection[], title: string): ReportBody {
  const found = sections.find((candidate) => candidate.title === title);
  if (found === undefined) throw new Error(`No section ${title}`);
  return found.body;
}

function rows(body: ReportBody): ReportCell[][] {
  if (body.kind !== 'table') throw new Error('No table');
  return body.rows;
}

function facts(body: ReportBody): Record<string, string> {
  if (body.kind !== 'facts') throw new Error('No facts');
  return Object.fromEntries(body.facts.map((entry) => [entry.label, entry.value.text]));
}

describe('the report of the store of VS Code', () => {
  it('gives each server version, newest first, with the rule of the cleanup of the Monitor', () => {
    const report = vscodeStoreReport(store(), records, CLOCK, 'linux-x64');
    const servers = rows(section(report.sections, 'VS Code Server'));
    expect(servers.map((row) => [row[0].text, row[3].text, row[5].text, row[6].chip])).toEqual([
      ['1.141.0', 'aaaaaaa', '1 hour ago', { text: 'kept: newest', tone: 'keep' }],
      ['1.140.2', 'bbbbbbb', '9 days ago', { text: 'kept: one of the 2 newest', tone: 'keep' }],
      ['1.139.1', 'ccccccc', '16 days ago', { text: 'removed at the next cleanup, unless a running container runs it', tone: 'remove' }],
      ['1.138.0', 'ddddddd', '3 days ago', { text: 'kept: used 3 days ago', tone: 'keep' }],
      // Without a marker, the time of its folder counts (30 days): it goes too, also when it is incomplete.
      ['1.137.0', 'fffffff', 'none · downloaded 30 days ago', { text: 'removed at the next cleanup (incomplete), unless a running container runs it', tone: 'remove' }],
    ]);
    expect(servers[0][4].text).toBe('230 MB');
  });

  it('gives each extension file with the rule of the cleanup of the Monitor', () => {
    const report = vscodeStoreReport(store(), records, CLOCK, 'linux-x64');
    expect(rows(section(report.sections, 'Extensions')).map((row) => [row[0].text, row[1].text, row[2].text, row[5].chip?.text])).toEqual([
      ['dbaeumer.vscode-eslint', '3.0.16', 'universal', 'kept: the version that the runs chose'],
      ['dbaeumer.vscode-eslint', '3.0.10', 'universal', 'removed at the next cleanup: an older version'],
      ['golang.go', '0.48.0', 'linux-x64', 'kept: newest'],
      ['golang.go', '0.47.2', 'linux-x64', 'kept: a list pins @0.47.2'],
      ['README', '', 'universal', 'no file of the Monitor: left alone'],
      ['some.unlisted', '1.0.0', 'universal', 'removed at the next cleanup: no list of the last 14 days names it'],
    ]);
    expect(report.summary).toEqual([
      { text: '5 server versions', tone: 'info' },
      { text: '6 extension files', tone: 'info' },
      { text: '4 removed at the next cleanup', tone: 'remove' },
      { text: '2 downloads failed', tone: 'warn' },
    ]);
  });

  it('leaves the server versions of another platform to their engine, and claims no removal it cannot know', () => {
    const other = store({ servers: [server(A, '1.141.0'), server(B, '1.140.2'), server(C, '1.139.1'), server(E, '1.120.0', { platform: 'linux-arm64' })] });
    const rule = (report: ReturnType<typeof vscodeStoreReport>, version: string) => rows(section(report.sections, 'VS Code Server')).find((row) => row[0].text === version)?.[6].chip;
    const report = vscodeStoreReport(other, records, CLOCK, 'linux-x64');
    expect(rule(report, '1.120.0')).toEqual({ text: 'kept: the Monitor cleans only the versions for linux-x64, the platform of this engine', tone: 'info' });
    expect(rule(report, '1.139.1')?.tone).toBe('remove');
    // Without the platform of the engine, or with a list of the store that stopped at a limit: no removal is certain.
    const noPlatform = vscodeStoreReport(other, records, CLOCK);
    expect([rule(noPlatform, '1.139.1')?.tone, rule(noPlatform, '1.120.0')?.tone]).toEqual(['warn', 'keep']);
    expect(noPlatform.notices).toEqual([expect.stringContaining('platform of the engine is not known')]);
    expect(rule(vscodeStoreReport({ ...other, cut: true }, records, CLOCK, 'linux-x64'), '1.139.1')).toEqual({ text: 'not known: the list of the store is incomplete', tone: 'warn' });
  });

  it('leaves alone the folders that are no version of the Monitor, and names an incomplete version that stays', () => {
    const report = vscodeStoreReport(
      store({ servers: [server(A, '1.141.0', { script: false }), server(B, '1.140.2'), server(C, '1.139.1'), server('leftover', '9.9.9'), server(D, '1.200.0', { quality: 'exploration' })] }),
      records,
      CLOCK,
      'linux-x64',
    );
    const rule = (commit: string) => rows(section(report.sections, 'VS Code Server')).find((row) => row[3].text === commit.slice(0, 7))?.[6].chip;
    expect(rule('leftover')).toEqual({ text: 'no version of the Monitor: left alone', tone: 'info' });
    expect(rule(D)).toEqual({ text: 'no version of the Monitor: left alone', tone: 'info' });
    // The folder 9.9.9 does not count as one of the 2 newest: 1.141.0 (incomplete) and 1.140.2 are, and 1.139.1 goes.
    expect([rule(A), rule(B)?.tone, rule(C)?.tone]).toEqual([{ text: 'incomplete: no window uses it', tone: 'warn' }, 'keep', 'remove']);
  });

  it('says that the failed downloads and the last cleanup are not known without the text of their records', () => {
    const textless = monitorRecords({ cut: false, textsDropped: true, files: [{ path: 'cache-run.json', bytes: 10, omitted: 'output' }] });
    const report = vscodeStoreReport(store(), textless, CLOCK, 'linux-x64');
    const failed = section(report.sections, 'Downloads that failed');
    expect(failed.kind === 'table' ? failed.empty : undefined).toBe('Not known: the reader could not read cache-run.json or extensions/failures.json whole.');
    expect(facts(section(report.sections, 'Cleanup and downloads'))['Last cleanup']).toBe('not known: the reader could not read cache-run.json whole');
  });

  it('names the next cleanup of a store that was never cleaned', () => {
    const fresh = monitorRecords({ cut: false, textsDropped: false, files: [monitorFile('cache-run.json', { lastEndAt: NOW - HOUR })] });
    expect(facts(section(vscodeStoreReport(store(), fresh, CLOCK, 'linux-x64').sections, 'Cleanup and downloads'))).toMatchObject({ 'Last cleanup': 'none yet', 'Next cleanup': 'with the next run' });
  });

  it('orders the builds of one version by their download, as the releases come', () => {
    const insiders = (commit: string, daysAgo: number) => server(commit, '1.142.0-insider', { quality: 'insider', modifiedAt: NOW - daysAgo * DAY });
    const report = vscodeStoreReport(store({ servers: [insiders(A, 40), insiders(B, 20), insiders(C, 30), insiders(D, 50)], used: [] }), records, CLOCK, 'linux-x64');
    expect(rows(section(report.sections, 'VS Code Server')).map((row) => [row[3].text, row[6].chip?.tone])).toEqual([
      ['bbbbbbb', 'keep'],
      ['ccccccc', 'keep'],
      ['aaaaaaa', 'remove'],
      ['ddddddd', 'remove'],
    ]);
  });

  it('takes a time ahead of the clock as due, as the Monitor does (a clock that was corrected)', () => {
    const ahead = monitorRecords({
      cut: false,
      textsDropped: false,
      files: [monitorFile('cache-run.json', { lastCleanupAt: NOW + 3 * DAY, failedFetches: { [`stable-linux-x64-${E}`]: NOW + 3 * DAY } }), monitorFile('extensions/failures.json', { 'ms-python.python': NOW + 3 * DAY })],
    });
    const report = vscodeStoreReport(store(), ahead, CLOCK, 'linux-x64');
    expect(rows(section(report.sections, 'Downloads that failed')).map((row) => row[2].text)).toEqual(['with the next run', 'with the next run']);
    expect(facts(section(report.sections, 'Cleanup and downloads'))['Next cleanup']).toBe('with the next run');
  });

  it('counts a list that cannot be read only while the cleanup keeps it, and ignores a name that is no devspace ID', () => {
    const lists = monitorRecords({
      cut: false,
      textsDropped: false,
      files: [
        monitorFile(`extensions/wanted/${DEVSPACE}.json`, { at: NOW - DAY, configuration: ['dbaeumer.vscode-eslint'], defaults: [] }),
        // The cleanup of the Monitor removes this list first: its file is older than 14 days.
        monitorFile(`extensions/wanted/${OTHER_DEVSPACE}.json`, 'no json', NOW - 20 * DAY),
        monitorFile('extensions/wanted/notes.v1.json', 'no json'),
      ],
    });
    expect(lists.others.map((file) => file.path)).toEqual(['extensions/wanted/notes.v1.json']);
    const extensions = rows(section(vscodeStoreReport(store(), lists, CLOCK, 'linux-x64').sections, 'Extensions'));
    expect(extensions.find((row) => row[0].text === 'some.unlisted')?.[5].chip?.tone).toBe('remove');
  });

  it('gives no rule of an extension file while a record that the rules need is not read whole', () => {
    const textless = monitorRecords({ cut: false, textsDropped: false, files: [monitorFile(`extensions/wanted/${DEVSPACE}.json`, { at: NOW - DAY, configuration: ['golang.go'], defaults: [] }), { path: 'extensions/chosen.json', bytes: 2_000_000, omitted: 'size' }] });
    const cut = monitorRecords({ cut: true, textsDropped: false, files: [monitorFile(`extensions/wanted/${DEVSPACE}.json`, { at: NOW - DAY, configuration: ['golang.go'], defaults: [] })] });
    for (const partial of [textless, cut]) {
      const report = vscodeStoreReport(store(), partial, CLOCK, 'linux-x64');
      const extensions = rows(section(report.sections, 'Extensions'));
      expect(extensions.map((row) => row[5].chip?.text)).toEqual([undefined, undefined, undefined, undefined, 'no file of the Monitor: left alone', undefined]);
      expect(report.summary).toContainEqual({ text: '2 removed at the next cleanup', tone: 'remove' });
      expect(report.notices).toEqual([expect.stringContaining('the rules of the extension files need could not be read whole')]);
    }
  });

  it('keeps the files of the extensions that no list names while a list cannot be read, as the Monitor does', () => {
    const unreadable = monitorRecords({
      cut: false,
      textsDropped: false,
      files: [monitorFile(`extensions/wanted/${DEVSPACE}.json`, { at: NOW - DAY, configuration: ['dbaeumer.vscode-eslint'], defaults: [] }), monitorFile(`extensions/wanted/${OTHER_DEVSPACE}.json`, 'no json')],
    });
    const extensions = rows(section(vscodeStoreReport(store(), unreadable, CLOCK, 'linux-x64').sections, 'Extensions'));
    expect(extensions.find((row) => row[0].text === 'some.unlisted')?.[5].chip?.text).toBe('kept: newest');
  });

  it('gives the failed downloads with their next try, and the cleanup', () => {
    const report = vscodeStoreReport(store(), records, CLOCK, 'linux-x64');
    expect(rows(section(report.sections, 'Downloads that failed')).map((row) => row.map((entry) => entry.text))).toEqual([
      ['VS Code Server eeeeeee (stable, linux-x64)', 'yesterday 03:00', 'with the next run'],
      ['Extension ms-python.python', 'today 07:00', 'with the first run after tomorrow 07:00'],
    ]);
    expect(facts(section(report.sections, 'Cleanup and downloads'))).toMatchObject({
      'Last cleanup': 'today 06:00 · at most once a day',
      'Next cleanup': 'with the first run after tomorrow 06:00',
      'Downloads now': expect.stringMatching(/^1 temporary file \(4\.1 kB\)/),
    });
    expect(report.notices).toEqual([]);
  });

  it('says what it misses without the records of the Monitor, and when a list is incomplete', () => {
    const report = vscodeStoreReport(store({ cut: true }), undefined, CLOCK, 'linux-x64');
    expect(report.sections.map((entry) => entry.title)).toEqual(['VS Code Server', 'Extensions', 'Cleanup and downloads']);
    expect(rows(section(report.sections, 'Extensions'))[1][5].chip).toBeUndefined();
    // With the records of the Monitor, an incomplete list of the store still gives no rule of an extension file: its newest file can be missing.
    const cut = vscodeStoreReport(store({ cut: true }), records, CLOCK, 'linux-x64');
    expect(rows(section(cut.sections, 'Extensions')).map((row) => row[5].chip?.tone)).toEqual([undefined, undefined, undefined, undefined, 'info', undefined]);
    expect(cut.notices).toEqual(['The store holds more entries than the reader lists: some lists are incomplete, and the rules of the extension files are missing.']);
    expect(report.notices).toEqual([expect.stringContaining('more entries than the reader lists'), expect.stringContaining('devspaces-monitor is not there')]);
  });

  it('shows at most MAX_EXTENSION_ROWS extension files and counts the others', () => {
    const many = Array.from({ length: MAX_EXTENSION_ROWS + 2 }, (_, index) => ({ folder: 'universal', name: `pub.ext${index}-1.0.0`, bytes: 1 }));
    const body = section(vscodeStoreReport(store({ extensions: many }), records, CLOCK, 'linux-x64').sections, 'Extensions');
    expect(rows(body)).toHaveLength(MAX_EXTENSION_ROWS);
    expect(body.kind === 'table' ? body.more : undefined).toBe('2 more files, sorted by extension');
  });
});

describe('the report of the cache of the workers', () => {
  it('gives its top level, the largest first, and says when it holds more', () => {
    const report = workerCacheReport(
      {
        entries: [
          { name: 'small', kind: 'file', modifiedAt: NOW - HOUR, usage: { bytes: 10, files: 1, cut: false } },
          { name: 'cli', kind: 'folder', modifiedAt: NOW - DAY, usage: { bytes: 48_000_000, files: 300, cut: true } },
        ],
        more: true,
      },
      CLOCK,
    );
    const body = section(report.sections, 'Top level');
    expect(rows(body).map((row) => row.map((entry) => entry.text))).toEqual([
      ['cli', 'folder', 'at least 48 MB', '300', 'yesterday 09:00'],
      ['small', 'file', '10 B', '1', 'today 08:00'],
    ]);
    expect(body.kind === 'table' ? body.more : undefined).toBe('It holds more entries than the reader lists.');
    const many = Array.from({ length: MAX_CACHE_ROWS + 3 }, (_, index) => ({ name: `e${index}`, kind: 'file' as const, usage: { bytes: 1, files: 1, cut: false } }));
    const more = section(workerCacheReport({ entries: many, more: true }, CLOCK).sections, 'Top level');
    expect(more.kind === 'table' ? more.more : undefined).toBe('3 more entries. It holds more entries than the reader lists.');
  });
});
