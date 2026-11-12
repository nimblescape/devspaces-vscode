// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The move of the Monitor to the script of a newer version of Devspaces (docs/requirements.md R-DS-011): a window of a
// newer version stores its script with its version and helper tag in the volume (storeWorkerScript); the Monitor
// creates its successor with that script from that helper image, with the version and the hash of that worker script,
// and ends. The volume is a temporary folder; the engine is a fake.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERSION_ENV } from '../core/http';
import { bundleHash } from '../core/loader/pipeLoader';
import { LABEL_HELPER } from '../core/names';
import { LABEL_MONITOR, LABEL_MONITOR_CREATE, LABEL_MONITOR_VERSION } from '../core/remoteMonitor/protocol';
import { MONITOR_SUCCESSOR_ENV, monitorLabel } from '../core/remoteMonitor/remoteSessionMonitor';
import { MONITOR_WORKER_HASH_ENV, WORKER_SCRIPT_FOLDER, storeWorkerScript } from '../core/remoteMonitor/workerScript';
import type { DockerEngine, MonitorRunSpec } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { SelfUpgrade } from './selfUpgrade';

const TAG = 'devspaces-worker:0123456789ab';
const NEW_TAG = 'devspaces-worker:ba9876543210';
const SCRIPT = 'console.log("monitor 0.6.0")';
const NEW_SCRIPT = 'console.log("monitor 0.7.0")';
const CREATE = '0f0f0f0f-0000-4000-8000-000000000001';
const OWN_ID = 'a'.repeat(64);
const CURRENT = `sha256:${'2'.repeat(64)}`;
const NEW_IMAGE = `sha256:${'3'.repeat(64)}`;
const OWN_WORKER = bundleHash(SCRIPT);
const ENV: NodeJS.ProcessEnv = { DEVSPACE_MONITOR_CREATE_ID: CREATE, [VERSION_ENV]: '0.6.0' };

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-monitor-version-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/**
 * The move of a monitor of Devspaces `version` (null: none) that ends when idle, from the current build of its tag;
 * `images` the images of the engine, `imageLabels` the labels of an image ID (default: the label of a helper image).
 */
function setup(
  images: Record<string, string> = { [TAG]: CURRENT, [CURRENT]: CURRENT, [NEW_TAG]: NEW_IMAGE, [NEW_IMAGE]: NEW_IMAGE },
  version: string | null = '0.6.0',
  imageLabels: Record<string, Record<string, string>> = {},
) {
  const created: MonitorRunSpec[] = [];
  const calls: string[] = [];
  const lines: string[] = [];
  const own = {
    Id: OWN_ID,
    Name: '/devspaces-monitor',
    Image: CURRENT,
    Config: { Labels: { [LABEL_MONITOR]: monitorLabel(SCRIPT, TAG, 'idle'), [LABEL_MONITOR_CREATE]: CREATE, [LABEL_MONITOR_VERSION]: '0.6.0' }, Env: [`${VERSION_ENV}=0.6.0`, `${MONITOR_WORKER_HASH_ENV}=${OWN_WORKER}`] },
    HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock', 'devspaces-monitor:/state'] },
    ExecIDs: null,
  };
  const engine: DockerEngine = {
    ...unusedEngine(),
    containerIds: async () => [OWN_ID],
    containerSummaries: async () => [],
    inspect: async (kind, reference) => {
      if (kind === 'container') return reference === OWN_ID ? own : undefined;
      if (kind !== 'image' || images[reference] === undefined) return undefined;
      return { Id: images[reference], RepoTags: [], Config: { Labels: imageLabels[images[reference]] ?? { [LABEL_HELPER]: 'true' }, Env: [] } };
    },
    updateRestartPolicy: async (_id, policy) => void calls.push(`policy ${policy}`),
    renameContainer: async (_id, name) => void calls.push(`rename ${name}`),
    tagImage: async (image, reference) => void calls.push(`tag ${image.slice(7, 11)} ${reference}`),
    createAttached: async (spec) => {
      created.push(spec);
      return { kind: 'ready' };
    },
  };
  const upgrade = new SelfUpgrade({
    engine,
    env: ENV,
    log: (message) => lines.push(message),
    monotonic: () => 0,
    script: async () => SCRIPT,
    helperTag: async () => TAG,
    busy: () => false,
    removals: () => undefined,
    stateDir,
    version: () => version ?? undefined,
    sleep: async () => {},
  });
  return { upgrade, created, calls, lines };
}

/** What a window of `version` stores in the volume at its ensure. */
function store(script: string, version: string, helperTag: string): string {
  return storeWorkerScript(stateDir, script, { version, helperTag });
}

describe('the move of the Monitor to the script of a newer version of Devspaces', () => {
  it('creates its successor with the script, version and helper image of the newest version that a window stored, and ends', async () => {
    const hash = store(NEW_SCRIPT, '0.7.0', NEW_TAG);
    // An earlier version, and the own script of this monitor, are never a target.
    store('console.log("monitor 0.5.0")', '0.5.0', NEW_TAG);
    const { upgrade, created, calls, lines } = setup();
    expect(await upgrade.check()).toBe(true);
    expect(calls).toEqual(['policy no', `rename devspaces-monitor-earlier-${'a'.repeat(12)}`, 'tag 3333 devspaces-monitor:ba9876543210']);
    const [spec] = created;
    expect(spec).toMatchObject({ name: 'devspaces-monitor', image: 'devspaces-monitor:ba9876543210', imageId: NEW_IMAGE, restartPolicy: 'on-failure' });
    expect(spec.labels).toMatchObject({ [LABEL_MONITOR]: monitorLabel(NEW_SCRIPT, NEW_TAG, 'idle'), [LABEL_MONITOR_VERSION]: '0.7.0' });
    expect(spec.env).toMatchObject({ [VERSION_ENV]: '0.7.0', [MONITOR_WORKER_HASH_ENV]: hash, [MONITOR_SUCCESSOR_ENV]: '1' });
    expect(spec.command.join(' ')).toContain(hash);
    expect(lines).toEqual([
      'A window stored the script of Devspaces 0.7.0, a newer version than 0.6.0. The Monitor moves to it: it creates its successor devspaces-monitor from the helper image devspaces-worker:ba9876543210, and then ends.',
      `The successor devspaces-monitor runs Devspaces 0.7.0. This Monitor (now devspaces-monitor-earlier-${'a'.repeat(12)}) ends; the successor removes it.`,
    ]);
  });

  it('takes the newest version, and the newest record of one version', async () => {
    store('console.log("monitor 0.7.0")', '0.7.0', NEW_TAG);
    const newest = store('console.log("monitor 0.10.0")', '0.10.0', NEW_TAG);
    const { upgrade, created } = setup();
    expect(await upgrade.check()).toBe(true);
    expect(created[0].env).toMatchObject({ [VERSION_ENV]: '0.10.0', [MONITOR_WORKER_HASH_ENV]: newest });
  });

  it('stays while the helper image or the script of the newer version is missing (logged once), and on its own version', async () => {
    const hash = store(NEW_SCRIPT, '0.7.0', NEW_TAG);
    const noImage = setup({ [TAG]: CURRENT, [CURRENT]: CURRENT });
    expect(await noImage.upgrade.check()).toBe(false);
    expect(await noImage.upgrade.check()).toBe(false);
    expect(noImage.lines).toEqual([
      'The helper image devspaces-worker:ba9876543210 of Devspaces 0.7.0 is not on the Docker engine; the Monitor moves to that version once a window of it built the image.',
    ]);
    fs.rmSync(path.join(stateDir, WORKER_SCRIPT_FOLDER, `${hash}.js`));
    const noScript = setup();
    expect(await noScript.upgrade.check()).toBe(false);
    expect(noScript.lines).toEqual([`The Monitor cannot move to Devspaces 0.7.0: the worker script ${hash.slice(0, 12)} is not in the volume (the next open stores it).`]);
    expect(noScript.created).toEqual([]);
  });

  it('never moves to an image of the helper tag without the label of a helper image (logged once)', async () => {
    store(NEW_SCRIPT, '0.7.0', NEW_TAG);
    const { upgrade, created, lines } = setup(undefined, '0.6.0', { [NEW_IMAGE]: {} });
    expect(await upgrade.check()).toBe(false);
    expect(await upgrade.check()).toBe(false);
    expect(created).toEqual([]);
    expect(lines).toEqual([`The image of ${NEW_TAG} is no helper image of Devspaces (no label ${LABEL_HELPER}); the Monitor does not move to Devspaces 0.7.0 from it.`]);
  });

  it('never moves to its own script and tag, to an earlier or the same version, or without a version of its own', async () => {
    store(SCRIPT, '0.7.0', TAG);
    store('console.log("monitor 0.6.0 again")', '0.6.0', NEW_TAG);
    store('console.log("monitor 0.5.9")', '0.5.9', NEW_TAG);
    const { upgrade, created } = setup();
    expect(await upgrade.check()).toBe(false);
    expect(created).toEqual([]);
    store(NEW_SCRIPT, '0.7.0', NEW_TAG);
    const noVersion = setup(undefined, null);
    expect(await noVersion.upgrade.check()).toBe(false);
    expect(noVersion.created).toEqual([]);
  });

  it('the same script of a newer version with another helper tag moves to that tag', async () => {
    store(SCRIPT, '0.7.0', NEW_TAG);
    const { upgrade, created } = setup();
    expect(await upgrade.check()).toBe(true);
    expect(created[0]).toMatchObject({ imageId: NEW_IMAGE, labels: { [LABEL_MONITOR]: monitorLabel(SCRIPT, NEW_TAG, 'idle'), [LABEL_MONITOR_VERSION]: '0.7.0' } });
  });
});
