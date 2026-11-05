// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The build of an image runs in a container of the build image of Devspaces (buildx) on the engine, the same on every
// engine: only the way to the engine differs (the Docker context of the local Docker, the Docker pipe of the extension,
// `ssh://<host>`). The build image is pulled by its digest when it is missing, and gets its own tag. `docker build`
// here is the fallback when that is not possible.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandError } from '../errors';
import { abortError, isAbortError, silentLogger, type Logger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { BootstrapDocker, BUILD_CONTAINER_REMOVE_TIMEOUT_MS } from './bootstrapDocker';
import { BUILDX_PIN, buildxImageTag, buildxPulledReference, buildxRunArgs } from './buildxImage';
import { WSL_HOST, remoteDockerTarget, type DockerTarget } from './dockerHost';
import { runWithDockerTarget } from './dockerTargets';
import { firstTarFile } from './tarFile';

const WSL = remoteDockerTarget(WSL_HOST);
const SSH = remoteDockerTarget('build-box');
const LOCAL: DockerTarget = { kind: 'local', host: '', endpoint: 'unix:///var/run/docker.sock', context: 'default' };
const DOCKERFILE_TEXT = 'FROM debian:trixie-slim\nCOPY Dockerfile /Dockerfile\n';
const TAG = buildxImageTag();
const PINNED = buildxPulledReference();
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
/** The Docker pipe of the extension for the WSL distribution. */
const PIPE = 'unix:///run/user/1000/devspaces-0123456789abcdef/docker.sock';
const dockerPipe = (target: DockerTarget): string | undefined => (target.host === WSL_HOST ? PIPE : undefined);

function ok(stdout = '', stderr = ''): RunResult {
  return { exitCode: 0, stdout, stderr, timedOut: false };
}

function failed(exitCode: number, stderr: string): RunResult {
  return { exitCode, stdout: '', stderr, timedOut: false };
}

const missing = (reference: string): RunResult => failed(1, `Error response from daemon: No such image: ${reference}\n`);

interface Call {
  args: string[];
  options: RunOptions;
}

/**
 * The Docker CLI: records its calls and answers with `handler` (undefined: the default answer). By default the build
 * image is there, the lookup by the build label finds one image, and every other call succeeds.
 */
function runnerOf(handler: (call: Call) => RunResult | Promise<RunResult> | undefined = () => undefined): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ProcessRunner = {
    async run(_file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
      const call = { args: [...args], options };
      calls.push(call);
      const answer = await handler(call);
      if (answer !== undefined) return answer;
      if (args[0] === 'image' && args[1] === 'ls' && args.some((arg) => arg.startsWith('label=')) && !args.includes('dangling=true')) {
        return ok(`${JSON.stringify({ ID: IMAGE_ID, Repository: 'devspaces-worker', Tag: 'abc', CreatedAt: '' })}\n`);
      }
      return ok();
    },
  };
  return { runner, calls };
}

/** The arguments without the pair `--label nimblescape.devspaces.build-id=<nonce>`. */
function withoutBuildLabel(args: readonly string[]): string[] {
  const index = args.findIndex((arg) => arg.startsWith('nimblescape.devspaces.build-id='));
  expect(args[index - 1]).toBe('--label');
  return [...args.slice(0, index - 1), ...args.slice(index + 1)];
}

/** The name of the build container of a `docker run` call. */
function containerName(call: Call): string {
  const name = call.args[call.args.indexOf('--name') + 1];
  expect(name).toMatch(/^devspaces-build-[0-9a-f]{16}$/);
  return name;
}

const isRun = (call: Call): boolean => call.args[0] === 'run';
const isClassicBuild = (call: Call): boolean => call.args[0] === 'build';
const isRemoval = (call: Call): boolean => call.args[0] === 'rm';

function recordingLogger(): { logger: Logger; infos: string[]; warnings: string[] } {
  const infos: string[] = [];
  const warnings: string[] = [];
  return { logger: { ...silentLogger, info: (message) => infos.push(message), warn: (message) => warnings.push(message) }, infos, warnings };
}

describe('BootstrapDocker.buildImage in a container of the build image', () => {
  let folder: string;
  let dockerfile: string;

  beforeEach(async () => {
    folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'devspaces-build-container-'));
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

  /** The `docker run` of the build, without the build label, for the container `name` and the socket `socket`. */
  const expectedRun = (name: string, socket: string): string[] =>
    buildxRunArgs({
      name,
      image: TAG,
      socket,
      tag: 'devspaces-worker:abc',
      dockerfile: 'Dockerfile',
      buildArgs: ['--pull', '--label', 'nimblescape.devspaces.worker=true', '--build-arg', 'DEVCONTAINER_CLI_VERSION=0.90.0'],
    });

  it.each([
    ['the local Docker', LOCAL, '/var/run/docker.sock', { DOCKER_CONTEXT: 'default' }],
    ['the WSL distribution of Devspaces', WSL, '/var/run/docker.sock', { DOCKER_HOST: PIPE }],
    ['an SSH host', SSH, '/run/user/1000/docker.sock', { DOCKER_HOST: 'ssh://build-box' }],
  ])('builds the same way on %s; only the way to the engine differs', async (_name, target, socket, env) => {
    const output: string[] = [];
    const { runner, calls } = runnerOf((call) => {
      if (!isRun(call)) return undefined;
      call.options.onStderr?.('#1 [internal] load remote build context\n');
      return ok();
    });
    const engineSocket = vi.fn(async (of: DockerTarget | undefined) => (of?.host === 'build-box' ? '/run/user/1000/docker.sock' : '/var/run/docker.sock'));
    const { logger, infos } = recordingLogger();
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', { dockerPipe, engineSocket });
    const id = await runWithDockerTarget(target, () => docker.buildImage(buildOptions({ onOutput: (text) => output.push(text) })));
    expect(id).toBe(IMAGE_ID);
    expect(engineSocket).toHaveBeenCalledWith(target);
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['image', 'inspect'],
      ['run', '--rm'],
      ['image', 'ls'],
      ['image', 'ls'],
    ]);
    expect(calls[0].args).toEqual(['image', 'inspect', '--format', '{{json .Id}}', TAG]);
    const run = calls[1];
    expect(withoutBuildLabel(run.args)).toEqual(expectedRun(containerName(run), socket));
    // The context: the Dockerfile in a tar archive on the standard input.
    expect(firstTarFile(run.options.input as Buffer, { name: 'Dockerfile', maxBytes: 1024 })?.toString('utf8')).toBe(DOCKERFILE_TEXT);
    expect(run.options.env).toMatchObject(env);
    expect(output).toEqual(['#1 [internal] load remote build context\n']);
    expect(infos).toContain(`Building image devspaces-worker:abc (--pull) in the container ${containerName(run)} with buildx ${BUILDX_PIN.version} (BuildKit).`);
    expect(infos.some((line) => /^docker run: exit code 0 after \d+\.\d s\.$/.test(line))).toBe(true);
  });

  it('mounts /var/run/docker.sock without engineSocket', async () => {
    const { runner, calls } = runnerOf();
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', {});
    await docker.buildImage(buildOptions());
    expect(calls.find(isRun)?.args).toContain('type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock');
  });

  it('pulls a missing build image by its digest, gives it its tag, removes the name of the pull and the older versions', async () => {
    const { runner, calls } = runnerOf((call) => {
      if (call.args[0] === 'image' && call.args[1] === 'inspect') return missing(call.args[4]);
      if (call.args[0] === 'pull') {
        call.options.onStdout?.(`Status: Downloaded newer image for ${PINNED}\n`);
        return ok();
      }
      if (call.args[0] === 'image' && call.args.includes(`reference=devspaces-buildx`)) {
        return ok(
          ['0.30.0', '0.38.0', BUILDX_PIN.version, '99.0.0', 'latest'].map((tag) => JSON.stringify({ ID: 'sha256:1', Repository: 'devspaces-buildx', Tag: tag })).join('\n'),
        );
      }
      return undefined;
    });
    const { logger, infos } = recordingLogger();
    const outputs: string[] = [];
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, { ...logger, output: (text) => outputs.push(text) }, 'linux', {});
    await runWithDockerTarget(SSH, () => docker.buildImage(buildOptions()));
    expect(calls.map((call) => call.args).slice(0, 8)).toEqual([
      ['image', 'inspect', '--format', '{{json .Id}}', TAG],
      ['image', 'inspect', '--format', '{{json .Id}}', PINNED],
      ['pull', PINNED],
      ['tag', PINNED, TAG],
      ['image', 'rm', PINNED],
      ['image', 'ls', '--filter', 'reference=devspaces-buildx', '--format', '{{json .}}'],
      // Only the older versions; a newer one (of a newer Devspaces on the same engine) and another tag stay.
      ['image', 'rm', 'devspaces-buildx:0.30.0'],
      ['image', 'rm', 'devspaces-buildx:0.38.0'],
    ]);
    expect(calls[8].args[0]).toBe('run');
    expect(calls[8].args).toContain(TAG);
    expect(infos).toContain(`Pulling the build image ${PINNED} (buildx ${BUILDX_PIN.version}).`);
    expect(outputs).toContain(`Status: Downloaded newer image for ${PINNED}\n`);
  });

  it('tags an image of the pinned digest that is there already, and removes none of its names', async () => {
    const { runner, calls } = runnerOf((call) => (call.args[0] === 'image' && call.args[1] === 'inspect' && call.args[4] === TAG ? missing(TAG) : undefined));
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', {});
    await docker.buildImage(buildOptions());
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ['image', 'inspect'],
      ['image', 'inspect'],
      ['tag', PINNED],
      ['image', 'ls'],
      ['run', '--rm'],
      ['image', 'ls'],
      ['image', 'ls'],
    ]);
    expect(calls.some((call) => call.args[0] === 'pull')).toBe(false);
  });

  it('builds with `docker build` when the build image cannot be pulled, and when Docker cannot run the container', async () => {
    let answer = (call: Call): RunResult | undefined => {
      if (call.args[0] === 'image' && call.args[1] === 'inspect') return missing(call.args[4]);
      if (call.args[0] === 'pull') return failed(1, 'Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit.\n');
      return undefined;
    };
    const { runner, calls } = runnerOf((call) => answer(call));
    const { logger, infos, warnings } = recordingLogger();
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', {});
    expect(await docker.buildImage(buildOptions())).toBe(IMAGE_ID);
    expect(calls.some(isRun)).toBe(false);
    const classic = calls.find(isClassicBuild);
    expect(withoutBuildLabel(classic?.args ?? [])).toEqual([
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
    expect(classic?.options.input).toBeUndefined();
    expect(warnings).toEqual([expect.stringMatching(/^The build image docker\/buildx-bin@sha256:[0-9a-f]{64} could not be prepared, so the image is built with `docker build`: .*pull rate limit/)]);
    expect(infos).toContain('Building image devspaces-worker:abc (--pull) with `docker build`.');

    calls.length = 0;
    warnings.length = 0;
    answer = (call) => (isRun(call) ? failed(125, 'docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /var/run/docker.sock\n') : undefined);
    await docker.buildImage(buildOptions());
    const name = containerName(calls.find(isRun) as Call);
    expect(calls.filter(isClassicBuild)).toHaveLength(1);
    expect(warnings).toEqual([`Docker could not run the build container ${name}, so the image is built with \`docker build\`: docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /var/run/docker.sock`]);
    await vi.waitFor(() => expect(calls.filter(isRemoval).map((call) => call.args)).toEqual([['rm', '-f', name]]));
  });

  it('fails with the error of a build that ran and failed, without `docker build`, and removes its container', async () => {
    const { runner, calls } = runnerOf((call) => {
      if (isRun(call)) return failed(1, 'ERROR: failed to build: failed to solve: process "/bin/sh -c false" did not complete successfully: exit code: 1\n');
      if (isRemoval(call)) return failed(1, 'Error response from daemon: No such container: x\n');
      return undefined;
    });
    const { logger, warnings } = recordingLogger();
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', {});
    const error = await docker.buildImage(buildOptions()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).stderr).toContain('failed to solve');
    expect(calls.some(isClassicBuild)).toBe(false);
    const name = containerName(calls.find(isRun) as Call);
    await vi.waitFor(() => expect(calls.filter(isRemoval).map((call) => [call.args, call.options.timeoutMs])).toEqual([[['rm', '-f', name], BUILD_CONTAINER_REMOVE_TIMEOUT_MS]]));
    // A container that its `--rm` removed already is no failure.
    expect(warnings).toEqual([]);
  });

  it('removes the container after a cancel, and logs when that fails', async () => {
    const { runner, calls } = runnerOf((call) => {
      if (isRun(call)) throw abortError();
      if (isRemoval(call)) return failed(1, 'Cannot connect to the Docker daemon\n');
      return undefined;
    });
    const { logger, warnings } = recordingLogger();
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', {});
    const error = await docker.buildImage(buildOptions()).catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    const name = containerName(calls.find(isRun) as Call);
    await vi.waitFor(() => expect(warnings).toEqual([`The build container ${name} could not be removed, so its build may go on: Cannot connect to the Docker daemon`]));
    expect(calls.some(isClassicBuild)).toBe(false);
  });

  it('builds with `docker build` when the Dockerfile is not at the top of its context folder', async () => {
    const { runner, calls } = runnerOf();
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', {});
    await docker.buildImage(buildOptions({ context: os.tmpdir() }));
    expect(calls.map((call) => call.args[0])).toEqual(['build', 'image', 'image']);
  });

  it('uses the tag that another window gave the build image while this one prepared it', async () => {
    let tagged = false;
    const { runner, calls } = runnerOf((call) => {
      if (call.args[0] === 'image' && call.args[1] === 'inspect') return tagged && call.args[4] === TAG ? ok('"sha256:1"') : missing(call.args[4]);
      if (call.args[0] === 'pull') {
        tagged = true;
        return failed(1, 'Error response from daemon: unexpected EOF\n');
      }
      return undefined;
    });
    const { logger, warnings } = recordingLogger();
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', {});
    await docker.buildImage(buildOptions());
    expect(calls.find(isRun)?.args).toContain(TAG);
    expect(calls.some(isClassicBuild)).toBe(false);
    expect(warnings).toEqual([]);
  });
});
