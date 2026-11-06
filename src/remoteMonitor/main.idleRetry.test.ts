// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// A Monitor that ends when idle waits for the retries of a background run that did not reach the network (a computer
// that woke up before its Wi-Fi or VPN), up to the retry after 30 minutes; a retry an hour later does not keep it. The
// volume is a temporary folder.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CACHE_RUN_FILE } from '../core/remoteMonitor/protocol';
import type { EngineContainerSummary } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { IDLE_RETRY_MAX_WAIT_MS } from './backgroundRules';
import { CacheSchedule, CurrentCacheSettings, cacheRunStore, main } from './main';

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-09T10:00:00Z');
const DAILY = { DEVSPACE_IMAGE_SCHEDULE: '7 6 * * *', DEVSPACE_IMAGE_TZ: 'UTC' };
const WAITING = 'did not reach the network and is tried again at';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-monitor-idle-retry-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const store = (state: Record<string, unknown>) => fs.writeFileSync(path.join(stateDir, CACHE_RUN_FILE), JSON.stringify(state));
const occurrences = (text: string, part: string) => text.split(part).length - 1;

describe('the retry that a Monitor that ends when idle waits for', () => {
  it('is the waiting retry up to the one after 30 minutes, none after a run that reached the network, none while paused', async () => {
    expect(IDLE_RETRY_MAX_WAIT_MS).toBe(30 * MINUTE);
    let time = T0;
    let paused = false;
    const reached = [false, false, false, false, false, false, true];
    const schedule = new CacheSchedule({
      now: () => time,
      log: () => {},
      settings: new CurrentCacheSettings(DAILY, stateDir, () => {}),
      pass: async () => reached.shift() ?? true,
      state: cacheRunStore(stateDir),
      paused: () => paused,
    });
    expect(schedule.heldRetryAt).toBeUndefined();
    await schedule.check();
    // The retries after 2, 5, 10, 20 and 30 minutes keep it.
    for (const wait of [2, 5, 10, 20, 30]) {
      expect(schedule.heldRetryAt).toBe(time + wait * MINUTE);
      paused = true;
      expect(schedule.heldRetryAt).toBeUndefined();
      paused = false;
      time += wait * MINUTE;
      await schedule.check();
    }
    // The sixth run did not reach the network either: the retry an hour later does not keep it.
    expect(schedule.heldRetryAt).toBeUndefined();
    time += 60 * MINUTE;
    await schedule.check();
    expect(reached).toEqual([]);
    expect(schedule.heldRetryAt).toBeUndefined();
  });
});

describe('the idle exit while a retry waits', () => {
  /**
   * A monitor that ends when idle over the stored state of the test; its loop waits at its first tick for the first
   * check of the schedule (which reads the stored retry), and stops after `maxTicks` ticks.
   */
  async function runMonitor(maxTicks: number) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    let mono = 0;
    let ticks = 0;
    let out = '';
    let stopped!: () => void;
    const reachedEnd = new Promise<void>((resolve) => (stopped = resolve));
    // The check asks for the time after it read the stored state; the loop waits at its first tick, so the check is the
    // only one that asks once it is armed.
    let armed = false;
    let checked!: () => void;
    const firstCheck = new Promise<void>((resolve) => (checked = resolve));
    const result = main(['run'], {
      env: { ...DAILY, DEVSPACE_IMAGE_FIRST_MS: '1000' },
      stateDir,
      engine: { ...unusedEngine(), containerSummaries: async (): Promise<EngineContainerSummary[]> => [] },
      vscodeBackground: () => undefined,
      lockDevspace: async () => ({ kind: 'locked', release: () => {} }),
      exec: (_file, _args, _options, callback) => callback(null, 'removed\n', ''),
      monotonic: () => mono,
      now: () => {
        if (armed) checked();
        return T0 + mono;
      },
      sleep: async (ms) => {
        ticks += 1;
        if (ticks === 1) await firstCheck;
        mono += ms;
        if (ticks >= maxTicks) {
          stopped();
          await new Promise(() => {});
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      out: (text) => (out += text),
    });
    let exited: number | undefined;
    void result.then((code) => (exited = code));
    await vi.waitFor(() => expect(out).toContain('first check in 1 s'));
    armed = true;
    await vi.advanceTimersByTimeAsync(1_000);
    return { result, reachedEnd, out: () => out, exited: () => exited, mono: () => mono };
  }

  it('stays while the retry after 10 minutes waits, and logs it once', async () => {
    store({ lastEndAt: T0 - 24 * 60 * MINUTE, retryAt: T0 + 25 * MINUTE, retries: 3, lastAttemptAt: T0 - 10 * MINUTE });
    const monitor = await runMonitor(60);
    await monitor.reachedEnd;
    // 60 ticks of 15 s: longer than the idle time of 5 minutes, shorter than the wait for the retry.
    expect(monitor.mono()).toBeGreaterThan(5 * MINUTE);
    expect(monitor.mono()).toBeLessThan(25 * MINUTE);
    expect(monitor.exited()).toBeUndefined();
    expect(occurrences(monitor.out(), WAITING)).toBe(1);
    expect(monitor.out()).toContain(`${WAITING} ${new Date(T0 + 25 * MINUTE).toISOString()}; the Monitor waits for it.`);
    expect(monitor.out()).not.toContain('the Monitor exits.');
  });

  it('exits when idle while the retry an hour later waits', async () => {
    store({ lastEndAt: T0 - 24 * 60 * MINUTE, retryAt: T0 + 50 * MINUTE, retries: 6, lastAttemptAt: T0 - 10 * MINUTE });
    const monitor = await runMonitor(200);
    expect(await monitor.result).toBe(0);
    expect(monitor.out()).not.toContain(WAITING);
    expect(monitor.out()).toContain('the Monitor exits. The next open starts it again.');
  });
});
