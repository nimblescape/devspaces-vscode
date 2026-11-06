// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Lima VM of Devspaces as a Docker host (docs/architecture.md "The Lima VM of Devspaces", R-VM-001): before each
// transport to it (a shell before the relay, a connection of the relay, or a Docker connection of the extension),
// Devspaces makes sure that the pinned Lima is installed (lima.ts) and that the VM runs, and starts it when it is
// stopped. Nothing keeps the VM running: the idle check in the VM powers it off when nothing runs there. The calls of
// this extension host at the same time share one check and one start. No `vscode`.
import { untilAborted, type Logger, type ProcessRunner } from '../ports';
import { installLima, type InstallLimaOptions } from './lima';
import { LimaInstance, limaPaths, type LimaPaths } from './limaInstance';

/**
 * How long a VM that was found running counts as running without a new check: the idle check powers the VM off only
 * after two checks in a row a minute apart with nothing running, so it cannot be off sooner after a use.
 */
const RUNNING_FOR_MS = 60_000;

/** The Lima VM of Devspaces is not set up yet: the Docker setup of the view creates it. */
export class LimaVmMissingError extends Error {
  constructor() {
    super('The Lima VM of Devspaces is not set up.');
    this.name = 'LimaVmMissingError';
  }
}

export interface LimaVmDeps {
  runner: ProcessRunner;
  logger: Logger;
  platform: NodeJS.Platform;
  arch: string;
  /** The folders of the VM. Default: limaPaths() in the home folder. */
  paths?: LimaPaths;
  /** The environment of this process. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** For tests. Default: installLima. */
  install?: (options: InstallLimaOptions) => Promise<string>;
  /** For tests. Default: Date.now. */
  now?: () => number;
}

/** The Lima VM of Devspaces for the transports to its Docker host (LIMA_HOST). */
export class LimaVm {
  readonly paths: LimaPaths;
  private instance: Promise<LimaInstance> | undefined;
  private starting: Promise<void> | undefined;
  private runningAt: number | undefined;

  constructor(private readonly deps: LimaVmDeps) {
    this.paths = deps.paths ?? limaPaths();
  }

  /**
   * The instance with the pinned Lima, installed once; after a failed install, the next call tries again. The install
   * goes on for the other callers when the signal of one aborts.
   */
  lima(signal?: AbortSignal): Promise<LimaInstance> {
    if (this.instance === undefined) {
      const { runner, logger, platform, arch, env } = this.deps;
      const instance = (this.deps.install ?? installLima)({ folder: this.paths.lima, platform, arch, logger }).then(
        (limactl) => new LimaInstance({ limactl, paths: this.paths, runner, logger, env }),
      );
      this.instance = instance;
      instance.catch(() => {
        if (this.instance === instance) this.instance = undefined;
      });
    }
    return untilAborted(this.instance, signal);
  }

  /**
   * Returns when the VM runs: after a start when it is stopped. The calls at the same time share one check and one
   * start. Throws LimaVmMissingError before the VM was created, a LimaError of `limactl`, the error of the install of
   * Lima, and an AbortError when the signal aborts.
   */
  ready(signal?: AbortSignal): Promise<void> {
    if (this.runningAt !== undefined && this.now() - this.runningAt < RUNNING_FOR_MS) return Promise.resolve();
    // Without the signal of one caller: a cancel of one does not stop the start for the others.
    this.starting ??= this.startIfStopped().finally(() => {
      this.starting = undefined;
    });
    return untilAborted(this.starting, signal);
  }

  /** Forgets that the VM ran (after a transport to it failed), so that the next ready() checks it again. */
  forgetRunning(): void {
    this.runningAt = undefined;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async startIfStopped(): Promise<void> {
    const instance = await this.lima();
    const status = await instance.status();
    if (status === 'missing') throw new LimaVmMissingError();
    if (status !== 'running') {
      const started = this.now();
      await instance.start(undefined, (line) => this.deps.logger.info(`limactl: ${line}`));
      this.deps.logger.info(`The Lima VM of Devspaces started in ${Math.round((this.now() - started) / 1000)} seconds.`);
    }
    this.runningAt = this.now();
  }
}
