// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Background prebuild of the workspace helper image. Devspace never falls back to a previous helper image. After an
// extension update the helper tag is new; the prebuild builds it right after the activation, in the background, so the
// first open after the update does not wait for it and does not fail when the network goes away later. The activation
// starts it only after the first use of Devspaces (src/vscode/extension.ts); before that, the first open builds the
// image. Without a previous helper image, an open that finds no usable helper image and cannot build one fails with
// helperFailed. It runs on the Docker engine of the current Docker context, local or remote alike. With the setting
// updateImagesOnConnect on, it also runs when the refresh of the helper image is due (the rebuild that a check asked
// for, the weekly check of the base image), and its maintaining ensure then also runs the daily cleanup when that is due;
// the cleanup alone never makes it run. On an SSH host it waits for the connection of the relay of this window to the host,
// and runs only through it, without a login of its own (docs/requirements.md R-ENG-002).
import * as fs from 'fs';
import { LOCAL_DOCKER_TARGET, describeDockerHost, hostAccessOf, unsupportedTargetReason, type DockerTarget } from '../docker/dockerHost';
import { runWithDockerTarget } from '../docker/dockerTargets';
import { checkSshLogin, engineInfoTimeoutOf, type SshCheckDeps } from '../docker/remoteDocker';
import { errorMessage } from '../errors';
import { isAbortError, type Logger } from '../ports';
import { helperImageTag, helperTimeLimit } from './helperImage';
import { readHelperState } from './helperState';
import { helperStatePathFor, type HelperImages } from './helperImages';

/**
 * What a prebuild did. `notDue`: the state file of the engine knows the current tag, and no refresh is due;
 * `unsupported`: the Docker endpoint is neither local nor SSH (a remote SSH host is prebuilt too); `dockerNotRunning`:
 * the Docker engine does not answer; `built`: the tag was missing and was built; `present`: the tag exists (also after
 * the maintenance that was due, a rebuild that failed keeping the existing image); `failed`: the build failed (the
 * next open tries again); `cancelled`: dispose ended it; `connectionEnded`: on an SSH host, the connection of this
 * window to the host ended before the prebuild was done, and the prebuild does not log in itself (the next open, or
 * the next prebuild, prepares the image).
 */
export type HelperPrebuildOutcome = 'notDue' | 'unsupported' | 'dockerNotRunning' | 'built' | 'present' | 'failed' | 'cancelled' | 'connectionEnded';

/**
 * The time limit of a prebuild, on every engine. Nobody can cancel the background prebuild, and an open that joins its
 * build can end only its own wait; a build that stalls (a half-open SSH connection after a sleep) would otherwise block
 * every open and worker preparation on that engine until a reload. At the limit the build is ended. The build of a
 * missing tag fails, and a caller that waited for it builds for itself (with the layers that BuildKit finished in its
 * cache). A rebuild that a check asked for (`--pull --no-cache`, which reuses no layer) counts as a failed rebuild
 * instead, as the limit aborts with a time limit (helperTimeLimit): the existing image is used, also by a caller that
 * waited for it, and the next check is in a week, so the next start does not repeat it.
 */
export const HELPER_PREBUILD_TIMEOUT_MS = 15 * 60_000;

export interface HelperPrebuildDeps {
  helper: Pick<HelperImages, 'engineKey' | 'prebuildImage' | 'refreshDue'>;
  /**
   * The setting updateImagesOnConnect, read when the prebuild runs. With it on, the
   * rebuild that a check asked for and the weekly check of the base image make the prebuild due and run. The daily
   * cleanup never makes it due; it runs, with the setting on or off, whenever the prebuild runs and it is due too (the
   * setting governs the check and the rebuild, not the cleanup).
   */
  checkBaseImage: () => boolean;
  /**
   * Whether the Docker engine of `target` answers (dockerEngineAnswers); it never starts Docker (a WSL distribution
   * only while its Monitor runs permanently, because `wsl.exe` starts it). Called within the operation on `target`.
   * Never throws, except an AbortError.
   */
  dockerRunning: (target: DockerTarget, signal: AbortSignal) => Promise<boolean>;
  /**
   * For an SSH host (hostAccessOf: `ssh`): resolves when a connection of the relay of this window to `host` is open and
   * the Docker pipe of the extension serves it (HostPipes.whenDockerHost); rejects with an AbortError when `signal`
   * aborts. With it, the prebuild on an SSH host waits for that connection without a time limit (the work of the
   * prebuild has its time limit after it), asks nothing before it (no SSH check, no `docker info`: the connection
   * passed its checks), and its Docker calls go only through that connection (runWithDockerTarget, `withoutLogin`).
   * Without it, the prebuild on an SSH host checks the host with dockerRunning and may log in itself.
   */
  connection?: (host: string, signal: AbortSignal) => Promise<void>;
  /** resources/helper/Dockerfile of the installed extension: its content gives the current helper tag. */
  dockerfilePath: string;
  /**
   * `helper.json` of the local Docker (StoragePaths.helperState). A remote engine has its own state file next to it
   * (helperStatePathFor), the one that the open of that engine writes.
   */
  statePath: string;
  logger: Logger;
  /** The time limit of the prebuild (HELPER_PREBUILD_TIMEOUT_MS by default). */
  timeoutMs?: number;
}

/** What dockerEngineAnswers needs. */
export interface DockerEngineAnswersDeps {
  /** BootstrapDocker.daemonStatus: `docker info` in the context of the operation, directly (not through the worker). */
  daemonStatus: (signal: AbortSignal, timeoutMs?: number) => Promise<{ running: boolean }>;
  /** For the SSH check before a remote host (checkSshLogin). */
  ssh: SshCheckDeps;
  /**
   * For the work in the background on an SSH host (the build of a missing helper image that the refresh of the sidebar
   * asks for): whether a connection of the relay of this window to `host` is open, with the Docker pipe of the extension
   * (HostPipes.dockerHost). With it, an SSH host answers exactly when that connection is open (its engine passed the
   * checks of that connection), and nothing logs in to the host (docs/requirements.md R-ENG-002). Without it, the SSH
   * check and `docker info` decide, and both may log in.
   */
  connected?: (host: string) => boolean;
  /**
   * Whether a call on the engine of the Docker host `host` must not run now, because it would start a WSL distribution
   * that does not run (WslLifetime.leavesStopped). False when not given.
   */
  leavesStopped?: (host: string) => Promise<boolean>;
  logger: Logger;
}

/**
 * Whether the Docker engine of `target` answers, for the work in the background; Docker is never started for it. An SSH
 * host with `connected`: whether the connection of this window to it is open, and nothing else.
 * The local Docker: `docker info`. A remote host: first our own `ssh -o BatchMode=yes` (checkSshLogin, a success of the
 * last minute counts), so no password, passphrase or host key is ever asked, also on Windows where the ssh of the Docker
 * CLI could ask on a hidden console; then `docker info` in the context of the operation with the time limit
 * of a remote host. A WSL distribution: false while a call must leave it stopped (`leavesStopped`: it does not run, its
 * Monitor does not run permanently, and no flow of the user runs); else the start of its shell (checkSshLogin), which
 * starts the distribution and its Docker engine when it does not run (docs/architecture.md "The WSL distribution of
 * Devspaces"); then `docker info`. An endpoint that is neither local nor SSH: false. Never throws, except an AbortError.
 */
export async function dockerEngineAnswers(target: DockerTarget, deps: DockerEngineAnswersDeps, signal: AbortSignal): Promise<boolean> {
  switch (target.kind) {
    case 'local':
      return (await deps.daemonStatus(signal)).running;
    case 'unsupported':
      return false;
    case 'remote': {
      if (deps.connected !== undefined && hostAccessOf(target.host)?.kind === 'ssh') {
        if (deps.connected(target.host)) return true;
        deps.logger.info(`The work in the background does not reach ${target.host} now: it uses only the connection of this window to the host, and that connection is not open.`);
        return false;
      }
      if (await deps.leavesStopped?.(target.host)) return false;
      const login = await checkSshLogin(target.host, deps.ssh, { signal });
      if (!login.ok) {
        deps.logger.info(`The Docker host ${target.host} cannot be reached ${hostAccessOf(target.host)?.kind === 'wsl' ? 'through wsl.exe' : 'over SSH'}: ${login.detail}`);
        return false;
      }
      // A host that our ssh cannot check would be asked by the ssh of the Docker CLI, which may ask a question; nothing
      // asks one unattended. The first open on that host builds the tag.
      if (login.skipped === 'notAnSshTarget') {
        deps.logger.info(`The workspace helper image is not prepared in the background on ${target.host}: it is no SSH address that can be checked without questions.`);
        return false;
      }
      return (await deps.daemonStatus(signal, engineInfoTimeoutOf(target.host))).running;
    }
  }
}

/**
 * The background prebuild. `start` runs it once (never rejects, never blocks: the caller does not await it); `dispose`
 * cancels it (the build of the Docker CLI is ended), and so does `stop` for the engine of a removal of Devspaces.
 *
 * It runs when the helper state file of the engine has no record of the current helper tag (after an update that
 * changed the tag, a first installation, or a tag that the cleanup removed), or, with the setting
 * updateImagesOnConnect on, when the refresh of that tag is due by the state file (HelperImages.refreshDue: the rebuild
 * that a check asked for, the weekly check of the base image, which an attempt that the registry did not answer puts
 * off by a week here). The daily cleanup alone never makes it due: it is housekeeping, and runs when the prebuild runs
 * anyway and in the preparation of the worker for an open. The state file alone decides, so a window that starts after
 * the prebuild of another one finds the record (and no refresh due) and does nothing. It asks Docker nothing when it
 * is not due, so an activation does not wake Docker Desktop from its Resource Saver mode, nor connect to a remote host,
 * for housekeeping. It runs on the Docker engine of the target that `start` gets, local or remote alike (it runs as an
 * operation on it, so the engine key, the state file and every Docker call are those of an open on that engine), and
 * only when that engine answers (Docker is never started for this; a WSL distribution only while its Monitor runs
 * permanently). On an SSH host (with HelperPrebuildDeps.connection), it waits, when it is due, for the connection of the
 * relay of this window to the host, and its Docker calls go only through it: it never logs in itself
 * (docs/requirements.md R-ENG-002). A missing tag is then built by the next open, before its connection (the container
 * of the connection runs the helper image), and the prebuild finds the record afterwards. The ensure is the
 * maintaining one of HelperImages.prebuildImage (it builds a missing tag, runs the
 * rebuild itself so that the next open does not wait for it, starts the check, and runs the cleanup when that is due
 * too), shared with the preparation of a worker in the same window, so one that needs the missing tag meanwhile never
 * builds a second time, and one before an open joins the rebuild. There is no lock across windows (a lock left behind by a window that closed during the prebuild would block
 * the prebuild of every window). Windows that start at the same time
 * may each build the tag, or run the rebuild, once (BuildKit shares the layer cache; the extra images stay dangling
 * until the daily cleanup removes them); windows that start later find the record and no refresh due, and do nothing.
 */
export class HelperPrebuild {
  private readonly controller = new AbortController();
  private readonly limit = new AbortController();
  /**
   * On an SSH host (HelperPrebuildDeps.connection): aborted when a Docker call of the prebuild would log in to the host,
   * because the connection of this window to it ended (BootstrapDocker, runWithDockerTarget with `withoutLogin`).
   */
  private readonly withoutLogin = new AbortController();
  private run: Promise<HelperPrebuildOutcome> | undefined;
  /** The target of the prebuild that `start` began, while it runs. */
  private running: DockerTarget | undefined;

  constructor(private readonly deps: HelperPrebuildDeps) {}

  /**
   * Starts the prebuild once, as an operation on `target` (the local Docker by default); later calls return the same
   * promise. Never rejects.
   */
  start(target: DockerTarget = LOCAL_DOCKER_TARGET): Promise<HelperPrebuildOutcome> {
    if (this.run !== undefined) return this.run;
    this.running = target;
    // An SSH host: only through the connection of this window to it (HelperPrebuildDeps.connection).
    const throughConnection = this.deps.connection !== undefined && target.kind === 'remote' && hostAccessOf(target.host)?.kind === 'ssh';
    this.run = runWithDockerTarget(target, () => this.prebuild(target, throughConnection), throughConnection ? { withoutLogin: this.withoutLogin } : {})
      .catch((error: unknown) => {
        if (this.limit.signal.aborted && !this.controller.signal.aborted) {
          this.deps.logger.warn('The workspace helper image was not ready within the time limit of the background preparation; the next open prepares it.');
          return 'failed' as const;
        }
        if (this.controller.signal.aborted) return 'cancelled' as const;
        if (this.withoutLogin.signal.aborted) {
          this.deps.logger.info(
            `The background preparation of the workspace helper image on ${target.host} stopped: the connection of this window to the host ended, and the work in the background does not log in itself. The next open prepares the image.`,
          );
          return 'connectionEnded' as const;
        }
        if (isAbortError(error)) return 'cancelled' as const;
        this.deps.logger.warn(`The workspace helper image could not be prepared in the background: ${errorMessage(error)}`);
        return 'failed' as const;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.run;
  }

  /** Cancels a prebuild that runs (on deactivation). */
  dispose(): void {
    this.controller.abort();
  }

  /**
   * "Remove Devspaces from This Docker Engine…" on the Docker host of `target`: a prebuild that runs there is cancelled
   * (as by dispose), and the call waits for its end, so that it does not build the helper image again after its
   * removal. Nothing when the prebuild runs on another host or did not start.
   */
  async stop(target: Pick<DockerTarget, 'host'>): Promise<void> {
    if (this.run === undefined || this.running?.host !== target.host) return;
    this.deps.logger.info(`The background preparation of the workspace helper image on ${describeDockerHost(target.host)} stops: Devspaces is being removed from there.`);
    this.controller.abort();
    await this.run;
  }

  /**
   * `throughConnection` (an SSH host with HelperPrebuildDeps.connection): when the prebuild is due, it first waits for
   * the connection of this window to the host, without a time limit; the time limit starts after it.
   */
  private async prebuild(target: DockerTarget, throughConnection: boolean): Promise<HelperPrebuildOutcome> {
    const { deps } = this;
    if (throughConnection && deps.connection !== undefined) {
      const waiting = this.controller.signal;
      if (!(await this.isDue(waiting))) return waiting.aborted ? 'cancelled' : 'notDue';
      deps.logger.info(`The workspace helper image on ${target.host} is prepared in the background through the connection of this window to the host, when that connection is open.`);
      await deps.connection(target.host, waiting);
    }
    // A time limit, not a cancel, so a rebuild that it ends counts as a failed one.
    const timer = setTimeout(
      () => this.limit.abort(helperTimeLimit('The time limit of the background preparation of the workspace helper image ended.')),
      deps.timeoutMs ?? HELPER_PREBUILD_TIMEOUT_MS,
    );
    try {
      return await this.prebuildWithin(target, AbortSignal.any([this.controller.signal, this.limit.signal, this.withoutLogin.signal]), throughConnection);
    } finally {
      clearTimeout(timer);
    }
  }

  private async prebuildWithin(target: DockerTarget, signal: AbortSignal, throughConnection: boolean): Promise<HelperPrebuildOutcome> {
    const { deps } = this;
    if (target.kind === 'unsupported') {
      deps.logger.info(`The workspace helper image is not prepared in the background. ${unsupportedTargetReason(target)}`);
      return 'unsupported';
    }
    // Again after the wait for the connection: another window may have done it meanwhile.
    if (!(await this.isDue(signal))) return signal.aborted ? 'cancelled' : 'notDue';
    if (signal.aborted) return 'cancelled';
    // A remote host is prebuilt like the local Docker. Through the connection, the engine passed the checks of that
    // connection, and nothing is asked that could log in.
    if (!throughConnection && !(await deps.dockerRunning(target, signal))) {
      deps.logger.info('The workspace helper image is not prepared in the background: Docker is not running. It is prepared at the next open.');
      return 'dockerNotRunning';
    }
    let built = false;
    // The maintaining ensure, with the setting updateImagesOnConnect. A rebuild that fails keeps the existing image
    // (helperImage.ts logs it), so only the build of a missing tag counts as `built`.
    const use = await deps.helper.prebuildImage({
      signal,
      checkBaseImage: deps.checkBaseImage(),
      onBuild: (kind) => {
        if (kind === 'refresh') {
          deps.logger.info('The workspace helper image is built again in the background.');
          return;
        }
        built = true;
        deps.logger.info('The workspace helper image is built in the background.');
      },
    });
    deps.logger.info(
      built
        ? `The workspace helper image ${use.tag} was built in the background.`
        : `The workspace helper image ${use.tag} is ready.`,
    );
    return built ? 'built' : 'present';
  }

  /**
   * The state file of the engine has no record of the current tag (or only a removal mark), or the refresh of the tag
   * is due by that file (HelperImages.refreshDue, with the setting updateImagesOnConnect; never the cleanup alone).
   * The state file of the engine of the operation (helperStatePathFor with the engine key of an open),
   * read after the tag, so a dispose while the Dockerfile is read does not even read the engine. The engine key comes
   * from the target of the operation; Docker is not asked.
   */
  private async isDue(signal: AbortSignal): Promise<boolean> {
    const { deps } = this;
    const tag = helperImageTag(await fs.promises.readFile(deps.dockerfilePath, 'utf8'));
    if (signal.aborted) return false;
    const statePath = helperStatePathFor(deps.statePath, await deps.helper.engineKey());
    const record = (await readHelperState(statePath)).images[tag];
    if (record === undefined || record.removedAt !== undefined) return true;
    return deps.helper.refreshDue({ checkBaseImage: deps.checkBaseImage() });
  }
}
