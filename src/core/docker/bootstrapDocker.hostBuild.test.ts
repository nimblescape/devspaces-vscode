// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The build of an image on the WSL distribution of Devspaces runs with the Docker CLI there and its buildx (BuildKit),
// when it has buildx (BootstrapDockerOptions.hostCli): `docker build … -f Dockerfile -`, with the context as a tar
// archive on its standard input. Otherwise, and on any other engine, the build runs here as before.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandError } from '../errors';
import { abortError, isAbortError, silentLogger, type Logger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { BootstrapDocker, type HostDockerCli } from './bootstrapDocker';
import { LOCAL_DOCKER_TARGET, WSL_HOST, remoteDockerTarget } from './dockerHost';
import { runWithDockerTarget } from './dockerTargets';
import { firstTarFile } from './tarFile';

const WSL = remoteDockerTarget(WSL_HOST);
const SSH = remoteDockerTarget('build-box');
const DOCKERFILE_TEXT = 'FROM debian:trixie-slim\nCOPY Dockerfile /Dockerfile\n';
const BUILDX_VERSION = 'github.com/docker/buildx v0.38.1 0dbe87f36ed472fe36b6796c3f70b4210a731fc5\n';
/** The Docker pipe of the extension for the WSL distribution, which the calls here go through. */
const PIPE = 'unix:///run/user/1000/devspaces-0123456789abcdef/docker.sock';
const dockerPipe = (): string => PIPE;

function ok(stdout = '', stderr = ''): RunResult {
  return { exitCode: 0, stdout, stderr, timedOut: false };
}

interface Call {
  args: string[];
  options: RunOptions;
}

/** The Docker CLI of this computer: records its calls; `docker image ls` lists one image. */
function localRunner(): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ProcessRunner = {
    async run(_file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
      calls.push({ args: [...args], options });
      if (args[0] === 'image' && args[1] === 'ls' && !args.includes('dangling=true')) {
        return ok(`${JSON.stringify({ ID: `sha256:${'a'.repeat(64)}`, Repository: 'devspaces-worker', Tag: 'abc', CreatedAt: '' })}\n`);
      }
      return ok();
    },
  };
  return { runner, calls };
}

/** The Docker CLI on the computer of the engine: records its calls and answers with `handler`. */
function hostCliOf(handler: (call: Call) => RunResult | Promise<RunResult>): { cli: HostDockerCli; calls: Call[] } {
  const calls: Call[] = [];
  const cli: HostDockerCli = async (args, options) => {
    const call = { args: [...args], options };
    calls.push(call);
    return handler(call);
  };
  return { cli, calls };
}

/** The arguments of `docker build` without the pair `--label nimblescape.devspaces.build-id=<nonce>`. */
function withoutBuildLabel(args: readonly string[]): string[] {
  const index = args.findIndex((arg) => arg.startsWith('nimblescape.devspaces.build-id='));
  expect(args[index - 1]).toBe('--label');
  return [...args.slice(0, index - 1), ...args.slice(index + 1)];
}

function recordingLogger(): { logger: Logger; infos: string[]; warnings: string[] } {
  const infos: string[] = [];
  const warnings: string[] = [];
  return { logger: { ...silentLogger, info: (message) => infos.push(message), warn: (message) => warnings.push(message) }, infos, warnings };
}

describe('BootstrapDocker.buildImage with the Docker CLI on the computer of the engine', () => {
  let folder: string;
  let dockerfile: string;

  beforeEach(async () => {
    folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devspaces-host-build-'));
    dockerfile = path.join(folder, 'Dockerfile');
    await fs.promises.writeFile(dockerfile, DOCKERFILE_TEXT);
  });

  afterEach(async () => {
    await fs.promises.rm(folder, { recursive: true, force: true });
  });

  const buildOptions = (extra: Partial<Parameters<BootstrapDocker['buildImage']>[0]> = {}): Parameters<BootstrapDocker['buildImage']>[0] => ({
    tag: 'devspaces-worker:abc',
    dockerfile,
    context: folder,
    labels: { 'nimblescape.devspaces.worker': 'true' },
    buildArgs: { DEVCONTAINER_CLI_VERSION: '0.90.0' },
    pull: true,
    ...extra,
  });

  it('builds on the WSL distribution with its Docker CLI and buildx, with the context as a tar archive on standard input', async () => {
    const { runner, calls } = localRunner();
    const output: string[] = [];
    const host = hostCliOf((call) => {
      if (call.args[0] === 'buildx') return ok(BUILDX_VERSION);
      call.options.onStderr?.('#1 [internal] load remote build context\n');
      return ok();
    });
    const hostCli = vi.fn(() => host.cli);
    const { logger, infos } = recordingLogger();
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'win32', { dockerPipe, hostCli });
    const id = await runWithDockerTarget(WSL, () => docker.buildImage(buildOptions({ onOutput: (text) => output.push(text) })));
    expect(id).toBe(`sha256:${'a'.repeat(64)}`);
    expect(hostCli).toHaveBeenCalledWith(WSL);
    expect(host.calls.map((call) => call.args[0])).toEqual(['buildx', 'build']);
    expect(host.calls[0].args).toEqual(['buildx', 'version']);
    expect(host.calls[0].options.timeoutMs).toBeGreaterThan(0);
    const build = host.calls[1];
    expect(withoutBuildLabel(build.args)).toEqual([
      'build',
      '--builder',
      'default',
      '-t',
      'devspaces-worker:abc',
      '-f',
      'Dockerfile',
      '--pull',
      '--label',
      'nimblescape.devspaces.worker=true',
      '--build-arg',
      'DEVCONTAINER_CLI_VERSION=0.90.0',
      '-',
    ]);
    // The context: the Dockerfile in a tar archive.
    const input = build.options.input;
    expect(Buffer.isBuffer(input)).toBe(true);
    expect(firstTarFile(input as Buffer, { name: 'Dockerfile', maxBytes: 1024 })?.toString('utf8')).toBe(DOCKERFILE_TEXT);
    expect(output).toEqual(['#1 [internal] load remote build context\n']);
    // Only the lookup by the build label runs here; no build.
    expect(calls.every((call) => call.args[0] === 'image')).toBe(true);
    const label = build.args.find((arg) => arg.startsWith('nimblescape.devspaces.build-id='));
    expect(calls[0].args).toEqual(['image', 'ls', '--filter', `label=${label}`, '--no-trunc', '--format', '{{json .}}']);
    expect(infos).toContain(`Building image devspaces-worker:abc (--pull) on ${WSL_HOST} with its Docker CLI and buildx v0.38.1 (BuildKit).`);
    expect(infos.some((line) => /^docker build: exit code 0 after \d+\.\d s\.$/.test(line))).toBe(true);
  });

  it('builds here as before when the Docker CLI there has no buildx', async () => {
    const { runner, calls } = localRunner();
    const host = hostCliOf(() => ({ exitCode: 1, stdout: '', stderr: "docker: 'buildx' is not a docker command.\n", timedOut: false }));
    const { logger, infos } = recordingLogger();
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'win32', { dockerPipe, hostCli: () => host.cli });
    await runWithDockerTarget(WSL, () => docker.buildImage(buildOptions()));
    expect(host.calls.map((call) => call.args)).toEqual([['buildx', 'version']]);
    expect(withoutBuildLabel(calls[0].args)).toEqual([
      'build',
      '-t',
      'devspaces-worker:abc',
      '-f',
      dockerfile,
      '--pull',
      '--label',
      'nimblescape.devspaces.worker=true',
      '--build-arg',
      'DEVCONTAINER_CLI_VERSION=0.90.0',
      folder,
    ]);
    expect(calls[0].options.input).toBeUndefined();
    expect(infos).toContain(
      `The Docker CLI on ${WSL_HOST} has no buildx that runs (docker buildx version: docker: 'buildx' is not a docker command.), so the image is built from this computer, as before.`,
    );
    expect(infos).toContain('Building image devspaces-worker:abc (--pull).');
  });

  it('builds here as before when the check of buildx there fails or does not answer, or the hook throws', async () => {
    const { runner, calls } = localRunner();
    const { logger, infos, warnings } = recordingLogger();
    let answer: () => RunResult | Promise<RunResult> = () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    const host = hostCliOf(() => answer());
    let hostCli: () => HostDockerCli | undefined = () => host.cli;
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'win32', { dockerPipe, hostCli: () => hostCli() });
    await runWithDockerTarget(WSL, () => docker.buildImage(buildOptions()));
    expect(infos.some((line) => line.includes('(docker buildx version: no answer within the time limit)'))).toBe(true);
    answer = () => Promise.reject(new Error('spawn wsl.exe EACCES'));
    await runWithDockerTarget(WSL, () => docker.buildImage(buildOptions()));
    hostCli = () => {
      throw new Error('broken');
    };
    await runWithDockerTarget(WSL, () => docker.buildImage(buildOptions()));
    expect(warnings).toEqual([
      `The image cannot be built with the Docker CLI on ${WSL_HOST}, so the image is built from this computer, as before: spawn wsl.exe EACCES`,
      `The image cannot be built with the Docker CLI on ${WSL_HOST}, so the image is built from this computer, as before: broken`,
    ]);
    expect(calls.filter((call) => call.args[0] === 'build')).toHaveLength(3);
  });

  it('builds here without a check where the hook gives no Docker CLI, outside an operation on a remote engine, and for a Dockerfile below its context', async () => {
    const { runner, calls } = localRunner();
    const host = hostCliOf(() => ok(BUILDX_VERSION));
    const hostCli = vi.fn((target: { host: string }) => (target.host === WSL_HOST ? host.cli : undefined));
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'win32', { dockerPipe, hostCli });
    await runWithDockerTarget(SSH, () => docker.buildImage(buildOptions()));
    expect(hostCli).toHaveBeenCalledWith(SSH);
    await runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.buildImage(buildOptions()));
    await docker.buildImage(buildOptions());
    const nested = path.join(folder, 'docker');
    await fs.promises.mkdir(nested);
    await fs.promises.writeFile(path.join(nested, 'Dockerfile'), DOCKERFILE_TEXT);
    await runWithDockerTarget(WSL, () => docker.buildImage(buildOptions({ dockerfile: path.join(nested, 'Dockerfile') })));
    expect(hostCli).toHaveBeenCalledTimes(1);
    expect(host.calls).toEqual([]);
    expect(calls.filter((call) => call.args[0] === 'build')).toHaveLength(4);
  });

  it('builds here as before when the Docker CLI there could not be started for the build', async () => {
    const { runner, calls } = localRunner();
    const host = hostCliOf((call) => (call.args[0] === 'buildx' ? ok(BUILDX_VERSION) : Promise.reject(new Error('spawn wsl.exe ENOENT'))));
    const { logger, warnings } = recordingLogger();
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'win32', { dockerPipe, hostCli: () => host.cli });
    expect(await runWithDockerTarget(WSL, () => docker.buildImage(buildOptions()))).toBe(`sha256:${'a'.repeat(64)}`);
    expect(warnings).toEqual([`The Docker CLI on ${WSL_HOST} could not be started, so the image is built from this computer, as before: spawn wsl.exe ENOENT`]);
    expect(calls.filter((call) => call.args[0] === 'build').map((call) => call.args.at(-1))).toEqual([folder]);
  });

  it('throws CommandError when the build there fails, and builds nothing here', async () => {
    const { runner, calls } = localRunner();
    const host = hostCliOf((call) => (call.args[0] === 'buildx' ? ok(BUILDX_VERSION) : { exitCode: 1, stdout: '', stderr: 'ERROR: failed to solve\n', timedOut: false }));
    const { logger, infos } = recordingLogger();
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'win32', { dockerPipe, hostCli: () => host.cli });
    const error = await runWithDockerTarget(WSL, () => docker.buildImage(buildOptions())).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).stderr).toContain('failed to solve');
    expect(calls).toEqual([]);
    expect(infos.some((line) => /^docker build: exit code 1 after \d+\.\d s\.$/.test(line))).toBe(true);
  });

  it('rejects with an AbortError when the signal aborts during the check or the build, and builds nothing here', async () => {
    const { runner, calls } = localRunner();
    let stage: 'check' | 'build' = 'check';
    const host = hostCliOf((call) => {
      if (call.args[0] === 'buildx' && stage === 'check') return Promise.reject(abortError());
      if (call.args[0] === 'buildx') return ok(BUILDX_VERSION);
      return Promise.reject(abortError());
    });
    const { logger, infos } = recordingLogger();
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'win32', { dockerPipe, hostCli: () => host.cli });
    const signal = new AbortController().signal;
    const first = await runWithDockerTarget(WSL, () => docker.buildImage(buildOptions({ signal }))).catch((caught: unknown) => caught);
    expect(isAbortError(first)).toBe(true);
    expect(host.calls[0].options.signal).toBe(signal);
    stage = 'build';
    const second = await runWithDockerTarget(WSL, () => docker.buildImage(buildOptions({ signal }))).catch((caught: unknown) => caught);
    expect(isAbortError(second)).toBe(true);
    expect(host.calls[2].options.signal).toBe(signal);
    expect(calls).toEqual([]);
    expect(infos.some((line) => /^docker build: cancelled after \d+\.\d s\.$/.test(line))).toBe(true);
  });
});
