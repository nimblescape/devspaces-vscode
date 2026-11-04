// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// recordEngineHelperCheck (docs/requirements.md R-DS-003): the last check of the helper image by the Monitor of the
// engine goes into the state of the helper image of that engine, so that the window does not check it while the
// Monitor did, and an open does not build it again after the Monitor did.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../ports';
import type { HelperCheck } from '../remoteMonitor/helperCheck';
import {
  ENGINE_CHECK_CLOCK_SKEW_MS,
  HELPER_CHECK_INTERVAL_MS,
  ensureHelperImageUse,
  helperImageTag,
  helperRefreshDue,
  recordEngineHelperCheck,
  type HelperImageDocker,
} from './helperImage';
import { HelperImages, helperStatePathFor } from './helperImages';
import { readHelperState, type HelperImageRecord, type HelperState } from './helperState';

const BASE = 'node:24-trixie-slim';
const DOCKERFILE = `ARG BASE_IMAGE=${BASE}\nFROM \${BASE_IMAGE}\n`;
const TAG = helperImageTag(DOCKERFILE);
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const NOW = Date.parse('2026-11-04T12:00:00Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const clock = { now: () => NOW };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function stateFile(images: Record<string, HelperImageRecord>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-engine-check-'));
  dirs.push(dir);
  const file = path.join(dir, 'helper.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, images } satisfies HelperState));
  return file;
}

function check(change: Partial<HelperCheck> = {}): HelperCheck {
  return { tag: TAG, baseImage: BASE, baseDigest: DIGEST_B, checkedAt: iso(-2 * HOUR), ...change };
}

async function recordOf(file: string): Promise<HelperImageRecord | undefined> {
  return (await readHelperState(file)).images[TAG];
}

describe('recordEngineHelperCheck', () => {
  it('takes a newer check of the Monitor as the check of the window: no own check for 7 days, no rebuild that an older check asked for', async () => {
    // The window checked 8 days ago and asked for a rebuild (the base image changed then).
    const file = stateFile({
      [TAG]: { baseImage: BASE, baseDigest: DIGEST_A, latestBaseDigest: DIGEST_B, checkedAt: iso(-8 * DAY), attemptedAt: iso(-DAY), builtAt: iso(-30 * DAY), lastUsedAt: iso(-HOUR) },
    });
    expect(await recordEngineHelperCheck(file, check(), { clock })).toBe(true);
    // The Monitor built the image again from DIGEST_B (or found it current): the rebuild and the attempt are done.
    expect(await recordOf(file)).toEqual({ baseImage: BASE, baseDigest: DIGEST_B, checkedAt: iso(-2 * HOUR), builtAt: iso(-30 * DAY), lastUsedAt: iso(-HOUR) });
    const state = await readHelperState(file);
    expect(helperRefreshDue(state, DOCKERFILE, { now: NOW, checkBaseImage: true, baseDigest: true })).toBe(false);
    // In 7 days from the check of the Monitor, the window checks again (when the Monitor did not check meanwhile).
    expect(helperRefreshDue(state, DOCKERFILE, { now: NOW - 2 * HOUR + HELPER_CHECK_INTERVAL_MS, checkBaseImage: true, baseDigest: true })).toBe(true);
    // The same check again changes nothing.
    expect(await recordEngineHelperCheck(file, check(), { clock })).toBe(false);
  });

  it('drops a rebuild that a newer check of the window asked for when the Monitor recorded that digest', async () => {
    // The Monitor rebuilt at 06:00 from DIGEST_B; the window checked at 10:00 against its old record and asked for it.
    const file = stateFile({ [TAG]: { baseImage: BASE, baseDigest: DIGEST_A, latestBaseDigest: DIGEST_B, checkedAt: iso(-2 * HOUR), attemptedAt: iso(-3 * HOUR) } });
    expect(await recordEngineHelperCheck(file, check({ checkedAt: iso(-6 * HOUR) }), { clock })).toBe(true);
    // The window keeps the time of its own check (and its attempt).
    expect(await recordOf(file)).toEqual({ baseImage: BASE, baseDigest: DIGEST_B, checkedAt: iso(-2 * HOUR), attemptedAt: iso(-3 * HOUR) });
  });

  it('keeps a rebuild that a newer check of the window asked for with another digest', async () => {
    // The base image changed again after the check of the Monitor: the window rebuilds.
    const record: HelperImageRecord = { baseImage: BASE, baseDigest: DIGEST_A, latestBaseDigest: `sha256:${'c'.repeat(64)}`, checkedAt: iso(-2 * HOUR) };
    const file = stateFile({ [TAG]: record });
    expect(await recordEngineHelperCheck(file, check({ checkedAt: iso(-6 * HOUR) }), { clock })).toBe(false);
    expect(await recordOf(file)).toEqual(record);
  });

  it('ignores an older check of the Monitor when the window asked for nothing', async () => {
    const record: HelperImageRecord = { baseImage: BASE, baseDigest: DIGEST_A, checkedAt: iso(-HOUR) };
    const file = stateFile({ [TAG]: record });
    expect(await recordEngineHelperCheck(file, check({ checkedAt: iso(-2 * HOUR) }), { clock })).toBe(false);
    expect(await recordOf(file)).toEqual(record);
  });

  it('clears the mark of a build without --pull only when the Monitor checked after that build', async () => {
    const before = stateFile({ [TAG]: { baseImage: BASE, builtWithoutPull: iso(-DAY), attemptedAt: iso(-DAY) } });
    expect(await recordEngineHelperCheck(before, check(), { clock })).toBe(true);
    expect(await recordOf(before)).toEqual({ baseImage: BASE, baseDigest: DIGEST_B, checkedAt: iso(-2 * HOUR) });
    // A build from the local base image after the check of the Monitor: the Monitor builds it again in its next run,
    // and the window does not take the older check.
    const record: HelperImageRecord = { baseImage: BASE, builtWithoutPull: iso(-HOUR), attemptedAt: iso(-HOUR) };
    const after = stateFile({ [TAG]: record });
    expect(await recordEngineHelperCheck(after, check(), { clock })).toBe(false);
    expect(await recordOf(after)).toEqual(record);
  });

  it('takes nothing for a tag that the state does not know, a foreign or removed tag, or another base image', async () => {
    const unknown = stateFile({});
    expect(await recordEngineHelperCheck(unknown, check(), { clock })).toBe(false);
    expect(await recordOf(unknown)).toBeUndefined();
    for (const record of [{ foreignSince: iso(-DAY), lastUsedAt: iso(-DAY) }, { removedAt: iso(-DAY) }, { baseImage: 'debian:trixie', checkedAt: iso(-8 * DAY) }] satisfies HelperImageRecord[]) {
      const file = stateFile({ [TAG]: record });
      expect(await recordEngineHelperCheck(file, check(), { clock })).toBe(false);
      expect(await recordOf(file)).toEqual(record);
    }
  });

  it('refuses a check from the future of this clock beyond the skew, and takes one within it as now', async () => {
    const record: HelperImageRecord = { baseImage: BASE, baseDigest: DIGEST_A, checkedAt: iso(-8 * DAY) };
    const far = stateFile({ [TAG]: record });
    expect(await recordEngineHelperCheck(far, check({ checkedAt: iso(ENGINE_CHECK_CLOCK_SKEW_MS + 1000) }), { clock })).toBe(false);
    expect(await recordOf(far)).toEqual(record);
    const near = stateFile({ [TAG]: record });
    expect(await recordEngineHelperCheck(near, check({ checkedAt: iso(ENGINE_CHECK_CLOCK_SKEW_MS - 1000) }), { clock })).toBe(true);
    expect((await recordOf(near))?.checkedAt).toBe(iso(0));
  });

  // The folder of the state is read-only for the atomic write (its temporary file); root writes anyway.
  it.skipIf(process.getuid?.() === 0)('never throws: a state that cannot be written is one warning', async () => {
    const file = stateFile({ [TAG]: { baseImage: BASE, baseDigest: DIGEST_A, checkedAt: iso(-8 * DAY) } });
    fs.chmodSync(path.dirname(file), 0o500);
    const warnings: string[] = [];
    const logger: Logger = { info: () => {}, warn: (message) => warnings.push(message), error: () => {}, output: () => {} };
    try {
      expect(await recordEngineHelperCheck(file, check(), { clock, logger })).toBe(false);
    } finally {
      fs.chmodSync(path.dirname(file), 0o700);
    }
    expect(warnings).toEqual([expect.stringContaining('The state of the workspace helper image could not be written')]);
  });

  it('makes the maintaining ensure of an open skip its own check and the rebuild', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-engine-check-'));
    dirs.push(dir);
    const dockerfile = path.join(dir, 'Dockerfile');
    fs.writeFileSync(dockerfile, DOCKERFILE);
    const file = path.join(dir, 'helper.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, images: { [TAG]: { baseImage: BASE, baseDigest: DIGEST_A, latestBaseDigest: DIGEST_B, checkedAt: iso(-8 * DAY) } }, lastCleanupAt: iso(0) }));
    await recordEngineHelperCheck(file, check(), { clock });
    const builds: unknown[] = [];
    const lookups: string[] = [];
    const docker: HelperImageDocker = {
      imageExists: async () => true,
      imageId: async () => `sha256:${'1'.repeat(64)}`,
      buildImage: async (options) => (builds.push(options), undefined),
      listImagesByLabel: async () => [],
      removeImage: async () => false,
    };
    const use = await ensureHelperImageUse(docker, dockerfile, { statePath: file, clock, baseDigest: async (reference) => (lookups.push(reference), DIGEST_B) });
    expect(use.tag).toBe(TAG);
    expect(builds).toEqual([]);
    expect(lookups).toEqual([]);
  });

  it('HelperImages.recordEngineCheck writes the state file of the engine of the heartbeat, and logs the change once', async () => {
    const local = stateFile({ [TAG]: { baseImage: BASE, baseDigest: DIGEST_A, checkedAt: iso(-8 * DAY) } });
    const remote = helperStatePathFor(local, 'ssh://box');
    fs.writeFileSync(remote, fs.readFileSync(local));
    const lines: string[] = [];
    const logger: Logger = { info: (message) => lines.push(message), warn: () => {}, error: () => {}, output: () => {} };
    const helper = new HelperImages({ docker: {} as never, logger, dockerfilePath: '/nowhere/Dockerfile', statePath: local, clock });
    await helper.recordEngineCheck('ssh://box', check());
    await helper.recordEngineCheck('ssh://box', check());
    expect((await readHelperState(remote)).images[TAG]).toMatchObject({ baseDigest: DIGEST_B, checkedAt: iso(-2 * HOUR) });
    expect((await readHelperState(local)).images[TAG]).toMatchObject({ baseDigest: DIGEST_A, checkedAt: iso(-8 * DAY) });
    expect(lines).toEqual([`The Monitor checked the workspace helper image ${TAG} at ${iso(-2 * HOUR)}: it is built from the current base image ${BASE}.`]);
  });
});
