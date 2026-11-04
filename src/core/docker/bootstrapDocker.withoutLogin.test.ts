// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The work in the background on an SSH host never logs in to the host (docs/requirements.md R-ENG-002): it runs as an
// operation with `withoutLogin` (runWithDockerTarget), and BootstrapDocker refuses each of its Docker calls that would
// log in (`ssh://<host>`, or the shell before the relay, which may log in too). The refusal aborts the controller of the
// work and throws an AbortError. Through the Docker pipe of the extension, its calls run as usual.
import { describe, expect, it, vi } from 'vitest';
import { isAbortError, type Logger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import { BootstrapDocker } from './bootstrapDocker';
import { WSL_HOST, remoteDockerTarget } from './dockerHost';
import { operationDockerTarget, operationWithoutLogin, runWithDockerTarget } from './dockerTargets';

const OK: RunResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
const PIPE = 'unix:///run/user/1000/devspaces-0123456789abcdef/docker.sock';
const REMOTE = remoteDockerTarget('build-box');

function recording(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger: Logger = {
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
    output: () => undefined,
  };
  return { logger, lines };
}

function setUp(pipe: () => string | undefined): { docker: BootstrapDocker; envs: NodeJS.ProcessEnv[]; shell: ReturnType<typeof vi.fn>; lines: string[] } {
  const envs: NodeJS.ProcessEnv[] = [];
  const runner: ProcessRunner = {
    async run(_file: string, _args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
      envs.push(options.env ?? {});
      return OK;
    },
  };
  const shell = vi.fn(async () => OK);
  const { logger, lines } = recording();
  const docker = new BootstrapDocker(runner, '/usr/bin/docker', { PATH: '/usr/bin' }, logger, 'linux', { dockerPipe: pipe, remoteShell: shell });
  return { docker, envs, shell, lines };
}

describe('the scope of the work in the background without a login (runWithDockerTarget, withoutLogin)', () => {
  it('is known within the operation and in an operation on the same host within it, not on another host and not after the end', async () => {
    const withoutLogin = new AbortController();
    const seen: Array<AbortController | undefined> = [];
    await runWithDockerTarget(
      REMOTE,
      async () => {
        seen.push(operationWithoutLogin());
        await runWithDockerTarget(REMOTE, async () => seen.push(operationWithoutLogin()));
        await runWithDockerTarget(remoteDockerTarget('other-box'), async () => seen.push(operationWithoutLogin()));
      },
      { withoutLogin },
    );
    expect(seen).toEqual([withoutLogin, withoutLogin, undefined]);
    expect(operationWithoutLogin()).toBeUndefined();
    await runWithDockerTarget(REMOTE, async () => {
      expect(operationWithoutLogin()).toBeUndefined();
      expect(operationDockerTarget()).toBe(REMOTE);
    });
  });
});

describe('BootstrapDocker in the work in the background without a login', () => {
  it('refuses a call that would log in with ssh://<host>: no process, the controller of the work is aborted, an AbortError', async () => {
    const { docker, envs, lines } = setUp(() => undefined);
    const withoutLogin = new AbortController();
    const error = await runWithDockerTarget(REMOTE, () => docker.run(['build', '-t', 'x', '.']), { withoutLogin }).catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(withoutLogin.signal.aborted).toBe(true);
    expect(envs).toEqual([]);
    expect(lines.join('\n')).toContain('docker build -t x . does not run: the work in the background on build-box uses only the connection of this window to the host');
  });

  it('refuses a call that only reads instead of the shell before the relay, which could log in', async () => {
    const { docker, envs, shell } = setUp(() => undefined);
    const withoutLogin = new AbortController();
    const error = await runWithDockerTarget(REMOTE, () => docker.run(['image', 'inspect', 'x']), { withoutLogin }).catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(shell).not.toHaveBeenCalled();
    expect(envs).toEqual([]);
  });

  it('runs every call through the Docker pipe of the extension while the connection is open', async () => {
    const { docker, envs, shell } = setUp(() => PIPE);
    const withoutLogin = new AbortController();
    await runWithDockerTarget(
      REMOTE,
      async () => {
        await docker.run(['image', 'inspect', 'x']);
        await docker.run(['build', '-t', 'x', '.']);
      },
      { withoutLogin },
    );
    expect(envs.map((env) => env.DOCKER_HOST)).toEqual([PIPE, PIPE]);
    expect(shell).not.toHaveBeenCalled();
    expect(withoutLogin.signal.aborted).toBe(false);
  });

  it('leaves the calls of other operations as they are: ssh://<host> without the pipe', async () => {
    const { docker, envs } = setUp(() => undefined);
    await runWithDockerTarget(REMOTE, () => docker.run(['build', '-t', 'x', '.']));
    expect(envs[0].DOCKER_HOST).toBe('ssh://build-box');
  });

  it('leaves the calls that do not reach the engine, and the WSL distribution, which needs no login', async () => {
    const { docker, envs } = setUp(() => undefined);
    const withoutLogin = new AbortController();
    await runWithDockerTarget(REMOTE, () => docker.run(['context', 'ls']), { withoutLogin });
    expect(envs).toHaveLength(1);
    // The WSL distribution has no `ssh://`: without its pipe, a call that changes something fails as before.
    const error = await runWithDockerTarget(remoteDockerTarget(WSL_HOST), () => docker.run(['build', '-t', 'x', '.']), { withoutLogin }).catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(false);
    expect(withoutLogin.signal.aborted).toBe(false);
  });
});
