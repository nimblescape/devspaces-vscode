// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker API version between a Docker CLI and a Docker engine (docs/architecture.md "The Docker CLI of Devspaces"):
// the Docker CLI of Devspaces, or the Docker CLI of this computer where a window runs it for a remote engine. The CLI
// asks the engine for its newest API version and speaks the lower of that and its own newest one, but never one below
// its own oldest one: with an older engine it speaks its newest one, which the engine refuses. The engine refuses an
// API version below its minimum (DOCKER_MIN_API_VERSION of dockerd). So both work together when the newest API version
// of the engine is at least the oldest one of the CLI, and the minimum of the engine is at most the newest one of the
// CLI. The range of the CLI of Devspaces comes from its pin (dockerCliPin.json, measured by
// scripts/docker-cli-pin.mjs), the newest version of the CLI of this computer from `docker version`, the versions of
// the engine from the probe of the worker (`GET /version`), or from the error of the engine for a call of the CLI
// before the worker (dockerApiErrorMismatch). No `vscode`.
import { compareVersions } from '../vscodeExtensions';

/** An API version of Docker, `1.40`, as the source of a regular expression. */
export const API_VERSION_SOURCE = String.raw`\d{1,4}\.\d{1,4}`;

/**
 * The API versions that a Docker CLI speaks: from its oldest one to its newest one. `min` is undefined when it is not
 * known: a Docker CLI names only its newest one (the Docker CLI of this computer, localDockerCliApi).
 */
export interface DockerApiRange {
  min?: string;
  max: string;
}

/**
 * A Docker CLI whose API versions are checked: its name in a message (`the Docker CLI 29.9.2 of Devspaces`), its
 * versions, and whose it is: `devspaces` (its pin, ownDockerCli.ts), or `computer` (the Docker CLI of this computer,
 * which the user updates).
 */
export interface DockerCliApi {
  name: string;
  range: DockerApiRange;
  kind: 'devspaces' | 'computer';
}

/** The API versions of an engine (`GET /version`): its newest one and its minimum; undefined when it named none. */
export interface EngineApiVersions {
  apiVersion?: string;
  minApiVersion?: string;
}

/** Why a Docker CLI cannot work with an engine. */
export type DockerApiMismatch =
  /** The newest API version of the engine (`engine`) is older than the oldest one of the CLI (`minimum`). */
  | { kind: 'engineTooOld'; engine: string; minimum: string }
  /** The engine needs at least `minimum`, newer than the newest API version of the CLI (`client`). */
  | { kind: 'cliTooOld'; client: string; minimum: string };

/**
 * Why the CLI with the API versions `cli` cannot work with the engine `engine`, or undefined when they work together
 * or when the engine or the CLI did not name the version that the check needs.
 */
export function dockerApiMismatch(engine: EngineApiVersions, cli: DockerApiRange): DockerApiMismatch | undefined {
  if (engine.apiVersion !== undefined && cli.min !== undefined && compareVersions(engine.apiVersion, cli.min) < 0) {
    return { kind: 'engineTooOld', engine: engine.apiVersion, minimum: cli.min };
  }
  if (engine.minApiVersion !== undefined && compareVersions(engine.minApiVersion, cli.max) > 0) {
    return { kind: 'cliTooOld', client: cli.max, minimum: engine.minApiVersion };
  }
  return undefined;
}

/** The error of the engine for a call with a newer API version than it speaks: the version of the call, its newest. */
const TOO_NEW = new RegExp(String.raw`client version (${API_VERSION_SOURCE}) is too new\. Maximum supported API version is (${API_VERSION_SOURCE})`);
/** The same error of an engine before Docker 17.04 (API 1.27): the version of the call, the newest one of the engine. */
const NEWER_THAN_SERVER = new RegExp(String.raw`client is newer than server \(client API version: (${API_VERSION_SOURCE}), server API version: (${API_VERSION_SOURCE})\)`);
/** The error of the engine for a call with an older API version than its minimum: the version of the call, the minimum. */
const TOO_OLD = new RegExp(String.raw`client version (${API_VERSION_SOURCE}) is too old\. Minimum supported API version is (${API_VERSION_SOURCE})`);

/**
 * The mismatch that the error output `text` of a Docker call names, when the call came from the CLI with the API
 * versions `cli`: in both cases that CLI calls with its newest API version (see above), so an error of another CLI
 * (for example the one of the shell before the relay) is not taken; nor is an error whose engine the CLI can work with
 * (a call with the newest version after a failed negotiation, for example), nor an engine that is too old for a CLI
 * whose oldest version is not known. Undefined for any other text.
 */
export function dockerApiErrorMismatch(text: string, cli: DockerApiRange): DockerApiMismatch | undefined {
  const tooNew = TOO_NEW.exec(text) ?? NEWER_THAN_SERVER.exec(text);
  if (tooNew !== null && tooNew[1] === cli.max) return dockerApiMismatch({ apiVersion: tooNew[2] }, cli);
  const tooOld = TOO_OLD.exec(text);
  if (tooOld !== null && tooOld[1] === cli.max) return dockerApiMismatch({ minApiVersion: tooOld[2] }, cli);
  return undefined;
}

/** The message when the error output `text` of a Docker call of `cli` on the engine on `host` is a mismatch, or undefined. */
export function dockerApiErrorText(text: string, host: string, cli: DockerCliApi): string | undefined {
  const mismatch = dockerApiErrorMismatch(text, cli.range);
  return mismatch === undefined ? undefined : dockerApiMismatchText(mismatch, host, cli);
}

/**
 * The message of `mismatch` between the Docker CLI `cli` (named, for example, `the Docker CLI 29.9.2 of Devspaces`)
 * and the Docker engine on `host`.
 */
export function dockerApiMismatchText(mismatch: DockerApiMismatch, host: string, cli: Pick<DockerCliApi, 'name' | 'kind'>): string {
  const start = `${cli.name.charAt(0).toUpperCase()}${cli.name.slice(1)} cannot work with the Docker engine on ${host}: `;
  switch (mismatch.kind) {
    case 'engineTooOld':
      return `${start}the engine speaks the Docker API up to version ${mismatch.engine}, and the CLI needs version ${mismatch.minimum} or later. Update that Docker engine.`;
    case 'cliTooOld': {
      const update = cli.kind === 'devspaces' ? 'A newer version of Devspaces brings a newer Docker CLI.' : 'Update the Docker CLI of this computer.';
      return (
        `${start}the engine needs the Docker API version ${mismatch.minimum} or later, and the CLI speaks only up to version ${mismatch.client}. ` +
        `${update} Until then, that engine accepts the CLI when the environment variable DOCKER_MIN_API_VERSION of dockerd is ${mismatch.client} or lower.`
      );
    }
  }
}

/** The output of `docker version` for localDockerCliApi: the version of the CLI and its newest API version. */
export const LOCAL_CLI_VERSION_FORMAT = '{{.Client.Version}} {{.Client.APIVersion}}';
/** How long that `docker version` may take: it reaches no engine, so it ends at once. */
export const LOCAL_CLI_VERSION_TIMEOUT_MS = 10_000;

/**
 * The Docker CLI of this computer as a DockerCliApi, from the output of `docker version --format
 * LOCAL_CLI_VERSION_FORMAT` (`29.9.2 1.56`), which the CLI prints also when it reaches no engine. Only its newest API
 * version: a Docker CLI does not name its oldest one, so the check finds only an engine whose minimum is newer
 * (cliTooOld). Undefined for any other output.
 */
export function localDockerCliApi(stdout: string): DockerCliApi | undefined {
  const match = new RegExp(String.raw`^([\w.+~-]{1,64}) (${API_VERSION_SOURCE})$`).exec(stdout.trim());
  if (match === null) return undefined;
  return { name: `the Docker CLI ${match[1]} of this computer`, range: { max: match[2] }, kind: 'computer' };
}
