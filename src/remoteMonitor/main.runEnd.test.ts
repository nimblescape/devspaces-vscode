// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Mutation probes of the background run in the monitor: the schedule of the background run never rejects when the end
// of a run cannot be stored (its callers are `void schedule.run()` and `void schedule.check()`: a rejection would be
// unhandled and end the process, and a permanent monitor would be restarted into the same failure); the state file
// keeps the fields that an update does not name (the end of the run never wipes the time of the last cleanup);
// `monitor.js run` checks the schedule at its first check (a restart runs nothing while the stored end is recent) and
// makes the VS Code part afresh for each run; that part reads the proxy of the daemon. The volume is a temporary
// folder; nothing needs root.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_RUN_FILE } from '../core/remoteMonitor/protocol';
import { MAX_RUN_REPORTS, MAX_RUN_REPORTS_FILE_BYTES, RUN_REPORTS_FILE, type RunReport } from '../core/remoteMonitor/runReport';
import type { EngineContainerSummary } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { CacheSchedule, CurrentCacheSettings, STATE_TEMPORARY_FILE, cacheRunStore, main, removeStaleStateTemporaryFiles, runReportStore, vmFromEnv, vscodeBackgroundDeps } from './main';

const T0 = Date.parse('2026-10-09T10:00:00Z');
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-remote-monitor-11h2r1-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('the end of a run that cannot be stored', () => {
  it('run() and check() resolve and log one line', async () => {
    const log: string[] = [];
    let passes = 0;
    const schedule = new CacheSchedule({
      now: () => T0,
      log: (message) => log.push(message),
      settings: new CurrentCacheSettings({ DEVSPACE_IMAGE_SCHEDULE: '90', DEVSPACE_IMAGE_TZ: 'UTC' }, stateDir, () => {}),
      pass: async () => void passes++,
      state: { read: async () => ({}), update: async () => Promise.reject(new Error('no space left on device')) },
    });
    await expect(schedule.check()).resolves.toBeUndefined();
    await expect(schedule.run()).resolves.toBeUndefined();
    expect(passes).toBe(2);
    expect(log.filter((line) => line === 'The end of the background run could not be stored: no space left on device')).toHaveLength(2);
  });
});

describe('the state file of the background run', () => {
  it('an update keeps the fields that it does not name', async () => {
    const store = cacheRunStore(stateDir);
    await store.update({ lastCleanupAt: T0 });
    await store.update({ lastEndAt: T0 + 1 });
    expect(await store.read()).toEqual({ lastEndAt: T0 + 1, lastCleanupAt: T0 });
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, CACHE_RUN_FILE), 'utf8'))).toEqual({ lastEndAt: T0 + 1, lastCleanupAt: T0 });
  });
});

/** `monitor.js run` over the volume of the test; the loop never ends (a permanent monitor). */
function startRun(env: NodeJS.ProcessEnv, vscodeBackground: () => undefined) {
  let mono = 0;
  let out = '';
  void main(['run'], {
    env: { DEVSPACE_MONITOR_PERMANENT: '1', ...env },
    stateDir,
    engine: { ...unusedEngine(), containerSummaries: async (): Promise<EngineContainerSummary[]> => [] },
    vscodeBackground,
    lockDevspace: async () => ({ kind: 'locked', release: () => {} }),
    exec: (_file, _args, _options, callback) => callback(null, 'removed\n', ''),
    monotonic: () => mono,
    now: () => T0 + mono,
    sleep: async (ms) => {
      mono += ms;
      await new Promise(() => {});
    },
    out: (text) => (out += text),
  });
  return { out: () => out };
}

/** Lets real I/O (the reads of the volume) of a check finish while the timers are fake. */
async function settle(ms = 300): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((resolve) => setImmediate(resolve));
}

describe('monitor.js run', () => {
  it('the first check after a restart runs nothing while the stored end of the last run is younger than the interval', async () => {
    fs.writeFileSync(path.join(stateDir, CACHE_RUN_FILE), JSON.stringify({ lastEndAt: T0 - 60_000 }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const monitor = startRun({ DEVSPACE_IMAGE_FIRST_MS: '1000' }, () => undefined);
    await vi.waitFor(() => expect(monitor.out()).toContain('first check in 1 s'));
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(monitor.out()).not.toContain('The background run starts.');
  });

  it('makes the VS Code part afresh for each run (a failed proxy read counts only for that run)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    let made = 0;
    const monitor = startRun({ DEVSPACE_IMAGE_FIRST_MS: '1000', DEVSPACE_IMAGE_INTERVAL_MS: '1000' }, () => void made++);
    await vi.waitFor(() => expect(monitor.out()).toContain('first check in 1 s'));
    const atStart = made;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(monitor.out().split('The background run ended.').length - 1).toBe(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(monitor.out().split('The background run ended.').length - 1).toBe(2));
    expect(made - atStart).toBe(2);
  });
});

describe('the HTTPS of the VS Code part', () => {
  it('reads the proxy of the daemon', async () => {
    let proxyReads = 0;
    const engine = {
      ...unusedEngine(),
      proxy: async () => {
        proxyReads++;
        return {};
      },
    };
    const deps = vscodeBackgroundDeps({ DEVSPACE_VSCODE_STORE: 'devspaces-vscode' }, engine, () => {});
    const controller = new AbortController();
    const request = deps!.store.transport.request({ method: 'GET', url: 'https://127.0.0.1:1/', headers: {} }, controller.signal);
    await request.catch(() => undefined);
    expect(proxyReads).toBe(1);
  });
});

// The leftover temporary files of cache-run.json (written at the end of every background run) are removed at the start
// of `run` too.
describe('the leftover temporary files of the state of the background run', () => {
  it('are removed like those of the other files of the volume', async () => {
    const stale = 'cache-run.json.123.4.tmp';
    fs.writeFileSync(path.join(stateDir, stale), '{}');
    const old = new Date(T0 - 2 * 60 * 60_000);
    fs.utimesSync(path.join(stateDir, stale), old, old);
    expect(STATE_TEMPORARY_FILE.test(stale)).toBe(true);
    expect(await removeStaleStateTemporaryFiles(stateDir, T0)).toEqual([stale]);
  });

  // The record of the cleanup of the engine (cleanup.json, docs/requirements.md R-DS-007) is one of them.
  it('include those of the record of the cleanup of the engine', () => {
    expect(STATE_TEMPORARY_FILE.test('cleanup.json.123.4.tmp')).toBe(true);
    expect(STATE_TEMPORARY_FILE.test('cleanup.json')).toBe(false);
  });

  // The reports of the runs (runs.json, docs/requirements.md R-DS-003) too.
  it('include those of the reports of the runs', () => {
    expect(STATE_TEMPORARY_FILE.test(`${RUN_REPORTS_FILE}.123.4.tmp`)).toBe(true);
    expect(STATE_TEMPORARY_FILE.test(RUN_REPORTS_FILE)).toBe(false);
  });
});

// The short report of each run in the volume (docs/requirements.md R-DS-003): the newest first, the last 7.
describe('the reports of the background runs in the volume', () => {
  const made = (n: number): RunReport => ({ startedAt: new Date(T0 + n * 60_000).toISOString(), endedAt: new Date(T0 + n * 60_000 + 1000).toISOString(), reachedNetwork: n % 2 === 0, events: { imagePulled: { count: 1, items: [`node:${n}`] } } });

  it('adds each report first and keeps the newest MAX_RUN_REPORTS, written at once', async () => {
    const store = runReportStore(stateDir);
    expect(await store.read()).toEqual([]);
    for (let n = 1; n <= MAX_RUN_REPORTS + 2; n++) await store.add(made(n));
    const kept = await store.read();
    expect(kept).toEqual(Array.from({ length: MAX_RUN_REPORTS }, (_, i) => made(MAX_RUN_REPORTS + 2 - i)));
    expect(fs.readdirSync(stateDir)).toEqual([RUN_REPORTS_FILE]);
  });

  it('a read that fails writes nothing, so the earlier reports stay', async () => {
    // The volume folder is a file: the read of the reports fails (ENOTDIR), not "no file".
    const notAFolder = path.join(stateDir, 'not-a-folder');
    fs.writeFileSync(notAFolder, 'x');
    await expect(runReportStore(notAFolder).add(made(1))).rejects.toThrow(/ENOTDIR/);
    expect(fs.readFileSync(notAFolder, 'utf8')).toBe('x');
  });

  it('a file that is not valid, too large or a link counts as no earlier report, and is replaced', async () => {
    const file = path.join(stateDir, RUN_REPORTS_FILE);
    const store = runReportStore(stateDir);
    for (const content of ['not json', JSON.stringify({ runs: [made(1)] }) + ' '.repeat(MAX_RUN_REPORTS_FILE_BYTES)]) {
      fs.writeFileSync(file, content);
      expect(await store.read()).toEqual([]);
      await store.add(made(2));
      expect(await store.read()).toEqual([made(2)]);
    }
    const target = path.join(stateDir, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ runs: [made(3)] }));
    fs.rmSync(file);
    fs.symlinkSync(target, file);
    expect(await store.read()).toEqual([]);
    await store.add(made(4));
    // The write replaces the link; the file that it pointed to stays as it was.
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(await store.read()).toEqual([made(4)]);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ runs: [made(3)] });
  });
});

describe('the Monitor on the VM of Devspaces', () => {
  it('knows it by DEVSPACE_MONITOR_VM `1` only', () => {
    expect(vmFromEnv({ DEVSPACE_MONITOR_VM: '1' })).toBe(true);
    for (const value of [undefined, '0', 'true', '']) expect(vmFromEnv({ DEVSPACE_MONITOR_VM: value }), String(value)).toBe(false);
  });
});
