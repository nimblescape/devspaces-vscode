// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The events of the current background run for its report (docs/requirements.md R-DS-003): the collector of a run
// follows its asynchronous work; work outside a run notes nothing, and two collectors never mix.
import { describe, expect, it } from 'vitest';
import { RunReportBuilder } from '../core/remoteMonitor/runReport';
import { noteRun, withRunNotes } from './runNotes';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('the events of the current run', () => {
  it('follow the asynchronous work of the run, also after a timer', async () => {
    const notes = new RunReportBuilder(0);
    const result = await withRunNotes(notes, async () => {
      noteRun('imagePulled', 'node:24');
      await tick();
      await Promise.all([
        (async () => {
          await tick();
          noteRun('serverAdded', 'a');
        })(),
        (async () => noteRun('serverAdded', 'b'))(),
      ]);
      return 'done';
    });
    expect(result).toBe('done');
    expect(notes.finish(0, true).events).toEqual({ imagePulled: { count: 1, items: ['node:24'] }, serverAdded: { count: 2, items: ['b', 'a'] } });
  });

  it('outside a run, an event is noted nowhere and never throws', async () => {
    expect(() => noteRun('imagePulled', 'node:24')).not.toThrow();
    const notes = new RunReportBuilder(0);
    // Work started before the run is not part of it.
    const before = tick().then(() => noteRun('imageRemoved', 'outside'));
    await withRunNotes(notes, async () => {
      await before;
      noteRun('imagePulled', 'inside');
    });
    expect(notes.finish(0, true).events).toEqual({ imagePulled: { count: 1, items: ['inside'] } });
  });

  it('two runs at the same time keep their own events', async () => {
    const first = new RunReportBuilder(0);
    const second = new RunReportBuilder(0);
    await Promise.all([
      withRunNotes(first, async () => {
        await tick();
        noteRun('imagePulled', 'first');
      }),
      withRunNotes(second, async () => {
        noteRun('imagePulled', 'second');
        await tick();
      }),
    ]);
    expect(first.finish(0, true).events.imagePulled?.items).toEqual(['first']);
    expect(second.finish(0, true).events.imagePulled?.items).toEqual(['second']);
  });
});
