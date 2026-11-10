// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The check of a local Docker before an operation. Devspaces never uses the Docker of this computer
// (docs/requirements.md R-ENG-001), so it starts none: a local Docker is only the engine of the tests of the engine
// (DockerTargets with `computerDocker`). Also the start of a program that outlives this process
// (launchDetachedProcess, for the keeper of the WSL distribution of Devspaces).
import { spawn } from 'child_process';
import { UserFacingError } from '../errors';
import { Messages } from '../messages';
import { abortError, type Logger } from '../ports';
import type { BootstrapDocker } from './bootstrapDocker';

/** `docker info` of a user without access to the socket of a running engine. */
const SOCKET_PERMISSION_DENIED = /permission denied/i;

/**
 * Starts a program without waiting for it; `onExit` runs with its exit code (null when a signal ended it) when it
 * ended while this process runs. `windowsHide`: no window on Windows, also not a console window (a program that runs in
 * the background).
 */
export function launchDetachedProcess(
  file: string,
  args: readonly string[],
  onExit?: (code: number | null) => void,
  options: { windowsHide?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { detached: true, stdio: 'ignore', shell: false, windowsHide: options.windowsHide === true });
    child.once('error', reject);
    if (onExit !== undefined) child.once('exit', (code) => onExit(code));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Resolves when `docker info` of the local Docker succeeds; it starts nothing (see the module comment). No CLI →
 * UserFacingError('dockerNotInstalled'). A Docker that does not run, or that this user may not use →
 * UserFacingError('dockerStartFailed', Messages.dockerStartFailed, detail). Podman as the CLI or as the engine
 * (BootstrapDocker.podmanInUse) → UserFacingError('dockerEndpointUnsupported', Messages.podmanNotSupported). Rejects
 * with an AbortError when the signal aborts.
 */
export async function ensureDockerRunning(docker: BootstrapDocker, logger: Logger, options: { signal?: AbortSignal } = {}): Promise<void> {
  const { signal } = options;
  if (!docker.isInstalled()) throw new UserFacingError('dockerNotInstalled', Messages.dockerNotInstalled);
  if (signal?.aborted) throw abortError();
  const status = await docker.daemonStatus(signal);
  // Podman is refused before anything else: `podman info` has no server version, so the CLI of the package
  // podman-docker reads as a Docker that does not run.
  const podman = await docker.podmanInUse(status.running, signal);
  if (podman !== undefined) {
    logger.warn(`Podman is used instead of Docker, which Devspaces does not support. ${podman}`);
    throw new UserFacingError('dockerEndpointUnsupported', Messages.podmanNotSupported, podman);
  }
  if (status.running) return;
  const reason = SOCKET_PERMISSION_DENIED.test(status.detail)
    ? 'The Docker engine runs, but this user has no access to it.'
    : 'The local Docker does not run, and Devspaces starts no Docker of this computer.';
  logger.info(`${reason} docker info: ${status.detail}`);
  throw new UserFacingError('dockerStartFailed', Messages.dockerStartFailed, `${reason}\ndocker info: ${status.detail}`);
}
