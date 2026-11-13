// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The parts of a report of a resource of the view Docker Hosts (docs/requirements.md R-ENG-008): sections of facts or
// tables, each with the place its values come from, and colored tags that give the rule of Devspaces for an item. The
// report page (src/vscode) shows them as they are. The texts of times and sizes. Pure; no I/O.
import { formatSize } from './hostObjects';

/**
 * The color of a tag: `keep` kept or up to date, `remove` removed or replaced soon, `info` a rule of Devspaces, `warn`
 * failed or at risk, `new` a record that is new.
 */
export type ReportTone = 'keep' | 'remove' | 'info' | 'warn' | 'new';

export interface ReportChip {
  text: string;
  tone: ReportTone;
}

/** A value of a fact or a cell of a table, with a tag when a rule of Devspaces applies to it. */
export interface ReportCell {
  text: string;
  chip?: ReportChip;
}

export interface ReportFact {
  label: string;
  value: ReportCell;
}

export type ReportBody =
  | { kind: 'facts'; facts: ReportFact[] }
  /** `more`: a line under the rows (for example the number of the rows that are left out). `empty`: the text without rows. */
  | { kind: 'table'; columns: string[]; rows: ReportCell[][]; more?: string; empty?: string };

export interface ReportSection {
  title: string;
  chip?: ReportChip;
  body: ReportBody;
  /** Where the values come from, in words. */
  from: string;
}

/** The content of a report: the tags of its summary, its sections, and notes on what could not be read. */
export interface ReportContent {
  summary: ReportChip[];
  sections: ReportSection[];
  /** What could not be read, in words (for example that the reader of the volumes found no image). */
  notices: string[];
  /** The report offers Show Log of the Monitor: the report of its container or of its volume. */
  monitorLog: boolean;
  /**
   * The report of any other container offers Show Log of its log: its full ID. Not for a container whose log driver gives
   * no log (`none`).
   */
  containerLog?: string;
}

export function cell(text: string, chip?: ReportChip): ReportCell {
  return chip === undefined ? { text } : { text, chip };
}

export function fact(label: string, text: string, chip?: ReportChip): ReportFact {
  return { label, value: cell(text, chip) };
}

export function chip(text: string, tone: ReportTone): ReportChip {
  return { text, tone };
}

/** The clock of a report: now, and the time zone of this computer, in which it gives times. */
export interface ReportClock {
  now: number;
  timeZone: string;
}

const DAY_MS = 24 * 60 * 60_000;

/** One formatter per time zone: a report gives hundreds of times. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** The date of `at` in `timeZone` as YYYY-MM-DD, and its time as HH:MM. */
function dateAndTime(at: number, timeZone: string): { date: string; time: string } {
  let format = FORMATTERS.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
    FORMATTERS.set(timeZone, format);
  }
  const parts = format.formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

/** One formatter per time zone for the times of a log (with seconds and milliseconds). */
const LOG_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** A time as `2026-11-12 22:07:25.606` in `timeZone`: the times of the lines of a log (Show Log). */
export function logTimeText(at: number, timeZone: string): string {
  let format = LOG_FORMATTERS.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h23',
      timeZone,
    });
    LOG_FORMATTERS.set(timeZone, format);
  }
  const parts = format.formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}.${part('fractionalSecond')}`;
}

/** The calendar date `days` after the date `date` (YYYY-MM-DD), by the calendar, so a day of 23 or 25 hours counts as one. */
function dateAfter(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The dates of today, yesterday and tomorrow of a clock, found once for all the times of a report. */
const DAYS = new WeakMap<ReportClock, { now: number; timeZone: string; today: string; yesterday: string; tomorrow: string }>();

/**
 * A time as `today 06:07`, `yesterday 06:07`, `tomorrow 06:07`, else `2026-11-10 06:07`, in the time zone of the clock;
 * `an invalid time` for a number that is no time of a Date (a record can hold one).
 */
export function timeText(at: number, clock: ReportClock): string {
  if (Number.isNaN(new Date(at).getTime())) return 'an invalid time';
  const { date, time } = dateAndTime(at, clock.timeZone);
  let days = DAYS.get(clock);
  if (days === undefined || days.now !== clock.now || days.timeZone !== clock.timeZone) {
    const today = dateAndTime(clock.now, clock.timeZone).date;
    days = { now: clock.now, timeZone: clock.timeZone, today, yesterday: dateAfter(today, -1), tomorrow: dateAfter(today, 1) };
    DAYS.set(clock, days);
  }
  if (date === days.today) return `today ${time}`;
  if (date === days.yesterday) return `yesterday ${time}`;
  if (date === days.tomorrow) return `tomorrow ${time}`;
  return `${date} ${time}`;
}

/** A time of Docker as timeText (dockerTime); undefined for none, for one that does not parse, and for year 1 (never). */
export function dockerTimeText(value: string | undefined, clock: ReportClock): string | undefined {
  const at = dockerTime(value);
  return at === undefined ? undefined : timeText(at, clock);
}

/** The form of a time in the lists of the Docker CLI (`2026-11-10 06:07:08 +0100 CET`). */
const CLI_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) ([+-]\d{2})(\d{2})(?: \S+)?$/;

/**
 * A time of Docker in milliseconds: ISO 8601 (of an inspect) or the form of the lists of the Docker CLI; undefined for
 * none, for one that does not parse, and for year 1.
 */
export function dockerTime(value: string | undefined): number | undefined {
  if (value === undefined || value.startsWith('0001-')) return undefined;
  const cli = CLI_TIME.exec(value);
  const at = Date.parse(cli !== null ? `${cli[1]}T${cli[2]}${cli[3]}:${cli[4]}` : value);
  return Number.isNaN(at) ? undefined : at;
}

/**
 * A span of time in words, in its largest unit that rounds to at least 1: `20 s`, `5 minutes`, `3 hours`, `9 days`
 * (hours up to 2 days).
 */
export function spanText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(ms / DAY_MS);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** How long ago `at` was: `20 s ago`, `5 minutes ago`, `3 hours ago`, `9 days ago`; `in 5 minutes` for a time ahead. */
export function ageText(at: number, now: number): string {
  const text = spanText(Math.abs(now - at));
  return at > now ? `in ${text}` : `${text} ago`;
}

/** A size, `complete: false` with the word "at least" (a size that a limit of the reader cut). */
export function sizeText(bytes: number, complete = true): string {
  return complete ? formatSize(bytes) : `at least ${formatSize(bytes)}`;
}

/** `count` with the noun, in the plural when it is not 1: `1 file`, `3 files`. */
export function countText(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

/** The first 12 hex digits of a digest or an ID (`sha256:` left out). */
export { shortImageId as shortDigest } from './hostObjects';

/** The items of a list as one text: the first `max`, then `and N more`. */
export function itemsText(items: readonly string[], max = 3): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

/** `{ [key]: value }`, or no field when `value` is undefined (for optional fields under exactOptionalPropertyTypes). */
export function optional<K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, T>);
}
