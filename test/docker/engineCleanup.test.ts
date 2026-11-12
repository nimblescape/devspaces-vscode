// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The cleanup of the engine by the Monitor (src/remoteMonitor/engineCleanup.ts, docs/requirements.md R-DS-007) against
// the real engine, over the production client of the Engine API: the earlier builds of a helper tag, the monitor tags
// without their helper tag, the helper tags that no running container used for 7 days, the older build images and the
// older base images of the helper image go; the image of a stopped container, the own helper tag and its base image
// stay. The port that the cleanup gets sees only the images and containers of this run (the label of the run is added
// to each list and prune), so the test never touches other objects of the engine; the removals, the inspects and the
// answers of the engine are the real ones.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LABEL_HELPER } from '../../src/core/names';
import { BUILD_CACHE_UNUSED_FILTER, HELPER_TAG_UNUSED_MS } from '../../src/remoteMonitor/cleanupRules';
import type { CleanupEngine } from '../../src/remoteMonitor/engine';
import { EngineCleanup } from '../../src/remoteMonitor/engineCleanup';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { dockerTestContext, testEngine } from './harness';

describe('the cleanup of the engine by the Monitor', () => {
  const { run, env, cli, log } = dockerTestContext('engineCleanup');
  const runLabel = `${TEST_RUN_LABEL}=${run.runId}`;
  const hex = (): string => crypto.randomBytes(6).toString('hex');
  const own = `devspaces-worker:${hex()}`;
  const unused = `devspaces-worker:${hex()}`;
  const stopped = `devspaces-worker:${hex()}`;
  const running = `devspaces-worker:${hex()}`;
  const staleMonitor = `devspaces-monitor:${hex()}`;
  const oldBuildx = 'devspaces-buildx:0.0.1';
  const base = `devspaces-test-cleanup-base-${run.runId}`;
  const context = path.join(run.runDir, 'engine-cleanup-context');
  const prunes: string[] = [];
  const lines: string[] = [];
  let now = Date.parse('2026-11-12T08:00:00.000Z');
  let record: string | undefined;

  /** Builds `dockerfile` as `tag`, with the label of the run; returns the ID of the image. */
  const build = (tag: string, dockerfile: string): string => {
    cli.ok(['build', '-q', '--label', runLabel, '-f', '-', '-t', tag, context], dockerfile);
    return cli.ok(['image', 'inspect', '-f', '{{.Id}}', tag]);
  };
  const exists = (reference: string): boolean => cli.run(['image', 'inspect', reference]).code === 0;

  /** The production port, with the label of the run added to each list and prune. */
  const scopedEngine = (): CleanupEngine => {
    const engine = testEngine(env);
    return {
      images: (filters, signal) => engine.images({ ...filters, label: [...(filters.label ?? []), runLabel] }, signal),
      containerIds: (filters, signal) => engine.containerIds({ ...filters, label: [...(filters.label ?? []), runLabel] }, signal),
      inspect: (kind, reference, signal) => engine.inspect(kind, reference, signal),
      removeImage: (reference, signal) => engine.removeImage(reference, signal),
      pruneContainers: (filters, signal) => {
        prunes.push('containers');
        return engine.pruneContainers({ ...filters, label: [...(filters.label ?? []), runLabel] }, signal);
      },
      pruneBuildCache: async (filters, signal) => {
        prunes.push(`build cache ${JSON.stringify(filters)}`);
        // The real request, with an `id` that no record has: the engine takes the filters, and removes nothing.
        return engine.pruneBuildCache({ ...filters, id: [`devspaces-test-${run.runId}`] }, signal);
      },
    };
  };

  const cleanup = (): EngineCleanup =>
    new EngineCleanup({
      engine: scopedEngine(),
      log: (message) => {
        lines.push(message);
        log.info(message);
      },
      now: () => now,
      record: {
        read: async () => record,
        write: async (text) => {
          record = text;
        },
      },
      ownHelper: async () => ({ tag: own, baseImage: `${base}:new` }),
      referencesInUse: async () => ({ references: [], complete: true }),
      vm: true,
    });

  let earlierBuild = '';
  let oldBase = '';

  beforeAll(() => {
    fs.mkdirSync(context, { recursive: true });
    const helper = (from: string, text: string) => `FROM ${from}\nLABEL ${LABEL_HELPER}=true\nRUN echo ${text} > /helper\n`;
    oldBase = build(`${base}:old`, `FROM ${TEST_BASE_IMAGE}\nRUN echo old-${run.runId} > /base\n`);
    // The own helper tag on the old base, then rebuilt on the new base. The engine with the containerd image store
    // deletes the image that a build takes the tag from, while Docker Desktop and the classic store keep it without a
    // tag; so the earlier build of the test is an image without a tag of its own: a commit of a container of the first
    // build (with its labels and its layers on the old base).
    build(own, helper(`${base}:old`, 'own'));
    const first = cli.ok(['create', '--label', runLabel, '--network', 'none', own, 'true']);
    earlierBuild = cli.ok(['commit', first]);
    cli.ok(['rm', first]);
    build(`${base}:new`, `FROM ${TEST_BASE_IMAGE}\nRUN echo new-${run.runId} > /base\n`);
    build(own, helper(`${base}:new`, 'own'));
    build(unused, helper(`${base}:new`, 'unused'));
    build(stopped, helper(`${base}:new`, 'stopped'));
    build(running, helper(`${base}:new`, 'running'));
    cli.ok(['create', '--label', runLabel, '--network', 'none', stopped, 'true']);
    // A monitor tag whose helper tag is not on its image.
    cli.ok(['tag', unused, staleMonitor]);
    build(oldBuildx, `FROM ${TEST_BASE_IMAGE}\nRUN echo buildx-${run.runId} > /buildx\n`);
  });

  afterAll(() => {
    removeRunObjects(cli, run.runId);
    for (const tag of [own, unused, stopped, running, staleMonitor, oldBuildx, `${base}:old`, `${base}:new`]) cli.run(['image', 'rm', '-f', tag]);
  });

  it('a first pass removes the earlier build, the stale monitor tag, the older build image and the older base image', async () => {
    expect(cli.ok(['image', 'inspect', '-f', '{{json .RepoTags}}', earlierBuild])).toBe('[]');
    await cleanup().pass();
    expect(exists(earlierBuild)).toBe(false);
    expect(exists(staleMonitor)).toBe(false);
    expect(exists(oldBuildx)).toBe(false);
    expect(exists(oldBase)).toBe(false);
    for (const tag of [own, unused, stopped, running, `${base}:new`]) expect(exists(tag), tag).toBe(true);
    expect(prunes).toEqual(['containers', `build cache ${JSON.stringify({ until: [BUILD_CACHE_UNUSED_FILTER] })}`]);
    expect(lines.filter((line) => /could not|failed/i.test(line))).toEqual([]);
  });

  it('after 7 days without a running container, removes a helper tag, keeps a used one, the image of a stopped container and the own tag', async () => {
    // The look finds the running container by the ID of its image (the filter `ancestor`).
    const container = cli.ok(['run', '-d', '--label', runLabel, '--network', 'none', running, 'sleep', '300']);
    try {
      now += HELPER_TAG_UNUSED_MS - 60_000;
      await cleanup().observe();
      now += 60_000;
      await cleanup().pass();
      expect(exists(unused)).toBe(false);
      expect(exists(stopped)).toBe(true);
      expect(exists(running)).toBe(true);
      expect(exists(own)).toBe(true);
      expect(exists(`${base}:new`)).toBe(true);
      expect(lines).toContain(`A container uses these, so they stay: the workspace helper image ${stopped}, which no running container used for 7 days.`);
    } finally {
      cli.run(['rm', '-f', container]);
    }
  });
});
