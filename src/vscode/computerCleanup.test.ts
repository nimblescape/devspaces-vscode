// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The steps of "Remove Devspaces from This Computer…" besides the Docker engines (R-GEN-009): the inventory for the
// question, and the removal of the SSH key of Devspaces with its line on each host, through the SshKeyOffer of the
// window. `ssh` is a fake that runs the remote command with `sh` in a temporary home folder of "the host"; `ssh-keygen`
// is a fake too.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import type { RunOptions, RunResult } from '../core/ports';
import { NO_KEY_LINE_TEXT } from '../core/sshKey';
import { ComputerCleanup, ComputerCleanupTexts, type ComputerCleanupDeps } from './computerCleanup';
import { SshKeyOffer } from './sshKeyOffer';

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

interface Programs {
  sshPath?: () => string | undefined;
  sshKeygenPath?: () => string | undefined;
}

function setUp(overrides: Partial<ComputerCleanupDeps> & Programs = {}, answer: (call: Call) => RunResult | undefined = () => undefined) {
  const calls: Call[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
  // The list: a record that forgets the key (setSshKey) says so at the next read.
  const records: { host: string; sshKey?: 'installed' | 'declined' }[] = [
    { host: 'devspaces-vm', sshKey: 'installed' },
    { host: 'box', sshKey: 'installed' },
    { host: 'me@cloud', sshKey: 'declined' },
    { host: 'old' },
  ];
  const state = {
    readStrict: vi.fn(async () => ({ remoteHosts: ['devspaces-vm', 'box', 'me@cloud'], hosts: records.map((record) => ({ ...record })) })),
    setSshKey: vi.fn(async (host: string, value: 'installed' | 'declined' | undefined) => {
      const record = records.find((entry) => entry.host === host);
      if (record !== undefined) record.sshKey = value;
    }),
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
  const { sshPath, sshKeygenPath, ...rest } = overrides;
  const key = new SshKeyOffer({
    home: path.join(dir, 'local'),
    platform: 'linux',
    computerName: 'desk',
    wrapperFolder: path.join(dir, 'wrapper'),
    runner,
    sshPath: sshPath ?? (() => '/usr/bin/ssh'),
    sshKeygenPath: sshKeygenPath ?? (() => '/usr/bin/ssh-keygen'),
    env: { PATH: '/usr/bin', HOME: path.join(dir, 'local') },
    state: { sshKeyNow: () => undefined, setSshKey: async () => undefined },
    dialogs: {} as never,
    logger,
  });
  expect(key.keyPath).toBe(keyPath());
  const deps: ComputerCleanupDeps = {
    logger,
    state,
    vmHost: 'devspaces-vm',
    vmState: async () => 'vm' as const,
    removeVm: vi.fn(async () => undefined),
    vmGone: vi.fn(),
    key,
    folder: path.join(dir, 'local', '.nimblescape', 'devspaces'),
    files: { runner, platform: 'linux', env: {}, homeDir: path.join(dir, 'local'), uid: () => 1000 },
    uninstallExtension: vi.fn(async () => undefined),
    ...rest,
  };
  return { cleanup: new ComputerCleanup(deps), calls, logger, state, deps };
}

describe('the inventory for the question of the command', () => {
  it('names the engines of the list without the VM, the VM, the hosts with the line of the key, the key and the folder', async () => {
    keyFiles();
    fs.mkdirSync(path.join(dir, 'local', '.nimblescape', 'devspaces'), { recursive: true });
    const { cleanup } = setUp();
    expect(await cleanup.inventory()).toEqual({
      listUnreadable: undefined,
      engines: ['box', 'me@cloud'],
      vm: 'devspaces-vm',
      vmLeftovers: false,
      keyHosts: ['box'],
      keyFile: keyPath(),
      folder: path.join(dir, 'local', '.nimblescape', 'devspaces'),
    });
  });

  // Mutation: a list that cannot be read counted as empty, so that the key was deleted while its lines stayed.
  it('leaves out what is not there, names a list that cannot be read instead of counting it as empty, and counts an unknown VM as there', async () => {
    const { cleanup, logger } = setUp({
      state: { readStrict: async () => Promise.reject(new Error('remote-docker.json is not a valid list of Docker hosts')), setSshKey: async () => undefined },
      vmState: async () => Promise.reject(new Error('limactl failed')),
    });
    expect(await cleanup.inventory()).toEqual({
      listUnreadable: 'remote-docker.json is not a valid list of Docker hosts',
      engines: [],
      vm: 'devspaces-vm',
      vmLeftovers: false,
      keyHosts: [],
      keyFile: undefined,
      folder: undefined,
    });
    expect(logger.warn).toHaveBeenCalledWith('The list of Docker hosts of Devspaces could not be read: remote-docker.json is not a valid list of Docker hosts');
    const none = setUp({ vmState: async () => 'none' as const, vmHost: undefined, folder: undefined });
    expect((await none.cleanup.inventory()).vm).toBeUndefined();
    expect((await none.cleanup.inventory()).engines).toEqual(['devspaces-vm', 'box', 'me@cloud']);
    expect((await none.cleanup.inventory()).keyHosts).toEqual(['devspaces-vm', 'box']);
    // Only the files of a setup that did not end: the VM with leftovers, so that the question names them as such.
    const leftovers = setUp({ vmState: async () => 'leftovers' as const });
    expect(await leftovers.cleanup.inventory()).toMatchObject({ vm: 'devspaces-vm', vmLeftovers: true });
    expect(await leftovers.cleanup.vmExists()).toBe(true);
    expect(await none.cleanup.vmExists()).toBe(false);
  });
});

describe('the removal of the SSH key of Devspaces', () => {
  it('removes the line of the key on each host with a login that may use only the key, then deletes the key', async () => {
    keyFiles();
    write(authorizedKeys('box'), `ssh-ed25519 AAAAother ann@desk\n${PUBLIC}\nssh-ed25519 ${BLOB} devspaces@old-name\n`);
    // The fake ssh logs in to `cloud` with `-l me`, so its home folder is that of `cloud`.
    write(authorizedKeys('cloud'), `${PUBLIC}\n`);
    const { cleanup, calls, state, logger } = setUp();
    expect(await cleanup.removeSshKey(['box', 'me@cloud'])).toEqual([]);
    expect(fs.readFileSync(authorizedKeys('box'), 'utf8')).toBe('ssh-ed25519 AAAAother ann@desk\n');
    expect(fs.readFileSync(authorizedKeys('cloud'), 'utf8')).toBe('');
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
    write(authorizedKeys('cloud'), `${PUBLIC}\n`);
    // The login with the key works there, but the file step does not (also with "Permission denied" in its text).
    const failure = 'sh: 1: cannot create /home/me/.ssh/authorized_keys.devspaces: Permission denied';
    const { cleanup, state } = setUp({}, (call) =>
      call.file === '/usr/bin/ssh' && call.args.at(-2) === 'box' ? { exitCode: 2, stdout: '', stderr: `${failure}\n`, timedOut: false } : undefined,
    );
    expect(await cleanup.removeSshKey(['box', 'me@cloud'])).toEqual([ComputerCleanupTexts.keyLineLeft('box', failure, keyPath()), ComputerCleanupTexts.keyKept(keyPath())]);
    expect(state.setSshKey.mock.calls).toEqual([['me@cloud', undefined]]);
    expect(fs.existsSync(keyPath())).toBe(true);
    expect(fs.existsSync(`${keyPath()}.pub`)).toBe(true);
  });

  // Mutation: a host that refuses the login with the key counted as a line that stays, so that the key stayed at every
  // run of the command although no run can log in there with it.
  it('deletes the key when a host refuses the login with it, forgets the key for that host, and says to check the file there by hand', async () => {
    keyFiles();
    const { cleanup, state, logger } = setUp({}, (call) =>
      call.file === '/usr/bin/ssh' && call.args.at(-2) === 'box' ? { exitCode: 255, stdout: '', stderr: 'box: Permission denied (publickey).\n', timedOut: false } : undefined,
    );
    expect(await cleanup.removeSshKey(['box'])).toEqual([ComputerCleanupTexts.keyRefused('box', keyPath())]);
    expect(state.setSshKey.mock.calls).toEqual([['box', undefined]]);
    expect(fs.existsSync(keyPath())).toBe(false);
    expect(fs.existsSync(`${keyPath()}.pub`)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(`${ComputerCleanupTexts.keyRefused('box', keyPath())} (box: Permission denied (publickey))`);
    expect(logger.info).toHaveBeenCalledWith(`Devspaces deleted its SSH key ${keyPath()}, if it was there.`);
    expect(ComputerCleanupTexts.keyRefused('box', keyPath())).toContain('box does not accept the SSH key of Devspaces any more');
  });

  // Mutation: the key deleted while its line stays on a host where something of Devspaces stays, so that a new run of
  // the command cannot log in there with it any more.
  it('keeps the key and the line on the hosts where something of Devspaces stays, and removes the line on the others', async () => {
    keyFiles();
    write(authorizedKeys('box'), `${PUBLIC}\n`);
    // The fake ssh logs in to `cloud` with `-l me`, so its home folder is that of `cloud`.
    write(authorizedKeys('cloud'), `${PUBLIC}\n`);
    const { cleanup, calls, state } = setUp();
    expect(await cleanup.removeSshKey(['me@cloud'], ['box'])).toEqual([ComputerCleanupTexts.keyKeptFor(['box'], keyPath())]);
    expect(fs.readFileSync(authorizedKeys('cloud'), 'utf8')).toBe('');
    expect(fs.readFileSync(authorizedKeys('box'), 'utf8')).toBe(`${PUBLIC}\n`);
    expect(calls.filter((call) => call.file === '/usr/bin/ssh').map((call) => call.args.at(-2))).toEqual(['cloud']);
    expect(state.setSshKey.mock.calls).toEqual([['me@cloud', undefined]]);
    expect(fs.existsSync(keyPath())).toBe(true);
    expect(fs.existsSync(`${keyPath()}.pub`)).toBe(true);
    expect(ComputerCleanupTexts.keyKeptFor(['box', 'me@cloud'], keyPath())).toContain('its line on box, me@cloud, where something');
    // Only hosts where something stays: no login at all, the key stays.
    const only = setUp();
    expect(await only.cleanup.removeSshKey([], ['box'])).toEqual([ComputerCleanupTexts.keyKeptFor(['box'], keyPath())]);
    expect(only.calls).toEqual([]);
    expect(fs.existsSync(keyPath())).toBe(true);
  });

  it('keeps the key when the host allows it without a line in ~/.ssh/authorized_keys (another file), and names that', async () => {
    keyFiles();
    const { cleanup, state } = setUp();
    expect(await cleanup.removeSshKey(['box'])).toEqual([ComputerCleanupTexts.keyLineLeft('box', NO_KEY_LINE_TEXT, keyPath()), ComputerCleanupTexts.keyKept(keyPath())]);
    expect(state.setSshKey).not.toHaveBeenCalled();
    expect(fs.existsSync(keyPath())).toBe(true);
  });

  it('names why a line stays: a timeout, no ssh, a host that is no SSH alias or address, a symbolic link', async () => {
    keyFiles();
    const timedOut = setUp({}, (call) => (call.file === '/usr/bin/ssh' ? { exitCode: null, stdout: '', stderr: '', timedOut: true } : undefined));
    expect((await timedOut.cleanup.removeSshKey(['box']))[0]).toBe(ComputerCleanupTexts.keyLineLeft('box', 'ssh did not answer within 30 seconds', keyPath()));
    expect(ComputerCleanupTexts.keyLineLeft('box', 'ssh did not answer within 30 seconds.', keyPath())).toContain('on box (ssh did not answer within 30 seconds). Remove');
    const noSsh = setUp({ sshPath: () => undefined });
    expect((await noSsh.cleanup.removeSshKey(['box']))[0]).toBe(ComputerCleanupTexts.keyLineLeft('box', 'ssh was not found, or the host is no SSH alias or address', keyPath()));
    const option = setUp();
    expect((await option.cleanup.removeSshKey(['-oProxyCommand=x']))[0]).toBe(ComputerCleanupTexts.keyLineLeft('-oProxyCommand=x', 'ssh was not found, or the host is no SSH alias or address', keyPath()));
    // ssh that cannot be started.
    const missing = setUp({}, (call) => {
      if (call.file === '/usr/bin/ssh') throw Object.assign(new Error('spawn /usr/bin/ssh ENOENT'), { code: 'ENOENT' });
      return undefined;
    });
    expect((await missing.cleanup.removeSshKey(['box']))[0]).toBe(ComputerCleanupTexts.keyLineLeft('box', 'spawn /usr/bin/ssh ENOENT', keyPath()));
    expect(option.calls.some((call) => call.file === '/usr/bin/ssh')).toBe(false);
    write(path.join(remoteHome('box'), 'managed'), `${PUBLIC}\n`);
    fs.mkdirSync(path.dirname(authorizedKeys('box')), { recursive: true });
    fs.symlinkSync(path.join(remoteHome('box'), 'managed'), authorizedKeys('box'));
    const link = setUp();
    expect((await link.cleanup.removeSshKey(['box']))[0]).toBe(ComputerCleanupTexts.keyLineLeft('box', '~/.ssh/authorized_keys is a symbolic link', keyPath()));
    expect(fs.readFileSync(path.join(remoteHome('box'), 'managed'), 'utf8')).toBe(`${PUBLIC}\n`);
    expect(fs.existsSync(keyPath())).toBe(true);
  });

  // Mutation: a fallback to the .pub file removes the lines of the key of that file, which need not be the private key
  // that the login uses, and then deletes the key while its line stays.
  it('reads the public key only from the private key, and logs in nowhere and keeps the key when that fails', async () => {
    keyFiles();
    write(authorizedKeys('box'), `${PUBLIC}\n`);
    const failing = setUp({}, (call) => (call.file === '/usr/bin/ssh-keygen' ? { exitCode: 1, stdout: '', stderr: 'invalid format', timedOut: false } : undefined));
    expect(await failing.cleanup.removeSshKey(['box'], ['me@cloud'])).toEqual([
      ComputerCleanupTexts.keyUnreadable(keyPath(), `the key ${keyPath()} could not be read: invalid format`, ['box', 'me@cloud']),
    ]);
    expect(ComputerCleanupTexts.keyUnreadable(keyPath(), 'ssh-keygen was not found on this computer.', ['box', 'me@cloud'])).toBe(
      `The SSH key of Devspaces ${keyPath()} could not be read (ssh-keygen was not found on this computer), so its line stays in ~/.ssh/authorized_keys on box, me@cloud. Remove each line there with the public key of ${keyPath()}.pub; its comment is "devspaces@" and the name of this computer, or a former name of it.`,
    );
    expect(failing.calls.map((call) => call.file)).toEqual(['/usr/bin/ssh-keygen']);
    expect(fs.readFileSync(authorizedKeys('box'), 'utf8')).toBe(`${PUBLIC}\n`);
    expect(fs.existsSync(keyPath())).toBe(true);
    const noKeygen = setUp({ sshKeygenPath: () => undefined });
    expect(await noKeygen.cleanup.removeSshKey(['box'])).toEqual([ComputerCleanupTexts.keyUnreadable(keyPath(), 'ssh-keygen was not found on this computer.', ['box'])]);
    expect(noKeygen.calls).toEqual([]);
  });

  // Mutation: the key deleted after another window added its line on a new host while the command ran.
  it('keeps the key for a host that got its line while the command ran', async () => {
    keyFiles();
    write(authorizedKeys('box'), `${PUBLIC}\n`);
    const { cleanup, state } = setUp();
    state.readStrict.mockImplementationOnce(async () => ({ remoteHosts: ['box'], hosts: [{ host: 'box', sshKey: 'installed' as const }] }));
    state.readStrict.mockImplementationOnce(async () => ({ remoteHosts: ['box', 'new'], hosts: [{ host: 'new', sshKey: 'installed' as const }] }));
    await cleanup.inventory();
    expect(await cleanup.removeSshKey(['box'])).toEqual([ComputerCleanupTexts.keyKeptFor(['new'], keyPath())]);
    expect(fs.existsSync(keyPath())).toBe(true);
    // A list that cannot be read again: the key stays.
    state.readStrict.mockRejectedValueOnce(new Error('EACCES'));
    expect(await cleanup.removeSshKey([])).toEqual([ComputerCleanupTexts.keyKept(keyPath())]);
    expect(fs.existsSync(keyPath())).toBe(true);
  });

  it('only deletes the key files when no host has the line', async () => {
    keyFiles();
    const { cleanup, calls, state } = setUp();
    await state.setSshKey('box', undefined);
    expect(await cleanup.removeSshKey([])).toEqual([]);
    expect(calls).toEqual([]);
    expect(fs.existsSync(keyPath())).toBe(false);
    // Nothing there: nothing to do, no failure.
    expect(await cleanup.removeSshKey([])).toEqual([]);
  });
});
