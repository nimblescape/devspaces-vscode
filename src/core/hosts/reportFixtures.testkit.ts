// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Shared values of the tests of the reports of the view Docker Hosts (only the tests import this file).
import type { ReportClock } from './reportModel';
import type { MonitorFile } from './volumeReader';

export const SOURCE = '0123456789abcdef0123456789abcdef';
export const OTHER_SOURCE = 'fedcba9876543210fedcba9876543210';
export const DEVSPACE = '11111111-2222-3333-4444-555555555555';
export const OTHER_DEVSPACE = '66666666-7777-8888-9999-000000000000';
export const HASH = 'c'.repeat(64);
export const HELPER = 'devspaces-worker:0123456789ab';
/** 2026-11-12 09:00 in Vienna (08:00 UTC). */
export const NOW = Date.UTC(2026, 10, 12, 8, 0);
export const CLOCK: ReportClock = { now: NOW, timeZone: 'Europe/Vienna' };
export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;

/** A record of the volume of the Monitor with `value` as its JSON text. */
export function monitorFile(path: string, value: unknown, modifiedAt = NOW - HOUR): MonitorFile {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { path, bytes: Buffer.byteLength(text), modifiedAt, text };
}
