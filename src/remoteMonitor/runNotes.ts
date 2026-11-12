// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The events of the current background run for its report (src/core/remoteMonitor/runReport.ts): the parts of the
// run (images.ts, helperRefresh.ts, engineCleanup.ts, background.ts, extensionDownloads.ts, prepares.ts) call noteRun
// next to the line of the log that they write. The run gives its collector with withRunNotes, and the collector
// follows the asynchronous work of the run (AsyncLocalStorage), so that the parts need no new argument. Work that is
// not part of a run (a command of a window) notes nothing. No `vscode`.
import { AsyncLocalStorage } from 'async_hooks';
import type { RunEvent, RunReportBuilder } from '../core/remoteMonitor/runReport';

const current = new AsyncLocalStorage<RunReportBuilder>();

/** Runs `work` with `notes` as the collector of the events (noteRun) of everything that it starts. */
export function withRunNotes<T>(notes: RunReportBuilder, work: () => Promise<T>): Promise<T> {
  return current.run(notes, work);
}

/** One event of the current run (or `count` of one kind), with its name; nothing outside a run. Never throws. */
export function noteRun(event: RunEvent, item?: string, count?: number): void {
  try {
    current.getStore()?.note(event, item, count);
  } catch {
    // The report is information only: a failure never stops the run.
  }
}
