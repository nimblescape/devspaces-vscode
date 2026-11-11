// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The shells before the relay of a window on local `sh -s` logins (in place of `ssh … sh -s`).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger, type StartedByteProcess } from '../ports';
import { NodeProcessRunner } from '../process';
import { sshPromptSignal, sshPromptsAllowed, withSshPrompts } from '../sshAskpass';
import { LIMA_HOST } from '../docker/dockerHost';
import { RemoteShells } from './remoteShells';

const describeUnix = process.platform === 'win32' ? describe.skip : describe;
const runner = new NodeProcessRunner();

/** RemoteShells whose logins are `script` (a local `sh -s` by default), with the hosts that each login was for. */
function shells(options: { script?: string; noTransport?: string[]; logger?: Logger; idleCloseMs?: number } = {}) {
  const logins: string[] = [];
  const processes: StartedByteProcess[] = [];
  const registry = new RemoteShells({
    logger: options.logger ?? silentLogger,
    start: (host) => {
      if (options.noTransport?.includes(host)) return undefined;
      logins.push(host);
      const process = runner.startBytes('sh', ['-c', options.script ?? 'exec sh -s']);
      processes.push(process);
      return { process };
    },
    idleCloseMs: options.idleCloseMs,
    loginTimeoutMs: 5_000,
  });
  return { registry, logins, processes };
}

describeUnix('RemoteShells', () => {
  it('logs in once per host for the calls at the same time and after, and logs the login', async () => {
    const lines: string[] = [];
    const { registry, logins } = shells({ logger: { ...silentLogger, info: (line) => lines.push(line) } });
    const results = await Promise.all([registry.run('box', 'printf one'), registry.run('box', 'printf two'), registry.login('box'), registry.run('other', 'printf three')]);
    expect(results.map((result) => (result !== undefined && 'stdout' in result ? result.stdout : result))).toEqual(['one', 'two', { ok: true }, 'three']);
    await expect(registry.run('box', 'printf four')).resolves.toMatchObject({ stdout: 'four' });
    expect(logins.sort()).toEqual(['box', 'other']);
    expect(lines.filter((line) => line.startsWith('The shell on box'))).toEqual(['The shell on box is open: one login for the checks before the relay.']);
    registry.dispose();
  });

  it('runs a Docker call with the docker of the other computer, each word as it is, and none with a word that a line cannot carry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-shells-'));
    try {
      fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\nprintf '%s|' "$@"\necho "words: $#" >&2\nexit 4\n`, { mode: 0o755 });
      const { registry } = shells({ script: `PATH=${dir}:$PATH; export PATH; exec sh -s` });
      await expect(registry.docker('box', ['ps', '--filter', "name=it's $HOME"])).resolves.toEqual({
        exitCode: 4,
        stdout: "ps|--filter|name=it's $HOME|",
        stderr: 'words: 3\n',
        timedOut: false,
      });
      await expect(registry.docker('box', ['ps', 'a\nb'])).resolves.toBeUndefined();
      registry.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has no shell for a host without a transport', async () => {
    const { registry, logins } = shells({ noTransport: ['box/path'] });
    await expect(registry.login('box/path')).resolves.toBeUndefined();
    await expect(registry.run('box/path', 'true')).resolves.toBeUndefined();
    await expect(registry.takeOver('box/path')).resolves.toBeUndefined();
    expect(logins).toEqual([]);
  });

  it('gives a failed login as the result of ssh, and logs in again for the next call', async () => {
    const { registry, logins } = shells({ script: 'echo "ssh: connect to host box port 22: Connection refused" >&2; exit 255' });
    await expect(registry.login('box')).resolves.toEqual({ ok: false, detail: 'ssh: connect to host box port 22: Connection refused', timedOut: false });
    await expect(registry.run('box', 'true')).resolves.toEqual({ exitCode: 255, stdout: '', stderr: 'ssh: connect to host box port 22: Connection refused', timedOut: false });
    expect(logins).toEqual(['box', 'box']);
  });

  // In a slow virtual machine, WSL can run out of time to start the distribution (its own limit of 30 seconds).
  it('starts a WSL distribution again when WSL ran out of time to start it, at most 3 times, and no other host', async () => {
    const timeout = 'This operation returned because the timeout period expired. \nError code: Wsl/Service/CreateInstance/ERROR_TIMEOUT';
    // wsl.exe writes its errors to the standard output.
    const failing = `printf '%s\\n' '${timeout}'; exit 1`;
    let failures = 2;
    const lines: string[] = [];
    const logins: string[] = [];
    const registry = new RemoteShells({
      logger: { ...silentLogger, info: (line) => lines.push(line) },
      loginTimeoutMs: 5_000,
      start: (host) => {
        logins.push(host);
        return { process: runner.startBytes('sh', ['-c', failures-- > 0 ? failing : 'exec sh -s']) };
      },
    });
    await expect(registry.run('wsl:devspaces', 'printf one')).resolves.toMatchObject({ stdout: 'one' });
    expect(logins).toEqual(['wsl:devspaces', 'wsl:devspaces', 'wsl:devspaces']);
    expect(lines.filter((line) => line.startsWith('WSL ran out of time'))).toEqual([
      `WSL ran out of time to start the distribution devspaces (attempt 1 of 3), so Devspaces starts it again: ${timeout.replace(' \n', '\n')}`,
      `WSL ran out of time to start the distribution devspaces (attempt 2 of 3), so Devspaces starts it again: ${timeout.replace(' \n', '\n')}`,
    ]);
    registry.dispose();

    // Three times out of time: the third failure counts.
    failures = 5;
    logins.length = 0;
    const again = new RemoteShells({ logger: silentLogger, loginTimeoutMs: 5_000, start: (host) => (logins.push(host), { process: runner.startBytes('sh', ['-c', failing]) }) });
    await expect(again.login('wsl:devspaces')).resolves.toMatchObject({ ok: false, timedOut: false, detail: expect.stringContaining('ERROR_TIMEOUT') });
    expect(logins).toHaveLength(3);
    // An SSH host, and another error of WSL, log in once; the output of an SSH login before the marker is no reason.
    logins.length = 0;
    await expect(again.login('box')).resolves.toEqual({ ok: false, detail: 'The login ended before the shell answered.', timedOut: false });
    expect(logins).toEqual(['box']);
    const other = new RemoteShells({
      logger: silentLogger,
      loginTimeoutMs: 5_000,
      start: (host) => (logins.push(host), { process: runner.startBytes('sh', ['-c', "echo 'Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND' >&2; exit 1"]) }),
    });
    logins.length = 0;
    await expect(other.login('wsl:devspaces')).resolves.toMatchObject({ ok: false });
    expect(logins).toEqual(['wsl:devspaces']);
  });

  it('forgets a shell to a WSL distribution that ended, so that the next call logs in again', async () => {
    const { registry, logins, processes } = shells();
    await expect(registry.run('wsl:devspaces', 'printf one')).resolves.toMatchObject({ stdout: 'one' });
    processes[0].kill();
    await processes[0].exited;
    await expect(registry.run('wsl:devspaces', 'printf two')).resolves.toMatchObject({ stdout: 'two' });
    expect(logins).toEqual(['wsl:devspaces', 'wsl:devspaces']);
    registry.dispose();
  });

  // A login of the background runs with BatchMode and fails for a host that needs a password or an unknown host key.
  it('logs in anew for a flow of the user after a login of the background in progress failed', async () => {
    const logins: string[] = [];
    const prompts = { onPrompt: () => () => undefined };
    const registry = new RemoteShells({
      logger: silentLogger,
      loginTimeoutMs: 5_000,
      start: () => {
        const asks = sshPromptsAllowed();
        logins.push(asks ? 'asks' : 'quiet');
        const script = asks ? 'exec sh -s' : 'sleep 0.3; echo "me@box: Permission denied (password)." >&2; exit 255';
        const process = runner.startBytes('sh', ['-c', script]);
        return asks ? { process, prompts } : { process };
      },
    });
    const background = registry.login('box');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const flow = withSshPrompts(() => registry.login('box'));
    await expect(background).resolves.toMatchObject({ ok: false, detail: 'me@box: Permission denied (password).' });
    await expect(flow).resolves.toEqual({ ok: true });
    expect(logins).toEqual(['quiet', 'asks']);
    registry.dispose();
  });

  // The key offer (SshKeyOffer.afterLogin) asks the user and runs a command on the shell; the other calls go on.
  it('runs the step after the login once, gives the shell to the calls at once, and to the relay only after the step', async () => {
    const steps: string[] = [];
    const warnings: string[] = [];
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => (release = resolve));
    const registry = new RemoteShells({
      logger: { ...silentLogger, warn: (line) => warnings.push(line) },
      loginTimeoutMs: 5_000,
      idleCloseMs: 50,
      start: () => ({
        process: runner.startBytes('sh', ['-c', 'exec sh -s']),
        afterLogin: async (shell) => {
          steps.push('asked');
          // Longer than the time without use of the shell: the question of the user.
          await answered;
          steps.push(`ran ${(await shell.run('printf key')).stdout}`);
        },
      }),
    });
    await expect(registry.run('box', 'printf one')).resolves.toMatchObject({ stdout: 'one' });
    await expect(registry.login('box')).resolves.toEqual({ ok: true });
    const taking = registry.takeOver('box').then((taken) => {
      steps.push('taken');
      return taken;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(steps).toEqual(['asked']);
    release();
    const taken = await taking;
    expect(taken).toBeDefined();
    expect(steps).toEqual(['asked', 'ran key', 'taken']);
    expect(warnings).toEqual([]);
    taken?.kill();
    registry.dispose();
  });

  it('ends the step after the login before a fresh login closes its shell', async () => {
    const steps: string[] = [];
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => (release = resolve));
    let logins = 0;
    const registry = new RemoteShells({
      logger: silentLogger,
      loginTimeoutMs: 5_000,
      start: () => {
        logins++;
        const first = logins === 1;
        return {
          process: runner.startBytes('sh', ['-c', 'exec sh -s']),
          afterLogin: first
            ? async (shell) => {
                await answered;
                steps.push(`ran ${(await shell.run('printf key')).stdout}`);
              }
            : undefined,
        };
      },
    });
    await expect(registry.login('box')).resolves.toEqual({ ok: true });
    const fresh = registry.login('box', undefined, { fresh: true }).then((result) => steps.push(`fresh ${JSON.stringify(result)}`));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(steps).toEqual([]);
    expect(logins).toBe(1);
    release();
    await fresh;
    expect(steps).toEqual(['ran key', 'fresh {"ok":true}']);
    expect(logins).toBe(2);
    registry.dispose();
  });

  it('gives out the shell after a step after the login that failed, and logs it', async () => {
    const warnings: string[] = [];
    const registry = new RemoteShells({
      logger: { ...silentLogger, warn: (line) => warnings.push(line) },
      loginTimeoutMs: 5_000,
      start: () => ({ process: runner.startBytes('sh', ['-c', 'exec sh -s']), afterLogin: () => Promise.reject(new Error('no answer')) }),
    });
    await expect(registry.run('box', 'printf one')).resolves.toMatchObject({ stdout: 'one' });
    await expect(registry.takeOver('box')).resolves.toBeDefined();
    expect(warnings).toEqual(['The step after the login on box failed: no answer']);
    registry.dispose();
  });

  // The test of a host sees the SSH configuration and the host of now.
  it('logs in anew with fresh, and ends the open shell at once', async () => {
    const { registry, logins, processes } = shells();
    await expect(registry.run('box', 'printf one')).resolves.toMatchObject({ stdout: 'one' });
    await expect(registry.login('box', undefined, { fresh: true })).resolves.toEqual({ ok: true });
    expect(logins).toEqual(['box', 'box']);
    await processes[0].exited;
    // The calls after it use the new login, and so does a login without fresh.
    await expect(registry.run('box', 'printf two')).resolves.toMatchObject({ stdout: 'two' });
    await expect(registry.login('box')).resolves.toEqual({ ok: true });
    expect(logins).toEqual(['box', 'box']);
    registry.dispose();
  });

  it('shares the login of a flow with the other calls of the same flow, also after a failure', async () => {
    const logins: string[] = [];
    const registry = new RemoteShells({
      logger: silentLogger,
      loginTimeoutMs: 5_000,
      start: () => {
        logins.push('login');
        // A login that cannot ask (the pipe of the questions is not ready yet) and is refused.
        return { process: runner.startBytes('sh', ['-c', 'sleep 0.2; echo "me@box: Permission denied (password)." >&2; exit 255']) };
      },
    });
    const results = await withSshPrompts(() => Promise.all([registry.login('box'), registry.login('box')]));
    expect(results).toEqual([expect.objectContaining({ ok: false }), expect.objectContaining({ ok: false })]);
    expect(logins).toEqual(['login']);
    registry.dispose();
  });

  // Two flows of the user: the Cancel of the first ends the questions of its login, and the second asks itself.
  it('logs in anew for a flow of the user after the login of another flow was cancelled, but not after a time limit', async () => {
    const logins: string[] = [];
    const prompts = { onPrompt: () => () => undefined };
    let script = '';
    const registry = new RemoteShells({
      logger: silentLogger,
      loginTimeoutMs: 5_000,
      start: () => {
        const signal = sshPromptSignal();
        logins.push(sshPromptsAllowed() ? 'flow' : 'background');
        const process = runner.startBytes('sh', ['-c', script]);
        // The Cancel of the flow ends its questions, and `ssh` then fails.
        signal?.addEventListener('abort', () => process.kill());
        return { process, prompts };
      },
    });
    script = 'sleep 0.2; exec sh -s';
    const first = new AbortController();
    const cancelled = withSshPrompts(() => registry.login('box'), first.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = withSshPrompts(() => registry.login('box'));
    first.abort();
    await expect(cancelled).resolves.toMatchObject({ ok: false });
    await expect(second).resolves.toEqual({ ok: true });
    expect(logins).toEqual(['flow', 'flow']);
    registry.dispose();
    // A host that did not answer in time: the second flow takes that result.
    logins.length = 0;
    script = 'sleep 30';
    const late = new RemoteShells({ logger: silentLogger, loginTimeoutMs: 300, start: () => (logins.push('login'), { process: runner.startBytes('sh', ['-c', script]), prompts }) });
    const both = await Promise.all([withSshPrompts(() => late.login('box')), new Promise((resolve) => setTimeout(resolve, 50)).then(() => withSshPrompts(() => late.login('box')))]);
    expect(both).toEqual([expect.objectContaining({ ok: false, timedOut: true }), expect.objectContaining({ ok: false, timedOut: true })]);
    expect(logins).toEqual(['login']);
    late.dispose();
  });

  it('gives the relay the login of the shell after the calls before it, and a new login to the calls after it', async () => {
    const { registry, logins } = shells();
    const before = registry.run('box', 'printf before');
    const taking = registry.takeOver('box');
    await expect(before).resolves.toMatchObject({ stdout: 'before' });
    const taken = await taking;
    expect(taken).toBeDefined();
    expect(logins).toEqual(['box']);
    // The shell is the relay's now: the next call logs in again, and there is nothing more to take over.
    await expect(registry.run('box', 'printf after')).resolves.toMatchObject({ stdout: 'after' });
    expect(logins).toEqual(['box', 'box']);
    taken!.end();
    await taken!.exited;
    registry.dispose();
  });

  it('leaves a busy shell of the VM to its commands, so that the relay logs in itself, and waits for them on an SSH host', async () => {
    const { registry, logins } = shells();
    await registry.login(LIMA_HOST);
    const running = registry.run(LIMA_HOST, 'sleep 0.3; printf done');
    await expect(registry.takeOver(LIMA_HOST)).resolves.toBeUndefined();
    await expect(running).resolves.toMatchObject({ stdout: 'done' });
    // Without a command on it, the relay takes it over.
    const taken = await registry.takeOver(LIMA_HOST);
    expect(taken).toBeDefined();
    taken!.end();
    // On an SSH host, the takeover waits for the command before it.
    await registry.login('box');
    const before = registry.run('box', 'sleep 0.3; printf before');
    const takenBox = await registry.takeOver('box');
    await expect(before).resolves.toMatchObject({ stdout: 'before' });
    expect(takenBox).toBeDefined();
    takenBox!.end();
    expect(logins).toEqual([LIMA_HOST, 'box']);
    registry.dispose();
  });

  it('holds a shell back from the relay while the page samples on it, and gives it again after the last hold', async () => {
    const { registry, logins } = shells();
    expect(registry.hasShell('box')).toBe(false);
    const login = registry.login('box');
    // A login in progress counts: a command needs no new login.
    expect(registry.hasShell('box')).toBe(true);
    await login;
    const first = registry.keep('box');
    const second = registry.keep('box');
    await expect(registry.takeOver('box')).resolves.toBeUndefined();
    first();
    first();
    await expect(registry.takeOver('box')).resolves.toBeUndefined();
    // The shell stays with the window meanwhile.
    await expect(registry.run('box', 'printf still')).resolves.toMatchObject({ stdout: 'still' });
    second();
    // A hold that starts while the takeover waits for the command before it keeps the shell too.
    const before = registry.run('box', 'sleep 0.3; printf before');
    const waiting = registry.takeOver('box');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const late = registry.keep('box');
    await expect(waiting).resolves.toBeUndefined();
    await expect(before).resolves.toMatchObject({ stdout: 'before' });
    await expect(registry.run('box', 'printf kept')).resolves.toMatchObject({ stdout: 'kept' });
    late();
    const taken = await registry.takeOver('box');
    expect(taken).toBeDefined();
    expect(registry.hasShell('box')).toBe(false);
    taken!.end();
    expect(logins).toEqual(['box']);
    registry.dispose();
  });

  it('gives the relay a login that is still in progress, and nothing when there is none', async () => {
    const { registry } = shells();
    await expect(registry.takeOver('box')).resolves.toBeUndefined();
    const login = registry.login('box');
    const taken = await registry.takeOver('box');
    await expect(login).resolves.toEqual({ ok: true });
    expect(taken).toBeDefined();
    taken!.end();
    registry.dispose();
  });

  it('logs in again after a shell was closed for a time without use', async () => {
    const { registry, logins, processes } = shells({ idleCloseMs: 100 });
    await registry.run('box', 'true');
    await processes[0].exited;
    await registry.run('box', 'true');
    expect(logins).toEqual(['box', 'box']);
    registry.dispose();
  });

  it('stops every shell at the end of the window, and opens none after it', async () => {
    const { registry, processes, logins } = shells();
    await registry.login('box');
    registry.dispose();
    await expect(processes[0].exited).resolves.toMatchObject({ exitCode: null });
    await expect(registry.run('box', 'true')).resolves.toBeUndefined();
    expect(logins).toEqual(['box']);
  });

  it('stops a login in progress at the end of the window', async () => {
    const { registry, processes } = shells({ script: 'exec sleep 30' });
    const login = registry.login('box');
    registry.dispose();
    // It ends long before its 30 seconds (and the time limit of the login).
    await processes[0].exited;
    await expect(login).resolves.toMatchObject({ ok: false, timedOut: false });
  });

  it('stops the shell of one host at once (a stop of the VM), with the command on it, and logs in anew for the next call', async () => {
    const { registry, processes, logins } = shells();
    await registry.login('box');
    await registry.login('other');
    const running = registry.run('box', 'sleep 30');
    await new Promise((resolve) => setTimeout(resolve, 50));
    registry.close('box');
    // The command ends with the shell, long before its 30 seconds (the time limit of the test is 5 seconds), as a failure.
    expect((await running)?.exitCode).not.toBe(0);
    await expect(processes[0].exited).resolves.toMatchObject({ exitCode: null });
    // The shell of the other host stays; the next call to the host logs in anew.
    await expect(registry.run('other', 'printf still')).resolves.toMatchObject({ stdout: 'still' });
    await expect(registry.run('box', 'printf again')).resolves.toMatchObject({ stdout: 'again' });
    expect(logins).toEqual(['box', 'other', 'box']);
    // Nothing to stop: no error.
    registry.close('none');
    registry.dispose();
  });

  it('stops a login in progress of one host at once', async () => {
    const { registry, processes } = shells({ script: 'exec sleep 30' });
    const login = registry.login('box');
    registry.close('box');
    await processes[0].exited;
    await expect(login).resolves.toMatchObject({ ok: false, timedOut: false });
    registry.dispose();
  });
});
