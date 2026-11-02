// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The API versions of the real engine (src/core/docker/dockerApiVersion.ts): the versions that the worker reads
// (`ApiVersion` and `MinAPIVersion` of `GET /version`), and the two errors of the engine for a call with an API
// version that it does not speak, as dockerApiErrorMismatch reads them for the Docker CLI that called.
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { LOCAL_CLI_VERSION_FORMAT, LOCAL_CLI_VERSION_TIMEOUT_MS, dockerApiErrorMismatch, dockerApiMismatch, localDockerCliApi } from '../../src/core/docker/dockerApiVersion';
import { NodeProcessRunner } from '../../src/core/process';
import { compareVersions } from '../../src/core/vscodeExtensions';
import { helperDockerSocket } from '../../src/core/helper/helperImages';
import { engineApi, engineHijack } from '../../src/helperChannel/engineApi';
import { dockerEngine } from '../../src/helperChannel/engineClient';
import { dockerTestContext } from './harness';

describe('the Docker API versions of the real engine', () => {
  const { run, env } = dockerTestContext('dockerApiVersion');
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

  // As extension.ts reads the Docker CLI of this computer: an address that nobody serves, and no context.
  it('reads the newest API version of the Docker CLI without an engine, at least the one that it speaks with this engine', async () => {
    const runner = new NodeProcessRunner();
    const cliEnv: NodeJS.ProcessEnv = { ...env, DOCKER_HOST: `unix://${path.join(os.tmpdir(), `devspaces-no-docker-engine-${process.pid}.sock`)}` };
    delete cliEnv.DOCKER_CONTEXT;
    const result = await runner.run(run.dockerPath, ['version', '--format', LOCAL_CLI_VERSION_FORMAT], { env: cliEnv, timeoutMs: LOCAL_CLI_VERSION_TIMEOUT_MS });
    expect(result.exitCode).not.toBe(0);
    const local = localDockerCliApi(result.stdout);
    if (local === undefined) throw new Error(`not read: ${result.stdout} ${result.stderr}`);
    expect(local.range.min).toBeUndefined();
    // With the engine, the CLI speaks the lower of its newest version and the newest one of the engine.
    const withEngine = await runner.run(run.dockerPath, ['version', '--format', '{{.Client.APIVersion}}'], { env, timeoutMs: LOCAL_CLI_VERSION_TIMEOUT_MS });
    expect(compareVersions(local.range.max, withEngine.stdout.trim())).toBeGreaterThanOrEqual(0);
  });
});
