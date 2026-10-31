// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { dockerApiErrorMismatch, dockerApiMismatch, dockerApiMismatchText } from './dockerApiVersion';

/** The API versions of the Docker CLI 29.9.2. */
const CLI = { min: '1.40', max: '1.56' };
const OWN = 'the Docker CLI 29.9.2 of Devspaces';

describe('dockerApiMismatch', () => {
  it('finds no mismatch while the newest API version of the engine is at least the oldest one of the CLI, and its minimum at most the newest one', () => {
    for (const engine of [
      { apiVersion: '1.40', minApiVersion: '1.24' },
      { apiVersion: '1.52', minApiVersion: '1.44' },
      { apiVersion: '1.60', minApiVersion: '1.56' },
      // An engine of the far future, as long as it accepts the newest version of the CLI.
      { apiVersion: '2.3', minApiVersion: '1.40' },
    ]) {
      expect(dockerApiMismatch(engine, CLI), JSON.stringify(engine)).toBeUndefined();
    }
  });

  // The versions are numbers: 1.9 is older than 1.40.
  it('finds an engine whose newest API version is older than the oldest one of the CLI', () => {
    expect(dockerApiMismatch({ apiVersion: '1.39', minApiVersion: '1.12' }, CLI)).toEqual({ kind: 'engineTooOld', engine: '1.39', minimum: '1.40' });
    expect(dockerApiMismatch({ apiVersion: '1.9' }, CLI)).toEqual({ kind: 'engineTooOld', engine: '1.9', minimum: '1.40' });
  });

  it('finds an engine whose minimum API version is newer than the newest one of the CLI', () => {
    expect(dockerApiMismatch({ apiVersion: '1.64', minApiVersion: '1.57' }, CLI)).toEqual({ kind: 'cliTooOld', client: '1.56', minimum: '1.57' });
    expect(dockerApiMismatch({ minApiVersion: '2.0' }, CLI)).toEqual({ kind: 'cliTooOld', client: '1.56', minimum: '2.0' });
  });

  // An engine that names no such version: that half is not checked.
  it('checks only the versions that the engine named', () => {
    expect(dockerApiMismatch({}, CLI)).toBeUndefined();
    expect(dockerApiMismatch({ apiVersion: '1.52' }, CLI)).toBeUndefined();
    expect(dockerApiMismatch({ minApiVersion: '1.40' }, CLI)).toBeUndefined();
  });
});

describe('dockerApiErrorMismatch', () => {
  it('reads the two errors of the engine for the API version of the CLI', () => {
    expect(dockerApiErrorMismatch('Error response from daemon: client version 1.56 is too new. Maximum supported API version is 1.39\n', CLI)).toEqual({
      kind: 'engineTooOld',
      engine: '1.39',
      minimum: '1.40',
    });
    expect(
      dockerApiErrorMismatch('Error response from daemon: client version 1.56 is too old. Minimum supported API version is 1.60, please upgrade your client to a newer version', CLI),
    ).toEqual({ kind: 'cliTooOld', client: '1.56', minimum: '1.60' });
  });

  // Another CLI (the one of the shell before the relay, or of this computer) calls with another version: its error is
  // not one of the Docker CLI of Devspaces.
  it('reads no error of a call with another API version, and no other error', () => {
    expect(dockerApiErrorMismatch('Error response from daemon: client version 1.41 is too new. Maximum supported API version is 1.39', CLI)).toBeUndefined();
    expect(dockerApiErrorMismatch('Error response from daemon: client version 1.43 is too old. Minimum supported API version is 1.44', CLI)).toBeUndefined();
    expect(dockerApiErrorMismatch('', CLI)).toBeUndefined();
    // A call with the newest version of the CLI after a failed negotiation, on an engine that the CLI can work with.
    expect(dockerApiErrorMismatch('Error response from daemon: client version 1.56 is too new. Maximum supported API version is 1.47', CLI)).toBeUndefined();
    expect(dockerApiErrorMismatch('Error response from daemon: client version 1.56 is too old. Minimum supported API version is 1.44', CLI)).toBeUndefined();
    expect(dockerApiErrorMismatch('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', CLI)).toBeUndefined();
  });
});

describe('dockerApiMismatchText', () => {
  it('names the CLI, the engine, both versions and the way out', () => {
    expect(dockerApiMismatchText({ kind: 'engineTooOld', engine: '1.39', minimum: '1.40' }, 'build-box', OWN)).toBe(
      'The Docker CLI 29.9.2 of Devspaces cannot work with the Docker engine on build-box: the engine speaks the Docker API up to version 1.39, and the CLI ' +
        'needs version 1.40 or later. Update that Docker engine.',
    );
    expect(dockerApiMismatchText({ kind: 'cliTooOld', client: '1.56', minimum: '1.60' }, 'wsl:devspaces', OWN)).toBe(
      'The Docker CLI 29.9.2 of Devspaces cannot work with the Docker engine on wsl:devspaces: the engine needs the Docker API version 1.60 or later, and the ' +
        'CLI speaks only up to version 1.56. A newer version of Devspaces brings a newer Docker CLI. Until then, that engine accepts the CLI when the ' +
        'environment variable DOCKER_MIN_API_VERSION of dockerd is 1.56 or lower.',
    );
  });
});
