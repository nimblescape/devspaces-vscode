// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reports of the images of Devspaces in the view Docker Hosts (docs/requirements.md R-ENG-010): a devspace image
// with its build and what it was built from against the registry, a prepared image against the build, a base image with
// its version, the devspaces built on it and its older versions, the helper image, the base image of the helper image,
// and the build image; and the reports of the helper containers.
import { describe, expect, it } from 'vitest';
import { BUILDX_PIN, buildxImageTag } from '../docker/buildxImage';
import { resourceName } from '../names';
import { registryReferenceKey } from '../remoteMonitor/registryAnswers';
import type { BuildRecord } from '../types';
import { helperReport } from './helperReport';
import type { HostObject } from './hostObjects';
import { imageReport, imageReportNeedsRecords, isImageReportObject } from './imageReport';
import { monitorRecords } from './monitorRecords';
import type { ReportComputer, ReportDevspace } from './monitorReport';
import type { ContainerDetails, ImageDetails } from './objectDetails';
import type { ReportBody, ReportContent, ReportFact } from './reportModel';
import { CLOCK, DAY, DEVSPACE, HELPER, HOUR, NOW, OTHER_DEVSPACE, SOURCE, monitorFile } from './reportFixtures.testkit';
import { reportVolumes, resourceReport } from './resourceReport';

const REPOSITORY = 'majikmate/module-ts';
const NAME = resourceName(REPOSITORY, DEVSPACE);
const BASE = 'ghcr.io/majikmate/devcontainer-classroom-web:latest';
const OLD = `sha256:${'1'.repeat(64)}`;
const NEW = `sha256:${'3'.repeat(64)}`;
const FEATURE = `sha256:${'a'.repeat(64)}`;
const RECORD: BuildRecord = {
  builtAt: '2026-11-10T13:22:00.000Z',
  devspaceImage: `${NAME}:2`,
  buildNumber: 2,
  configPath: '.devcontainer/devcontainer.json',
  configHash: `sha256:${'9'.repeat(64)}`,
  images: { [BASE]: OLD, 'postgres:16@sha256:77c1e9': `sha256:${'7'.repeat(64)}` },
  features: { 'ghcr.io/devcontainers/features/github-cli:1': FEATURE },
};
const ENTRY: ReportDevspace = { id: DEVSPACE, repository: REPOSITORY, volumeName: NAME, configPath: '.devcontainer/devcontainer.json', createdAt: '2026-11-03T08:00:00.000Z', lastUsedAt: '2026-11-12T04:40:00.000Z', owner: { id: '1', login: 'scalarion' }, buildRecord: RECORD };
const COMPUTER: ReportComputer = { id: SOURCE, repositories: new Map([[DEVSPACE, REPOSITORY]]), devspaces: new Map([[DEVSPACE, ENTRY]]), version: '0.4.2' };
const RECORDS = monitorRecords({
  cut: false,
  textsDropped: false,
  files: [
    monitorFile('registry-digests.json', { digests: { [registryReferenceKey(BASE)!]: { digest: NEW, at: NOW - 2 * HOUR } } }),
    monitorFile('helper-image.json', { tag: HELPER, baseImage: 'node:24-trixie-slim', baseDigest: OLD, checkedAt: new Date(NOW - 3 * HOUR).toISOString(), builtAt: new Date(NOW - 4 * DAY).toISOString() }),
    monitorFile('replaced-images.json', { 'ghcr.io/majikmate/devcontainer-classroom-web': [OLD, NEW] }),
    monitorFile('pulled-over-images.json', { 'ghcr.io/majikmate/devcontainer-classroom-web': [OLD] }),
  ],
});

function image(labels: Record<string, string> = {}, extra: Partial<ImageDetails> = {}): ImageDetails {
  return { kind: 'image', labels: new Map(Object.entries(labels)), repoDigests: [], ...extra };
}

function facts(report: ReportContent | undefined, title: string): Record<string, ReportFact['value']> {
  const section = report?.sections.find((entry) => entry.title === title);
  if (section?.body.kind !== 'facts') throw new Error(`no facts section ${title}`);
  return Object.fromEntries(section.body.facts.map((entry) => [entry.label, entry.value]));
}

function rows(report: ReportContent | undefined, title: string): string[][] {
  const body: ReportBody | undefined = report?.sections.find((entry) => entry.title === title)?.body;
  if (body?.kind !== 'table') throw new Error(`no table ${title}`);
  return body.rows.map((row) => row.map((value) => [value.text, value.chip?.text].filter((part) => part !== undefined && part !== '').join(' | ')));
}

const devspaceImage: HostObject = { kind: 'image', id: 'sha256:i2', name: `${NAME}:2`, tags: [`${NAME}:2`], purpose: 'devspace', devspaceId: DEVSPACE, repository: REPOSITORY, role: 'image' };

describe('which images have a report part, and which read the records of the Monitor', () => {
  it('takes the images of Devspaces, not the images of others', () => {
    expect(isImageReportObject(devspaceImage)).toBe(true);
    expect(isImageReportObject({ kind: 'image', purpose: 'otherDevspace', role: 'prepared image' })).toBe(true);
    expect(isImageReportObject({ kind: 'image', purpose: 'notDevspaces' })).toBe(false);
    expect(isImageReportObject({ kind: 'image', purpose: 'other' })).toBe(false);
    expect(isImageReportObject({ kind: 'container', purpose: 'devspace', role: 'image' })).toBe(false);
    expect(reportVolumes(devspaceImage)).toEqual({ monitor: 'devspaces-monitor' });
    expect(reportVolumes({ kind: 'image', name: BASE, purpose: 'baseImage' })).toEqual({ monitor: 'devspaces-monitor' });
    expect(reportVolumes({ kind: 'image', name: HELPER, purpose: 'helperImage' })).toEqual({ monitor: 'devspaces-monitor' });
    for (const object of [
      { kind: 'image', purpose: 'devspace', role: 'prepared image' },
      { kind: 'image', purpose: 'buildImage' },
      { kind: 'image', purpose: 'helperBaseImage' },
      { kind: 'image', purpose: 'notDevspaces' },
    ] as const) {
      expect(imageReportNeedsRecords(object)).toBe(false);
    }
  });
});

describe('the report of a devspace image', () => {
  it('gives its build, and each image and Feature that it was built from against the registry now', () => {
    const report = imageReport({ object: devspaceImage, details: image({ 'nimblescape.devspaces.build-record': JSON.stringify(RECORD) }), devspace: ENTRY, records: RECORDS, computer: COMPUTER, clock: CLOCK });
    expect(facts(report, 'The build')).toEqual({
      Devspace: { text: 'majikmate/module-ts · owner scalarion' },
      Build: { text: 'build 2 of 2026-11-10 14:22', chip: { text: 'the current image of the devspace', tone: 'keep' } },
      Configuration: { text: '.devcontainer/devcontainer.json · hash sha256:999999999999…' },
    });
    expect(rows(report, 'Built from')).toEqual([
      [BASE, 'image', 'sha256:111111111111…', 'sha256:333333333333… · asked today 07:00', 'newer in the registry'],
      ['postgres:16@sha256:77c1e9', 'image', 'sha256:777777777777…', '', 'pinned by a digest: it does not change'],
      ['ghcr.io/devcontainers/features/github-cli:1', 'Feature', 'sha256:aaaaaaaaaaaa…', '', 'the Monitor does not ask for Features: the next Start checks them'],
    ]);
    expect(report?.summary).toEqual([{ text: '1 image newer in the registry', tone: 'remove' }]);
  });

  it('says up to date, an earlier build, a shared image, and an image without a build record', () => {
    const upToDate = monitorRecords({ cut: false, textsDropped: false, files: [monitorFile('registry-digests.json', { digests: { [registryReferenceKey(BASE)!]: { digest: OLD, at: NOW - HOUR } } })] });
    const report = imageReport({ object: devspaceImage, details: image(), devspace: ENTRY, records: upToDate, computer: COMPUTER, clock: CLOCK });
    expect(rows(report, 'Built from')[0].at(-1)).toBe('up to date');
    expect(report?.summary).toEqual([]);
    // Build 1 on a devspace whose current image is build 2.
    const earlier = { ...RECORD, devspaceImage: `${NAME}:1`, buildNumber: 1 };
    const old = imageReport({ object: { ...devspaceImage, name: `${NAME}:1`, tags: [`${NAME}:1`] }, details: image({ 'nimblescape.devspaces.build-record': JSON.stringify(earlier) }), devspace: ENTRY, computer: COMPUTER, clock: CLOCK });
    expect(facts(old, 'The build').Build.chip).toEqual({ text: 'an earlier build: the current one is build 2; the next update and Delete… remove the earlier builds', tone: 'remove' });
    // Without the records of the Monitor, the registry is not known.
    expect(rows(old, 'Built from')[0].at(-1)).toBe('not known: the records of the Monitor were not read');
    // A shared image has only its key: the build record of this computer names one of its tags.
    const key = `sha256:${'b'.repeat(64)}`;
    const shared = imageReport({ object: { ...devspaceImage, tags: [`${NAME}:2`, `${resourceName('majikmate/shop', OTHER_DEVSPACE)}:4`] }, details: image({ 'nimblescape.devspaces.image-key': key }), devspace: ENTRY, computer: COMPUTER, clock: CLOCK });
    expect(facts(shared, 'The build')['Shared image']).toEqual({ text: 'image key sha256:bbbbbbbbbbbb… · tags of 2 devspaces', chip: { text: 'a devspace that moves to another image removes only its own tag', tone: 'info' } });
    expect(facts(shared, 'The build').Build.text).toBe('build 2 of 2026-11-10 14:22');
    const unknown = imageReport({ object: { ...devspaceImage, purpose: 'otherDevspace' }, details: image(), computer: COMPUTER, clock: CLOCK });
    expect(facts(unknown, 'The build').Build).toEqual({ text: 'not known: no build record names a tag of this image' });
    expect(unknown?.sections.map((section) => section.title)).toEqual(['The build']);
  });
});

describe('the report of a prepared image', () => {
  const object: HostObject = { ...devspaceImage, name: `${NAME}:prepared`, tags: [`${NAME}:prepared`], role: 'prepared image', createdAt: '2026-11-12T05:15:00Z' };

  it('gives its prepare, the rules of the start and of the removal, and the changes against the build', () => {
    const label = { key: { configPath: RECORD.configPath, configHash: RECORD.configHash, images: { [BASE]: NEW, 'postgres:16@sha256:77c1e9': RECORD.images['postgres:16@sha256:77c1e9'] }, features: RECORD.features }, helperImage: `sha256:${'5'.repeat(64)}` };
    const report = imageReport({ object, details: image({ 'nimblescape.devspaces.prepared': JSON.stringify(label) }, { createdAt: '2026-11-12T05:15:00Z' }), devspace: ENTRY, computer: COMPUTER, clock: CLOCK });
    expect(facts(report, 'The prepare')).toMatchObject({
      Prepared: { text: 'today 06:15' },
      'Built by the helper image': { text: 'sha256:555555555555…' },
      'Next Start': { chip: { text: 'rule of the start', tone: 'info' } },
      Removed: { text: expect.stringContaining('when its devspace has no workspace volume on this engine') },
    });
    expect(rows(report, 'Changes against build 2')).toEqual([
      ['Configuration', '.devcontainer/devcontainer.json · sha256:999999999999…', 'no change'],
      [`${BASE} (image)`, 'sha256:111111111111…', 'sha256:333333333333… | changed'],
      ['postgres:16@sha256:77c1e9 (image)', 'sha256:777777777777…', 'no change'],
      ['ghcr.io/devcontainers/features/github-cli:1 (Feature)', 'sha256:aaaaaaaaaaaa…', 'no change'],
    ]);
  });

  it('says when the image has no valid prepare label', () => {
    const report = imageReport({ object, details: image({ 'nimblescape.devspaces.prepared': '' }), devspace: ENTRY, computer: COMPUTER, clock: CLOCK });
    expect(facts(report, 'The prepare').Prepare).toEqual({ text: 'not known: the image has no valid prepare label' });
    expect(report?.sections.map((section) => section.title)).toEqual(['The prepare']);
  });
});

describe('the report of a base image', () => {
  const object: HostObject = { kind: 'image', id: NEW, name: BASE, tags: [BASE], purpose: 'baseImage' };

  it('gives its version against the registry, the devspaces built on it, and its older versions', () => {
    const report = imageReport({ object, details: image({}, { repoDigests: [`ghcr.io/majikmate/devcontainer-classroom-web@${NEW}`] }), records: RECORDS, computer: COMPUTER, clock: CLOCK });
    expect(rows(report, 'This version')).toEqual([[BASE, 'sha256:333333333333…', 'sha256:333333333333… · asked today 07:00', 'up to date']]);
    expect(rows(report, 'Devspaces that use it')).toEqual([['majikmate/module-ts', '2', 'sha256:111111111111…', 'built on another version']]);
    expect(rows(report, 'Older versions that pulls replaced')).toEqual([['ghcr.io/majikmate/devcontainer-classroom-web', 'sha256:111111111111…', 'replaced by a pull of the Monitor']]);
    expect(report?.summary).toEqual([]);
    const older = imageReport({ object: { ...object, id: OLD }, details: image({}, { repoDigests: [`ghcr.io/majikmate/devcontainer-classroom-web@${OLD}`] }), records: RECORDS, computer: COMPUTER, clock: CLOCK });
    expect(rows(older, 'This version')[0].at(-1)).toBe('newer in the registry');
    expect(rows(older, 'Devspaces that use it')[0].at(-1)).toBe('built on this version');
    expect(older?.summary).toEqual([{ text: 'newer in the registry', tone: 'remove' }]);
    // Two tags that are both newer in the registry give one chip in the summary.
    const LATEST = 'ghcr.io/majikmate/devcontainer-classroom-web:latest';
    const twoTags = monitorRecords({
      cut: false,
      textsDropped: false,
      files: [monitorFile('registry-digests.json', { digests: { [registryReferenceKey(BASE)!]: { digest: NEW, at: NOW }, [registryReferenceKey(LATEST)!]: { digest: NEW, at: NOW } } })],
    });
    const both = imageReport({ object: { ...object, id: OLD, tags: [BASE, LATEST] }, details: image({}, { repoDigests: [`ghcr.io/majikmate/devcontainer-classroom-web@${OLD}`] }), records: twoTags, computer: COMPUTER, clock: CLOCK });
    expect(rows(both, 'This version').map((row) => row.at(-1))).toEqual(['newer in the registry', 'newer in the registry']);
    expect(both?.summary).toEqual([{ text: 'newer in the registry', tone: 'remove' }]);
    // Without the records: no older versions, and the registry is not known.
    const bare = imageReport({ object, details: image(), computer: COMPUTER, clock: CLOCK });
    expect(bare?.sections.map((section) => section.title)).toEqual(['This version', 'Devspaces that use it']);
  });
});

describe('the reports of the helper image, its base image, and the build image', () => {
  it('gives the version of Devspaces of the helper image and the last check of the Monitor', () => {
    const object: HostObject = { kind: 'image', id: 'sha256:h', name: HELPER, tags: [HELPER, 'devspaces-monitor:0123456789ab'], purpose: 'helperImage' };
    const report = imageReport({ object, details: image({ 'nimblescape.devspaces.worker-base-digest': OLD }), records: RECORDS, computer: COMPUTER, currentHelperTag: HELPER, clock: CLOCK });
    expect(facts(report, 'The helper image')).toMatchObject({
      For: { text: 'this version of Devspaces', chip: { text: 'in use', tone: 'keep' } },
      'Base image': { text: 'node:24-trixie-slim · sha256:111111111111…' },
      'Last check by the Monitor': { text: 'today 06:00' },
      'Last build by the Monitor': { text: '2026-11-08 09:00' },
    });
    const other = imageReport({ object: { ...object, tags: ['devspaces-worker:ffffffffffff'] }, details: image(), records: RECORDS, computer: COMPUTER, currentHelperTag: HELPER, clock: CLOCK });
    expect(facts(other, 'The helper image').For.text).toContain('another version of Devspaces');
    expect(facts(other, 'The helper image')['Last check by the Monitor']).toBeUndefined();
    const earlier = imageReport({ object: { ...object, tags: [] }, details: image(), computer: COMPUTER, currentHelperTag: HELPER, clock: CLOCK });
    expect(facts(earlier, 'The helper image').Build.chip?.tone).toBe('remove');
  });

  it('gives the rule of the base image of the helper image and the pin of the build image', () => {
    expect(facts(imageReport({ object: { kind: 'image', id: 'sha256:n', name: 'node:24-trixie-slim', tags: ['node:24-trixie-slim'], purpose: 'helperBaseImage' }, computer: COMPUTER, clock: CLOCK }), 'The base image of the helper image').Removed.chip?.text).toBe('rule of the Monitor');
    const build = (tag: string): ReportFact['value'] | undefined => {
      const values = facts(imageReport({ object: { kind: 'image', id: 'sha256:b', name: tag, tags: [tag], purpose: 'buildImage' }, computer: COMPUTER, clock: CLOCK }), 'The build image');
      return values.Pin ?? values.Version;
    };
    expect(build(buildxImageTag())).toEqual({ text: `docker/buildx-bin ${BUILDX_PIN.version} · sha256:${BUILDX_PIN.digest.slice(7, 19)}…`, chip: { text: 'the pin of this version of Devspaces', tone: 'keep' } });
    expect(build('devspaces-buildx:0.1.0')).toEqual({ text: '0.1.0', chip: { text: `not the pin of this version of Devspaces (${BUILDX_PIN.version})`, tone: 'info' } });
  });
});

describe('the reports of the helper containers', () => {
  const container = (extra: Partial<ContainerDetails> = {}): ContainerDetails => ({ kind: 'container', labels: new Map(), image: HELPER, env: new Map(), mounts: [], ports: [], networks: [], ...extra });

  it('names the window of a worker, the volumes of a batch helper, and when each ends', () => {
    const worker = (name: string) => facts(helperReport({ object: { kind: 'container', id: 'w', name, purpose: 'worker' }, details: container(), computer: COMPUTER, currentHelperTag: HELPER }), 'The worker');
    expect(worker(`${NAME}-worker1`)).toMatchObject({ Serves: { text: 'the window of the devspace majikmate/module-ts' }, Image: { text: HELPER, chip: { tone: 'keep' } } });
    expect(worker(`${resourceName('majikmate/web-basics', OTHER_DEVSPACE)}-worker2`).Serves.text).toBe('the window of a devspace that this computer does not know');
    expect(worker('devspaces-api-worker1').Serves.text).toBe('a window of VS Code that is not connected to a devspace');
    // The worker of a child row starts with the name of its workspace volume, with the part of its source.
    const child = resourceName(REPOSITORY, DEVSPACE, 'config');
    const childComputer: ReportComputer = { ...COMPUTER, devspaces: new Map([[DEVSPACE, { ...ENTRY, volumeName: child }]]) };
    const serves = helperReport({ object: { kind: 'container', id: 'w', name: `${child}-worker1`, purpose: 'worker' }, computer: childComputer });
    expect(facts(serves, 'The worker').Serves.text).toBe('the window of the devspace majikmate/module-ts');
    const batch = facts(
      helperReport({ object: { kind: 'container', id: 'b', name: 'devspaces-batch-3f0c2a91', purpose: 'batchHelper' }, details: container({ image: 'devspaces-worker:ffffffffffff', mounts: [{ type: 'volume', source: NAME, destination: '/workspaces', readOnly: false }] }), computer: COMPUTER, currentHelperTag: HELPER }),
      'The batch helper',
    );
    expect(batch).toMatchObject({ 'Volumes of its step': { text: NAME }, Image: { text: 'devspaces-worker:ffffffffffff' } });
    expect(batch.Image.chip).toBeUndefined();
    expect(facts(helperReport({ object: { kind: 'container', id: 'c', name: 'devspaces-build-0123456789abcdef', purpose: 'buildContainer' }, computer: COMPUTER }), 'The build container').Ends.text).toBe('removed at the end of its build');
    expect(helperReport({ object: { kind: 'container', id: 'm', name: 'devspaces-monitor', purpose: 'monitor' }, computer: COMPUTER })).toBeUndefined();
  });

  it('puts the part of a helper container and of an image before the facts of Docker', () => {
    const titles = (object: HostObject): string[] => resourceReport({ object, computer: COMPUTER, currentHelperTag: HELPER, clock: CLOCK }).sections.map((section) => section.title);
    expect(titles({ kind: 'container', id: 'w', name: `${NAME}-worker1`, purpose: 'worker' })).toEqual(['The worker', 'Facts of Docker']);
    expect(titles({ kind: 'image', id: 'sha256:b', name: buildxImageTag(), tags: [buildxImageTag()], purpose: 'buildImage' })).toEqual(['The build image', 'Facts of Docker']);
    expect(titles(devspaceImage)).toEqual(['The build', 'Built from', 'Facts of Docker']);
  });
});
