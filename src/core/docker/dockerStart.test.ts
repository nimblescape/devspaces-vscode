// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it, vi } from 'vitest';
import { UserFacingError } from '../errors';
import { Messages } from '../messages';
import { abortError, isAbortError, silentLogger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
// The Docker CLI of the extension (BootstrapDocker).
import { BootstrapDocker } from './bootstrapDocker';
import { ensureDockerRunning, launchDetachedProcess } from './dockerStart';

interface Call {
  file: string;
  args: string[];
  options: RunOptions;
}

type Handler = (call: Call) => RunResult | Promise<RunResult>;

class FakeRunner implements ProcessRunner {
  readonly calls: Call[] = [];
  constructor(private readonly handler: Handler) {}
  /** As a real process: a call whose signal aborts ends with an AbortError. */
  async run(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const call = { file, args: [...args], options };
    this.calls.push(call);
    const { signal } = options;
    if (signal?.aborted) throw abortError();
    const answer = Promise.resolve(this.handler(call));
    if (signal === undefined) return answer;
    return new Promise<RunResult>((resolve, reject) => {
      const onAbort = (): void => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      answer.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }
}

const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr: string, exitCode = 1, stdout = ''): RunResult => ({ exitCode, stdout, stderr, timedOut: false });
const READY = ok('"29.8.0"\n');
const NOT_READY = fail('failed to connect to the docker API at unix:///var/run/docker.sock', 1, '""\n');
const DOCKER = '/usr/local/bin/docker';

/** `docker --version` and `docker version --format '{{json .Server}}'` of Docker. */
const DOCKER_CLI_VERSION = ok('Docker version 29.8.0, build 3f2a5b1\n');
const DOCKER_SERVER = ok(`${JSON.stringify({ Platform: { Name: 'Docker Engine - Community' }, Components: [{ Name: 'Engine', Version: '29.8.0' }, { Name: 'containerd', Version: '2.1.4' }], Version: '29.8.0' })}\n`);

interface Script {
  /** Results of `docker info`, in order; the last one repeats. */
  info: RunResult[];
  /** `docker --version`, or a function that answers each call. Default: the Docker CLI. */
  cliVersion?: RunResult | Promise<RunResult> | (() => RunResult | Promise<RunResult>);
  /** `docker version --format '{{json .Server}}'`. Default: Docker Engine. */
  serverVersion?: RunResult;
}

function setup(script: Script) {
  let infoIndex = 0;
  const runner = new FakeRunner((call) => {
    if (call.args[0] === 'info') {
      const result = script.info[Math.min(infoIndex, script.info.length - 1)];
      infoIndex++;
      return result;
    }
    if (call.args[0] === '--version') return typeof script.cliVersion === 'function' ? script.cliVersion() : (script.cliVersion ?? DOCKER_CLI_VERSION);
    if (call.args[0] === 'version') return script.serverVersion ?? DOCKER_SERVER;
    throw new Error(`Unexpected call: ${call.file} ${call.args.join(' ')}`);
  });
  // The file at the path of the CLI (BootstrapDocker.podmanCli): another identity is another file there.
  const cliFile = { identity: 'docker 29.8.0' as string | undefined };
  const docker = new BootstrapDocker(runner, DOCKER, { PATH: '/usr/bin' }, silentLogger, 'darwin', { fileIdentity: async () => cliFile.identity });
  const run = (options: { signal?: AbortSignal } = {}) => ensureDockerRunning(docker, silentLogger, options);
  const infoCalls = () => runner.calls.filter((call) => call.args[0] === 'info');
  const versionCalls = () => runner.calls.filter((call) => call.args[0] === '--version' || call.args[0] === 'version');
  return { runner, docker, cliFile, run, infoCalls, versionCalls };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('ensureDockerRunning', () => {
  it('does nothing when Docker runs', async () => {
    const s = setup({ info: [READY] });
    await s.run();
    expect(s.infoCalls()).toHaveLength(1);
    expect(s.infoCalls()[0].options.timeoutMs).toBe(20_000);
  });

  // Podman is not supported.
  describe('Podman', () => {
    // The package podman-docker: `docker` runs podman, whose `info` has no ServerVersion.
    const PODMAN_INFO = fail(
      'Emulate Docker CLI using podman. Create /etc/containers/nodocker to quiet msg.\nError: template: info:1:7: executing "info" at <.ServerVersion>: can\'t evaluate field ServerVersion in type *define.Info\n',
      125,
    );

    it('refuses the docker command of podman-docker with a message', async () => {
      const s = setup({ info: [PODMAN_INFO], cliVersion: ok('podman version 5.2.2\n') });
      const error = await rejection(s.run());
      expect(error).toBeInstanceOf(UserFacingError);
      expect(error).toMatchObject({ code: 'dockerEndpointUnsupported', message: Messages.podmanNotSupported, detail: 'docker --version: podman version 5.2.2' });
      expect(s.infoCalls()).toHaveLength(1);
    });

    it('refuses the Docker-compatible API of Podman behind the Docker CLI', async () => {
      const podmanServer = ok(`${JSON.stringify({ Platform: { Name: 'linux/amd64/fedora-40' }, Components: [{ Name: 'Podman Engine', Version: '5.2.2' }], Version: '5.2.2' })}\n`);
      const s = setup({ info: [ok('"5.2.2"\n')], serverVersion: podmanServer });
      const error = await rejection(s.run());
      expect(error).toMatchObject({ code: 'dockerEndpointUnsupported', message: Messages.podmanNotSupported, detail: 'docker version: the engine is Podman Engine 5.2.2.' });
      expect(s.runner.calls.find((call) => call.args[0] === 'version')?.args).toEqual(['version', '--format', '{{json .Server}}']);
    });

    it('asks the CLI once per file of the CLI, the engine at each check, and takes a check that fails for Docker', async () => {
      const s = setup({ info: [READY] });
      await s.run();
      await s.run();
      expect(s.versionCalls().map((call) => call.args[0])).toEqual(['--version', 'version', 'version']);
      // Another file at the path of the CLI (for example an update of Docker), or a file that cannot be read: asked again.
      s.cliFile.identity = 'docker 29.9.0';
      await s.run();
      s.cliFile.identity = undefined;
      await s.run();
      await s.run();
      expect(s.versionCalls().map((call) => call.args[0])).toEqual(['--version', 'version', 'version', '--version', 'version', '--version', 'version', '--version', 'version']);
      // Docker that does not run: only the CLI is asked (the engine does not answer).
      const stopped = setup({ info: [NOT_READY] });
      await rejection(stopped.run());
      expect(stopped.versionCalls().map((call) => call.args[0])).toEqual(['--version']);
      // A version call that fails counts as Docker.
      const failing = setup({ info: [READY], cliVersion: fail('unknown flag: --version'), serverVersion: fail('error during connect') });
      await expect(failing.run()).resolves.toBeUndefined();
    });

    it('runs one docker --version for callers that overlap; a caller that cancels ends only its own wait', async () => {
      let answer: (result: RunResult) => void = () => undefined;
      const s = setup({ info: [READY], cliVersion: new Promise<RunResult>((resolve) => (answer = resolve)) });
      const cancel = new AbortController();
      const first = s.docker.podmanCli(cancel.signal);
      const second = s.docker.podmanCli();
      await vi.waitFor(() => expect(s.versionCalls()).toHaveLength(1));
      // The shared call has no signal of a caller.
      expect(s.versionCalls()[0].options.signal).toBeUndefined();
      cancel.abort();
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      answer(ok('podman version 5.2.2\n'));
      await expect(second).resolves.toBe('docker --version: podman version 5.2.2');
      await expect(s.docker.podmanCli()).resolves.toBe('docker --version: podman version 5.2.2');
      expect(s.versionCalls()).toHaveLength(1);
    });

    it('gives the answer to the first caller when the second one, which shares the call, cancels', async () => {
      let answer: (result: RunResult) => void = () => undefined;
      const s = setup({ info: [READY], cliVersion: new Promise<RunResult>((resolve) => (answer = resolve)) });
      const cancel = new AbortController();
      const first = s.docker.podmanCli();
      const second = s.docker.podmanCli(cancel.signal);
      await vi.waitFor(() => expect(s.versionCalls()).toHaveLength(1));
      cancel.abort();
      await expect(second).rejects.toMatchObject({ name: 'AbortError' });
      answer(ok('podman version 5.2.2\n'));
      await expect(first).resolves.toBe('docker --version: podman version 5.2.2');
      expect(s.versionCalls()).toHaveLength(1);
    });

    it('asks docker --version again after a call that failed or rejected', async () => {
      const answers: Array<() => RunResult | Promise<RunResult>> = [() => fail('error during connect'), () => Promise.reject(abortError())];
      const s = setup({ info: [READY], cliVersion: () => (answers.shift() ?? (() => ok('podman version 5.2.2\n')))() });
      await expect(s.docker.podmanCli()).resolves.toBeUndefined();
      await expect(s.docker.podmanCli()).rejects.toMatchObject({ name: 'AbortError' });
      await expect(s.docker.podmanCli()).resolves.toBe('docker --version: podman version 5.2.2');
      await expect(s.docker.podmanCli()).resolves.toBe('docker --version: podman version 5.2.2');
      expect(s.versionCalls()).toHaveLength(3);
    });
  });

  it('throws dockerNotInstalled without a CLI', async () => {
    const runner = new FakeRunner(() => ok());
    const docker = new BootstrapDocker(runner, undefined, {}, silentLogger, 'darwin');
    const error = await rejection(ensureDockerRunning(docker, silentLogger));
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as UserFacingError).code).toBe('dockerNotInstalled');
    expect((error as UserFacingError).message).toBe(Messages.dockerNotInstalled);
    expect(runner.calls).toHaveLength(0);
  });

  // docs/requirements.md R-ENG-001: Devspaces never uses, and so never starts, the Docker of this computer.
  it('starts no Docker: a Docker that does not run fails at once with dockerStartFailed', async () => {
    const s = setup({ info: [NOT_READY] });
    const error = (await rejection(s.run())) as UserFacingError;
    expect(error).toMatchObject({ code: 'dockerStartFailed', message: Messages.dockerStartFailed });
    expect(error.detail).toBe(`The local Docker does not run, and Devspaces starts no Docker of this computer.\ndocker info: ${NOT_READY.stderr}`);
    expect(s.runner.calls.map((call) => call.args[0])).toEqual(['info', '--version']);
  });

  it('says when the user has no access to a running engine', async () => {
    const s = setup({
      info: [fail('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock')],
    });
    const error = (await rejection(s.run())) as UserFacingError;
    expect(error).toMatchObject({ code: 'dockerStartFailed', message: Messages.dockerStartFailed });
    expect(error.detail).toContain('The Docker engine runs, but this user has no access to it.');
    expect(s.infoCalls()).toHaveLength(1);
  });

  it('rejects at once with an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const s = setup({ info: [NOT_READY] });
    const error = await rejection(s.run({ signal: controller.signal }));
    expect(isAbortError(error)).toBe(true);
    expect(s.runner.calls).toHaveLength(0);
  });
});

describe('launchDetachedProcess', () => {
  it('resolves when the program has started', async () => {
    await expect(launchDetachedProcess(process.execPath, ['-e', ''])).resolves.toBeUndefined();
  });

  it('rejects when the program does not exist', async () => {
    await expect(launchDetachedProcess('/nonexistent/devspace-test/Docker Desktop.exe', [])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('tells the end of the program while this process runs', async () => {
    const ended = vi.fn();
    await launchDetachedProcess(process.execPath, ['-e', 'process.exit(3)'], ended);
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    expect(ended).toHaveBeenCalledWith(3);
  });
});
