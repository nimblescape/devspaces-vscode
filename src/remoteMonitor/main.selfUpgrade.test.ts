// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The loop of `run` and the move of the Monitor to the current build of its helper image (docs/requirements.md
// R-DS-009; selfUpgrade.ts): between two ticks the Monitor finds that the tag is on another image, creates its successor
// and exits with 0; a monitor that stays on its build goes on ticking. The volume is a temporary folder; the engine is a
// fake.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { helperImageTag } from '../core/helper/helperImageBuild';
import { LABEL_DEVSPACE_ID } from '../core/names';
import { LABEL_MONITOR, LABEL_MONITOR_CREATE } from '../core/remoteMonitor/protocol';
import { monitorLabel } from '../core/remoteMonitor/remoteSessionMonitor';
import type { DockerEngine, EngineContainerSummary, MonitorRunSpec } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { main } from './main';

const T0 = Date.parse('2026-11-12T10:00:00Z');
const SCRIPT = 'console.log("monitor")';
const CREATE = '0f0f0f0f-0000-4000-8000-000000000001';
const OWN_ID = 'a'.repeat(64);
const EARLIER = `sha256:${'1'.repeat(64)}`;
const CURRENT = `sha256:${'2'.repeat(64)}`;
const DOCKERFILE = 'FROM node:26-trixie-slim\n';
const TAG = helperImageTag(DOCKERFILE);

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-monitor-upgrade-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** `run` of a monitor that ends when idle and whose tag is on `tagImage`; it ends at the latest after `maxTicks` ticks. */
async function run(tagImage: string, maxTicks = 3) {
  const dockerfile = path.join(stateDir, 'Dockerfile');
  fs.writeFileSync(dockerfile, DOCKERFILE);
  const created: MonitorRunSpec[] = [];
  const calls: string[] = [];
  let mono = 0;
  let ticks = 0;
  let looks = 0;
  let out = '';
  const own = { Id: OWN_ID, Name: '/devspaces-monitor', Image: EARLIER, Config: { Labels: { [LABEL_MONITOR]: monitorLabel(SCRIPT, TAG, 'idle'), [LABEL_MONITOR_CREATE]: CREATE }, Env: [] }, HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock', 'devspaces-monitor:/state'] }, ExecIDs: null };
  const engine: DockerEngine = {
    ...unusedEngine(),
    containerSummaries: async (label): Promise<EngineContainerSummary[]> => (label === LABEL_DEVSPACE_ID ? [{ id: 'b'.repeat(64), name: 'devspace', state: 'running', labels: {} }] : []),
    containerIds: async (filters) => (filters.label?.[0] === `${LABEL_MONITOR_CREATE}=${CREATE}` ? [OWN_ID] : []),
    inspect: async (kind, reference) => {
      if (kind === 'container') return reference === OWN_ID ? own : undefined;
      if (kind === 'image' && reference === TAG) looks += 1;
      if (kind === 'image') return reference === TAG ? { Id: tagImage, RepoTags: [TAG], Config: {} } : reference === EARLIER ? { Id: EARLIER, RepoTags: [], Config: {} } : undefined;
      return undefined;
    },
    updateRestartPolicy: async (_id, policy) => void calls.push(`policy ${policy}`),
    renameContainer: async (_id, name) => void calls.push(`rename ${name}`),
    tagImage: async (_image, reference) => void calls.push(`tag ${reference}`),
    createAttached: async (spec) => {
      created.push(spec);
      return { kind: 'ready' };
    },
  };
  const code = await main(['run'], {
    env: { DEVSPACE_MONITOR_CREATE_ID: CREATE, DEVSPACE_IMAGE_FIRST_MS: '86400000' },
    stateDir,
    engine: engine as never,
    helperRefresh: { dockerfile },
    monitorScript: async () => SCRIPT,
    vscodeBackground: () => undefined,
    lockDevspace: async () => ({ kind: 'locked', release: () => {} }),
    monotonic: () => mono,
    now: () => T0 + mono,
    sleep: async (ms) => {
      ticks += 1;
      mono += ms;
      // A monitor that stays: end the test after some ticks (the loop never ends while a devspace runs).
      if (ticks >= maxTicks) throw new Error('ended by the test');
    },
    out: (text) => (out += text),
  }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  return { code, created, calls, out, ticks, looks };
}

describe('the loop of run and the move to the current build of the helper image', () => {
  it('moves at the first chance between two ticks, and exits with 0 once its successor runs', async () => {
    const { code, created, calls, out, ticks } = await run(CURRENT);
    expect(code).toBe(0);
    expect(ticks).toBe(0);
    expect(calls).toEqual(['policy no', `rename devspaces-monitor-earlier-${'a'.repeat(12)}`, `tag ${TAG.replace('devspaces-worker:', 'devspaces-monitor:')}`]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: 'devspaces-monitor', imageId: CURRENT, restartPolicy: 'on-failure' });
    expect(out).toContain('The Monitor moves to the current build: it creates its successor devspaces-monitor from it, and then ends.');
    expect(out).toContain('The successor devspaces-monitor runs from the current build of the helper image.');
  });

  it('goes on ticking while the tag is on its own build, and looks again only once a minute', async () => {
    const { code, created, calls, ticks, looks } = await run(EARLIER, 6);
    expect(code).toBe('ended by the test');
    expect(ticks).toBe(6);
    // Six ticks of 15 s: a look at the first, and one a minute later.
    expect(looks).toBe(2);
    expect(calls).toEqual([]);
    expect(created).toEqual([]);
  });
});
