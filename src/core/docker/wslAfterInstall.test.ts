// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoragePaths } from '../storage/paths';
import { SessionFiles } from '../storage/sessionFiles';
import { WSL_AFTER_INSTALL_MAX_AGE_MS, WslAfterInstall } from './wslAfterInstall';

const START = Date.parse('2026-11-05T08:00:00.000Z');
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() });
const LINK = { path: '/course', query: 'repository=school/course-<username>' };

let root: string;
let files: SessionFiles;
let now: number;
let bootTime: number;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsl-after-install-'));
  files = new SessionFiles(new StoragePaths(root));
  now = START;
  // Windows started an hour before the installation of WSL.
  bootTime = START - 3_600_000;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function afterInstall(log = logger()): WslAfterInstall {
  return new WslAfterInstall({ files, logger: log, clock: { now: () => now }, bootTime: () => bootTime });
}

describe('WslAfterInstall', () => {
  it('waits for the restart of Windows after the installation of WSL, and then gives the record with its link to one window', async () => {
    await afterInstall().started(LINK);
    expect(await files.readWslSetupAfterInstall()).toEqual({ createdAt: '2026-11-05T08:00:00.000Z', link: LINK });
    now = START + 600_000;
    // Before the restart: the restart is missing, and no window takes the record.
    await expect(afterInstall().restartPending()).resolves.toBe(true);
    await expect(afterInstall().take('window-1')).resolves.toBeUndefined();
    expect(await files.readWslSetupAfterInstall()).toBeDefined();
    // After the restart: one window takes it, and it is gone.
    bootTime = START + 300_000;
    await expect(afterInstall().restartPending()).resolves.toBe(false);
    await expect(afterInstall().take('window-1')).resolves.toEqual({ createdAt: '2026-11-05T08:00:00.000Z', link: LINK });
    await expect(afterInstall().take('window-2')).resolves.toBeUndefined();
    expect(await files.readWslSetupAfterInstall()).toBeUndefined();
  });

  it('has no restart pending and nothing to take without a record', async () => {
    await expect(afterInstall().restartPending()).resolves.toBe(false);
    await expect(afterInstall().take('window-1')).resolves.toBeUndefined();
  });

  it('writes a record without a link for the Docker setup of the view, which replaces an older one', async () => {
    await afterInstall().started(LINK);
    now = START + 1000;
    await afterInstall().started();
    expect(await files.readWslSetupAfterInstall()).toEqual({ createdAt: '2026-11-05T08:00:01.000Z' });
  });

  it('removes a record that is too old, and does not go on with it', async () => {
    await afterInstall().started(LINK);
    now = START + WSL_AFTER_INSTALL_MAX_AGE_MS + 1;
    bootTime = now - 1000;
    const log = logger();
    await expect(afterInstall().restartPending()).resolves.toBe(false);
    await expect(afterInstall(log).take('window-1')).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('it is too old'));
    expect(await files.readWslSetupAfterInstall()).toBeUndefined();
  });

  it('forgets the record when Devspaces uses its distribution, so that no window goes on with it after a later restart', async () => {
    await afterInstall().started(LINK);
    await afterInstall().forget();
    expect(await files.readWslSetupAfterInstall()).toBeUndefined();
    bootTime = START + 300_000;
    now = START + 600_000;
    await expect(afterInstall().take('window-1')).resolves.toBeUndefined();
    // Without a record, nothing happens.
    await expect(afterInstall().forget()).resolves.toBeUndefined();
  });

  it('never throws when the record cannot be written or read', async () => {
    const broken = {
      writeWslSetupAfterInstall: vi.fn(async () => Promise.reject(new Error('EACCES'))),
      readWslSetupAfterInstall: vi.fn(async () => Promise.reject(new Error('EIO'))),
      claimWslSetupAfterInstall: vi.fn(),
      removeWslSetupAfterInstall: vi.fn(async () => Promise.reject(new Error('EBUSY'))),
    };
    const log = logger();
    const after = new WslAfterInstall({ files: broken, logger: log, clock: { now: () => now }, bootTime: () => bootTime });
    await expect(after.started()).resolves.toBeUndefined();
    await expect(after.restartPending()).resolves.toBe(false);
    await expect(after.take('window-1')).resolves.toBeUndefined();
    await expect(after.forget()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(4);
  });
});
