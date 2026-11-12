// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The loop of `run` and the merge of identical devspace images (R-DS-010, D6; imageMerge.ts): a pass between two
// ticks when it is due, and one right before a monitor that ends when idle exits. The volume is a temporary folder; the
// engine and the merge are fakes.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LABEL_DEVSPACE_ID } from '../core/names';
import type { DockerEngine, EngineContainerSummary } from '../core/worker/dockerEngine';
import { unusedEngine } from '../core/worker/dockerEngine.testkit';
import { main } from './main';

const T0 = Date.parse('2026-11-12T10:00:00Z');

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-monitor-merge-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/**
 * `run` with a fake merge that is due at the ticks of `dueAt` (0 = the first look); it ends at the latest after `maxTicks`
 * ticks. `idle`: no devspace runs, and each tick takes longer than the idle time of the monitor (100 ms).
 */
async function run(dueAt: readonly number[], maxTicks = 4, idle = false) {
  let mono = 0;
  let ticks = 0;
  let looks = 0;
  const events: string[] = [];
  const engine: DockerEngine = {
    ...unusedEngine(),
    containerSummaries: async (label): Promise<EngineContainerSummary[]> => {
      if (label !== LABEL_DEVSPACE_ID) return [];
      events.push('tick');
      if (!idle) return [{ id: 'b'.repeat(64), name: 'devspace', state: 'running', labels: {} }];
      mono += 200;
      return [];
    },
  };
  const code = await main(['run'], {
    env: { DEVSPACE_IMAGE_FIRST_MS: '86400000', ...(idle ? { DEVSPACE_MONITOR_IDLE_MS: '100' } : {}) },
    stateDir,
    engine: engine as never,
    vscodeBackground: () => undefined,
    lockDevspace: async () => ({ kind: 'locked', release: () => {} }),
    imageMerge: {
      due: () => dueAt.includes(looks++),
      pass: async () => void events.push('merge'),
    },
    monotonic: () => mono,
    now: () => T0 + mono,
    sleep: async (ms) => {
      ticks += 1;
      mono += ms;
      if (ticks >= maxTicks) throw new Error('ended by the test');
    },
    out: () => {},
  }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  return { code, events };
}

describe('the loop of run and the merge of identical devspace images', () => {
  it('runs a pass between two ticks when it is due, and none when it is not', async () => {
    const { code, events } = await run([1, 2]);
    expect(code).toBe('ended by the test');
    expect(events).toEqual(['tick', 'tick', 'merge', 'tick', 'merge', 'tick']);
  });

  it('runs a pass right before a monitor that ends when idle exits, also when none is due', async () => {
    const { code, events } = await run([], 4, true);
    expect(code).toBe(0);
    expect(events).toEqual(['tick', 'merge']);
  });
});
