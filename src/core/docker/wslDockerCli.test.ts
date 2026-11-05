// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The Docker CLI in a WSL distribution: `wsl.exe … --exec env DEVSPACES_RUN=<mark> docker <args>`, and after a Cancel
// or a time limit a second `wsl.exe` that ends the processes of that mark.
import { spawn } from 'child_process';
import * as fs from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { abortError, isAbortError, silentLogger, type Logger, type RunOptions, type RunResult } from '../ports';
import { wslCommandArgs } from './dockerHost';
import { WSL_END_TIMEOUT_MS, wslDockerCli, wslEndCommand, wslMarkedCommand } from './wslDockerCli';

function ok(stdout = ''): RunResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

interface Call {
  args: string[];
  options: RunOptions;
}

function recorder(answer: (call: Call) => Promise<RunResult>): { runWsl: (args: readonly string[], options: RunOptions) => Promise<RunResult>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    runWsl: (args, options) => {
      const call = { args: [...args], options };
      calls.push(call);
      return answer(call);
    },
  };
}

/** The mark of a call of wslMarkedCommand, from its arguments of `wsl.exe`. */
function markOf(args: readonly string[]): string {
  const variable = args[args.indexOf('env') + 1];
  expect(variable).toMatch(/^DEVSPACES_RUN=[0-9a-f]{32}$/);
  return variable.slice('DEVSPACES_RUN='.length);
}

const isEnd = (call: Call): boolean => call.args.includes('sh');

describe('wslDockerCli', () => {
  it('runs docker with a new mark in the distribution, with the options of the call, and ends nothing after a normal end', async () => {
    const { runWsl, calls } = recorder(async () => ok('github.com/docker/buildx v0.38.1\n'));
    const cli = wslDockerCli(runWsl, 'devspaces', silentLogger);
    const signal = new AbortController().signal;
    const input = Buffer.from('tar');
    expect(await cli(['build', '-'], { input, signal, timeoutMs: 5000 })).toEqual(ok('github.com/docker/buildx v0.38.1\n'));
    await cli(['buildx', 'version'], {});
    const mark = markOf(calls[0].args);
    expect(calls[0].args).toEqual(wslCommandArgs('devspaces', ['env', `DEVSPACES_RUN=${mark}`, 'docker', 'build', '-']));
    expect(calls[0].options).toEqual({ input, signal, timeoutMs: 5000 });
    expect(markOf(calls[1].args)).not.toBe(mark);
    expect(calls).toHaveLength(2);
  });

  it('ends the processes of the mark after a Cancel, and still rejects with the AbortError at once', async () => {
    let endDone: () => void = () => {};
    const ended = new Promise<void>((resolve) => (endDone = resolve));
    const { runWsl, calls } = recorder(async (call) => {
      if (isEnd(call)) {
        endDone();
        return ok();
      }
      throw abortError();
    });
    const error = await wslDockerCli(runWsl, 'devspaces', silentLogger)(['build', '-'], {}).catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    await ended;
    expect(calls[1].args).toEqual(wslCommandArgs('devspaces', wslEndCommand(markOf(calls[0].args))));
    expect(calls[1].options).toEqual({ timeoutMs: WSL_END_TIMEOUT_MS });
  });

  it('ends the processes of the mark after the time limit, and not after another failure', async () => {
    let answer: RunResult | Error = { exitCode: null, stdout: '', stderr: '', timedOut: true };
    const { runWsl, calls } = recorder(async (call) => {
      if (isEnd(call)) return ok();
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const cli = wslDockerCli(runWsl, 'devspaces', silentLogger);
    expect((await cli(['buildx', 'version'], { timeoutMs: 1 })).timedOut).toBe(true);
    await vi.waitFor(() => expect(calls.filter(isEnd)).toHaveLength(1));
    answer = { exitCode: 1, stdout: '', stderr: 'failed to solve', timedOut: false };
    await cli(['build', '-'], {});
    answer = new Error('spawn wsl.exe ENOENT');
    await expect(cli(['build', '-'], {})).rejects.toThrow('ENOENT');
    expect(calls.filter(isEnd)).toHaveLength(1);
  });

  it('logs when the processes of the mark could not be ended', async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message) => warnings.push(message) };
    let end: RunResult | Error = { exitCode: 1, stdout: 'Wsl/Service/CreateInstance/ERROR_TIMEOUT', stderr: '', timedOut: false };
    const { runWsl } = recorder(async (call) => {
      if (!isEnd(call)) throw abortError();
      if (end instanceof Error) throw end;
      return end;
    });
    const cli = wslDockerCli(runWsl, 'devspaces', logger);
    await cli(['build', '-'], {}).catch(() => undefined);
    end = new Error('spawn wsl.exe ENOENT');
    await cli(['build', '-'], {}).catch(() => undefined);
    await vi.waitFor(() => expect(warnings).toHaveLength(2));
    expect(warnings).toEqual([
      'The Docker CLI in the WSL distribution devspaces could not be ended after its stop, so its work may go on there: Wsl/Service/CreateInstance/ERROR_TIMEOUT',
      'The Docker CLI in the WSL distribution devspaces could not be ended after its stop, so its work may go on there: spawn wsl.exe ENOENT',
    ]);
  });
});

/** Runs `command` (no shell) and resolves with its exit code. */
function exitOf(command: readonly string[], env: NodeJS.ProcessEnv = process.env): { pid: number | undefined; exited: Promise<number | null> } {
  const child = spawn(command[0], command.slice(1), { env, stdio: 'ignore' });
  return { pid: child.pid, exited: new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal === null ? code : -1))) };
}

// The script of wslEndCommand on Linux, as root of a WSL distribution runs it (a process of the same user here).
describe.skipIf(process.platform !== 'linux')('wslEndCommand with real processes', () => {
  it('ends the processes of its mark and leaves the others', async () => {
    const mark = 'a'.repeat(32);
    const marked = exitOf(wslMarkedCommand(mark, ['sh', '-c', 'sleep 30 & wait']));
    const other = exitOf(wslMarkedCommand('b'.repeat(32), ['sleep', '30']));
    // Until `env` has put the mark into the environment and started its command.
    for (const pid of [marked.pid, other.pid]) {
      await vi.waitFor(() => expect(fs.readFileSync(`/proc/${pid}/environ`, 'latin1')).toContain('DEVSPACES_RUN='), { timeout: 5000 });
    }
    expect(await exitOf(wslEndCommand(mark)).exited).toBe(0);
    expect(await marked.exited).toBe(-1);
    if (other.pid !== undefined) process.kill(other.pid);
    expect(await other.exited).toBe(-1);
  });
});
