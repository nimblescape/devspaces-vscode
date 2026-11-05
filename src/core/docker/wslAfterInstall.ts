// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The setup of Docker for Devspaces on Windows after the installation of WSL 2 (docs/requirements.md R-ENG-005): WSL 2
// runs only after the restart of Windows that its installation asks for. Devspaces writes a record when it starts the
// installation (wsl-setup-after-install.json). Until Windows restarts, a setup says that the restart is missing, before
// any download; the first window after the restart goes on with the setup, and with the link that needed it
// (Controller.goOnAfterWslInstall). No `vscode`.
import * as os from 'os';
import { errorMessage } from '../errors';
import { isoTime, systemClock, type Clock, type Logger } from '../ports';
import type { SessionFiles } from '../storage/sessionFiles';
import type { LinkUri, WslSetupAfterInstall } from '../types';

/** A record older than this does not go on, and is removed: the installation of WSL started too long ago. */
export const WSL_AFTER_INSTALL_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

export interface WslAfterInstallDeps {
  files: Pick<SessionFiles, 'writeWslSetupAfterInstall' | 'readWslSetupAfterInstall' | 'claimWslSetupAfterInstall' | 'removeWslSetupAfterInstall'>;
  logger: Logger;
  clock?: Clock;
  /** The time of the last start of Windows, in milliseconds. Default: now minus `os.uptime()`. */
  bootTime?: () => number;
}

export class WslAfterInstall {
  private readonly clock: Clock;

  constructor(private readonly deps: WslAfterInstallDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Devspaces starts the installation of WSL, for the link `link` or for the Docker setup. Never throws (logged). */
  async started(link?: LinkUri): Promise<void> {
    const record: WslSetupAfterInstall = { createdAt: isoTime(this.clock), ...(link !== undefined ? { link } : {}) };
    try {
      await this.deps.files.writeWslSetupAfterInstall(record);
    } catch (error) {
      this.deps.logger.warn(`Devspaces could not note that it installs WSL, so it does not go on by itself after the restart of Windows: ${errorMessage(error)}`);
    }
  }

  /**
   * True while Windows has not restarted since Devspaces started the installation of WSL (a record that is not too old,
   * from after the last start of Windows). Never throws (false, logged).
   */
  async restartPending(): Promise<boolean> {
    try {
      const record = await this.deps.files.readWslSetupAfterInstall();
      return record !== undefined && this.fresh(record) && !this.restartedSince(record);
    } catch (error) {
      this.deps.logger.warn(`Devspaces could not read whether it installed WSL: ${errorMessage(error)}`);
      return false;
    }
  }

  /**
   * The record for this window after the restart of Windows: only one window gets it (SessionFiles
   * .claimWslSetupAfterInstall), and it is gone afterwards. Undefined without a record, before the restart (the record
   * stays), when another window took it, or when it is too old (then it is removed). Never throws (logged).
   */
  async take(windowId: string): Promise<WslSetupAfterInstall | undefined> {
    const { files, logger } = this.deps;
    try {
      const record = await files.readWslSetupAfterInstall();
      if (record === undefined) return undefined;
      if (!this.fresh(record)) {
        logger.info(`The setup of Docker for Devspaces after the installation of WSL on ${record.createdAt} does not go on: it is too old.`);
        await files.removeWslSetupAfterInstall();
        return undefined;
      }
      if (!this.restartedSince(record)) return undefined;
      return await files.claimWslSetupAfterInstall(windowId);
    } catch (error) {
      logger.warn(`The setup of Docker for Devspaces after the installation of WSL could not go on: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Devspaces uses its WSL distribution (also when the installation of WSL needed no restart): the record goes, so that no
   * window goes on with it after a later restart. Never throws (logged).
   */
  async forget(): Promise<void> {
    try {
      await this.deps.files.removeWslSetupAfterInstall();
    } catch (error) {
      this.deps.logger.warn(`Devspaces could not remove its note of the installation of WSL: ${errorMessage(error)}`);
    }
  }

  private fresh(record: WslSetupAfterInstall): boolean {
    return Math.abs(this.clock.now() - Date.parse(record.createdAt)) <= WSL_AFTER_INSTALL_MAX_AGE_MS;
  }

  /** Windows started after Devspaces started the installation of WSL. */
  private restartedSince(record: WslSetupAfterInstall): boolean {
    const bootTime = this.deps.bootTime?.() ?? this.clock.now() - os.uptime() * 1000;
    return bootTime > Date.parse(record.createdAt);
  }
}
