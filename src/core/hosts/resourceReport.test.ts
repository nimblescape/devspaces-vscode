// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The content of the report of one resource of the view Docker Hosts (docs/requirements.md R-ENG-008): which shared
// volumes its reader reads, the sections of Devspaces before the facts of Docker, and what could not be read.
import { describe, expect, it } from 'vitest';
import type { HostObject } from './hostObjects';
import type { ReportComputer } from './monitorReport';
import { CLOCK, NOW, SOURCE, monitorFile } from './reportFixtures.testkit';
import { reportVolumes, resourceReport } from './resourceReport';
import type { VolumeReading } from './volumeReader';

const COMPUTER: ReportComputer = { id: SOURCE, repositories: new Map(), version: '0.4.1' };
const empty = { bytes: 0, files: 0, cut: false };
const reading: VolumeReading = {
  stopped: false,
  unreadable: 0,
  tooLong: false,
  monitor: { cut: false, textsDropped: false, files: [monitorFile('cache-run.json', { lastEndAt: NOW - 60_000 })] },
  vscode: { servers: [], used: [], extensions: [], temporary: empty, extensionTemporary: empty, locks: 0, cut: false },
  workerCache: { entries: [], more: false },
};

function shared(name: string): HostObject {
  return { kind: 'volume', id: name, name, purpose: 'sharedVolume' };
}

describe('the report of a resource', () => {
  it('reads the shared volumes that its report needs, and none for other objects', () => {
    expect(reportVolumes(shared('devspaces-vscode'))).toEqual({ vscode: 'devspaces-vscode', monitor: 'devspaces-monitor' });
    expect(reportVolumes(shared('devspaces-monitor'))).toEqual({ monitor: 'devspaces-monitor' });
    expect(reportVolumes(shared('devspaces-worker-cache'))).toEqual({ 'worker-cache': 'devspaces-worker-cache' });
    expect(reportVolumes({ kind: 'container', name: 'devspaces-monitor', purpose: 'monitor' })).toEqual({ monitor: 'devspaces-monitor' });
    // A volume of the same name that is not of Devspaces, and other objects, are never read.
    expect(reportVolumes({ kind: 'volume', name: 'devspaces-vscode', purpose: 'notDevspaces' })).toEqual({});
    expect(reportVolumes({ kind: 'volume', name: 'shop_pgdata', purpose: 'notDevspaces' })).toEqual({});
    expect(reportVolumes({ kind: 'image', name: 'devspaces-worker:0123456789ab', purpose: 'helperImage' })).toEqual({});
  });

  it('puts the sections of Devspaces before the facts of Docker', () => {
    const titles = (object: HostObject): string[] => resourceReport({ object, volumes: { kind: 'read', reading, image: 'devspaces-worker:0123456789ab' }, computer: COMPUTER, clock: CLOCK }).sections.map((section) => section.title);
    expect(titles(shared('devspaces-vscode'))).toEqual(['VS Code Server', 'Downloads that failed', 'Extensions', 'Cleanup and downloads', 'Facts of Docker']);
    expect(titles(shared('devspaces-monitor'))[0]).toBe('Background run');
    expect(titles(shared('devspaces-worker-cache'))).toEqual(['The volume', 'Top level', 'Facts of Docker']);
    expect(titles({ kind: 'container', id: 'm', name: 'devspaces-monitor', purpose: 'monitor' })).toEqual(['The Monitor', 'What it did: the last runs', 'Facts of Docker']);
  });

  it('gives an object that is not of Devspaces only the facts of Docker', () => {
    const report = resourceReport({ object: { kind: 'image', id: 'sha256:n', name: 'nginx:1.27', tags: ['nginx:1.27'], purpose: 'notDevspaces' }, computer: COMPUTER, clock: CLOCK });
    expect(report.sections.map((section) => section.title)).toEqual(['Facts of Docker']);
    expect(report).toMatchObject({ summary: [], notices: [], monitorLog: false });
  });

  it('says what could not be read', () => {
    const notices = (volumes: Parameters<typeof resourceReport>[0]['volumes'], detailsProblem?: string): string[] =>
      resourceReport({ object: shared('devspaces-monitor'), volumes, computer: COMPUTER, clock: CLOCK, ...(detailsProblem !== undefined ? { detailsProblem } : {}) }).notices;
    expect(notices({ kind: 'noImage' })).toEqual([expect.stringContaining('no helper image of Devspaces')]);
    expect(notices({ kind: 'noVolume' })).toEqual([expect.stringContaining('not there anymore')]);
    expect(notices({ kind: 'failed', detail: 'Docker is not running.' })).toEqual(['What the volume contains could not be read: Docker is not running.']);
    expect(notices({ kind: 'read', reading: { ...reading, stopped: true, unreadable: 2, tooLong: true, monitor: undefined }, image: 'x' }, 'No such volume')).toEqual([
      'The volumes hold too much for one read: their content is left out.',
      'The reader reached its limit of time or of entries: some sizes and lists are incomplete.',
      '2 folders could not be read: some sizes are incomplete.',
      'Docker could not give the facts of this object: No such volume',
    ]);
  });
});
