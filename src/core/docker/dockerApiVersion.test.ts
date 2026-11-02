// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { dockerApiErrorMismatch, dockerApiErrorText, dockerApiMismatch, dockerApiMismatchText, localDockerCliApi } from './dockerApiVersion';

/** The API versions of the Docker CLI 29.9.2. */
const CLI = { min: '1.40', max: '1.56' };
const OWN = { name: 'the Docker CLI 29.9.2 of Devspaces', kind: 'devspaces' } as const;

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
    // The form of an engine before Docker 17.04.
    expect(dockerApiErrorMismatch('Error response from daemon: client is newer than server (client API version: 1.56, server API version: 1.26)', CLI)).toEqual({
      kind: 'engineTooOld',
      engine: '1.26',
      minimum: '1.40',
    });
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

// The Docker CLI of this computer names only its newest API version.
describe('localDockerCliApi', () => {
  it('reads the version and the newest API version that `docker version` prints, also without an engine', () => {
    expect(localDockerCliApi('29.9.2 1.56\n')).toEqual({ name: 'the Docker CLI 29.9.2 of this computer', range: { max: '1.56' }, kind: 'computer' });
    expect(localDockerCliApi('24.0.7-ce 1.43')).toEqual({ name: 'the Docker CLI 24.0.7-ce of this computer', range: { max: '1.43' }, kind: 'computer' });
    for (const output of ['', '1.56', '29.9.2 latest', '29.9.2 1.56 more', 'a\tb 1.56', `${'9'.repeat(65)} 1.56`]) {
      expect(localDockerCliApi(output), JSON.stringify(output)).toBeUndefined();
    }
  });

  it('finds only an engine whose minimum is newer than its newest API version, by the probe or by the error of the engine', () => {
    const local = localDockerCliApi('24.0.7 1.43');
    if (local === undefined) throw new Error('not read');
    expect(dockerApiMismatch({ apiVersion: '1.56', minApiVersion: '1.44' }, local.range)).toEqual({ kind: 'cliTooOld', client: '1.43', minimum: '1.44' });
    expect(dockerApiErrorText('Error response from daemon: client version 1.43 is too old. Minimum supported API version is 1.44, please upgrade your client to a newer version', 'build-box', local)).toBe(
      'The Docker CLI 24.0.7 of this computer cannot work with the Docker engine on build-box: the engine needs the Docker API version 1.44 or later, and ' +
        'the CLI speaks only up to version 1.43. Update the Docker CLI of this computer. Until then, that engine accepts the CLI when the environment ' +
        'variable DOCKER_MIN_API_VERSION of dockerd is 1.43 or lower.',
    );
    // Its oldest version is not known: an old engine is left to the message of Docker.
    expect(dockerApiMismatch({ apiVersion: '1.20', minApiVersion: '1.12' }, local.range)).toBeUndefined();
    expect(dockerApiErrorMismatch('Error response from daemon: client version 1.43 is too new. Maximum supported API version is 1.20', local.range)).toBeUndefined();
  });
});
