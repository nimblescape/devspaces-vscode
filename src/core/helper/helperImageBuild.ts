// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The tag of the helper image and the inputs of its build, shared by the extension (helperImage.ts, which builds,
// checks and cleans up the helper image of a window) and the Monitor (src/remoteMonitor/helperRefresh.ts, which builds
// its own helper tag again when its base image changed; docs/requirements.md R-DS-003). Only these constants and the
// tag: the worker's bundle, which holds the Monitor, takes nothing else of the helper image of the extension
// (src/workerBundle.test.ts).
import * as crypto from 'crypto';

/**
 * Version of `@devcontainers/cli` in the helper image. It comes from the exact devDependency in package.json:
 * esbuild.mjs (and vitest.config.mts for the tests) puts it into the code at build time (scripts/cliVersion.mjs).
 * The version is part of the helper image tag, so after a version bump every user's helper is rebuilt at first use.
 */
export const DEVCONTAINER_CLI_VERSION: string = __DEVCONTAINER_CLI_VERSION__;

/** Repository part of the helper image tag. */
export const HELPER_IMAGE_REPOSITORY = 'devspaces-worker';

/**
 * The helper generation of this extension version, recorded per tag in helper.json (`generation`, for diagnosis) at
 * each build and rebuild. It is part of the helper tag (helperImageTag), so raising it gives a new current tag, which
 * is built: an image of an older generation never stays the current helper (for example after a release that fixes a
 * security problem in the helper image, when neither the Dockerfile nor the CLI version changed).
 */
export const HELPER_GENERATION = 1;

/**
 * The longest rebuild that a check asked for (`--pull --no-cache`), as long as the time limit of the background
 * prebuild. A rebuild that takes longer (a pull or a download that stalls without failing) is ended and counts as a
 * failed rebuild: the existing image stays, and the next check is in a week. The rebuild of the Monitor has the same
 * limit.
 */
export const HELPER_REBUILD_TIMEOUT_MS = 15 * 60_000;

/**
 * `devspaces-worker:<first 12 hex characters of sha256(Dockerfile content + CLI version + "\ngeneration " + helper
 * generation)>`. Line endings are normalized, so that a checkout with CRLF line endings gives the same tag. The helper
 * generation (HELPER_GENERATION) is part of the hash.
 */
export function helperImageTag(
  dockerfileContent: string,
  cliVersion: string = DEVCONTAINER_CLI_VERSION,
  generation: number = HELPER_GENERATION,
): string {
  const hash = crypto
    .createHash('sha256')
    .update(dockerfileContent.replace(/\r\n/g, '\n'))
    .update(cliVersion)
    .update(`\ngeneration ${generation}`)
    .digest('hex');
  return `${HELPER_IMAGE_REPOSITORY}:${hash.slice(0, 12)}`;
}
