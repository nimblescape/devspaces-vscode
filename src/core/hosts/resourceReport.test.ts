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
    expect(reportVolumes({ kind: 'image', name: 'nginx:1.27', purpose: 'notDevspaces' })).toEqual({});
    // The helper image needs the check of the Monitor (imageReport.test.ts tests the other images).
    expect(reportVolumes({ kind: 'image', name: 'devspaces-worker:0123456789ab', purpose: 'helperImage' })).toEqual({ monitor: 'devspaces-monitor' });
  });

  it('puts the sections of Devspaces before the facts of Docker', () => {
    const titles = (object: HostObject): string[] => resourceReport({ object, volumes: { kind: 'read', reading, image: 'devspaces-worker:0123456789ab' }, platform: 'linux-x64', computer: COMPUTER, clock: CLOCK }).sections.map((section) => section.title);
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

  it('offers Show Log on the report of every container whose log driver keeps a log, by its full ID; the Monitor has its own', () => {
    const id = '0123456789abcdef'.repeat(4);
    const web: HostObject = { kind: 'container', id, name: 'shop-web-1', purpose: 'notDevspaces', state: 'running' };
    const details = (logDriver?: string): Parameters<typeof resourceReport>[0]['details'] => ({ kind: 'container', labels: new Map(), env: new Map(), mounts: [], ports: [], networks: [], ...(logDriver !== undefined ? { logDriver } : {}) });
    expect(resourceReport({ object: web, details: details('json-file'), computer: COMPUTER, clock: CLOCK })).toMatchObject({ monitorLog: false, containerLog: id });
    // Without the facts of Docker, the button stays: Docker says why when the log cannot be read.
    expect(resourceReport({ object: web, computer: COMPUTER, clock: CLOCK }).containerLog).toBe(id);
    // The log driver none keeps no log: no Show Log, and the facts say why.
    const none = resourceReport({ object: web, details: details('none'), computer: COMPUTER, clock: CLOCK });
    expect(none.containerLog).toBeUndefined();
    expect(JSON.stringify(none.sections)).toContain('none (Docker keeps no log of it)');
    // The Monitor: Show Log of the Monitor, by its name. An image, a volume or a network has no log.
    const monitor = resourceReport({ object: { kind: 'container', id, name: 'devspaces-monitor', purpose: 'monitor' }, computer: COMPUTER, clock: CLOCK });
    expect(monitor).toMatchObject({ monitorLog: true });
    expect(monitor.containerLog).toBeUndefined();
    expect(resourceReport({ object: { kind: 'image', id: `sha256:${id}`, name: 'nginx:1.27', purpose: 'notDevspaces' }, computer: COMPUTER, clock: CLOCK }).containerLog).toBeUndefined();
  });

  it('offers Show Log on the report of a worker for the log that the worker writes itself, whose log driver is none', () => {
    const id = '0123456789abcdef'.repeat(4);
    const worker: HostObject = { kind: 'container', id, name: 'devspaces-api-worker1', purpose: 'worker', state: 'running' };
    const details: Parameters<typeof resourceReport>[0]['details'] = { kind: 'container', labels: new Map(), env: new Map(), mounts: [], ports: [], networks: [], logDriver: 'none' };
    const report = resourceReport({ object: worker, details, computer: COMPUTER, clock: CLOCK });
    expect(report).toMatchObject({ monitorLog: false, workerLog: id });
    expect(report.containerLog).toBeUndefined();
    expect(JSON.stringify(report.sections)).toContain('none (the worker writes a log of its own, which Show Log reads)');
    // Without the facts of Docker too; a row without a full ID has none.
    expect(resourceReport({ object: worker, computer: COMPUTER, clock: CLOCK }).workerLog).toBe(id);
    expect(resourceReport({ object: { ...worker, id: 'w1' }, computer: COMPUTER, clock: CLOCK }).workerLog).toBeUndefined();
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
    expect(notices({ kind: 'read', reading: { ...reading, monitor: { cut: true, textsDropped: false, files: [] } }, image: 'x' })).toEqual(['The volume devspaces-monitor holds more files than the reader lists: some records are missing.']);
    // The report of the container of the Monitor: one notice for one cause.
    const monitor = (volumes: Parameters<typeof resourceReport>[0]['volumes']): string[] => resourceReport({ object: { kind: 'container', id: 'm', name: 'devspaces-monitor', purpose: 'monitor' }, volumes, computer: COMPUTER, clock: CLOCK }).notices;
    expect(monitor({ kind: 'noImage' })).toEqual([expect.stringContaining('no helper image of Devspaces')]);
    expect(monitor({ kind: 'read', reading: { ...reading, monitor: undefined }, image: 'x' })).toEqual(['The volume devspaces-monitor is not there: the background run and the last runs are missing.']);
    // A read that was too long has no parts: it does not say that the volume is missing.
    expect(monitor({ kind: 'read', reading: { ...reading, tooLong: true, monitor: undefined }, image: 'x' })).toEqual(['The volumes hold too much for one read: their content is left out.']);
  });
});
