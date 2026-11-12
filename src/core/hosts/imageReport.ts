// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reports of the images of Devspaces in the view Docker Hosts (docs/requirements.md R-ENG-010): a devspace image
// (its build and what it was built from, against the answers of the registries to the Monitor), a prepared image (its
// prepare against the build of the devspace), a base image of a devspace (its version against the registry, the
// devspaces of this computer that are built on it, and the older versions that pulls replaced), the helper image (for
// which version of Devspaces, its base image and the last check of the Monitor), the base image of the helper image,
// and the build image. The values come from the labels of the image, its facts of Docker, the registry of this
// computer and the records of the Monitor. Before the facts of Docker (resourceReport.ts). Pure; no I/O.
import { BUILDX_PIN, BUILDX_REPOSITORY, buildxImageTag } from '../docker/buildxImage';
import { LABEL_HELPER_BASE_DIGEST, LABEL_IMAGE_KEY, LABEL_PREPARED, isImageKey, isSharedImageTag } from '../names';
import { preparedImageLabel } from '../pipeline/imageRecord';
import { registryReferenceKey, type RegistryAnswer } from '../remoteMonitor/registryAnswers';
import type { BuildRecord } from '../types';
import { buildText, devspaceFact, label, labelBuildRecord, labelsOf } from './devspaceReport';
import { isEarlierHelperBuild, normalizedReference, type HostObject } from './hostObjects';
import type { MonitorRecords } from './monitorRecords';
import type { ReportComputer, ReportDevspace } from './monitorReport';
import type { ObjectDetails } from './objectDetails';
import { cell, chip, countText, dockerTimeText, fact, itemsText, shortDigest, timeText, type ReportCell, type ReportChip, type ReportClock, type ReportContent, type ReportFact, type ReportSection } from './reportModel';

export interface ImageReportInput {
  object: HostObject;
  details?: ObjectDetails;
  /** The entry of the devspace of a devspace image in the registry of this computer. */
  devspace?: ReportDevspace;
  /** The records of the Monitor (the answers of the registries, the check of the helper image, the older versions). */
  records?: MonitorRecords;
  computer: ReportComputer;
  /** The helper tag of this version of Devspaces (helperImageTag), when it is known. */
  currentHelperTag?: string;
  clock: ReportClock;
}

/** Whether the report of `object` has a part of this module (imageReport gives it). */
export function isImageReportObject(object: Pick<HostObject, 'kind' | 'purpose' | 'role'>): boolean {
  if (object.kind !== 'image') return false;
  if (object.purpose === 'devspace' || object.purpose === 'otherDevspace') return object.role === 'image' || object.role === 'prepared image';
  return object.purpose === 'baseImage' || object.purpose === 'helperImage' || object.purpose === 'helperBaseImage' || object.purpose === 'buildImage';
}

/** Whether the report of the image `object` needs the records of the Monitor (resourceReport.ts, reportVolumes). */
export function imageReportNeedsRecords(object: Pick<HostObject, 'kind' | 'purpose' | 'role'>): boolean {
  return isImageReportObject(object) && object.role !== 'prepared image' && object.purpose !== 'helperBaseImage' && object.purpose !== 'buildImage';
}

/** A digest in short: `sha256:1b7e40…`. */
function digestText(digest: string): string {
  return `sha256:${shortDigest(digest)}…`;
}

/** The answer of the registry to the Monitor for the image reference `reference`, when the records have one. */
function registryAnswer(records: MonitorRecords | undefined, reference: string): RegistryAnswer | undefined {
  const key = registryReferenceKey(reference);
  const digests = records?.registry?.digests;
  return key !== undefined && digests !== undefined && Object.hasOwn(digests, key) ? digests[key] : undefined;
}

/** The answer of the registry in words: `sha256:3f9a1c… · asked today 06:08`. */
function answerText(answer: RegistryAnswer | undefined, clock: ReportClock): string {
  return answer !== undefined ? `${digestText(answer.digest)} · asked ${timeText(answer.at, clock)}` : '';
}

/** The repository of an image reference, as normalizedReference names it (without its tag and its digest). */
function repositoryOf(reference: string): string {
  const normalized = normalizedReference(reference);
  return normalized.slice(0, normalized.lastIndexOf(':'));
}

/** The repository of a tag as the engine lists it (`node`, `ghcr.io/owner/image`, `host:5000/image`): without its tag. */
function tagRepository(tag: string): string {
  const colon = tag.lastIndexOf(':');
  return colon > tag.lastIndexOf('/') ? tag.slice(0, colon) : tag;
}

/** The digest that the image has for the repository of `reference` (from its RepoDigests), when it has one. */
function localDigest(details: ObjectDetails | undefined, reference: string): string | undefined {
  if (details?.kind !== 'image') return undefined;
  const repository = repositoryOf(reference);
  const entry = details.repoDigests.find((digest) => digest.includes('@') && repositoryOf(digest) === repository);
  return entry?.slice(entry.indexOf('@') + 1);
}

/** Two digests are the same (the case of hex digits aside). */
function sameDigest(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** The rule of the registry for an image of a build record: up to date, newer in the registry, or not asked. */
function registryRule(reference: string, built: string, records: MonitorRecords | undefined): ReportChip {
  if (registryReferenceKey(reference) === undefined) return chip('pinned by a digest: it does not change', 'info');
  if (records === undefined) return chip('not known: the records of the Monitor were not read', 'info');
  const answer = registryAnswer(records, reference);
  if (answer === undefined) return chip('no answer of the registry to the Monitor: a private image, or no window sent it', 'info');
  return sameDigest(answer.digest, built) ? chip('up to date', 'keep') : chip('newer in the registry', 'remove');
}

/** The section "Built from": the images and the Features of a build record, each against the registry now. */
function builtFromSection(record: BuildRecord, records: MonitorRecords | undefined, clock: ReportClock): { section: ReportSection; newer: number } {
  const services = new Set(record.compose?.serviceImages ?? []);
  let newer = 0;
  const rows: ReportCell[][] = Object.entries(record.images)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reference, digest]) => {
      const rule = registryRule(reference, digest, records);
      if (rule.tone === 'remove') newer++;
      return [cell(reference), cell(services.has(reference) ? 'image of a service' : 'image'), cell(digestText(digest)), cell(answerText(registryAnswer(records, reference), clock)), cell('', rule)];
    });
  for (const [reference, digest] of Object.entries(record.features).sort(([a], [b]) => a.localeCompare(b))) {
    rows.push([cell(reference), cell('Feature'), cell(digestText(digest)), cell(''), cell('', chip('the Monitor does not ask for Features: the next Start checks them', 'info'))]);
  }
  return {
    newer,
    section: {
      title: 'Built from',
      body: { kind: 'table', columns: ['Reference', 'Kind', 'Digest at the build', 'Registry now', 'Rule'], rows, empty: 'The build record names no image and no Feature.' },
      from: 'From the build record (the digests that the registries gave right before the build) and registry-digests.json in devspaces-monitor (the answers of the registries to the Monitor for the images that the computers sent).',
    },
  };
}

/** The devspace tags of an image (`<devspace>:<build number>` and `<devspace>:prepared`), by their devspace. */
function devspaceNames(tags: readonly string[]): Set<string> {
  return new Set(tags.filter(isSharedImageTag).map((tag) => tag.slice(0, tag.lastIndexOf(':'))));
}

/** The fact of a shared image (R-DS-010): its image key and the devspaces that have a tag on it. */
function sharedFact(labels: ReadonlyMap<string, string>, tags: readonly string[]): ReportFact | undefined {
  const key = label(labels, LABEL_IMAGE_KEY);
  if (key === undefined || !isImageKey(key)) return undefined;
  return fact('Shared image', `image key ${digestText(key)} · tags of ${countText(devspaceNames(tags).size, 'devspace')}`, chip('a devspace that moves to another image removes only its own tag', 'info'));
}

/** The report of a devspace image. */
function devspaceImageReport(input: ImageReportInput): ReportContent {
  const { object, details, devspace, records, clock } = input;
  const tags = object.tags ?? [];
  const labels = labelsOf(details);
  // The record of this computer when its image is a tag of this one, else the record of the label (a shared image has none).
  const recorded = devspace?.buildRecord;
  const current = recorded !== undefined && tags.includes(recorded.devspaceImage);
  const fromLabel = labelBuildRecord(labels);
  const record = current ? recorded : fromLabel !== undefined && tags.includes(fromLabel.devspaceImage) ? fromLabel : undefined;
  const facts: ReportFact[] = [devspaceFact(object, devspace)];
  const summary: ReportChip[] = [];
  if (record !== undefined) {
    facts.push(
      fact(
        'Build',
        buildText(record, clock),
        current ? chip('the current image of the devspace', 'keep') : recorded !== undefined ? chip(`an earlier build: the current one is build ${recorded.buildNumber}; the next update and Delete… remove the earlier builds`, 'remove') : undefined,
      ),
    );
    facts.push(fact('Configuration', record.defaultImage !== undefined ? `the default image ${record.defaultImage}` : `${record.configPath} · hash ${digestText(record.configHash)}`));
    if (record.compose !== undefined) facts.push(fact('Docker Compose', `the image of the dev service ${record.compose.service}`));
  } else {
    facts.push(fact('Build', 'not known: no build record names a tag of this image'));
  }
  const shared = sharedFact(labels, tags);
  if (shared !== undefined) facts.push(shared);
  const sections: ReportSection[] = [
    { title: 'The build', body: { kind: 'facts', facts }, from: 'From the label build-record of the image (a shared image has none: the build record of this computer) and the registry of this computer.' },
  ];
  if (record !== undefined) {
    const built = builtFromSection(record, records, clock);
    sections.push(built.section);
    if (built.newer > 0) summary.push(chip(`${countText(built.newer, 'image')} newer in the registry`, 'remove'));
  }
  return { summary, sections, notices: [], monitorLog: false };
}

/** The report of a prepared image: its prepare, and what changed against the build of the devspace. */
function preparedImageReport(input: ImageReportInput): ReportContent {
  const { object, details, devspace, clock } = input;
  const tags = object.tags ?? [];
  const labels = labelsOf(details);
  const prepared = preparedImageLabel(labels.get(LABEL_PREPARED));
  const facts: ReportFact[] = [devspaceFact(object, devspace)];
  const created = dockerTimeText(details?.createdAt ?? object.createdAt, clock);
  if (prepared !== undefined) {
    facts.push(fact('Prepared', created ?? 'not known'));
    facts.push(fact('Built by the helper image', digestText(prepared.helperImage)));
    facts.push(fact('Configuration', `${prepared.key.configPath} · hash ${digestText(prepared.key.configHash)}`));
  }
  const shared = sharedFact(labels, tags);
  if (shared !== undefined) facts.push(shared);
  if (prepared === undefined && shared === undefined) facts.push(fact('Prepare', 'not known: the image has no valid prepare label'));
  facts.push(fact('Next Start', 'takes it over when the configuration, the digests and the helper image still fit; else it builds', chip('rule of the start', 'info')));
  facts.push(fact('Removed', 'by the next update and by Delete…, and by the Monitor when its devspace has no workspace volume on this engine', chip('rule of Devspaces', 'info')));
  const sections: ReportSection[] = [{ title: 'The prepare', body: { kind: 'facts', facts }, from: 'From the label prepared and the creation time of the image. The Monitor prepares the next image of a devspace in its background run.' }];
  const build = devspace?.buildRecord;
  if (prepared !== undefined && build !== undefined) {
    const rows: ReportCell[][] = [];
    const compare = (kind: string, before: Record<string, string>, after: Record<string, string>): void => {
      for (const reference of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
        const old = Object.hasOwn(before, reference) ? before[reference] : undefined;
        const next = Object.hasOwn(after, reference) ? after[reference] : undefined;
        const text = next === undefined ? 'not in it' : sameDigest(old, next) ? 'no change' : digestText(next);
        rows.push([cell(`${reference} (${kind})`), cell(old !== undefined ? digestText(old) : 'not in it'), cell(text, text === 'no change' ? undefined : chip('changed', 'new'))]);
      }
    };
    rows.push([
      cell('Configuration'),
      cell(`${build.configPath} · ${digestText(build.configHash)}`),
      build.configPath === prepared.key.configPath && sameDigest(build.configHash, prepared.key.configHash) ? cell('no change') : cell(`${prepared.key.configPath} · ${digestText(prepared.key.configHash)}`, chip('changed', 'new')),
    ]);
    compare('image', build.images, prepared.key.images);
    compare('Feature', build.features, prepared.key.features);
    sections.push({
      title: `Changes against build ${build.buildNumber}`,
      body: { kind: 'table', columns: ['Input', `Build ${build.buildNumber}`, 'Prepared'], rows },
      from: `From the label prepared (its configuration and digests) against the build record of build ${build.buildNumber} of this computer.`,
    });
  }
  return { summary: [], sections, notices: [], monitorLog: false };
}

/** The report of a base image of a devspace: its version against the registry, the devspaces built on it, its older versions. */
function baseImageReport(input: ImageReportInput): ReportContent {
  const { object, details, records, computer, clock } = input;
  const tags = object.tags ?? [];
  const summary: ReportChip[] = [];
  const versionRows = tags.map((tag): ReportCell[] => {
    const here = localDigest(details, tag);
    const answer = registryAnswer(records, tag);
    const rule =
      records === undefined
        ? chip('not known: the records of the Monitor were not read', 'info')
        : answer === undefined
          ? chip('no answer of the registry to the Monitor: a private image, or no window sent it', 'info')
          : here === undefined
            ? chip('not known: the image has no digest of this repository', 'info')
            : sameDigest(answer.digest, here)
              ? chip('up to date', 'keep')
              : chip('newer in the registry', 'remove');
    if (rule.tone === 'remove' && summary.length === 0) summary.push(chip('newer in the registry', 'remove'));
    return [cell(tag), cell(here !== undefined ? digestText(here) : ''), cell(answerText(answer, clock)), cell('', rule)];
  });
  const sections: ReportSection[] = [
    {
      title: 'This version',
      body: { kind: 'table', columns: ['Tag', 'Digest here', 'Registry now', 'Rule'], rows: versionRows, empty: 'The image has no tag.' },
      from: 'From docker image inspect (its digests) and registry-digests.json in devspaces-monitor (the answers of the registries to the Monitor). The Monitor pulls a newer version of an image that a window sent in its background run.',
    },
  ];
  // The devspaces of this computer whose build record names a tag of this image.
  const references = new Set(tags.map(normalizedReference));
  const users: ReportCell[][] = [];
  for (const devspace of computer.devspaces?.values() ?? []) {
    const record = devspace.buildRecord;
    if (record === undefined) continue;
    for (const [reference, digest] of Object.entries(record.images)) {
      if (!references.has(normalizedReference(reference))) continue;
      const here = localDigest(details, reference);
      users.push([cell(devspace.repository), cell(String(record.buildNumber)), cell(digestText(digest)), cell('', sameDigest(digest, here) ? chip('built on this version', 'keep') : chip('built on another version', 'info'))]);
    }
  }
  sections.push({
    title: 'Devspaces that use it',
    body: { kind: 'table', columns: ['Devspace', 'Build', 'Digest at the build', 'State'], rows: users, empty: 'No build record of a devspace of this computer names it.' },
    from: 'From the build records of the devspaces of this computer on this host.',
  });
  // The older versions that pulls replaced, of the repositories of its tags.
  const older: ReportCell[][] = [];
  for (const repository of [...new Set(tags.map(tagRepository))]) {
    const replaced = records !== undefined && Object.hasOwn(records.replaced, repository) ? records.replaced[repository] : [];
    const pulledOver = new Set(records !== undefined && Object.hasOwn(records.pulledOver, repository) ? records.pulledOver[repository] : []);
    for (const id of replaced) {
      if (sameDigest(id, object.id)) continue;
      older.push([cell(repository), cell(digestText(id)), cell(pulledOver.has(id) ? 'replaced by a pull of the Monitor' : 'replaced by a pull')]);
    }
  }
  if (records !== undefined) {
    sections.push({
      title: 'Older versions that pulls replaced',
      body: { kind: 'table', columns: ['Repository', 'Image', 'Came from'], rows: older, empty: 'No pull replaced a version of its repositories.' },
      from: 'From replaced-images.json and pulled-over-images.json in devspaces-monitor. Rule of the Monitor: of a repository in use stay the image that each reference points to now, every image that a container uses, and every image that another image is built on; the others go at its next run. The Monitor brings the records up to date at its runs: a version that went since its last run can still be in this table.',
    });
  }
  return { summary, sections, notices: [], monitorLog: false };
}

/** The time of an ISO 8601 text in milliseconds; undefined when it is missing or not a time. */
function timeOf(text: string | undefined): number | undefined {
  const time = text !== undefined ? Date.parse(text) : Number.NaN;
  return Number.isFinite(time) ? time : undefined;
}

/** The report of the helper image: for which version of Devspaces, its base image, and the last check of the Monitor. */
function helperImageReport(input: ImageReportInput): ReportContent {
  const { object, details, records, clock, currentHelperTag } = input;
  const tags = object.tags ?? [];
  const labels = labelsOf(details);
  const facts: ReportFact[] = [];
  if (isEarlierHelperBuild(object)) {
    facts.push(fact('Build', 'an earlier build of a helper tag', chip('the Monitor removes it at its next run once no container uses it', 'remove')));
  } else if (currentHelperTag !== undefined) {
    facts.push(tags.includes(currentHelperTag) ? fact('For', 'this version of Devspaces', chip('in use', 'keep')) : fact('For', 'another version of Devspaces (another computer, or an earlier version)'));
  }
  const baseDigest = label(labels, LABEL_HELPER_BASE_DIGEST);
  const check = records?.helper !== undefined && tags.includes(records.helper.tag) ? records.helper : undefined;
  if (check !== undefined || baseDigest !== undefined) facts.push(fact('Base image', [check?.baseImage, baseDigest !== undefined ? digestText(baseDigest) : undefined].filter((part) => part !== undefined).join(' · ')));
  if (check !== undefined) {
    const checked = timeOf(check.checkedAt);
    const attempted = timeOf(check.attemptedAt);
    if (checked !== undefined) facts.push(fact('Last check by the Monitor', timeText(checked, clock), chip('built from the current base image', 'keep')));
    if (attempted !== undefined && (checked === undefined || attempted > checked)) facts.push(fact('Last attempt', timeText(attempted, clock), chip('the check or the build failed: the image stayed as it was', 'warn')));
    const built = dockerTimeText(check.builtAt, clock);
    if (built !== undefined) facts.push(fact('Last build by the Monitor', built));
  }
  facts.push(fact('Removed', 'a helper tag that no running container used for 7 days goes at the next run of the Monitor, never the tag of the Monitor itself', chip('rule of the Monitor', 'info')));
  return {
    summary: [],
    sections: [{ title: 'The helper image', body: { kind: 'facts', facts }, from: 'From the tags and the label worker-base-digest of the image, and helper-image.json in devspaces-monitor. The Monitor builds the helper image again when its base image has a new version.' }],
    notices: [],
    monitorLog: false,
  };
}

/** The report of the base image of the helper image. */
function helperBaseImageReport(): ReportContent {
  const facts = [
    fact('Use', 'the base image of the helper image (the first FROM of its Dockerfile)'),
    fact('Removed', 'an older version goes at the next run of the Monitor when no other image is built on it, no devspace uses it, and it has at most one tag', chip('rule of the Monitor', 'info')),
  ];
  return { summary: [], sections: [{ title: 'The base image of the helper image', body: { kind: 'facts', facts }, from: 'From the Dockerfile of the helper image of this version of Devspaces.' }], notices: [], monitorLog: false };
}

/** The report of the build image (devspaces-buildx). */
function buildImageReport(input: ImageReportInput): ReportContent {
  const tags = (input.object.tags ?? []).filter((tag) => tag.startsWith(`${BUILDX_REPOSITORY}:`));
  const pinned = tags.includes(buildxImageTag());
  const facts = [
    pinned
      ? fact('Pin', `${BUILDX_PIN.image} ${BUILDX_PIN.version} · ${digestText(BUILDX_PIN.digest)}`, chip('the pin of this version of Devspaces', 'keep'))
      : fact('Version', itemsText(tags.map((tag) => tag.slice(BUILDX_REPOSITORY.length + 1))), chip(`not the pin of this version of Devspaces (${BUILDX_PIN.version})`, 'info')),
    fact('Use', 'only while the helper image is built, in a build container'),
    fact('Removed', 'the older versions go at the next run of the Monitor', chip('rule of the Monitor', 'info')),
  ];
  return { summary: [], sections: [{ title: 'The build image', body: { kind: 'facts', facts }, from: 'From buildxPin.json of this version of Devspaces and the tags of the image.' }], notices: [], monitorLog: false };
}

/** The part of the report of an image of Devspaces (isImageReportObject); undefined for another object. */
export function imageReport(input: ImageReportInput): ReportContent | undefined {
  const { object } = input;
  if (!isImageReportObject(object)) return undefined;
  switch (object.purpose) {
    case 'baseImage':
      return baseImageReport(input);
    case 'helperImage':
      return helperImageReport(input);
    case 'helperBaseImage':
      return helperBaseImageReport();
    case 'buildImage':
      return buildImageReport(input);
    default:
      return object.role === 'prepared image' ? preparedImageReport(input) : devspaceImageReport(input);
  }
}
