// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The records of the Monitor as the reader of the shared volumes read them (docs/requirements.md R-ENG-008): each file
// is parsed with the parser of the Monitor for it; a record without a text or one that does not parse is named as
// unreadable, and a file that is no record is named as another file.
import { describe, expect, it } from 'vitest';
import { monitorRecords } from './monitorRecords';
import { DEVSPACE, HASH, HOUR, NOW, SOURCE, monitorFile } from './reportFixtures.testkit';

describe('the records of the Monitor', () => {
  it('parses each record of the volume with the parser of the Monitor', () => {
    const records = monitorRecords({
      cut: false,
      textsDropped: false,
      files: [
        monitorFile('image-settings.json', { schedule: '7 6 * * *', timeZone: 'Europe/Vienna', newKey: 1 }),
        monitorFile('cache-run.json', { lastEndAt: 1_700_000_100_000, lastCleanupAt: 1_700_000_000_000 }),
        monitorFile(`heartbeats/${SOURCE}.${DEVSPACE}.json`, { at: 1_700_000_200_000, keepRunning: false, limitSeconds: 600, seq: 3 }),
        monitorFile(`images-in-use.${SOURCE}.json`, { at: 1_700_000_000_000, references: ['ghcr.io/a/b:1'] }),
        monitorFile('registry-digests.json', { digests: { 'ghcr.io/a/b:1': { digest: `sha256:${'d'.repeat(64)}`, at: 1_700_000_000_000 } } }),
        monitorFile('helper-image.json', { tag: 'devspaces-worker:0123456789ab', baseImage: 'node:24-trixie-slim', checkedAt: '2026-11-12T05:09:00Z' }),
        monitorFile('runs.json', { runs: [{ startedAt: '2026-11-12T05:07:00Z', endedAt: '2026-11-12T05:19:00Z', reachedNetwork: true, events: { imagePulled: { count: 1, items: ['ghcr.io/a/b:1'] } } }] }),
        monitorFile('last-use.json', { at: 1_700_000_300_000 }),
        monitorFile('replaced-images.json', { 'ghcr.io/a/b': ['sha256:x'] }),
        monitorFile('pulled-over-images.json', { 'ghcr.io/a/b': ['sha256:x'] }),
        monitorFile('extensions/failures.json', { 'ms-python.python': 1_700_000_000_000 }),
        monitorFile('extensions/chosen.json', { 'dbaeumer.vscode-eslint': 'universal/dbaeumer.vscode-eslint-3.0.16' }),
        monitorFile('extensions/dependencies.json', { 'ms-python.python': ['ms-python.debugpy'] }),
        monitorFile(`extensions/wanted/${DEVSPACE}.json`, { at: 1_700_000_000_000, configuration: ['dbaeumer.vscode-eslint'], defaults: [] }),
        { path: `worker-scripts/${HASH}.js`, bytes: 123_456, modifiedAt: 1_700_000_400_000 },
        monitorFile(`worker-scripts/${HASH}.json`, { version: '0.4.1', helperTag: 'devspaces-worker:0123456789ab' }),
      ],
    });
    expect(records.settings).toEqual({ schedule: '7 6 * * *', timeZone: 'Europe/Vienna' });
    expect(records.cacheRun).toEqual({ lastEndAt: 1_700_000_100_000, lastCleanupAt: 1_700_000_000_000 });
    expect(records.heartbeats).toEqual([{ source: SOURCE, devspaceId: DEVSPACE, record: { at: 1_700_000_200_000, keepRunning: false, limitSeconds: 600, seq: 3 } }]);
    expect(records.imagesInUse).toEqual([{ source: SOURCE, record: { at: 1_700_000_000_000, references: ['ghcr.io/a/b:1'] } }]);
    expect(records.registry?.digests['ghcr.io/a/b:1']?.at).toBe(1_700_000_000_000);
    expect(records.helper?.tag).toBe('devspaces-worker:0123456789ab');
    expect(records.runs).toHaveLength(1);
    expect(records.lastUse).toEqual({ at: 1_700_000_300_000 });
    expect(records.replaced).toEqual({ 'ghcr.io/a/b': ['sha256:x'] });
    expect(records.pulledOver).toEqual({ 'ghcr.io/a/b': ['sha256:x'] });
    expect(records.extensionFailures).toEqual(new Map([['ms-python.python', 1_700_000_000_000]]));
    expect(records.extensionChoices).toEqual(new Map([['dbaeumer.vscode-eslint', 'universal/dbaeumer.vscode-eslint-3.0.16']]));
    expect(records.extensionDependencies).toEqual(new Map([['ms-python.python', ['ms-python.debugpy']]]));
    expect(records.extensionLists).toEqual([{ devspaceId: DEVSPACE, modifiedAt: NOW - HOUR, record: { at: 1_700_000_000_000, configuration: [{ id: 'dbaeumer.vscode-eslint' }], defaults: [] } }]);
    expect(records.workerScripts).toEqual([{ hash: HASH, scriptBytes: 123_456, modifiedAt: 1_700_000_400_000, record: { version: '0.4.1', helperTag: 'devspaces-worker:0123456789ab' } }]);
    expect(records.unreadable).toEqual([]);
    expect(records.textless).toEqual([]);
    expect(records.cut).toBe(false);
    expect(records.others).toEqual([]);
  });

  it('names a record without a text or one that does not parse as unreadable, and any other file as another file', () => {
    const records = monitorRecords({
      cut: false,
      textsDropped: true,
      files: [
        { path: 'runs.json', bytes: 600_000, omitted: 'size' },
        { path: 'cache-run.json', bytes: 10, omitted: 'output' },
        monitorFile('helper-image.json', { tag: 'nginx:1', baseImage: 'x' }),
        monitorFile(`heartbeats/${SOURCE}.${DEVSPACE}.json`, 'not json'),
        monitorFile(`extensions/wanted/${DEVSPACE}.json`, { at: -1 }),
        monitorFile('cleanup.json', {}),
        monitorFile('runs.json.12.3.tmp', 'partial'),
        monitorFile('heartbeats/stray.json', {}),
        monitorFile(`worker-scripts/${HASH}.js.0123456789ab.tmp`, ''),
      ],
    });
    // A state of the background run without its text is not known.
    expect(records.cacheRun).toBeUndefined();
    expect(records.runs).toEqual([]);
    expect(records.heartbeats).toEqual([{ source: SOURCE, devspaceId: DEVSPACE }]);
    expect(records.extensionLists).toEqual([{ devspaceId: DEVSPACE, modifiedAt: NOW - HOUR }]);
    expect(records.unreadable).toEqual(['runs.json', 'cache-run.json', 'helper-image.json', `heartbeats/${SOURCE}.${DEVSPACE}.json`, `extensions/wanted/${DEVSPACE}.json`]);
    expect(records.textless).toEqual(['runs.json', 'cache-run.json']);
    expect(records.others.map((file) => file.path)).toEqual(['cleanup.json', 'runs.json.12.3.tmp', 'heartbeats/stray.json', `worker-scripts/${HASH}.js.0123456789ab.tmp`]);
  });

  it('gives a record that the Monitor reads leniently the value of the Monitor, and names it unreadable when it is no JSON object', () => {
    const records = monitorRecords({
      cut: true,
      textsDropped: false,
      files: [
        monitorFile('cache-run.json', 'not json'),
        monitorFile('replaced-images.json', [1]),
        monitorFile('pulled-over-images.json', { 'ghcr.io/a/b': 'no list' }),
        monitorFile('extensions/failures.json', 'not json'),
        monitorFile('extensions/chosen.json', null),
        monitorFile('extensions/dependencies.json', { 'ms-python.python': 'no list' }),
      ],
    });
    // An invalid state counts as an empty one, as the Monitor reads it; a valid object with invalid entries is no unreadable record.
    expect(records.cacheRun).toEqual({});
    expect([records.replaced, records.pulledOver, records.extensionFailures.size, records.extensionChoices.size, records.extensionDependencies.size]).toEqual([{}, {}, 0, 0, 0]);
    expect(records.unreadable).toEqual(['cache-run.json', 'replaced-images.json', 'extensions/failures.json', 'extensions/chosen.json']);
    expect(records.textless).toEqual([]);
    expect(records.cut).toBe(true);
  });

  it('leaves out a run that is not valid, as the Monitor reads the file, and names a file without the list of runs unreadable', () => {
    const runs = (value: unknown): [number, string[]] => {
      const records = monitorRecords({ cut: false, textsDropped: false, files: [monitorFile('runs.json', value)] });
      return [records.runs.length, records.unreadable];
    };
    expect(runs({ runs: [] })).toEqual([0, []]);
    expect(runs({ runs: [{ startedAt: 1 }] })).toEqual([0, []]);
    expect(runs({ runs: 'none' })).toEqual([0, ['runs.json']]);
    expect(runs('not json')).toEqual([0, ['runs.json']]);
  });
});
