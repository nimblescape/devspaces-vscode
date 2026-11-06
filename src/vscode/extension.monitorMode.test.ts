// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// extension.ts gives the Monitor of an engine the schedule of its background run (cacheUpdateSchedule), its mode
// (R-DS-003: permanent on a remote host unless stopMonitorWhenIdle is on; on the WSL distribution or VM of Devspaces
// and on the Docker of the computer it always ends when idle) and the ID of this computer. The settings come from
// monitorSettings.ts and are tested by their result; only that extension.ts calls them with the Docker host of the open
// and the target of the repair is read from its source (extension.ts cannot be loaded without VS Code).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { LIMA_HOST, WSL_HOST } from '../core/docker/dockerHost';
import { monitorSettingsOf, type MonitorSettingsDeps } from './monitorSettings';

const COMPUTER = 'c'.repeat(32);

const deps = (settings: ReturnType<MonitorSettingsDeps['settings']>): MonitorSettingsDeps => ({
  settings: () => settings,
  timeZone: () => 'Europe/Vienna',
  computerId: () => COMPUTER,
});

describe('the monitor settings of extension.ts', () => {
  // The default is daily at 06:07; the settings carry no prefixes.
  it('the schedule of cacheUpdateSchedule (default daily at 06:07) and the time zone', async () => {
    const settings = monitorSettingsOf(deps({ cacheUpdateSchedule: '60' }));
    expect(await settings.forOpen('user@host')).toEqual({ schedule: '60', timeZone: 'Europe/Vienna', permanent: true, computer: COMPUTER });
    expect((await monitorSettingsOf(deps({})).forOpen('')).schedule).toBe('7 6 * * *');
  });

  it('the mode on a remote host: permanent unless stopMonitorWhenIdle is on', async () => {
    for (const stop of [true, false, undefined]) {
      const settings = monitorSettingsOf(deps(stop === undefined ? {} : { stopMonitorWhenIdle: stop }));
      for (const host of ['user@host', 'build-box', 'me@10.0.0.5:2222']) {
        for (const each of [await settings.forOpen(host), await settings.forTarget({ kind: 'remote', host })]) {
          expect(each, `${host} ${String(stop)}`).toEqual({ schedule: '7 6 * * *', timeZone: 'Europe/Vienna', permanent: stop !== true, computer: COMPUTER });
        }
      }
    }
  });

  // The next start of a devspace there starts it again.
  it('the mode on the WSL distribution or VM of Devspaces and on the Docker of the computer: always ends when idle, whatever the setting says', async () => {
    for (const stop of [true, false, undefined]) {
      const settings = monitorSettingsOf(deps(stop === undefined ? {} : { stopMonitorWhenIdle: stop }));
      for (const host of ['', WSL_HOST, LIMA_HOST]) {
        expect((await settings.forOpen(host)).permanent, `${host} ${String(stop)}`).toBe(false);
      }
      expect((await settings.forTarget({ kind: 'local', host: '' })).permanent, String(stop)).toBe(false);
      expect((await settings.forTarget({ kind: 'remote', host: WSL_HOST })).permanent, String(stop)).toBe(false);
      expect((await settings.forTarget({ kind: 'unsupported', host: 'tcp://10.0.0.5:2375' })).permanent, String(stop)).toBe(false);
    }
  });

  it('a computer ID that cannot be read is left out, and the open goes on', async () => {
    const settings = monitorSettingsOf({
      ...deps({}),
      computerId: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(await settings.forOpen('build-box')).toEqual({ schedule: '7 6 * * *', timeZone: 'Europe/Vienna', permanent: true });
  });

  it('extension.ts gives an open the settings of its Docker host, and a repair and "Update All Images Now" those of their target', () => {
    const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');
    // No image list of imageLists.
    expect(source).toContain('openMonitor: async (dockerHost) => ({ images: await monitorSettings.forOpen(dockerHost) }),');
    expect(source).not.toContain('imageLists');
    expect(source).not.toContain('read:packages');
    expect(source).toContain('monitorCalls.monitorEnsure(target, await monitorSettings.forTarget(target), signal)');
    expect(source).toContain('monitorCalls.monitorRunNow(target, await monitorSettings.forTarget(target), signal)');
    // No question about the Monitor, and no answer.
    expect(source).not.toContain('MonitorQuestion');
    expect(source).not.toContain('monitorAnswered');
    // The WSL distribution of Devspaces has no rule of its own: it never starts for the Monitor, and it has no start
    // entry at the logon to Windows.
    expect(source).not.toContain('monitorPermanent');
    expect(source).not.toContain('StartEntry');
    expect(source).not.toContain('imageUpdateSchedule ??');
  });
});
