// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The API versions of the real engine (src/core/docker/dockerApiVersion.ts): the versions that the worker reads
// (`ApiVersion` and `MinAPIVersion` of `GET /version`), and the two errors of the engine for a call with an API
// version that it does not speak, as dockerApiErrorMismatch reads them for the Docker CLI that called.
import { describe, expect, it } from 'vitest';
import { dockerApiErrorMismatch, dockerApiMismatch } from '../../src/core/docker/dockerApiVersion';
import { helperDockerSocket } from '../../src/core/helper/helperImages';
import { engineApi, engineHijack } from '../../src/helperChannel/engineApi';
import { dockerEngine } from '../../src/helperChannel/engineClient';
import { dockerTestContext } from './harness';

describe('the Docker API versions of the real engine', () => {
  const { env } = dockerTestContext('dockerApiVersion');
  const socket = helperDockerSocket(env, process.platform);
  const api = engineApi(socket);

  it('names its newest and its oldest API version, and refuses a call outside of them with the errors that the extension reads', async () => {
    const version = await dockerEngine(api, engineHijack(socket)).version();
    expect(version.apiVersion).toMatch(/^1\.\d+$/);
    expect(version.minApiVersion).toMatch(/^1\.\d+$/);
    const newest = version.apiVersion;
    const oldest = version.minApiVersion ?? '';
    // A CLI that speaks exactly the versions of the engine works with it.
    expect(dockerApiMismatch(version, { min: newest, max: newest })).toBeUndefined();
    expect(dockerApiMismatch(version, { min: oldest, max: oldest })).toBeUndefined();

    const minor = (text: string) => Number(text.split('.')[1]);
    const tooNew = `1.${minor(newest) + 1}`;
    const tooOld = `1.${minor(oldest) - 1}`;
    const answerNew = await api({ method: 'GET', path: `/v${tooNew}/version` });
    expect(answerNew.status).toBe(400);
    // A CLI whose oldest and newest version is `tooNew` calls with it.
    expect(dockerApiErrorMismatch(answerNew.body, { min: tooNew, max: tooNew })).toEqual({ kind: 'engineTooOld', engine: newest, minimum: tooNew });
    const answerOld = await api({ method: 'GET', path: `/v${tooOld}/version` });
    expect(answerOld.status).toBe(400);
    expect(dockerApiErrorMismatch(answerOld.body, { min: tooOld, max: tooOld })).toEqual({ kind: 'cliTooOld', client: tooOld, minimum: oldest });
  });
});
