// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The build image of Devspaces: buildx (BuildKit) in a container on the engine, the same on every engine (the local
// Docker, the WSL distribution of Devspaces, an SSH host), so that the build of the helper image does not depend on the
// Docker CLI that sends it (BootstrapDocker.buildImage, docs/architecture.md "The helper image"). The image is
// docker/buildx-bin of Docker (the buildx program alone, `/buildx`), pinned by its version and the digest of its image
// index for all platforms in buildxPin.json (written by scripts/buildx-pin.mjs, which the workflow "Buildx image"
// runs every week). On the engine it carries the tag devspaces-buildx:<version>, so that the removal of older versions
// and "Remove Devspaces from This Docker Engine…" know it by its name. No `vscode`.
import { isRecord } from '../valueChecks';
import { LABEL_BUILD_RUN } from '../names';
import pin from './buildxPin.json';

/** The pin of the build image: the version of buildx, the repository of docker/buildx-bin, and the digest of its index. */
export interface BuildxPin {
  version: string;
  image: string;
  digest: string;
}

/** The pin of this version of Devspaces (buildxPin.json). */
export const BUILDX_PIN: BuildxPin = pin;

/** The repository of the tags of the build image on an engine. */
export const BUILDX_REPOSITORY = 'devspaces-buildx';

/** The start of the name of a build container, before 16 hex digits. */
export const BUILD_CONTAINER_PREFIX = 'devspaces-build-';

/** The exit code of `docker run` when Docker could not create or start the container. */
export const DOCKER_RUN_FAILED_EXIT_CODE = 125;

/** The tag of the build image of `buildx` on an engine: `devspaces-buildx:<version>`. */
export function buildxImageTag(buildx: BuildxPin = BUILDX_PIN): string {
  return `${BUILDX_REPOSITORY}:${buildx.version}`;
}

/** The reference by which the build image is pulled: `docker/buildx-bin@sha256:<digest of its index>`. */
export function buildxPulledReference(buildx: BuildxPin = BUILDX_PIN): string {
  return `${buildx.image}@${buildx.digest}`;
}

/** The filter of `docker image ls` for the tags of the build image. */
export const BUILDX_REFERENCE_FILTER = `reference=${BUILDX_REPOSITORY}`;

/** The arguments of `docker image ls` of the tags of the build image, one JSON line each (buildxImageTags). */
export const BUILDX_IMAGE_LS_ARGS: readonly string[] = ['image', 'ls', '--filter', BUILDX_REFERENCE_FILTER, '--format', '{{json .}}'];

/** The tags `devspaces-buildx:<tag>` of the JSON lines of BUILDX_IMAGE_LS_ARGS, each with the ID of its image. */
export function buildxImageTags(items: readonly unknown[]): Array<{ id: string; tag: string }> {
  return items.flatMap((item) =>
    isRecord(item) && typeof item.ID === 'string' && item.Repository === BUILDX_REPOSITORY && typeof item.Tag === 'string' && item.Tag !== '' && item.Tag !== '<none>'
      ? [{ id: item.ID, tag: `${BUILDX_REPOSITORY}:${item.Tag}` }]
      : [],
  );
}

/** The version x.y.z of a tag of BUILDX_REPOSITORY, as three numbers; undefined for another tag. */
function versionOf(tag: string): [number, number, number] | undefined {
  const match = new RegExp(`^${BUILDX_REPOSITORY}:(\\d+)\\.(\\d+)\\.(\\d+)$`).exec(tag);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True for a tag of the build image of an older version than `buildx`: the removal of older versions after the pull
 * of a new one removes it. A newer version stays, because a window of a newer Devspaces on the same engine uses it.
 */
export function isOlderBuildxTag(tag: string, buildx: BuildxPin = BUILDX_PIN): boolean {
  const version = versionOf(tag);
  const current = versionOf(buildxImageTag(buildx));
  if (version === undefined || current === undefined) return false;
  for (let index = 0; index < 3; index++) {
    if (version[index] !== current[index]) return version[index] < current[index];
  }
  return false;
}

/**
 * The proxy variables that the Docker CLI sets in a container that it creates, from the proxy settings of its
 * configuration (`proxies` of ~/.docker/config.json), and that `docker build` gives a build as build arguments. buildx
 * takes a build argument without a value from its environment, and leaves it out when the variable is not set.
 */
export const PROXY_BUILD_ARG_NAMES: readonly string[] = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'FTP_PROXY', 'ALL_PROXY'].flatMap((name) => [
  name,
  name.toLowerCase(),
]);

/**
 * The arguments of `docker run` of a build in a container of the build image `image` on the engine: the build context
 * as a tar archive on its standard input (`-`, contextTar), the Docker socket of the engine (`socket`, a path on the
 * computer of the engine) at /var/run/docker.sock, where buildx finds it. The container has no network (buildx talks
 * only to the socket; the engine pulls the base image), no capabilities, `no-new-privileges`, and `--rm`. buildx
 * builds with the builder of the engine (the docker driver, `--builder default`), which keeps the image in the engine
 * (`--load`). The build gets the proxy settings of the Docker CLI that runs the container, as `docker build` would:
 * `--build-arg <name>` without a value for each of PROXY_BUILD_ARG_NAMES, so that no value appears in the arguments (a
 * proxy URL can hold a password). `buildArgs` are the flags and the labels of the build (`--no-cache`, `--label k=v`,
 * `--build-arg k=v`, …); they come after these, so that a build argument of the caller wins.
 */
export function buildxRunArgs(options: {
  name: string;
  image: string;
  socket: string;
  tag: string;
  dockerfile: string;
  buildArgs: readonly string[];
}): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '--pull',
    'never',
    '--name',
    options.name,
    '--label',
    `${LABEL_BUILD_RUN}=true`,
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--mount',
    `type=bind,source=${options.socket},target=/var/run/docker.sock`,
    '--entrypoint',
    '/buildx',
    options.image,
    'build',
    '--builder',
    'default',
    '--load',
    '--progress',
    'plain',
    '-t',
    options.tag,
    '-f',
    options.dockerfile,
    ...PROXY_BUILD_ARG_NAMES.flatMap((name) => ['--build-arg', name]),
    ...options.buildArgs,
    '-',
  ];
}
