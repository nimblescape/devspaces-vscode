// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The steps of "Remove Devspaces from This Computer…" besides the Docker engines (R-GEN-009): the inventory for the
// question, and the removal of the SSH key of Devspaces with its line on each host. `ssh` is a fake that runs the remote
// command with `sh` in a temporary home folder of "the host"; `ssh-keygen` is a fake too.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../core/ports';
import { ComputerCleanup, ComputerCleanupTexts, type ComputerCleanupDeps } from './computerCleanup';

const BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIHgJ3c2oQkQe4m4oY0bJ6qNnV6l0Sx5Jm8m2bq9b3n1d';
const PUBLIC = `ssh-ed25519 ${BLOB} devspaces@desk`;
const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-cleanup-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const keyPath = () => path.join(dir, 'local', '.ssh', 'devspaces_ed25519');
/** The home folder of `host` for the fake ssh. */
const remoteHome = (host: string) => path.join(dir, 'remote', host);
const authorizedKeys = (host: string) => path.join(remoteHome(host), '.ssh', 'authorized_keys');

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function keyFiles(): void {
  write(keyPath(), '-----BEGIN OPENSSH PRIVATE KEY-----\n');
  write(`${keyPath()}.pub`, `${PUBLIC}\n`);
}

interface Call {
  file: string;
  args: readonly string[];
  options?: RunOptions;
}

function setUp(overrides: Partial<ComputerCleanupDeps> = {}, answer: (call: Call) => RunResult | undefined = () => undefined) {
  const calls: Call[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
  const state = {
    remoteHosts: vi.fn(async () => ['devspaces-vm', 'box', 'me@cloud']),
    read: vi.fn(async () => ({ hosts: [{ host: 'box', sshKey: 'installed' as const }, { host: 'me@cloud', sshKey: 'declined' as const }, { host: 'old' }] })),
    setSshKey: vi.fn(async () => undefined),
  };
  const runner = {
    run: vi.fn(async (file: string, args: readonly string[], options?: RunOptions): Promise<RunResult> => {
      const call = { file, args, options };
      calls.push(call);
      const answered = answer(call);
      if (answered !== undefined) return answered;
      if (file === '/usr/bin/ssh-keygen') return ok(`${PUBLIC}\n`);
      if (file === '/usr/bin/ssh') {
        // The last argument is the remote command; the host is the argument before it.
        const host = args.at(-2) as string;
        fs.mkdirSync(remoteHome(host), { recursive: true });
        try {
          execFileSync('sh', ['-c', args.at(-1) as string], { env: { HOME: remoteHome(host), PATH: process.env.PATH }, cwd: os.tmpdir(), stdio: 'pipe' });
          return ok();
        } catch (error) {
          const failure = error as { status: number | null; stderr: Buffer };
          return { exitCode: failure.status, stdout: '', stderr: failure.stderr.toString(), timedOut: false };
        }
      }
      throw new Error(`unexpected ${file}`);
    }),
  };
  const deps: ComputerCleanupDeps = {
    logger,
    runner,
    env: { PATH: '/usr/bin', HOME: path.join(dir, 'local') },
    state,
    vmHost: 'devspaces-vm',
    vmExists: async () => true,
    removeVm: vi.fn(async () => undefined),
    keyPath: keyPath(),
    sshPath: () => '/usr/bin/ssh',
    sshKeygenPath: () => '/usr/bin/ssh-keygen',
    folder: path.join(dir, 'local', '.nimblescape', 'devspaces'),
    files: { runner, platform: 'linux', env: {}, homeDir: path.join(dir, 'local'), uid: () => 1000 },
    uninstallExtension: vi.fn(async () => undefined),
    ...overrides,
  };
  return { cleanup: new ComputerCleanup(deps), calls, logger, state, deps };
}

describe('the inventory for the question of the command', () => {
  it('names the engines of the list without the VM, the VM, the hosts with the line of the key, the key and the folder', async () => {
    keyFiles();
    fs.mkdirSync(path.join(dir, 'local', '.nimblescape', 'devspaces'), { recursive: true });
    const { cleanup } = setUp();
    expect(await cleanup.inventory()).toEqual({
      engines: ['box', 'me@cloud'],
      vm: 'devspaces-vm',
      keyHosts: ['box'],
      keyFile: keyPath(),
      folder: path.join(dir, 'local', '.nimblescape', 'devspaces'),
    });
  });

  it('leaves out what is not there, and counts a list that cannot be read as empty and an unknown VM as there', async () => {
    const { cleanup, logger } = setUp({
      state: { remoteHosts: async () => Promise.reject(new Error('EACCES')), read: async () => Promise.reject(new Error('EACCES')), setSshKey: async () => undefined },
      vmExists: async () => Promise.reject(new Error('limactl failed')),
    });
    expect(await cleanup.inventory()).toEqual({ engines: [], vm: 'devspaces-vm', keyHosts: [], keyFile: undefined, folder: undefined });
    expect(logger.warn).toHaveBeenCalledWith('The list of Docker hosts of Devspaces could not be read: EACCES');
    const none = setUp({ vmExists: async () => false, vmHost: undefined, folder: undefined });
    expect((await none.cleanup.inventory()).vm).toBeUndefined();
    expect((await none.cleanup.inventory()).engines).toEqual(['devspaces-vm', 'box', 'me@cloud']);
  });
});

describe('the removal of the SSH key of Devspaces', () => {
  it('removes the line of the key on each host with a login that may use only the key, then deletes the key', async () => {
    keyFiles();
    write(authorizedKeys('box'), `ssh-ed25519 AAAAother ann@desk\n${PUBLIC}\nssh-ed25519 ${BLOB} devspaces@old-name\n`);
    const { cleanup, calls, state, logger } = setUp();
    expect(await cleanup.removeSshKey(['box', 'me@cloud'])).toEqual([]);
    expect(fs.readFileSync(authorizedKeys('box'), 'utf8')).toBe('ssh-ed25519 AAAAother ann@desk\n');
    // No file on the second host: nothing to remove.
    expect(fs.existsSync(authorizedKeys('me@cloud'))).toBe(false);
    expect(calls[0]).toMatchObject({ file: '/usr/bin/ssh-keygen', args: ['-y', '-f', keyPath()] });
    const logins = calls.filter((call) => call.file === '/usr/bin/ssh');
    expect(logins.map((call) => call.args.slice(0, -2))).toEqual([
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '-i', keyPath(), '-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=publickey', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '--'],
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T', '-i', keyPath(), '-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=publickey', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-l', 'me', '--'],
    ]);
    expect(logins.map((call) => call.args.at(-2))).toEqual(['box', 'cloud']);
    expect(logins.every((call) => call.args.at(-1)?.startsWith("sh -c '"))).toBe(true);
    expect(logins.every((call) => call.options?.env?.SSH_ASKPASS_REQUIRE === 'never' && call.options.timeoutMs === 30_000)).toBe(true);
    expect(state.setSshKey.mock.calls).toEqual([['box', undefined], ['me@cloud', undefined]]);
    expect(fs.existsSync(keyPath())).toBe(false);
    expect(fs.existsSync(`${keyPath()}.pub`)).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(`Devspaces deleted its SSH key ${keyPath()}, if it was there.`);
  });

  it('keeps the key when a line stays, so that a new run can still log in, and says what to remove by hand', async () => {
    keyFiles();
    const { cleanup, state } = setUp({}, (call) =>
      call.file === '/usr/bin/ssh' && call.args.at(-2) === 'box' ? { exitCode: 255, stdout: '', stderr: 'box: Permission denied (publickey).\n', timedOut: false } : undefined,
    );
    expect(await cleanup.removeSshKey(['box', 'me@cloud'])).toEqual([ComputerCleanupTexts.keyLineLeft('box', 'box: Permission denied (publickey).'), ComputerCleanupTexts.keyKept(keyPath())]);
    expect(state.setSshKey.mock.calls).toEqual([['me@cloud', undefined]]);
    expect(fs.existsSync(keyPath())).toBe(true);
    expect(fs.existsSync(`${keyPath()}.pub`)).toBe(true);
  });

  it('names why a line stays: a timeout, no ssh, a host that is no SSH alias or address, a symbolic link', async () => {
    keyFiles();
    const timedOut = setUp({}, (call) => (call.file === '/usr/bin/ssh' ? { exitCode: null, stdout: '', stderr: '', timedOut: true } : undefined));
    expect((await timedOut.cleanup.removeSshKey(['box']))[0]).toBe(ComputerCleanupTexts.keyLineLeft('box', 'ssh did not answer within 30 seconds'));
    const noSsh = setUp({ sshPath: () => undefined });
    expect((await noSsh.cleanup.removeSshKey(['box']))[0]).toBe(ComputerCleanupTexts.keyLineLeft('box', 'ssh was not found on this computer'));
    const option = setUp();
    expect((await option.cleanup.removeSshKey(['-oProxyCommand=x']))[0]).toBe(ComputerCleanupTexts.keyLineLeft('-oProxyCommand=x', 'the host is no SSH alias or address'));
    expect(option.calls.some((call) => call.file === '/usr/bin/ssh')).toBe(false);
    write(path.join(remoteHome('box'), 'managed'), `${PUBLIC}\n`);
    fs.mkdirSync(path.dirname(authorizedKeys('box')), { recursive: true });
    fs.symlinkSync(path.join(remoteHome('box'), 'managed'), authorizedKeys('box'));
    const link = setUp();
    expect((await link.cleanup.removeSshKey(['box']))[0]).toBe(ComputerCleanupTexts.keyLineLeft('box', '~/.ssh/authorized_keys is a symbolic link'));
    expect(fs.readFileSync(path.join(remoteHome('box'), 'managed'), 'utf8')).toBe(`${PUBLIC}\n`);
    expect(fs.existsSync(keyPath())).toBe(true);
  });

  it('reads the public key from the .pub file when ssh-keygen fails, and logs in nowhere when there is no key to read', async () => {
    keyFiles();
    const fallback = setUp({}, (call) => (call.file === '/usr/bin/ssh-keygen' ? { exitCode: 1, stdout: '', stderr: 'bad passphrase', timedOut: false } : undefined));
    write(authorizedKeys('box'), `${PUBLIC}\n`);
    expect(await fallback.cleanup.removeSshKey(['box'])).toEqual([]);
    expect(fs.readFileSync(authorizedKeys('box'), 'utf8')).toBe('');
    // Neither the private key nor its .pub file.
    const missing = setUp({ sshKeygenPath: () => undefined });
    const left = await missing.cleanup.removeSshKey(['box']);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^The SSH key of Devspaces .* could not be read, so its line stays on the hosts: .*ENOENT/);
    expect(missing.calls).toEqual([]);
  });

  it('only deletes the key files when no host has the line', async () => {
    keyFiles();
    const { cleanup, calls } = setUp();
    expect(await cleanup.removeSshKey([])).toEqual([]);
    expect(calls).toEqual([]);
    expect(fs.existsSync(keyPath())).toBe(false);
    // Nothing there: nothing to do, no failure.
    expect(await cleanup.removeSshKey([])).toEqual([]);
  });
});
