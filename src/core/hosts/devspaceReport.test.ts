// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reports of the objects of a devspace in the view Docker Hosts (docs/requirements.md R-ENG-010): the dev container
// with the labels that decide whether the next Start creates it again and the windows of the heartbeat records, a
// container of another service, the workspace volume with the Git record of this computer, the other volumes with the
// rule of Delete, and the network of the Docker Compose project; a devspace that this computer does not know has only
// its labels.
import { describe, expect, it } from 'vitest';
import { composeProjectName } from '../names';
import type { BuildRecord } from '../types';
import { devspaceReport, isDevspaceObject, labelBuildRecord } from './devspaceReport';
import type { HostObject } from './hostObjects';
import { monitorRecords } from './monitorRecords';
import type { ReportComputer, ReportDevspace } from './monitorReport';
import type { ContainerDetails, NetworkDetails, VolumeDetails } from './objectDetails';
import type { ReportContent, ReportFact } from './reportModel';
import { CLOCK, DEVSPACE, NOW, OTHER_SOURCE, SOURCE, monitorFile } from './reportFixtures.testkit';
import { reportVolumes, resourceReport } from './resourceReport';

const REPOSITORY = 'majikmate/shop';
const IMAGE = 'devspaces-majikmate-shop-brave-otter:2';
const RECORD: BuildRecord = { builtAt: '2026-11-10T13:22:00.000Z', devspaceImage: IMAGE, buildNumber: 2, configPath: '.devcontainer/devcontainer.json', configHash: 'sha256:9c1f', images: {}, features: {} };
const ENTRY: ReportDevspace = {
  id: DEVSPACE,
  repository: REPOSITORY,
  volumeName: 'devspaces-majikmate-shop-brave-otter',
  configPath: '.devcontainer/devcontainer.json',
  createdAt: '2026-11-03T08:00:00.000Z',
  lastUsedAt: '2026-11-12T04:40:00.000Z',
  owner: { id: '58122930', login: 'scalarion' },
  buildRecord: RECORD,
  additionalVolumes: ['shop_pgdata', 'shop_cache'],
  serviceVolumes: ['shop_pgdata'],
};
const COMPUTER: ReportComputer = { id: SOURCE, repositories: new Map([[DEVSPACE, REPOSITORY]]), devspaces: new Map([[DEVSPACE, ENTRY]]), version: '0.4.2' };

function container(labels: Record<string, string>, extra: Partial<ContainerDetails> = {}): ContainerDetails {
  return { kind: 'container', labels: new Map(Object.entries(labels)), image: IMAGE, env: new Map(), mounts: [], ports: [], networks: [], ...extra };
}

function volume(labels: Record<string, string> = {}): VolumeDetails {
  return { kind: 'volume', labels: new Map(Object.entries(labels)), users: [], moreUsers: false };
}

const devContainer: HostObject = { kind: 'container', id: 'c1', name: 'devspaces-majikmate-shop-brave-otter', purpose: 'devspace', devspaceId: DEVSPACE, repository: REPOSITORY, role: 'dev container', state: 'running' };
const CURRENT_LABELS = { 'nimblescape.devspaces.container-version': '1', 'nimblescape.devspaces.config-path': '.devcontainer/devcontainer.json', 'nimblescape.devspaces.build-record': JSON.stringify(RECORD) };

function facts(report: ReportContent | undefined, title: string): Record<string, ReportFact['value']> {
  const section = report?.sections.find((entry) => entry.title === title);
  if (section?.body.kind !== 'facts') throw new Error(`no facts section ${title}`);
  return Object.fromEntries(section.body.facts.map((entry) => [entry.label, entry.value]));
}

describe('isDevspaceObject', () => {
  it('takes the containers, the networks and the volumes of a devspace, not its images and not other objects', () => {
    expect(isDevspaceObject(devContainer)).toBe(true);
    expect(isDevspaceObject({ kind: 'volume', purpose: 'otherDevspace', role: 'workspace' })).toBe(true);
    expect(isDevspaceObject({ kind: 'volume', purpose: 'devspace', role: 'data of a service' })).toBe(true);
    expect(isDevspaceObject({ kind: 'network', purpose: 'devspace', role: 'network' })).toBe(true);
    expect(isDevspaceObject({ kind: 'image', purpose: 'devspace', role: 'image' })).toBe(false);
    expect(isDevspaceObject({ kind: 'container', purpose: 'worker' })).toBe(false);
    expect(isDevspaceObject({ kind: 'volume', purpose: 'sharedVolume', role: 'Monitor' })).toBe(false);
  });
});

describe('labelBuildRecord', () => {
  it('takes a valid build record of the label, nothing else', () => {
    expect(labelBuildRecord(new Map([['nimblescape.devspaces.build-record', JSON.stringify(RECORD)]]))).toEqual(RECORD);
    for (const text of ['', 'not json', '{"builtAt":1}', 'x'.repeat(9000)]) expect(labelBuildRecord(new Map([['nimblescape.devspaces.build-record', text]]))).toBeUndefined();
    expect(labelBuildRecord(new Map())).toBeUndefined();
  });
});

describe('the report of a dev container', () => {
  it('gives its devspace, its build, the labels of a current container, and the windows of the heartbeat records', () => {
    const records = monitorRecords({
      cut: false,
      textsDropped: false,
      files: [
        monitorFile(`heartbeats/${SOURCE}.${DEVSPACE}.json`, { at: NOW - 20_000, keepRunning: false, limitSeconds: 300, seq: 4 }),
        monitorFile(`heartbeats/${OTHER_SOURCE}.${DEVSPACE}.json`, { at: NOW - 3 * 60 * 60_000, keepRunning: true, limitSeconds: 300, seq: 9 }),
        monitorFile(`heartbeats/${SOURCE}.66666666-7777-8888-9999-000000000000.json`, { at: NOW, keepRunning: false, limitSeconds: 300, seq: 1 }),
      ],
    });
    const report = devspaceReport({ object: devContainer, details: container(CURRENT_LABELS), devspace: ENTRY, records, computer: COMPUTER, clock: CLOCK });
    expect(report?.sections.map((section) => section.title)).toEqual(['The devspace', 'Windows now']);
    expect(facts(report, 'The devspace')).toEqual({
      Devspace: { text: 'majikmate/shop · owner scalarion' },
      Image: { text: `${IMAGE} · build 2 of 2026-11-10 14:22` },
      Configuration: { text: '.devcontainer/devcontainer.json' },
      'Container setup': { text: 'version 1', chip: { text: 'current', tone: 'keep' } },
      'Host access checks': { text: 'on when it was created' },
      'Keep Running When Closed': { text: 'off' },
    });
    expect(report?.summary).toEqual([]);
    const windows = report?.sections[1].body;
    expect(windows?.kind === 'table' ? windows.rows.map((row) => row.map((value) => value.text)) : []).toEqual([
      ['this computer', '20 s ago', 'stops after 5 minutes without a sign'],
      ['another computer', '3 hours ago', 'keeps running'],
    ]);
  });

  it('says when the next Start creates it again, and names another build of the record of this computer', () => {
    const labels = { 'nimblescape.devspaces.container-config': 'unknown', 'nimblescape.devspaces.host-access': 'unrestricted' };
    const report = devspaceReport({ object: devContainer, details: container(labels, { image: 'devspaces-majikmate-shop-brave-otter:1' }), devspace: { ...ENTRY, keepRunning: true }, computer: COMPUTER, clock: CLOCK });
    const values = facts(report, 'The devspace');
    expect(values.Image).toEqual({ text: 'devspaces-majikmate-shop-brave-otter:1' });
    expect(values['Build record of this computer']).toEqual({ text: `${IMAGE} · build 2 of 2026-11-10 14:22`, chip: { text: 'another image than the one of the container', tone: 'info' } });
    expect(values.Configuration.chip?.tone).toBe('warn');
    expect(values['Container setup']).toEqual({ text: 'no version: older than the versions of the container setup', chip: expect.objectContaining({ tone: 'remove' }) });
    expect(values['Host access checks']).toEqual({ text: 'off when it was created', chip: expect.objectContaining({ tone: 'warn' }) });
    expect(values['Keep Running When Closed'].text).toContain('the Monitor never stops it');
    expect(report?.summary).toEqual([{ text: 'created again at the next Start', tone: 'remove' }]);
    // Without the records of the Monitor there is no table of windows (the notes of the read say why).
    expect(report?.sections.map((section) => section.title)).toEqual(['The devspace']);
  });

  it('gives a dev container of a devspace that this computer does not know only its labels', () => {
    const object: HostObject = { ...devContainer, purpose: 'otherDevspace', repository: 'majikmate/web-basics' };
    const values = facts(devspaceReport({ object, details: container(CURRENT_LABELS), computer: COMPUTER, clock: CLOCK }), 'The devspace');
    expect(values.Devspace).toEqual({ text: 'majikmate/web-basics', chip: expect.objectContaining({ text: expect.stringContaining('does not know') }) });
    expect(values['Keep Running When Closed']).toBeUndefined();
    expect(values['Build record of this computer']).toBeUndefined();
    // Without its details and its image, no build record of this computer is compared.
    const bare = facts(devspaceReport({ object: devContainer, devspace: ENTRY, computer: COMPUTER, clock: CLOCK }), 'The devspace');
    expect(Object.keys(bare)).toEqual(['Devspace', 'Configuration', 'Keep Running When Closed']);
  });
});

describe('the report of a container of another service', () => {
  const object: HostObject = { kind: 'container', id: 's1', name: 'devspaces-majikmate-shop-brave-otter-db-1', purpose: 'devspace', devspaceId: DEVSPACE, repository: REPOSITORY, role: 'service db' };
  const compose = { service: 'app', images: ['devspaces-majikmate-shop-brave-otter-worker'], serviceImages: ['postgres:16'], version: '2.40.0', inputsHash: 'sha256:1' };

  it('says whether its image was pulled or built for the devspace, and that it follows the devspace', () => {
    const devspace = { ...ENTRY, buildRecord: { ...RECORD, compose } };
    const mounts = [{ type: 'volume', source: 'shop_pgdata', destination: '/var/lib/postgresql/data', readOnly: false }];
    const pulled = facts(devspaceReport({ object, details: container({ 'nimblescape.devspaces.compose-service': 'db' }, { image: 'docker.io/library/postgres:16', mounts }), devspace, computer: COMPUTER, clock: CLOCK }), 'The service');
    expect(pulled.Service).toEqual({ text: 'db' });
    expect(pulled.Image.chip?.text).toBe('an image of the service, pulled and not built: Delete does not remove it');
    expect(pulled.Volumes).toEqual({ text: 'shop_pgdata' });
    expect(pulled['Stop and Delete'].text).toBe('with the devspace');
    const built = facts(devspaceReport({ object, details: container({ 'nimblescape.devspaces.compose-service': 'worker' }, { image: 'devspaces-majikmate-shop-brave-otter-worker' }), devspace, computer: COMPUTER, clock: CLOCK }), 'The service');
    expect(built.Image.chip?.text).toBe('built by Docker Compose for this devspace: Delete removes it');
    expect(built.Volumes).toBeUndefined();
    // Without its details, the role of the view names the service.
    expect(facts(devspaceReport({ object, devspace, computer: COMPUTER, clock: CLOCK }), 'The service').Service).toEqual({ text: 'db' });
  });
});

describe('the report of a workspace volume', () => {
  const object: HostObject = { kind: 'volume', id: 'devspaces-majikmate-shop-brave-otter', name: 'devspaces-majikmate-shop-brave-otter', purpose: 'devspace', devspaceId: DEVSPACE, repository: REPOSITORY, role: 'workspace' };

  it('gives its devspace and the Git record of this computer, with the changes that are not on GitHub', () => {
    const gitSummary = { branch: 'main', uncommittedFiles: 2, unpushedCommits: 1, stashes: 0, recordedAt: '2026-11-12T06:00:00.000Z' };
    const report = devspaceReport({ object, details: volume(), devspace: { ...ENTRY, gitSummary }, computer: COMPUTER, clock: CLOCK });
    expect(facts(report, 'The devspace')).toEqual({
      Devspace: { text: 'majikmate/shop · owner scalarion' },
      Source: { text: '.devcontainer/devcontainer.json' },
      Created: { text: '2026-11-03 09:00' },
      'Last open': { text: 'today 05:40' },
    });
    const git = report?.sections[1];
    expect(git?.title).toBe('Git at the last record');
    expect(git?.chip).toEqual({ text: 'changes that are not on GitHub', tone: 'warn' });
    expect(facts(report, 'Git at the last record')).toEqual({
      Branch: { text: 'main' },
      'Uncommitted files': { text: '2', chip: { text: 'not on GitHub', tone: 'warn' } },
      'Unpushed commits': { text: '1', chip: { text: 'not on GitHub', tone: 'warn' } },
      Stashes: { text: '0' },
      Recorded: { text: 'today 07:00' },
    });
    expect(report?.summary).toEqual([{ text: 'changes that are not on GitHub', tone: 'warn' }]);
  });

  it('says when everything is on GitHub, when no record is there yet, and the source of a default-image devspace', () => {
    const clean = devspaceReport({ object, details: volume(), devspace: { ...ENTRY, gitSummary: { branch: null, uncommittedFiles: 0, unpushedCommits: 0, stashes: 0, recordedAt: '2026-11-12T06:00:00.000Z' } }, computer: COMPUTER, clock: CLOCK });
    expect(clean?.sections[1].chip).toEqual({ text: 'nothing that is not on GitHub', tone: 'keep' });
    expect(facts(clean, 'Git at the last record').Branch).toEqual({ text: 'not known, or a detached HEAD' });
    expect(clean?.summary).toEqual([]);
    const none = devspaceReport({ object, details: volume(), devspace: { ...ENTRY, defaultImage: 'mcr.microsoft.com/devcontainers/base:ubuntu' }, computer: COMPUTER, clock: CLOCK });
    expect(facts(none, 'Git at the last record').Changes.text).toContain('no record of the Git state yet');
    expect(facts(none, 'The devspace').Source).toEqual({ text: 'the default image mcr.microsoft.com/devcontainers/base:ubuntu' });
  });

  it('gives a volume of a devspace that this computer does not know its labels, and warns that its Git state is not known', () => {
    const labels = { 'nimblescape.devspaces.owner-id': '58122930', 'nimblescape.devspaces.default-image': 'node:24' };
    const report = devspaceReport({ object: { ...object, purpose: 'otherDevspace', repository: 'majikmate/web-basics' }, details: volume(labels), computer: COMPUTER, clock: CLOCK });
    expect(facts(report, 'The devspace')).toMatchObject({ Source: { text: 'the default image node:24' }, Owner: { text: 'GitHub user 58122930' } });
    expect(facts(report, 'Git').Changes).toEqual({ text: 'not known on this computer', chip: { text: 'Remove… in this view deletes the changes that were not pushed', tone: 'warn' } });
  });
});

describe('the report of another volume of a devspace', () => {
  const object = (name: string, role: string): HostObject => ({ kind: 'volume', id: name, name, purpose: 'devspace', devspaceId: DEVSPACE, repository: REPOSITORY, role });
  // `devspace` null: a devspace that this computer does not know.
  const atDelete = (name: string, role: string, labels: Record<string, string> = {}, devspace: ReportDevspace | null = ENTRY): ReportFact['value'] =>
    facts(devspaceReport({ object: object(name, role), details: volume(labels), ...(devspace !== null ? { devspace } : {}), computer: COMPUTER, clock: CLOCK }), 'The volume')['At Delete…'];

  it('gives the rule of Delete for each kind', () => {
    expect(atDelete('shop_pgdata', 'data of a service', { 'nimblescape.devspaces.service-data': 'true' })).toEqual({ text: 'listed in the question "Remove the data of the services too?", not ticked', chip: { text: 'kept unless you tick it', tone: 'keep' } });
    // A volume that the open recorded as mounted by another service is data of a service, whatever its labels.
    expect(atDelete('shop_pgdata', 'additional volume').chip?.text).toBe('kept unless you tick it');
    expect(atDelete('shop_cache', 'additional volume').text).toBe('Delete… asks "Remove them too?" with Remove and Keep');
    expect(atDelete('shop_other', 'volume of Docker Compose').text).toContain('kept: the registry of this computer does not list it');
    expect(atDelete('shop_pgdata', 'data of a service', {}, null).chip).toEqual({ text: 'Remove… in this view deletes its data', tone: 'warn' });
  });
});

describe('the report of a network of a devspace', () => {
  it('says that Delete removes the network of its Docker Compose project', () => {
    const name = `${composeProjectName(REPOSITORY, DEVSPACE)}_default`;
    const object: HostObject = { kind: 'network', id: 'n1', name, purpose: 'devspace', devspaceId: DEVSPACE, repository: REPOSITORY, role: 'network' };
    const details = (project: string): NetworkDetails => ({ kind: 'network', labels: new Map([['com.docker.compose.project', project]]), internal: false, subnets: [], containers: [] });
    expect(facts(devspaceReport({ object, details: details(composeProjectName(REPOSITORY, DEVSPACE)), devspace: ENTRY, computer: COMPUTER, clock: CLOCK }), 'The network')['At Delete…'].text).toBe('removed with the containers of the Docker Compose project of the devspace');
    expect(facts(devspaceReport({ object, details: details('shop'), devspace: ENTRY, computer: COMPUTER, clock: CLOCK }), 'The network')['At Delete…']).toBeUndefined();
  });
});

describe('the report of an object of a devspace in the report of a resource', () => {
  it('reads the volume of the Monitor for a dev container, puts its part before the facts of Docker, and takes the entry of this computer', () => {
    expect(reportVolumes(devContainer)).toEqual({ monitor: 'devspaces-monitor' });
    expect(reportVolumes({ ...devContainer, purpose: 'otherDevspace' })).toEqual({ monitor: 'devspaces-monitor' });
    expect(reportVolumes({ ...devContainer, role: 'service db' })).toEqual({});
    expect(reportVolumes({ kind: 'volume', name: 'devspaces-majikmate-shop-brave-otter', purpose: 'devspace', role: 'workspace' })).toEqual({});
    const report = resourceReport({ object: devContainer, details: container(CURRENT_LABELS), volumes: { kind: 'noVolume' }, computer: COMPUTER, clock: CLOCK });
    expect(report.sections.map((section) => section.title)).toEqual(['The devspace', 'Facts of Docker']);
    expect(facts(report, 'The devspace').Devspace).toEqual({ text: 'majikmate/shop · owner scalarion' });
    expect(report.notices).toEqual(['The volume devspaces-monitor is not there: the records of the Monitor are missing from this report.']);
    expect(resourceReport({ object: devContainer, volumes: { kind: 'failed', detail: 'boom' }, computer: COMPUTER, clock: CLOCK }).notices).toEqual(['The records of the Monitor in devspaces-monitor could not be read: boom']);
  });
});
