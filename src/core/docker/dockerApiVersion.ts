// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker API version between the Docker CLI of Devspaces and a Docker engine (docs/architecture.md "The Docker CLI
// of Devspaces"). The CLI asks the engine for its newest API version and speaks the lower of that and its own newest
// one, but never one below its own oldest one: with an older engine it speaks its newest one, which the engine refuses.
// The engine refuses an API version below its minimum (DOCKER_MIN_API_VERSION of dockerd). So both work together when
// the newest API version of the engine is at least the oldest one of the CLI, and the minimum of the engine is at most
// the newest one of the CLI. The range of the CLI comes from its pin (dockerCliPin.json, measured by
// scripts/docker-cli-pin.mjs), the versions of the engine from the probe of the worker (`GET /version`). No `vscode`.
import { compareVersions } from '../vscodeExtensions';

/** The API versions that a Docker CLI speaks: from its oldest one to its newest one. */
export interface DockerApiRange {
  min: string;
  max: string;
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
 * or when the engine did not name the version that the check needs.
 */
export function dockerApiMismatch(engine: EngineApiVersions, cli: DockerApiRange): DockerApiMismatch | undefined {
  if (engine.apiVersion !== undefined && compareVersions(engine.apiVersion, cli.min) < 0) {
    return { kind: 'engineTooOld', engine: engine.apiVersion, minimum: cli.min };
  }
  if (engine.minApiVersion !== undefined && compareVersions(engine.minApiVersion, cli.max) > 0) {
    return { kind: 'cliTooOld', client: cli.max, minimum: engine.minApiVersion };
  }
  return undefined;
}

/**
 * The message of `mismatch` between the Docker CLI `cliName` (for example `the Docker CLI 29.9.2 of Devspaces`) and the
 * Docker engine on `host`.
 */
export function dockerApiMismatchText(mismatch: DockerApiMismatch, host: string, cliName: string): string {
  const start = `${cliName.charAt(0).toUpperCase()}${cliName.slice(1)} cannot work with the Docker engine on ${host}: `;
  switch (mismatch.kind) {
    case 'engineTooOld':
      return `${start}the engine speaks the Docker API up to version ${mismatch.engine}, and the CLI needs version ${mismatch.minimum} or later. Update that Docker engine.`;
    case 'cliTooOld':
      return (
        `${start}the engine needs the Docker API version ${mismatch.minimum} or later, and the CLI speaks only up to version ${mismatch.client}. ` +
        `A newer version of Devspaces brings a newer Docker CLI. Until then, that engine accepts the CLI when the environment variable DOCKER_MIN_API_VERSION of dockerd is ${mismatch.client} or lower.`
      );
  }
}
