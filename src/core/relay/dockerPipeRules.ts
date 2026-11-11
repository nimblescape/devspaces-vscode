// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The requests of the Docker API that the Docker pipes let through (docs/remote-connection.md "The request filter"):
// each pipe has an allow-list of methods and paths, and refuses every other request (dockerRequests.ts). The pipe of a
// window (windowPipe.ts) carries the Docker calls of the Dev Containers extension, which attaches the window to the
// container of its devspace: it may read the engine, the container and its image, start the container, and run
// programs in it, but not create, build or remove anything. The pipe of the extension (hostPipes.ts) carries the Docker
// calls of Devspaces itself (BootstrapDocker): the ones of its code, which also build the helper image in a container of
// the build image (buildxImage.ts), and remove Devspaces from the engine. The lists
// come from the Docker calls of both, measured in CI (test/vscode/attach/remote.test.ts fails on a refused request).
// Only the method and the path are checked, not the query or the body. No `vscode`.
import type { DockerRequest, DockerRequestRule } from './dockerRequests';

/** A container, an exec, a volume or a network in a path: its ID or its name, without a slash. */
const NAME = '[^/]+';
/** An image in a path: its ID or its reference, which can have slashes (`ghcr.io/owner/image:tag`). */
const IMAGE = '.+';

/** The characters of the paths of the Docker CLI: names, IDs, image references (`/`, `:`, `@`). */
const PATH_CHARACTERS = /^\/[A-Za-z0-9._:@/+-]*$/;

/** One allowed request: its method, and its path (without the version of the API) as a pattern. */
interface Endpoint {
  method: string;
  path: RegExp;
}

function endpoint(method: string, path: string): Endpoint {
  return { method, path: new RegExp(`^${path}$`) };
}

/** The requests that every Docker CLI sends first: the check of the engine and its API version. */
const ENGINE_CHECKS: Endpoint[] = [endpoint('HEAD', '/_ping'), endpoint('GET', '/_ping'), endpoint('GET', '/version')];

/** The Dev Containers extension in the window of a devspace: it reads, starts the container, and runs programs in it. */
export const WINDOW_PIPE_ENDPOINTS: readonly Endpoint[] = [
  ...ENGINE_CHECKS,
  endpoint('GET', '/info'),
  endpoint('GET', '/containers/json'),
  endpoint('GET', `/containers/${NAME}/json`),
  endpoint('POST', `/containers/${NAME}/start`),
  endpoint('POST', `/containers/${NAME}/exec`),
  endpoint('POST', `/exec/${NAME}/start`),
  endpoint('POST', `/exec/${NAME}/resize`),
  endpoint('GET', `/exec/${NAME}/json`),
  endpoint('GET', `/images/${IMAGE}/json`),
  endpoint('GET', '/events'),
];

/**
 * Devspaces itself (BootstrapDocker run): the checks of the engine and of the helper image, the build of the helper
 * image (the pull and the tag of the build image, and `docker run -i` of the build container, which the Docker CLI
 * stops with `kill` at its own stop; `docker build` as the fallback, with BuildKit or the classic builder), the
 * removal of its objects ("Remove Devspaces from This Docker Engine…"), and the read, the Stop of a container and the
 * removal of the view "Docker Hosts" (hostObjects.ts: `docker system df -v`, `docker container stop`, and `rm` without
 * force). Its worker starts behind the relay or with
 * `ssh://`, never through the pipe (BootstrapDocker.start).
 */
export const EXTENSION_PIPE_ENDPOINTS: readonly Endpoint[] = [
  ...ENGINE_CHECKS,
  endpoint('GET', '/info'),
  endpoint('GET', '/system/df'),
  endpoint('GET', '/containers/json'),
  endpoint('GET', `/containers/${NAME}/json`),
  endpoint('POST', '/containers/create'),
  endpoint('POST', `/containers/${NAME}/attach`),
  endpoint('POST', `/containers/${NAME}/start`),
  endpoint('POST', `/containers/${NAME}/wait`),
  endpoint('POST', `/containers/${NAME}/kill`),
  endpoint('POST', `/containers/${NAME}/stop`),
  endpoint('DELETE', `/containers/${NAME}`),
  endpoint('GET', '/images/json'),
  endpoint('GET', `/images/${IMAGE}/json`),
  endpoint('POST', '/images/create'),
  endpoint('POST', `/images/${IMAGE}/tag`),
  endpoint('DELETE', `/images/${IMAGE}`),
  endpoint('POST', '/build'),
  endpoint('POST', '/session'),
  endpoint('POST', '/grpc'),
  endpoint('GET', '/volumes'),
  endpoint('GET', `/volumes/${NAME}`),
  endpoint('DELETE', `/volumes/${NAME}`),
];

/**
 * The rule of a pipe from its list: a request whose method and path are on the list goes on. `user` names the program
 * whose calls the pipe carries, in the reason of a refusal.
 */
export function endpointRule(endpoints: readonly Endpoint[], user: string): DockerRequestRule {
  return (request: DockerRequest) => {
    // A path that the Docker CLI never sends (escapes, `.` and `..` segments, empty segments) could reach another
    // endpoint of the engine than the one that it seems to name.
    if (!PATH_CHARACTERS.test(request.path) || /\/\.{1,2}(\/|$)|\/\//.test(request.path)) return 'its path is not one that the Docker CLI sends';
    if (endpoints.some((allowed) => allowed.method === request.method && allowed.path.test(request.path))) return undefined;
    return `${user} does not need it`;
  };
}

/** The filter of the Docker pipe of a window. */
export const windowPipeRule: DockerRequestRule = endpointRule(WINDOW_PIPE_ENDPOINTS, 'the Dev Containers extension');
/** The filter of the Docker pipe of the extension. */
export const extensionPipeRule: DockerRequestRule = endpointRule(EXTENSION_PIPE_ENDPOINTS, 'Devspaces');
