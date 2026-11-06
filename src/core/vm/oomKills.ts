// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The processes that the kernel of an engine ended because the memory ran out (R-VM-006): the worker reads the counter
// `oom_kill` of /proc/vmstat and the boot id of the kernel that it runs on (a container sees both of the kernel of its
// engine, without a capability), and gives them with the answer of each heartbeat. The window compares them with those
// of the heartbeat before on that engine. No `vscode`.
import { readFileSync } from 'fs';
import { hasOnlyKeys, isRecord } from '../valueChecks';

/** The number of the processes that the kernel ended because the memory ran out, since its start `boot`. */
export interface OomKills {
  /** /proc/sys/kernel/random/boot_id: a new one at each start of the kernel, where the counter starts at 0. */
  boot: string;
  count: number;
}

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The strict check of OomKills (both sides of the helper channel). */
export function parseOomKills(value: unknown): OomKills | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['boot', 'count'])) return undefined;
  const { boot, count } = value;
  if (typeof boot !== 'string' || !BOOT_ID.test(boot)) return undefined;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? { boot, count } : undefined;
}

/** The counter `oom_kill` of the text of /proc/vmstat; undefined without it (a kernel older than 4.13). */
export function vmstatOomKills(vmstat: string): number | undefined {
  const match = /^oom_kill (\d+)$/m.exec(vmstat);
  if (match === null) return undefined;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) ? count : undefined;
}

/** The OomKills of the kernel that this process runs on (in the worker: of its engine); undefined when unreadable. */
export function readOomKills(read: (path: string) => string = (path) => readFileSync(path, 'utf8')): OomKills | undefined {
  try {
    return parseOomKills({ boot: read('/proc/sys/kernel/random/boot_id').trim(), count: vmstatOomKills(read('/proc/vmstat')) });
  } catch {
    return undefined;
  }
}

export interface OomWatchDeps {
  /** Every increase of the counter of an engine, with the processes that it added: for the log. */
  log: (host: string, added: number) => void;
  /** The first increase in a start of the kernel of an engine: for a message. The VM gets more memory only at its next start. */
  warn: (host: string, added: number) => void;
}

/**
 * The counters of the engines of this window, by the Docker host of each one ('' for the local Docker). The first one
 * of an engine is only kept: what the kernel ended before, this window did not see. Another boot id is a new start of
 * the kernel, whose counter started at 0, so all its processes are new.
 */
export class OomWatch {
  private readonly last = new Map<string, OomKills>();
  private readonly warnedBoot = new Map<string, string>();

  constructor(private readonly deps: OomWatchDeps) {}

  seen(host: string, kills: OomKills): void {
    const before = this.last.get(host);
    this.last.set(host, kills);
    if (before === undefined) return;
    const added = before.boot === kills.boot ? kills.count - before.count : kills.count;
    if (added <= 0) return;
    this.deps.log(host, added);
    if (this.warnedBoot.get(host) === kills.boot) return;
    this.warnedBoot.set(host, kills.boot);
    this.deps.warn(host, added);
  }
}
