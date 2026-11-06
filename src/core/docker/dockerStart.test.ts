// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it, vi } from 'vitest';
import { UserFacingError } from '../errors';
import { Messages } from '../messages';
import { abortError, isAbortError, silentLogger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
// The Docker CLI of the extension (BootstrapDocker).
import { BootstrapDocker } from './bootstrapDocker';
import { ensureDockerRunning, launchDetachedProcess, type DockerStarterOptions } from './dockerStart';

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
const UNKNOWN_DESKTOP = fail("docker: unknown command: docker desktop\n\nRun 'docker --help' for more information\n");
const DOCKER = '/usr/local/bin/docker';

/** Fake time: `sleep` advances the clock, unless it is aborted before its turn. */
function fakeTime() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: { now: () => now },
    sleep: async (ms: number, signal?: AbortSignal) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (signal?.aborted) throw abortError();
      sleeps.push(ms);
      now += ms;
    },
  };
}

/** `docker --version` and `docker version --format '{{json .Server}}'` of Docker. */
const DOCKER_CLI_VERSION = ok('Docker version 29.8.0, build 3f2a5b1\n');
const DOCKER_SERVER = ok(`${JSON.stringify({ Platform: { Name: 'Docker Engine - Community' }, Components: [{ Name: 'Engine', Version: '29.8.0' }, { Name: 'containerd', Version: '2.1.4' }], Version: '29.8.0' })}\n`);

interface Script {
  /** Results of `docker info`, in order; the last one repeats. */
  info: RunResult[];
  desktop?: (call: Call) => RunResult | Promise<RunResult>;
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
    if (call.args[0] === 'desktop') return script.desktop ? script.desktop(call) : ok();
    if (call.args[0] === '--version') return typeof script.cliVersion === 'function' ? script.cliVersion() : (script.cliVersion ?? DOCKER_CLI_VERSION);
    if (call.args[0] === 'version') return script.serverVersion ?? DOCKER_SERVER;
    throw new Error(`Unexpected call: ${call.file} ${call.args.join(' ')}`);
  });
  // The file at the path of the CLI (BootstrapDocker.podmanCli): another identity is another file there.
  const cliFile = { identity: 'docker 29.8.0' as string | undefined };
  const docker = new BootstrapDocker(runner, DOCKER, { PATH: '/usr/bin' }, silentLogger, 'darwin', { fileIdentity: async () => cliFile.identity });
  const time = fakeTime();
  const onStarting = vi.fn();
  const run = (options: Partial<DockerStarterOptions> & Pick<DockerStarterOptions, 'platform'>) =>
    ensureDockerRunning(docker, silentLogger, {
      onStarting,
      sleep: time.sleep,
      clock: time.clock,
      exists: () => false,
      launchDetached: async () => {
        throw new Error('not expected');
      },
      ...options,
    });
  const infoCalls = () => runner.calls.filter((call) => call.args[0] === 'info');
  const desktopCalls = () => runner.calls.filter((call) => call.args[0] === 'desktop');
  const versionCalls = () => runner.calls.filter((call) => call.args[0] === '--version' || call.args[0] === 'version');
  return { runner, docker, cliFile, time, onStarting, run, infoCalls, desktopCalls, versionCalls };
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
    await s.run({ platform: 'win32' });
    expect(s.onStarting).not.toHaveBeenCalled();
    expect(s.desktopCalls()).toHaveLength(0);
    expect(s.infoCalls()[0].options.timeoutMs).toBe(20_000);
  });

  // Podman is not supported; Docker is not started for it.
  describe('Podman', () => {
    // The package podman-docker: `docker` runs podman, whose `info` has no ServerVersion.
    const PODMAN_INFO = fail(
      'Emulate Docker CLI using podman. Create /etc/containers/nodocker to quiet msg.\nError: template: info:1:7: executing "info" at <.ServerVersion>: can\'t evaluate field ServerVersion in type *define.Info\n',
      125,
    );

    it('refuses the docker command of podman-docker with a message, and starts nothing', async () => {
      const s = setup({ info: [PODMAN_INFO], cliVersion: ok('podman version 5.2.2\n') });
      const error = await rejection(s.run({ platform: 'linux' }));
      expect(error).toBeInstanceOf(UserFacingError);
      expect(error).toMatchObject({ code: 'dockerEndpointUnsupported', message: Messages.podmanNotSupported, detail: 'docker --version: podman version 5.2.2' });
      expect(s.onStarting).not.toHaveBeenCalled();
      expect(s.desktopCalls()).toHaveLength(0);
      expect(s.infoCalls()).toHaveLength(1);
    });

    it('refuses the Docker-compatible API of Podman behind the Docker CLI', async () => {
      const podmanServer = ok(`${JSON.stringify({ Platform: { Name: 'linux/amd64/fedora-40' }, Components: [{ Name: 'Podman Engine', Version: '5.2.2' }], Version: '5.2.2' })}\n`);
      const s = setup({ info: [ok('"5.2.2"\n')], serverVersion: podmanServer });
      const error = await rejection(s.run({ platform: 'win32' }));
      expect(error).toMatchObject({ code: 'dockerEndpointUnsupported', message: Messages.podmanNotSupported, detail: 'docker version: the engine is Podman Engine 5.2.2.' });
      expect(s.runner.calls.find((call) => call.args[0] === 'version')?.args).toEqual(['version', '--format', '{{json .Server}}']);
    });

    it('asks the CLI once per file of the CLI, the engine at each check, and takes a check that fails for Docker', async () => {
      const s = setup({ info: [READY] });
      await s.run({ platform: 'win32' });
      await s.run({ platform: 'win32' });
      expect(s.versionCalls().map((call) => call.args[0])).toEqual(['--version', 'version', 'version']);
      // Another file at the path of the CLI (for example an update of Docker), or a file that cannot be read: asked again.
      s.cliFile.identity = 'docker 29.9.0';
      await s.run({ platform: 'win32' });
      s.cliFile.identity = undefined;
      await s.run({ platform: 'win32' });
      await s.run({ platform: 'win32' });
      expect(s.versionCalls().map((call) => call.args[0])).toEqual(['--version', 'version', 'version', '--version', 'version', '--version', 'version', '--version', 'version']);
      // Docker that does not run is started as before; only the CLI is asked (the engine does not answer).
      const stopped = setup({ info: [NOT_READY, READY] });
      await stopped.run({ platform: 'win32' });
      expect(stopped.versionCalls().map((call) => call.args[0])).toEqual(['--version']);
      expect(stopped.desktopCalls()).toHaveLength(1);
      // A version call that fails counts as Docker.
      const failing = setup({ info: [READY], cliVersion: fail('unknown flag: --version'), serverVersion: fail('error during connect') });
      await failing.run({ platform: 'win32' });
      expect(failing.onStarting).not.toHaveBeenCalled();
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
    const error = await rejection(ensureDockerRunning(docker, silentLogger, { platform: 'win32' }));
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as UserFacingError).code).toBe('dockerNotInstalled');
    expect((error as UserFacingError).message).toBe(Messages.dockerNotInstalled);
    expect(runner.calls).toHaveLength(0);
  });

  it('starts Docker Desktop with docker desktop start and polls every 2 seconds', async () => {
    const s = setup({ info: [NOT_READY, NOT_READY, NOT_READY, READY] });
    await s.run({ platform: 'win32' });
    expect(s.onStarting).toHaveBeenCalledTimes(1);
    expect(s.desktopCalls().map((call) => call.args)).toEqual([['desktop', 'start']]);
    expect(s.time.sleeps).toEqual([2000, 2000]);
    expect(s.infoCalls()).toHaveLength(4);
  });

  it('recognizes the message of older CLIs', async () => {
    const s = setup({
      info: [NOT_READY, READY],
      desktop: () => fail("docker: 'desktop' is not a docker command.\nSee 'docker --help'"),
    });
    const launched: string[] = [];
    await s.run({ platform: 'win32', env: {}, exists: () => true, launchDetached: async (file) => void launched.push(file) });
    expect(launched).toHaveLength(1);
  });

  it('falls back when the Docker Desktop CLI has no start command (it prints its usage)', async () => {
    const s = setup({
      info: [NOT_READY, READY],
      desktop: () => ok('Usage:  docker desktop COMMAND\n\nCommands:\n  status\n'),
    });
    const launched: string[] = [];
    await s.run({ platform: 'win32', env: {}, exists: () => true, launchDetached: async (file) => void launched.push(file) });
    expect(launched).toHaveLength(1);
  });

  it('starts Docker Desktop.exe on Windows without the Docker Desktop CLI', async () => {
    const launched: Array<{ file: string; args: readonly string[] }> = [];
    const s = setup({ info: [NOT_READY, READY], desktop: () => UNKNOWN_DESKTOP });
    await s.run({
      platform: 'win32',
      env: { ProgramFiles: 'D:\\Programs' },
      exists: (file) => file === 'D:\\Programs\\Docker\\Docker\\Docker Desktop.exe',
      launchDetached: async (file, args) => {
        launched.push({ file, args });
      },
    });
    expect(launched).toEqual([{ file: 'D:\\Programs\\Docker\\Docker\\Docker Desktop.exe', args: [] }]);
  });

  it('uses C:\\Program Files by default on Windows', async () => {
    const launched: string[] = [];
    const s = setup({ info: [NOT_READY, READY], desktop: () => UNKNOWN_DESKTOP });
    await s.run({
      platform: 'win32',
      env: {},
      exists: (file) => file === 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
      launchDetached: async (file) => {
        launched.push(file);
      },
    });
    expect(launched).toEqual(['C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe']);
  });

  it('starts Docker Desktop.exe of a per-user installation on Windows', async () => {
    const launched: string[] = [];
    const exe = 'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe';
    const s = setup({ info: [NOT_READY, READY], desktop: () => UNKNOWN_DESKTOP });
    await s.run({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      exists: (file) => file === exe,
      launchDetached: async (file) => {
        launched.push(file);
      },
    });
    expect(launched).toEqual([exe]);
  });

  it('fails on Windows when Docker Desktop.exe is missing', async () => {
    const s = setup({ info: [NOT_READY], desktop: () => UNKNOWN_DESKTOP });
    const error = await rejection(s.run({ platform: 'win32', env: {}, exists: () => false }));
    expect(error).toMatchObject({ code: 'dockerStartFailed' });
    expect((error as UserFacingError).detail).toContain('Docker Desktop.exe was not found');
  });

  it('fails on Windows when Docker Desktop.exe cannot be started', async () => {
    const s = setup({ info: [NOT_READY], desktop: () => UNKNOWN_DESKTOP });
    const error = await rejection(
      s.run({
        platform: 'win32',
        env: {},
        exists: () => true,
        launchDetached: async () => {
          throw new Error('spawn EACCES');
        },
      }),
    );
    expect(error).toMatchObject({ code: 'dockerStartFailed' });
    expect((error as UserFacingError).detail).toContain('spawn EACCES');
  });

  // docs/requirements.md R-ENG-001: on macOS and Linux, Devspaces never uses, and so never starts, the Docker of this computer.
  it.each(['darwin', 'linux'] as const)('starts no Docker on %s', async (platform) => {
    const s = setup({ info: [NOT_READY] });
    const error = (await rejection(s.run({ platform }))) as UserFacingError;
    expect(error).toMatchObject({ code: 'dockerStartFailed', message: Messages.dockerStartFailed });
    expect(error.detail).toContain('Devspaces starts the Docker of this computer only on Windows.');
    expect(s.desktopCalls()).toHaveLength(0);
  });

  it('does not try to start Docker when the user has no access to a running engine', async () => {
    const s = setup({
      info: [fail('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock')],
    });
    const error = (await rejection(s.run({ platform: 'win32' }))) as UserFacingError;
    expect(error).toMatchObject({ code: 'dockerStartFailed', message: Messages.dockerStartFailed });
    expect(error.detail).toContain('docker-users');
    expect(s.desktopCalls()).toHaveLength(0);
    expect(s.onStarting).not.toHaveBeenCalled();
  });

  it('gives up after 2 minutes with dockerStartFailed', async () => {
    const s = setup({ info: [NOT_READY] });
    const error = await rejection(s.run({ platform: 'win32' }));
    expect(error).toMatchObject({ code: 'dockerStartFailed', message: Messages.dockerStartFailed });
    expect((error as UserFacingError).detail).toContain('120 seconds');
    expect((error as UserFacingError).detail).toContain('failed to connect');
    expect(s.time.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(120_000);
    // One initial check, then one check at 0, 2, …, 120 seconds.
    expect(s.infoCalls()).toHaveLength(62);
    expect(s.onStarting).toHaveBeenCalledTimes(1);
  });

  it('respects timeoutMs and intervalMs', async () => {
    const s = setup({ info: [NOT_READY] });
    await rejection(s.run({ platform: 'win32', timeoutMs: 5000, intervalMs: 2000 }));
    expect(s.time.sleeps).toEqual([2000, 2000, 1000]);
  });

  it('polls while docker desktop start still waits, and ends it when Docker is ready', async () => {
    let startSignal: AbortSignal | undefined;
    const s = setup({
      info: [NOT_READY, READY],
      desktop: (call) =>
        new Promise<RunResult>((_resolve, reject) => {
          startSignal = call.options.signal;
          call.options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        }),
    });
    await s.run({ platform: 'win32' });
    // The start command got a head start of 10 s, then the polling began.
    expect(s.time.sleeps).toEqual([10_000]);
    expect(startSignal?.aborted).toBe(true);
  });

  it('does not give the start command a head start longer than timeoutMs', async () => {
    const s = setup({
      info: [NOT_READY],
      desktop: (call) =>
        new Promise<RunResult>((_resolve, reject) => {
          call.options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        }),
    });
    const error = await rejection(s.run({ platform: 'win32', timeoutMs: 5000 }));
    expect(error).toMatchObject({ code: 'dockerStartFailed' });
    expect(s.time.sleeps).toEqual([5000]);
  });

  it('rejects with an AbortError when the signal aborts, and ends the start command', async () => {
    const controller = new AbortController();
    let startSignal: AbortSignal | undefined;
    let infoCount = 0;
    const s = setup({
      info: [NOT_READY],
      desktop: (call) => {
        startSignal = call.options.signal;
        return ok();
      },
    });
    const original = s.runner.run.bind(s.runner);
    vi.spyOn(s.runner, 'run').mockImplementation(async (file, args, options) => {
      if (args[0] === 'info' && ++infoCount === 3) controller.abort();
      return original(file, args, options);
    });
    const error = await rejection(s.run({ platform: 'win32', signal: controller.signal }));
    expect(isAbortError(error)).toBe(true);
    expect(startSignal?.aborted).toBe(true);
  });

  it('rejects at once with an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const s = setup({ info: [NOT_READY] });
    const error = await rejection(s.run({ platform: 'win32', signal: controller.signal }));
    expect(isAbortError(error)).toBe(true);
    expect(s.runner.calls).toHaveLength(0);
  });

  it('limits the time of docker info to the remaining time', async () => {
    const s = setup({ info: [NOT_READY] });
    await rejection(s.run({ platform: 'win32', timeoutMs: 30_000 }));
    const timeouts = s.infoCalls().map((call) => call.options.timeoutMs);
    expect(timeouts[0]).toBe(20_000);
    expect(timeouts[1]).toBe(20_000);
    expect(Math.min(...(timeouts as number[]))).toBe(2_000);
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
