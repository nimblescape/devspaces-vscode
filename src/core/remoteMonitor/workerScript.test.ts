// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The worker's script in the volume of the Monitor: stored by the worker under its hash (and its hash given to
// the monitor that the ensure creates), read by the monitor only as a plain file with that hash, and the scripts of
// other versions removed after a day.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleHash } from '../loader/pipeLoader';
import type { DockerEngine, MonitorRunSpec } from '../worker/dockerEngine';
import { unusedEngine } from '../worker/dockerEngine.testkit';
import { ensureWorkerMonitor } from '../../helperChannel/flowOperations';
import { silentLogger } from '../ports';
import { setUserAgentVersion } from '../http';
import {
  MONITOR_WORKER_HASH_ENV,
  WORKER_SCRIPT_FOLDER,
  WORKER_SCRIPT_MAX_AGE_MS,
  parseWorkerScriptRecord,
  readWorkerScript,
  readWorkerScriptRecords,
  removeOtherWorkerScripts,
  storeWorkerScript,
  workerScriptPath,
} from './workerScript';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspace-worker-script-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('the worker script in the volume', () => {
  it('is stored under its hash, 0600 in a 0700 folder, and read back only with that hash', () => {
    const hash = storeWorkerScript(stateDir, 'the worker');
    expect(hash).toBe(bundleHash('the worker'));
    const file = workerScriptPath(stateDir, hash);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readWorkerScript(stateDir, hash)).toEqual({ script: 'the worker' });
    expect(readWorkerScript(stateDir, 'nope')).toEqual({ reason: 'the hash of its worker script is invalid' });
  });

  it('is stored again when it is missing or changed, and never read through a link', () => {
    const hash = storeWorkerScript(stateDir, 'the worker');
    const file = workerScriptPath(stateDir, hash);
    fs.rmSync(file);
    storeWorkerScript(stateDir, 'the worker');
    expect(fs.readFileSync(file, 'utf8')).toBe('the worker');
    fs.writeFileSync(file, 'the other');
    expect('reason' in readWorkerScript(stateDir, hash)).toBe(true);
    storeWorkerScript(stateDir, 'the worker');
    expect(readWorkerScript(stateDir, hash)).toEqual({ script: 'the worker' });
    fs.rmSync(file);
    fs.writeFileSync(path.join(stateDir, 'elsewhere'), 'the worker');
    fs.symlinkSync(path.join(stateDir, 'elsewhere'), file);
    expect('reason' in readWorkerScript(stateDir, hash)).toBe(true);
  });

  it('the monitor removes the scripts of other hashes and leftovers after a day, never its own or another file', () => {
    const own = storeWorkerScript(stateDir, 'own');
    const other = storeWorkerScript(stateDir, 'other');
    const young = storeWorkerScript(stateDir, 'young');
    const folder = path.join(stateDir, WORKER_SCRIPT_FOLDER);
    const leftover = path.join(folder, `${own}.js.0123456789ab.tmp`);
    fs.writeFileSync(leftover, '');
    fs.writeFileSync(path.join(folder, 'notes.txt'), '');
    const now = Date.now();
    const old = new Date(now - WORKER_SCRIPT_MAX_AGE_MS - 60_000);
    for (const file of [workerScriptPath(stateDir, own), workerScriptPath(stateDir, other), leftover, path.join(folder, 'notes.txt')]) fs.utimesSync(file, old, old);
    expect(removeOtherWorkerScripts(stateDir, own, now).sort()).toEqual([`${other}.js`, `${own}.js.0123456789ab.tmp`].sort());
    expect(fs.readdirSync(folder).sort()).toEqual([`${own}.js`, `${young}.js`, 'notes.txt'].sort());
  });
});

describe('the record of a worker script: its version of Devspaces and helper tag (R-DS-011)', () => {
  const TAG = 'devspaces-worker:0123456789ab';

  it('is stored beside the script, 0600, read back with its hash and the time of its file, and stored again when it changed', () => {
    const hash = storeWorkerScript(stateDir, 'the worker', { version: '0.7.0', helperTag: TAG });
    const file = path.join(stateDir, WORKER_SCRIPT_FOLDER, `${hash}.json`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: '0.7.0', helperTag: TAG });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readWorkerScriptRecords(stateDir)).toEqual([{ hash, version: '0.7.0', helperTag: TAG, mtimeMs: fs.statSync(file).mtimeMs }]);
    storeWorkerScript(stateDir, 'the worker', { version: '0.7.1', helperTag: TAG });
    expect(readWorkerScriptRecords(stateDir).map((record) => record.version)).toEqual(['0.7.1']);
    fs.rmSync(file);
    storeWorkerScript(stateDir, 'the worker', { version: '0.7.1', helperTag: TAG });
    expect(readWorkerScriptRecords(stateDir).map((record) => record.version)).toEqual(['0.7.1']);
  });

  it('refuses an invalid record, and the Monitor leaves out invalid files, links and keys that it does not know', () => {
    expect(() => storeWorkerScript(stateDir, 'the worker', { version: '0.7', helperTag: TAG })).toThrow('The record of the worker script is invalid.');
    expect(() => storeWorkerScript(stateDir, 'the worker', { version: '0.7.0', helperTag: 'node:26' })).toThrow('The record of the worker script is invalid.');
    expect(parseWorkerScriptRecord(JSON.stringify({ version: '0.7.0', helperTag: TAG, later: true }))).toEqual({ version: '0.7.0', helperTag: TAG });
    expect(parseWorkerScriptRecord('{"version":"0.7.0"}')).toBeUndefined();
    const folder = path.join(stateDir, WORKER_SCRIPT_FOLDER);
    // Nothing was stored for an invalid record.
    expect(fs.existsSync(folder)).toBe(false);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, `${'1'.repeat(64)}.json`), 'not json');
    fs.writeFileSync(path.join(stateDir, 'elsewhere.json'), JSON.stringify({ version: '0.7.0', helperTag: TAG }));
    fs.symlinkSync(path.join(stateDir, 'elsewhere.json'), path.join(folder, `${'2'.repeat(64)}.json`));
    fs.writeFileSync(path.join(folder, 'other.json'), JSON.stringify({ version: '0.7.0', helperTag: TAG }));
    expect(readWorkerScriptRecords(stateDir)).toEqual([]);
  });

  it('the monitor removes the records of other hashes after a day with their scripts, never its own', () => {
    const own = storeWorkerScript(stateDir, 'own', { version: '0.6.0', helperTag: TAG });
    const other = storeWorkerScript(stateDir, 'other', { version: '0.7.0', helperTag: TAG });
    const folder = path.join(stateDir, WORKER_SCRIPT_FOLDER);
    const now = Date.now();
    const old = new Date(now - WORKER_SCRIPT_MAX_AGE_MS - 60_000);
    for (const name of fs.readdirSync(folder)) fs.utimesSync(path.join(folder, name), old, old);
    expect(removeOtherWorkerScripts(stateDir, own, now).sort()).toEqual([`${other}.js`, `${other}.json`].sort());
    expect(fs.readdirSync(folder).sort()).toEqual([`${own}.js`, `${own}.json`].sort());
  });

  it('the ensure of the worker stores it with the version of this program and the helper tag of the worker', async () => {
    const specs: MonitorRunSpec[] = [];
    const engine: DockerEngine = {
      ...unusedEngine(),
      tagImage: async () => {},
      inspect: async () => undefined,
      createAttached: async (spec) => {
        specs.push(spec);
        return { kind: 'ready' };
      },
    };
    const own = { image: { tag: TAG, id: `sha256:${'a'.repeat(64)}` }, socket: '/var/run/docker.sock' };
    setUserAgentVersion('0.7.0');
    try {
      await ensureWorkerMonitor(engine, own, silentLogger, () => 'the worker', { schedule: '7 6 * * *', timeZone: 'UTC' }, new AbortController().signal, { read: () => 'the worker', stateDir });
    } finally {
      setUserAgentVersion(undefined);
    }
    expect(readWorkerScriptRecords(stateDir)).toMatchObject([{ hash: bundleHash('the worker'), version: '0.7.0', helperTag: TAG }]);
    expect(specs[0].labels['nimblescape.devspaces.monitor-version']).toBe('0.7.0');
  });
});

describe('the ensure of the Monitor with the worker script', () => {
  const OWN = { image: { tag: 'devspaces-worker:0123456789ab', id: `sha256:${'a'.repeat(64)}` }, socket: '/var/run/docker.sock' };
  const IMAGES = { schedule: '7 6 * * *', timeZone: 'UTC' };

  function engine(specs: MonitorRunSpec[]): DockerEngine {
    return {
      ...unusedEngine(),
      tagImage: async () => {},
      inspect: async () => undefined,
      createAttached: async (spec) => {
        specs.push(spec);
        return { kind: 'ready' };
      },
    };
  }

  it('stores the worker script first and gives the monitor its hash, nothing else of the worker', async () => {
    const specs: MonitorRunSpec[] = [];
    await ensureWorkerMonitor(engine(specs), OWN, silentLogger, () => 'the monitor', IMAGES, new AbortController().signal, { read: () => 'the worker', stateDir });
    const hash = bundleHash('the worker');
    expect(readWorkerScript(stateDir, hash)).toEqual({ script: 'the worker' });
    expect(specs[0].env).toEqual({
      DEVSPACE_IMAGE_SCHEDULE: '7 6 * * *',
      DEVSPACE_IMAGE_TZ: 'UTC',
      [MONITOR_WORKER_HASH_ENV]: hash,
      // The nonce of the create (by which the monitor finds its own container), not of the worker.
      DEVSPACE_MONITOR_CREATE_ID: specs[0].labels['nimblescape.devspaces.monitor-create'],
    });
  });

  it('without a worker script, as before (no variable)', async () => {
    const specs: MonitorRunSpec[] = [];
    await ensureWorkerMonitor(engine(specs), OWN, silentLogger, () => 'the monitor', IMAGES, new AbortController().signal);
    expect(specs[0].env[MONITOR_WORKER_HASH_ENV]).toBeUndefined();
  });

  it('a script that cannot be read is a warning, and the monitor gets no hash', async () => {
    const specs: MonitorRunSpec[] = [];
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (line: string) => void warnings.push(line) };
    const read = () => {
      throw new Error('ENOENT');
    };
    await ensureWorkerMonitor(engine(specs), OWN, logger, () => 'the monitor', IMAGES, new AbortController().signal, { read, stateDir });
    expect(specs[0].env[MONITOR_WORKER_HASH_ENV]).toBeUndefined();
    expect(warnings).toEqual(['The worker script cannot be read, so the Monitor prepares no devspace image: ENOENT']);
  });
});
