// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker calls of an operation on an SSH host go through the Docker pipe of the extension for the host while a
// connection of the relay to it is open (BootstrapDockerOptions.dockerPipe): DOCKER_HOST is the pipe, without
// DOCKER_CONTEXT and the TLS variables. Without the pipe, for the checks of a new connection (runWithoutPipe), and for
// the start of the worker, DOCKER_HOST is `ssh://<host>`, and each such call logs in itself. Outside of an operation and
// for the local Docker, the calls go as before.
import { describe, expect, it, vi } from 'vitest';
import { silentLogger, type Logger, type ProcessRunner, type RunOptions, type RunResult, type StartedProcess } from '../ports';
import { BootstrapDocker, isSharedShellCall, isShellCall } from './bootstrapDocker';
import { LOCAL_DOCKER_TARGET, WSL_HOST, remoteDockerTarget, type DockerTarget } from './dockerHost';
import { operationOnShell, operationOpenLoginOnly, runWithDockerTarget } from './dockerTargets';

const OK: RunResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
const PIPE = 'unix:///run/user/1000/devspaces-0123456789abcdef/docker.sock';
const SSH = 'ssh://build-box';
const REMOTE = remoteDockerTarget('build-box');

function recorder(): { runner: ProcessRunner; envs: NodeJS.ProcessEnv[]; starts: NodeJS.ProcessEnv[] } {
  const envs: NodeJS.ProcessEnv[] = [];
  const starts: NodeJS.ProcessEnv[] = [];
  const runner: ProcessRunner = {
    async run(_file: string, _args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
      envs.push(options.env ?? {});
      return OK;
    },
    start: (_file, _args, options) => {
      starts.push(options?.env ?? {});
      return {} as StartedProcess;
    },
  };
  return { runner, envs, starts };
}

describe('BootstrapDocker: the Docker pipe of the extension', () => {
  it('gives the calls of an operation on an SSH host the pipe as DOCKER_HOST, without the context, the TLS variables and the buildx builder of the user', async () => {
    const { runner, envs } = recorder();
    const dockerPipe = vi.fn((target: { host: string }) => (target.host === 'build-box' ? PIPE : undefined));
    const env = {
      PATH: '/usr/bin',
      Docker_Context: 'desktop-linux',
      DOCKER_HOST: 'ssh://build-box',
      DOCKER_TLS_VERIFY: '1',
      DOCKER_CERT_PATH: '/certs',
      DOCKER_TLS: '1',
      DOCKER_CONFIG: '/home/me/.docker',
      BUILDX_BUILDER: 'cloud-org-builder',
    };
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', env, silentLogger, 'win32', { dockerPipe });
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    expect(dockerPipe).toHaveBeenCalledWith(REMOTE);
    const keys = Object.keys(envs[0]).filter((key) => key.toUpperCase().startsWith('DOCKER_'));
    expect(keys.sort()).toEqual(['DOCKER_CONFIG', 'DOCKER_HOST']);
    expect(envs[0].DOCKER_HOST).toBe(PIPE);
    expect(envs[0].DOCKER_CONFIG).toBe('/home/me/.docker');
    // buildx would run `docker builder prune` on the builder of the user, not on the engine of the pipe.
    expect(envs[0].BUILDX_BUILDER).toBe('default');
  });

  it('gives the calls of an operation on an SSH host ssh://<host> without the pipe, and asks for no pipe outside of an operation or for the local Docker', async () => {
    const { runner, envs } = recorder();
    const dockerPipe = vi.fn((): string | undefined => undefined);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', { dockerPipe });
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    expect(envs[0].DOCKER_HOST).toBe(SSH);
    expect(envs[0].DOCKER_CONTEXT).toBeUndefined();
    expect(dockerPipe).toHaveBeenCalledTimes(1);
    dockerPipe.mockReturnValue(PIPE);
    await docker.run(['container', 'inspect', 'x']);
    await runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.run(['container', 'inspect', 'x']));
    expect(envs[1].DOCKER_HOST).toBeUndefined();
    expect(envs[2].DOCKER_HOST).toBeUndefined();
    expect(dockerPipe).toHaveBeenCalledTimes(1);
  });

  it('runs the checks of a new connection of the relay with ssh://<host> also while the host has the pipe', async () => {
    const { runner, envs } = recorder();
    const dockerPipe = vi.fn(() => PIPE);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', { dockerPipe });
    await runWithDockerTarget(REMOTE, () => docker.runWithoutPipe(['info', '--format', '{{json .ID}}']));
    expect(envs[0].DOCKER_HOST).toBe(SSH);
    expect(envs[0].DOCKER_CONTEXT).toBeUndefined();
    expect(dockerPipe).not.toHaveBeenCalled();
    // `run` takes the pipe.
    await runWithDockerTarget(REMOTE, () => docker.run(['info', '--format', '{{json .ID}}']));
    expect(envs[1].DOCKER_HOST).toBe(PIPE);
  });

  // The `ssh` of the Docker CLI with the key of Devspaces (SshKeyOffer.dockerSshEnv).
  it('lets sshEnv change the environment of a call with ssh://<host> only, never of the base environment', async () => {
    const { runner, envs } = recorder();
    const base = { PATH: '/usr/bin' };
    const sshEnv = vi.fn((host: string, env: NodeJS.ProcessEnv) => {
      env.PATH = `/wrapper:${env.PATH}`;
      env.DEVSPACES_SSH_IDENTITY = `key of ${host}`;
    });
    let pipe: string | undefined;
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', base, silentLogger, 'linux', { dockerPipe: () => pipe, sshEnv });
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    // The wrapper stays first in PATH (the folders that BootstrapDocker adds come at the end).
    expect(envs[0]).toMatchObject({ DOCKER_HOST: SSH, DEVSPACES_SSH_IDENTITY: 'key of build-box' });
    expect(envs[0].PATH?.startsWith('/wrapper:/usr/bin')).toBe(true);
    expect(sshEnv).toHaveBeenCalledTimes(1);
    pipe = PIPE;
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    await runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.run(['container', 'inspect', 'x']));
    expect(envs[1].DOCKER_HOST).toBe(PIPE);
    expect([envs[1].PATH, envs[2].PATH].some((value) => value?.includes('/wrapper'))).toBe(false);
    expect([envs[1].DEVSPACES_SSH_IDENTITY, envs[2].DEVSPACES_SSH_IDENTITY]).toEqual([undefined, undefined]);
    expect(sshEnv).toHaveBeenCalledTimes(1);
    expect(base).toEqual({ PATH: '/usr/bin' });
  });

  it('logs each call of an operation on an SSH host that logs in over SSH, never a call through the pipe', async () => {
    const { runner } = recorder();
    const lines: string[] = [];
    const logger: Logger = { ...silentLogger, info: (message) => lines.push(message) };
    let pipe: string | undefined;
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', { dockerPipe: () => pipe });
    await runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', 'x']));
    pipe = PIPE;
    await runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', 'x']));
    await runWithDockerTarget(REMOTE, () => docker.runWithoutPipe(['info', '--format', '{{json .ID}}']));
    await runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.run(['image', 'inspect', 'x']));
    // Outside an operation, the Docker CLI uses the local Docker.
    await docker.run(['info']);
    // The commands of the Docker contexts and the version of the CLI log in nowhere.
    pipe = undefined;
    await runWithDockerTarget(REMOTE, () => docker.run(['context', 'inspect', '--format', '{{json .}}']));
    await runWithDockerTarget(REMOTE, () => docker.run(['--version']));
    expect(lines).toEqual(['docker image inspect x logs in to build-box over SSH.', 'docker info --format {{json .ID}} logs in to build-box over SSH.']);
  });

  it('starts the worker (standard input open) never through the pipe', async () => {
    const { runner, starts } = recorder();
    const dockerPipe = vi.fn(() => PIPE);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', { dockerPipe });
    await runWithDockerTarget(REMOTE, async () => docker.start(['run', '-i', 'img']));
    expect(starts[0].DOCKER_HOST).toBe(SSH);
    expect(starts[0].DOCKER_CONTEXT).toBeUndefined();
    expect(dockerPipe).not.toHaveBeenCalled();
  });

  it('logs in over SSH when the lookup of the pipe fails', async () => {
    const { runner, envs } = recorder();
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message) => warnings.push(message) };
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', {
      dockerPipe: () => {
        throw new Error('broken');
      },
    });
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    expect(envs[0].DOCKER_HOST).toBe(SSH);
    expect(envs[0].DOCKER_CONTEXT).toBeUndefined();
    expect(warnings).toEqual(['The Docker pipe of build-box could not be looked up, so the call logs in itself: broken']);
  });
});

describe('BootstrapDocker: the Docker pipe of the WSL distribution of Devspaces', () => {
  const WSL = remoteDockerTarget(WSL_HOST);

  it('serves the pipe before each call of an operation there, and gives every call the pipe, also the checks of a new connection', async () => {
    const { runner, envs } = recorder();
    let pipe: string | undefined;
    const served: string[] = [];
    const servePipe = vi.fn(async (target: DockerTarget) => {
      served.push(target.host);
      pipe = PIPE;
    });
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin', DOCKER_HOST: 'tcp://x:2375' }, silentLogger, 'win32', {
      dockerPipe: (target) => (target.host === WSL_HOST ? pipe : undefined),
      servePipe,
    });
    await runWithDockerTarget(WSL, () => docker.run(['container', 'inspect', 'x']));
    await runWithDockerTarget(WSL, () => docker.runWithoutPipe(['info', '--format', '{{json .ID}}']));
    expect(envs.map((env) => env.DOCKER_HOST)).toEqual([PIPE, PIPE]);
    expect(served).toEqual([WSL_HOST, WSL_HOST]);
    // The hook is asked for every remote engine (extension.ts serves only the WSL distribution), never for the local one.
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'inspect', 'x']));
    await runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.run(['container', 'inspect', 'x']));
    await docker.run(['container', 'inspect', 'x']);
    expect(served).toEqual([WSL_HOST, WSL_HOST, 'build-box']);
  });

  it('never logs in with ssh:// there: without the pipe a call that only reads runs on the shell before the relay, any other one fails', async () => {
    const { runner, envs, starts } = recorder();
    const remoteShell = vi.fn(async (): Promise<RunResult | undefined> => ({ ...OK, stdout: 'on the shell' }));
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'win32', {
      dockerPipe: () => undefined,
      servePipe: async () => undefined,
      remoteShell,
    });
    await expect(runWithDockerTarget(WSL, () => docker.run(['container', 'inspect', 'x']))).resolves.toMatchObject({ stdout: 'on the shell' });
    expect(remoteShell).toHaveBeenCalledWith(WSL, ['container', 'inspect', 'x'], { timeoutMs: undefined, signal: undefined });
    remoteShell.mockResolvedValue(undefined);
    await expect(runWithDockerTarget(WSL, () => docker.run(['container', 'inspect', 'x']))).rejects.toMatchObject({
      code: 'dockerHostUnreachable',
      message: expect.stringContaining(WSL_HOST),
    });
    await expect(runWithDockerTarget(WSL, () => docker.run(['rm', '-f', 'x']))).rejects.toMatchObject({ code: 'dockerHostUnreachable' });
    // The worker starts there only behind the relay.
    await expect(runWithDockerTarget(WSL, async () => docker.start(['run', '-i', 'img']))).resolves.toBeUndefined();
    expect(envs).toEqual([]);
    expect(starts).toEqual([]);
  });

  it('logs a servePipe that throws and goes on', async () => {
    const { runner, envs } = recorder();
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message) => warnings.push(message) };
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'win32', {
      dockerPipe: () => PIPE,
      servePipe: () => Promise.reject(new Error('broken')),
    });
    await runWithDockerTarget(WSL, () => docker.run(['container', 'inspect', 'x']));
    expect(envs[0].DOCKER_HOST).toBe(PIPE);
    expect(warnings).toEqual([`The Docker pipe of ${WSL_HOST} could not be served: broken`]);
  });
});

describe('BootstrapDocker: the shell before the relay', () => {
  const SHELL: RunResult = { exitCode: 0, stdout: 'from the shell', stderr: '', timedOut: false };

  it('runs a call of an operation on an SSH host that only reads on the shell while the host has no pipe', async () => {
    const { runner, envs } = recorder();
    let pipe: string | undefined;
    const remoteShell = vi.fn(async () => SHELL);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', { dockerPipe: () => pipe, remoteShell });
    const signal = new AbortController().signal;
    await expect(runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', '--format', '{{json .Id}}', 'x'], { timeoutMs: 5_000, signal }))).resolves.toEqual(SHELL);
    // runWithoutPipe too: the checks of a new connection of the relay.
    await expect(runWithDockerTarget(REMOTE, () => docker.runWithoutPipe(['info', '--format', '{{json .ID}}']))).resolves.toEqual(SHELL);
    expect(remoteShell.mock.calls).toEqual([
      [REMOTE, ['image', 'inspect', '--format', '{{json .Id}}', 'x'], { timeoutMs: 5_000, signal }],
      [REMOTE, ['info', '--format', '{{json .ID}}'], { timeoutMs: undefined, signal: undefined }],
    ]);
    expect(envs).toEqual([]);
    // With the pipe, the call goes through it, and runWithoutPipe still on the shell.
    pipe = PIPE;
    await runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', 'x']));
    await runWithDockerTarget(REMOTE, () => docker.runWithoutPipe(['info']));
    expect(envs.map((env) => env.DOCKER_HOST)).toEqual([PIPE]);
    expect(remoteShell).toHaveBeenCalledTimes(3);
  });

  it('logs in over SSH for the calls that the shell does not take, and when the host has no shell', async () => {
    const { runner, envs } = recorder();
    const lines: string[] = [];
    const logger: Logger = { ...silentLogger, info: (message) => lines.push(message) };
    const remoteShell = vi.fn(async (_target: DockerTarget, args: readonly string[]) => (args[0] === 'ps' ? undefined : SHELL));
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', { remoteShell });
    await runWithDockerTarget(REMOTE, async () => {
      // A call that changes something, a CLI option of this computer, the client version, the contexts, input, a folder,
      // output listeners, and the environment of the caller.
      await docker.run(['volume', 'create', 'x']);
      await docker.run(['--config', '/home/me/.docker', 'info']);
      await docker.run(['version', '--format', '{{json .Server}}']);
      await docker.run(['context', 'inspect']);
      await docker.run(['image', 'inspect', 'x'], { input: 'x' });
      await docker.run(['image', 'inspect', 'x'], { cwd: '/tmp' });
      await docker.run(['image', 'inspect', 'x'], { onStdout: () => {} });
      await docker.run(['image', 'inspect', 'x'], { env: { PATH: '/usr/bin' } });
      // The host has no shell for it.
      await docker.run(['ps']);
    });
    await runWithDockerTarget(LOCAL_DOCKER_TARGET, () => docker.run(['image', 'inspect', 'x']));
    await docker.run(['image', 'inspect', 'x']);
    expect(remoteShell.mock.calls.map(([, args]) => args)).toEqual([['ps']]);
    expect(envs).toHaveLength(11);
    expect(lines.filter((line) => line.endsWith('logs in to build-box over SSH.'))).toEqual([
      'docker volume create x logs in to build-box over SSH.',
      'docker --config /home/me/.docker info logs in to build-box over SSH.',
      'docker version --format {{json .Server}} logs in to build-box over SSH.',
      'docker image inspect x logs in to build-box over SSH.',
      'docker image inspect x logs in to build-box over SSH.',
      'docker image inspect x logs in to build-box over SSH.',
      'docker ps logs in to build-box over SSH.',
    ]);
  });

  it('logs a failure of the shell and logs in over SSH; an abort is no failure', async () => {
    const { runner, envs } = recorder();
    const lines: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message) => lines.push(message) };
    const remoteShell = vi.fn(async (): Promise<RunResult | undefined> => {
      throw new Error('broken');
    });
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', { remoteShell });
    await expect(runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', 'x']))).resolves.toEqual(OK);
    expect(lines).toEqual(['docker image inspect could not run on the shell before the relay on build-box, so it logs in over SSH itself: broken']);
    expect(envs).toHaveLength(1);
    remoteShell.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', 'x']))).rejects.toMatchObject({ name: 'AbortError' });
    expect(envs).toHaveLength(1);
  });
});

describe('BootstrapDocker: the shared shell of a host (the view Docker Hosts)', () => {
  const SHELL: RunResult = { exitCode: 0, stdout: 'from the shell', stderr: '', timedOut: false };
  const WSL = remoteDockerTarget(WSL_HOST);
  const ACTIONS = [
    ['container', 'stop', 'abc'],
    ['container', 'start', 'abc'],
    ['container', 'rm', 'abc'],
    ['image', 'rm', 'node:22'],
    ['volume', 'rm', 'pgdata'],
    ['network', 'rm', 'shop_default'],
  ];
  const PRUNE = ['builder', 'prune', '--all', '--force'];

  it('runs the reads and the actions of the view on the shell of an SSH host without the pipe, and logs in for no other call', async () => {
    const { runner, envs } = recorder();
    const lines: string[] = [];
    const logger: Logger = { ...silentLogger, info: (message) => lines.push(message) };
    const remoteShell = vi.fn(async (_target: DockerTarget, _args: readonly string[]): Promise<RunResult | undefined> => SHELL);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', { dockerPipe: () => undefined, remoteShell });
    await runWithDockerTarget(
      REMOTE,
      async () => {
        await docker.run(['system', 'df', '--verbose', '--format', '{{json .}}']);
        for (const args of ACTIONS) await expect(docker.run(args)).resolves.toEqual(SHELL);
        // A call that changes something and is no action of the view still logs in itself, and so does the removal of the
        // build cache, which the Docker CLI of the host could send to a buildx builder of its user.
        await docker.run(['volume', 'create', 'x']);
        await docker.run(PRUNE);
      },
      { onShell: true },
    );
    expect(remoteShell.mock.calls.map(([target, args]) => [target.host, args])).toEqual([
      ['build-box', ['system', 'df', '--verbose', '--format', '{{json .}}']],
      ...ACTIONS.map((args) => ['build-box', args]),
    ]);
    expect(envs.map((env) => [env.DOCKER_HOST, env.BUILDX_BUILDER])).toEqual([
      [SSH, 'default'],
      [SSH, 'default'],
    ]);
    expect(lines.filter((line) => line.endsWith('over SSH.'))).toEqual([
      'docker volume create x logs in to build-box over SSH.',
      'docker builder prune --all --force logs in to build-box over SSH.',
    ]);
    // Without `onShell`, an action logs in over SSH, as before.
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'stop', 'abc']));
    expect(envs.map((env) => env.DOCKER_HOST)).toEqual([SSH, SSH, SSH]);
    expect(remoteShell).toHaveBeenCalledTimes(1 + ACTIONS.length);
  });

  it('goes through the pipe of an SSH host while a connection of the relay is open: it shares the login of the relay', async () => {
    const { runner, envs } = recorder();
    const remoteShell = vi.fn(async (_target: DockerTarget, _args: readonly string[]): Promise<RunResult | undefined> => SHELL);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'linux', { dockerPipe: () => PIPE, remoteShell });
    await runWithDockerTarget(REMOTE, () => docker.run(['container', 'stop', 'abc']), { onShell: true });
    expect(envs.map((env) => env.DOCKER_HOST)).toEqual([PIPE]);
    expect(remoteShell).not.toHaveBeenCalled();
  });

  it('runs the calls on the shell of the VM of Devspaces instead of its pipe, and through the pipe only what the shell does not take', async () => {
    const { runner, envs } = recorder();
    const remoteShell = vi.fn(async (_target: DockerTarget, _args: readonly string[]): Promise<RunResult | undefined> => SHELL);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'win32', {
      dockerPipe: (target) => (target.host === WSL_HOST ? PIPE : undefined),
      servePipe: async () => undefined,
      remoteShell,
    });
    await runWithDockerTarget(
      WSL,
      async () => {
        await expect(docker.run(['image', 'ls', '--format', '{{json .}}'])).resolves.toEqual(SHELL);
        await expect(docker.run(['volume', 'rm', 'pgdata'])).resolves.toEqual(SHELL);
        // The VM has no buildx builder of a user: the removal of the build cache runs on the shell too.
        await expect(docker.run(PRUNE)).resolves.toEqual(SHELL);
        // Input, and a call that the shell cannot carry, go through the pipe.
        await expect(docker.run(['image', 'inspect', 'x'], { input: 'x' })).resolves.toEqual(OK);
        await expect(docker.run(['volume', 'create', 'x'])).resolves.toEqual(OK);
        // No shell for the host: the pipe.
        remoteShell.mockResolvedValueOnce(undefined);
        await expect(docker.run(['container', 'stop', 'abc'])).resolves.toEqual(OK);
      },
      { onShell: true },
    );
    expect(remoteShell.mock.calls.map(([, args]) => args)).toEqual([['image', 'ls', '--format', '{{json .}}'], ['volume', 'rm', 'pgdata'], PRUNE, ['container', 'stop', 'abc']]);
    expect(envs.map((env) => env.DOCKER_HOST)).toEqual([PIPE, PIPE, PIPE]);
    // Without `onShell`, every call there goes through the pipe, as before.
    await runWithDockerTarget(WSL, () => docker.run(['image', 'ls']));
    expect(envs).toHaveLength(4);
    expect(remoteShell).toHaveBeenCalledTimes(4);
  });

  it('runs a read with `openLoginOnly` only on the open shell, and refuses each call that would log in', async () => {
    const { runner, envs } = recorder();
    const lines: string[] = [];
    const logger: Logger = { ...silentLogger, info: (message) => lines.push(message) };
    const remoteShell = vi.fn(async (_target: DockerTarget, _args: readonly string[], _options: Pick<RunOptions, 'timeoutMs' | 'signal'> & { login?: boolean }): Promise<RunResult | undefined> => SHELL);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', { dockerPipe: () => undefined, remoteShell });
    const refused = new AbortController();
    await runWithDockerTarget(
      REMOTE,
      async () => {
        await expect(docker.run(['image', 'ls', '--format', '{{json .}}'])).resolves.toEqual(SHELL);
        // No open shell: no new shell, and no `ssh://<host>` either.
        remoteShell.mockResolvedValueOnce(undefined);
        await expect(docker.run(['volume', 'ls', '--format', '{{json .}}'])).rejects.toMatchObject({ name: 'AbortError' });
      },
      { onShell: true, openLoginOnly: refused },
    );
    expect(remoteShell.mock.calls.map(([, args, options]) => [args[0], options.login])).toEqual([
      ['image', false],
      ['volume', false],
    ]);
    expect(refused.signal.aborted).toBe(true);
    expect(envs).toEqual([]);
    expect(lines).toContain('docker volume ls --format {{json .}} does not run: it may use only a login to build-box that is open, and none is.');
  });

  it('runs a read with `openLoginOnly` through the pipe of an SSH host (the login of the relay), never through the pipe of the VM', async () => {
    const { runner, envs } = recorder();
    const remoteShell = vi.fn(async (): Promise<RunResult | undefined> => undefined);
    const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, silentLogger, 'win32', { dockerPipe: () => PIPE, servePipe: async () => undefined, remoteShell });
    await runWithDockerTarget(REMOTE, () => docker.run(['image', 'ls', '--format', '{{json .}}']), { onShell: true, openLoginOnly: new AbortController() });
    expect(envs.map((env) => env.DOCKER_HOST)).toEqual([PIPE]);
    // The pipe of the VM makes a connection of its own (wsl.exe), which would start the WSL distribution.
    const refused = new AbortController();
    await expect(runWithDockerTarget(WSL, () => docker.run(['image', 'ls', '--format', '{{json .}}']), { onShell: true, openLoginOnly: refused })).rejects.toMatchObject({ name: 'AbortError' });
    expect(refused.signal.aborted).toBe(true);
    // Also without `onShell`, where a call of the VM goes to its pipe at once.
    await expect(runWithDockerTarget(WSL, () => docker.run(['image', 'ls', '--format', '{{json .}}']), { openLoginOnly: new AbortController() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(envs).toHaveLength(1);
    expect(remoteShell).toHaveBeenCalledTimes(1);
  });

  it('keeps `openLoginOnly` in an operation on the same host within it, not on another host', async () => {
    const refused = new AbortController();
    const seen: Array<[string, boolean]> = [];
    const note = (name: string) => seen.push([name, operationOpenLoginOnly() === refused]);
    await runWithDockerTarget(
      REMOTE,
      async () => {
        note('outer');
        await runWithDockerTarget(REMOTE, async () => note('same host'));
        await runWithDockerTarget(WSL, async () => note('other host'));
      },
      { openLoginOnly: refused },
    );
    note('outside');
    expect(seen).toEqual([
      ['outer', true],
      ['same host', true],
      ['other host', false],
      ['outside', false],
    ]);
  });

  it('keeps `onShell` in an operation on the same host within it, not on another host', async () => {
    const seen: Array<[string, boolean]> = [];
    const note = (name: string) => seen.push([name, operationOnShell()]);
    await runWithDockerTarget(
      REMOTE,
      async () => {
        note('outer');
        await runWithDockerTarget(REMOTE, async () => note('same host'));
        await runWithDockerTarget(WSL, async () => note('other host'));
        await runWithDockerTarget(REMOTE, async () => note('same host, off'), { onShell: false });
      },
      { onShell: true },
    );
    note('outside');
    expect(seen).toEqual([
      ['outer', true],
      ['same host', true],
      ['other host', false],
      ['same host, off', false],
      ['outside', false],
    ]);
  });
});

describe('isSharedShellCall', () => {
  it('takes the calls of isShellCall and the actions of the view Docker Hosts, nothing else that changes something', () => {
    for (const vm of [false, true]) {
      expect(isSharedShellCall(['info'], vm)).toBe(true);
      expect(isSharedShellCall(['container', 'stop', 'x'], vm)).toBe(true);
      expect(isSharedShellCall(['container', 'start', 'x'], vm)).toBe(true);
      expect(isSharedShellCall(['container', 'rm', 'x'], vm)).toBe(true);
      expect(isSharedShellCall(['image', 'rm', 'x'], vm)).toBe(true);
      expect(isSharedShellCall(['volume', 'rm', 'x'], vm)).toBe(true);
      expect(isSharedShellCall(['network', 'rm', 'x'], vm)).toBe(true);
      expect(isSharedShellCall(['volume', 'create', 'x'], vm)).toBe(false);
      expect(isSharedShellCall(['run', 'x'], vm)).toBe(false);
      expect(isSharedShellCall(['container', 'exec', 'x', 'sh'], vm)).toBe(false);
      expect(isSharedShellCall(['system', 'prune', '--force'], vm)).toBe(false);
      expect(isSharedShellCall(['-H', 'ssh://box', 'container', 'stop', 'x'], vm)).toBe(false);
      expect(isSharedShellCall(['context', 'rm', 'x'], vm)).toBe(false);
      expect(isSharedShellCall([], vm)).toBe(false);
    }
    // The removal of the build cache only on the VM: elsewhere the Docker CLI of the host could prune a builder of its user.
    expect(isSharedShellCall(['builder', 'prune', '--all', '--force'], true)).toBe(true);
    expect(isSharedShellCall(['builder', 'prune', '--all', '--force'], false)).toBe(false);
  });
});

describe('isShellCall', () => {
  it('takes the calls that only read and reach the engine, without a global option and without docker version', () => {
    expect(isShellCall(['info', '--format', '{{json .ServerVersion}}'])).toBe(true);
    expect(isShellCall(['image', 'inspect', 'x'])).toBe(true);
    expect(isShellCall(['ps', '--all'])).toBe(true);
    expect(isShellCall(['volume', 'ls'])).toBe(true);
    expect(isShellCall(['version'])).toBe(false);
    expect(isShellCall(['context', 'ls'])).toBe(false);
    expect(isShellCall(['-H', 'ssh://box', 'info'])).toBe(false);
    expect(isShellCall(['--version'])).toBe(false);
    expect(isShellCall(['run', 'x'])).toBe(false);
    expect(isShellCall(['build', '-'])).toBe(false);
    expect(isShellCall([])).toBe(false);
  });
});
