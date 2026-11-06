// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../ports';
import { DOCKER_CONTEXT_DESCRIPTION, dockerConfigDir, dockerContextFile, readDockerContext, syncDockerContext } from './dockerContext';

const SOCKET = '/home/ada/.nimblescape/devspaces/vm/devspaces/sock/docker.sock';
const HOST = `unix://${SOCKET}`;

let config: string;
let file: string;
let calls: string[][];
/** The answer of the next calls of the Docker CLI of the test. */
let answer: RunResult;

/** The context as the Docker CLI stores it. */
function store(meta: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(meta));
}

const ours = (host: string) => ({ Name: 'devspaces', Metadata: { Description: DOCKER_CONTEXT_DESCRIPTION }, Endpoints: { docker: { Host: host, SkipTLSVerify: false } } });
const deps = () => ({ file, docker: async (args: string[]) => (calls.push(args), answer) });

beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-docker-config-'));
  file = dockerContextFile(config);
  calls = [];
  answer = { exitCode: 0, stdout: 'devspaces\n', stderr: '', timedOut: false };
});

afterEach(() => fs.rmSync(config, { recursive: true, force: true }));

describe('the Docker context of the VM of Devspaces', () => {
  it('finds the context store of the Docker CLI: DOCKER_CONFIG, else ~/.docker, and the file by the SHA-256 of the name', () => {
    expect(dockerConfigDir({ DOCKER_CONFIG: '/etc/docker-ada' }, 'linux', '/home/ada')).toBe('/etc/docker-ada');
    expect(dockerConfigDir({ DOCKER_CONFIG: '' }, 'linux', '/home/ada')).toBe(path.join('/home/ada', '.docker'));
    expect(dockerConfigDir({}, 'darwin', '/Users/ada')).toBe(path.join('/Users/ada', '.docker'));
    // sha256("devspaces"), as `docker context create devspaces` names the folder.
    expect(dockerContextFile('/home/ada/.docker')).toBe(path.join('/home/ada/.docker', 'contexts', 'meta', 'c24b8a69003f47e0d3b7d30f286872590b11caf54286f5e9b75c847a75074c5e', 'meta.json'));
  });

  it('knows its own context by its description; another one, or one that cannot be read, is not its own', () => {
    expect(readDockerContext(file)).toEqual({ kind: 'missing' });
    store(ours(HOST));
    expect(readDockerContext(file)).toEqual({ kind: 'ours', host: HOST });
    store({ Name: 'devspaces', Metadata: {}, Endpoints: { docker: { Host: 'ssh://box' } } });
    expect(readDockerContext(file)).toEqual({ kind: 'other' });
    fs.writeFileSync(file, '{not json');
    expect(readDockerContext(file)).toEqual({ kind: 'other' });
    expect(readDockerContext(file, () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); })).toEqual({ kind: 'other' });
  });

  it('creates it for the socket of the VM, never as the current context, and changes only its own one', async () => {
    expect(await syncDockerContext(deps(), HOST)).toEqual({ kind: 'created' });
    expect(calls).toEqual([['context', 'create', 'devspaces', '--description', DOCKER_CONTEXT_DESCRIPTION, '--docker', `host=${HOST}`]]);
    store(ours(HOST));
    expect(await syncDockerContext(deps(), HOST)).toEqual({ kind: 'unchanged' });
    store(ours('unix:///old/docker.sock'));
    expect(await syncDockerContext(deps(), HOST)).toEqual({ kind: 'updated' });
    expect(calls[1]).toEqual(['context', 'update', 'devspaces', '--docker', `host=${HOST}`]);
    // A context devspaces that Devspaces did not create stays as it is, also when the setting is off.
    store({ Name: 'devspaces', Metadata: { Description: '' }, Endpoints: { docker: { Host: 'ssh://box' } } });
    expect(await syncDockerContext(deps(), HOST)).toEqual({ kind: 'taken' });
    expect(await syncDockerContext(deps(), undefined)).toEqual({ kind: 'unchanged' });
    expect(calls).toHaveLength(2);
  });

  it('points to the named pipe of the context on Windows', async () => {
    const pipe = 'npipe:////./pipe/devspaces-context-0123456789abcdef';
    expect(await syncDockerContext(deps(), pipe)).toEqual({ kind: 'created' });
    expect(calls).toEqual([['context', 'create', 'devspaces', '--description', DOCKER_CONTEXT_DESCRIPTION, '--docker', `host=${pipe}`]]);
    store(ours(pipe));
    expect(await syncDockerContext(deps(), pipe)).toEqual({ kind: 'unchanged' });
  });

  it('removes its own context when the setting is off; the current context stays, and why', async () => {
    expect(await syncDockerContext(deps(), undefined)).toEqual({ kind: 'unchanged' });
    store(ours(HOST));
    expect(await syncDockerContext(deps(), undefined)).toEqual({ kind: 'removed' });
    expect(calls).toEqual([['context', 'rm', 'devspaces']]);
    answer = { exitCode: 1, stdout: '', stderr: 'context "devspaces" is in use, set -f flag to force remove\n', timedOut: false };
    expect(await syncDockerContext(deps(), undefined)).toEqual({ kind: 'current', detail: 'context "devspaces" is in use, set -f flag to force remove' });
  });

  it('takes the same change by another window at the same time as done', async () => {
    answer = { exitCode: 1, stdout: '', stderr: 'context "devspaces" already exists\n', timedOut: false };
    const racing = { file, docker: async (args: string[]) => (calls.push(args), store(ours(HOST)), answer) };
    expect(await syncDockerContext(racing, HOST)).toEqual({ kind: 'unchanged' });
    expect(calls).toHaveLength(1);
  });

  it('needs a Docker CLI only for a change, an address that the CLI takes, and never throws', async () => {
    expect(await syncDockerContext({ file, docker: undefined }, HOST)).toEqual({ kind: 'noCli' });
    expect(await syncDockerContext({ file, docker: undefined }, undefined)).toEqual({ kind: 'unchanged' });
    expect(await syncDockerContext(deps(), 'unix:///Users/ada lovelace/sock/docker.sock')).toEqual({ kind: 'failed', detail: expect.stringContaining('cannot take the address') });
    expect(await syncDockerContext(deps(), 'unix:///a,b/docker.sock')).toMatchObject({ kind: 'failed' });
    expect(await syncDockerContext(deps(), 'unix://relative/docker.sock')).toMatchObject({ kind: 'failed' });
    expect(await syncDockerContext(deps(), 'npipe:////./pipe/a b')).toMatchObject({ kind: 'failed' });
    expect(await syncDockerContext(deps(), 'tcp://127.0.0.1:2375')).toMatchObject({ kind: 'failed' });
    answer = { exitCode: 1, stdout: '', stderr: 'permission denied\n', timedOut: false };
    expect(await syncDockerContext(deps(), HOST)).toEqual({ kind: 'failed', detail: 'permission denied' });
    expect(await syncDockerContext({ file, docker: () => Promise.reject(new Error('spawn docker ENOENT')) }, HOST)).toEqual({ kind: 'failed', detail: 'spawn docker ENOENT' });
    expect(calls).toHaveLength(1);
  });
});
