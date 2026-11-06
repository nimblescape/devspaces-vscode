// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The settings of the Monitor of an engine that extension.ts gives to an open (by the Docker host of the open) and to
// the repair of the heartbeats and "Update All Images Now" (by the Docker target): the schedule of its background run
// (cacheUpdateSchedule), the time zone of this computer, and its mode (R-DS-003, monitorRunsPermanently): permanent on
// a remote host unless stopMonitorWhenIdle is on; on the WSL distribution or VM of Devspaces and on the Docker of the
// computer it always ends when idle. A permanent one names this computer as its owner (its computer ID). No image
// patterns. Pure apart from the getters it is given; no `vscode`.
import type { DockerTarget } from '../core/docker/dockerHost';
import { hostAccessOf } from '../core/docker/dockerHost';
import { DEFAULT_CACHE_UPDATE_SCHEDULE, monitorRunsPermanently } from '../core/remoteMonitor/cacheSettings';
import type { MonitorSettings } from '../core/remoteMonitor/protocol';
import type { ExtensionSettings } from '../core/types';

export interface MonitorSettingsDeps {
  settings: () => Pick<ExtensionSettings, 'cacheUpdateSchedule' | 'stopMonitorWhenIdle'>;
  /** The time zone of this computer (usableTimeZone). */
  timeZone: () => string;
  /**
   * The ID of this computer (computer.id, 32 hex digits): the owner of a permanent monitor that it asks for. A failure to
   * read it leaves it out (an ensure without it keeps any running permanent monitor), so it never fails an open.
   */
  computerId: () => string;
}

/** The settings of the monitor of the engine `host` of this computer ('' for the Docker of the computer). Never throws. */
export function monitorSettingsFor(deps: MonitorSettingsDeps, host: string): MonitorSettings {
  return {
    schedule: deps.settings().cacheUpdateSchedule ?? DEFAULT_CACHE_UPDATE_SCHEDULE,
    timeZone: deps.timeZone(),
    // Only a remote host that Devspaces reaches over SSH counts as remote.
    permanent: monitorRunsPermanently(deps.settings().stopMonitorWhenIdle, hostAccessOf(host)?.kind === 'ssh'),
    // This computer: the owner of a permanent monitor that it creates (LABEL_MONITOR_OWNER), and how an ensure tells
    // its own permanent monitor from one that another computer keeps.
    ...computerOf(deps),
  };
}

/** `{ computer }` with the ID of this computer, or nothing when it cannot be read. */
function computerOf(deps: MonitorSettingsDeps): { computer?: string } {
  try {
    return { computer: deps.computerId() };
  } catch {
    return {};
  }
}

/**
 * The monitor settings of an open (its Docker host: empty for the Docker of the computer) and of the repair or "Update
 * All Images Now" on a Docker target: the same rules for every engine.
 */
export function monitorSettingsOf(deps: MonitorSettingsDeps): {
  forOpen(dockerHost: string): Promise<MonitorSettings>;
  forTarget(target: Pick<DockerTarget, 'kind' | 'host'>): Promise<MonitorSettings>;
} {
  return {
    forOpen: async (dockerHost) => monitorSettingsFor(deps, dockerHost),
    forTarget: async (target) => monitorSettingsFor(deps, target.host),
  };
}
