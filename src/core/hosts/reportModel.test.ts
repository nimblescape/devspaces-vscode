// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The texts of times, spans, sizes and lists of the reports of the view Docker Hosts (docs/requirements.md R-ENG-008):
// a time in the time zone of this computer, with today, yesterday and tomorrow by its days.
import { describe, expect, it } from 'vitest';
import { CLOCK, DAY, HOUR, NOW } from './reportFixtures.testkit';
import { ageText, countText, dockerTime, dockerTimeText, itemsText, shortDigest, sizeText, spanText, timeText } from './reportModel';

describe('the texts of a report', () => {
  it('gives a time in the time zone of this computer, by its day', () => {
    expect(timeText(NOW, CLOCK)).toBe('today 09:00');
    expect(timeText(NOW - 9 * HOUR - 30 * 60_000, CLOCK)).toBe('yesterday 23:30');
    expect(timeText(NOW + 15 * HOUR, CLOCK)).toBe('tomorrow 00:00');
    expect(timeText(NOW - 3 * DAY, CLOCK)).toBe('2026-11-09 09:00');
    expect(timeText(NOW, { now: NOW, timeZone: 'UTC' })).toBe('today 08:00');
    // A record can hold a safe integer that is no time of a Date.
    expect(timeText(9_000_000_000_000_000, CLOCK)).toBe('an invalid time');
  });

  it('reads the times of Docker, and takes year 1 as never', () => {
    expect(dockerTime('2026-11-12T08:00:00.123456789Z')).toBe(NOW + 123);
    expect(dockerTime('0001-01-01T00:00:00Z')).toBeUndefined();
    expect(dockerTime('soon')).toBeUndefined();
    // The form of the lists of the Docker CLI.
    expect(dockerTime('2026-11-12 09:00:00 +0100 CET')).toBe(NOW);
    expect(dockerTime('2026-11-12 08:00:00.5 +0000 UTC')).toBe(NOW + 500);
    expect(dockerTimeText(undefined, CLOCK)).toBeUndefined();
    expect(dockerTimeText('2026-11-12T08:00:00Z', CLOCK)).toBe('today 09:00');
  });

  it('gives ages, spans, sizes, counts, digests and lists in words', () => {
    expect(ageText(NOW - 20_000, NOW)).toBe('20 s ago');
    expect(ageText(NOW - 60_000, NOW)).toBe('1 minute ago');
    expect(ageText(NOW - 3 * HOUR, NOW)).toBe('3 hours ago');
    expect(ageText(NOW - 9 * DAY, NOW)).toBe('9 days ago');
    expect(ageText(NOW + 5 * 60_000, NOW)).toBe('in 5 minutes');
    expect(spanText(600_000)).toBe('10 minutes');
    expect(spanText(14 * DAY)).toBe('14 days');
    expect(sizeText(1024 * 1024)).toBe('1 MB');
    expect(sizeText(1024 * 1024, false)).toBe('at least 1 MB');
    expect(countText(1, 'file')).toBe('1 file');
    expect(countText(2, 'download failed', 'downloads failed')).toBe('2 downloads failed');
    expect(shortDigest(`sha256:${'ab'.repeat(32)}`)).toBe('abababababab');
    expect(itemsText(['a', 'b', 'c'])).toBe('a, b, c');
    expect(itemsText(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
  });
});
