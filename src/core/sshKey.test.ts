// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NO_KEY_LINE_EXIT,
  NO_KEY_LINE_TEXT,
  authorizedKeyPresentCommand,
  authorizedKeysCommand,
  devspacesKeyPath,
  keyComment,
  parsePublicKey,
  removeAuthorizedKeyCommand,
  removeKeyLinesCommand,
  sshWrapper,
} from './sshKey';

const BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIHgJ3c2oQkQe4m4oY0bJ6qNnV6l0Sx5Jm8m2bq9b3n1d';
const KEY = { type: 'ssh-ed25519', blob: BLOB };

describe('the key of Devspaces: its file, its public key and its comment', () => {
  it('is devspaces_ed25519 in the .ssh folder of the home folder', () => {
    expect(devspacesKeyPath('/home/ann', 'linux')).toBe('/home/ann/.ssh/devspaces_ed25519');
    expect(devspacesKeyPath('C:\\Users\\ann', 'win32')).toBe('C:\\Users\\ann\\.ssh\\devspaces_ed25519');
  });

  it('reads an Ed25519 public key from the output of ssh-keygen -y, with or without a comment', () => {
    expect(parsePublicKey(`ssh-ed25519 ${BLOB}\n`)).toEqual(KEY);
    expect(parsePublicKey(`ssh-ed25519 ${BLOB} devspaces@box\r\n`)).toEqual(KEY);
    expect(parsePublicKey(`ssh-rsa ${BLOB}`)).toBeUndefined();
    expect(parsePublicKey(`ssh-ed25519 ${BLOB}'; rm -rf ~`)).toBeUndefined();
    expect(parsePublicKey('Load key: invalid format')).toBeUndefined();
    expect(parsePublicKey('')).toBeUndefined();
  });

  it('names this computer in the comment, with plain characters only', () => {
    expect(keyComment('ann-laptop.local')).toBe('devspaces@ann-laptop.local');
    expect(keyComment("Ann's Mac Book")).toBe('devspaces@AnnsMacBook');
    expect(keyComment('$()')).toBe('devspaces@computer');
  });
});

describe('the command that adds the key to authorized_keys (run by sh in a home folder of the test)', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-ssh-key-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runCommand(command = authorizedKeysCommand(KEY, 'devspaces@box')): string {
    return execFileSync('sh', ['-c', command], { env: { HOME: home, PATH: process.env.PATH }, cwd: os.tmpdir() }).toString();
  }

  const file = (): string => path.join(home, '.ssh', 'authorized_keys');

  it('creates the folder and the file only for the owner, and adds the key once', () => {
    expect(runCommand()).toBe('added\n');
    expect(runCommand()).toBe('');
    expect(fs.readFileSync(file(), 'utf8')).toBe(`ssh-ed25519 ${BLOB} devspaces@box\n`);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(home, '.ssh')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps the keys there, adds a line feed to a last line without one, and adds no key that is there with another comment', () => {
    fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
    fs.writeFileSync(file(), 'ssh-ed25519 AAAAother ann@desk', { mode: 0o644 });
    runCommand();
    expect(fs.readFileSync(file(), 'utf8')).toBe(`ssh-ed25519 AAAAother ann@desk\nssh-ed25519 ${BLOB} devspaces@box\n`);
    // A file mode of the user stays.
    if (process.platform !== 'win32') expect(fs.statSync(file()).mode & 0o777).toBe(0o644);
    fs.writeFileSync(file(), `ssh-ed25519 ${BLOB} renamed@other\n`);
    runCommand();
    expect(fs.readFileSync(file(), 'utf8')).toBe(`ssh-ed25519 ${BLOB} renamed@other\n`);
  });

  it('adds the key when it is only in a comment, and finds it only in a line that is no comment', () => {
    const present = (): boolean => {
      try {
        execFileSync('sh', ['-c', authorizedKeyPresentCommand(KEY)], { env: { HOME: home, PATH: process.env.PATH }, cwd: os.tmpdir() });
        return true;
      } catch {
        return false;
      }
    };
    expect(present()).toBe(false);
    fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
    fs.writeFileSync(file(), `  # ssh-ed25519 ${BLOB} devspaces@box\n`);
    expect(present()).toBe(false);
    runCommand();
    expect(fs.readFileSync(file(), 'utf8')).toBe(`  # ssh-ed25519 ${BLOB} devspaces@box\nssh-ed25519 ${BLOB} devspaces@box\n`);
    expect(present()).toBe(true);
  });

  it('changes neither the folder nor the umask of the shell that runs it', () => {
    const out = execFileSync('sh', ['-c', `umask 022; ${authorizedKeysCommand(KEY, 'devspaces@box')}; umask; pwd`], {
      env: { HOME: home, PATH: process.env.PATH },
      cwd: os.tmpdir(),
    }).toString();
    expect(out.trim().split('\n')).toEqual(['added', '0022', fs.realpathSync(os.tmpdir())]);
  });

  it('removes exactly the line that it added, and keeps the others with the mode of the file', () => {
    fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
    const others = `ssh-ed25519 AAAAother ann@desk\n# ssh-ed25519 ${BLOB} devspaces@box\n`;
    fs.writeFileSync(file(), others, { mode: 0o640 });
    runCommand();
    expect(fs.readFileSync(file(), 'utf8')).toBe(`${others}ssh-ed25519 ${BLOB} devspaces@box\n`);
    runCommand(removeAuthorizedKeyCommand(KEY, 'devspaces@box'));
    expect(fs.readFileSync(file(), 'utf8')).toBe(others);
    if (process.platform !== 'win32') expect(fs.statSync(file()).mode & 0o777).toBe(0o640);
    // No copy stays behind.
    expect(fs.readdirSync(path.join(home, '.ssh'))).toEqual(['authorized_keys']);
    // The only line: an empty file.
    fs.writeFileSync(file(), `ssh-ed25519 ${BLOB} devspaces@box\n`);
    runCommand(removeAuthorizedKeyCommand(KEY, 'devspaces@box'));
    expect(fs.readFileSync(file(), 'utf8')).toBe('');
    // A symbolic link stays as it is.
    fs.writeFileSync(path.join(home, 'managed'), `ssh-ed25519 ${BLOB} devspaces@box\n`);
    fs.rmSync(file());
    fs.symlinkSync(path.join(home, 'managed'), file());
    expect(() => runCommand(removeAuthorizedKeyCommand(KEY, 'devspaces@box'))).toThrow(/is a symbolic link/);
    expect(fs.lstatSync(file()).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(file(), 'utf8')).toBe(`ssh-ed25519 ${BLOB} devspaces@box\n`);
    // No file: it fails and creates none.
    fs.rmSync(file());
    expect(() => runCommand(removeAuthorizedKeyCommand(KEY, 'devspaces@box'))).toThrow();
    expect(fs.existsSync(file())).toBe(false);
  });

  it('removes every line of the key of Devspaces with any comment for the removal from this computer', () => {
    const remove = (): void => void execFileSync('sh', ['-c', removeKeyLinesCommand(KEY)], { env: { HOME: home, PATH: process.env.PATH }, cwd: os.tmpdir(), stdio: 'pipe' });
    const fails = (): { status: number | null; stderr: string } => {
      try {
        remove();
        return { status: 0, stderr: '' };
      } catch (error) {
        const failure = error as { status: number | null; stderr: Buffer };
        return { status: failure.status, stderr: failure.stderr.toString().trim() };
      }
    };
    // Mutation: a file without a line of the key that counts as done, so that the key is deleted while the host still
    // allows it in another way (the login with the key worked). No file: the same, and no file is created.
    expect(fails()).toEqual({ status: NO_KEY_LINE_EXIT, stderr: NO_KEY_LINE_TEXT });
    expect(fs.existsSync(file())).toBe(false);
    fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
    fs.writeFileSync(file(), `ssh-ed25519 AAAAother ann@desk\nfrom="10.0.0.1" ssh-ed25519 ${BLOB} devspaces@box\n`);
    expect(fails()).toEqual({ status: NO_KEY_LINE_EXIT, stderr: NO_KEY_LINE_TEXT });
    expect(fs.readFileSync(file(), 'utf8')).toBe(`ssh-ed25519 AAAAother ann@desk\nfrom="10.0.0.1" ssh-ed25519 ${BLOB} devspaces@box\n`);
    fs.rmSync(file());
    const kept = `ssh-ed25519 AAAAother ann@desk
# ssh-ed25519 ${BLOB} devspaces@box
from="10.0.0.1" ssh-ed25519 ${BLOB} devspaces@box

ssh-ed25519 ${BLOB}x devspaces@box
`;
    fs.writeFileSync(file(), `ssh-ed25519 ${BLOB} devspaces@box
${kept}ssh-ed25519 ${BLOB} devspaces@renamed
ssh-ed25519 ${BLOB}
`, { mode: 0o640 });
    remove();
    expect(fs.readFileSync(file(), 'utf8')).toBe(kept);
    if (process.platform !== 'win32') expect(fs.statSync(file()).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(path.join(home, '.ssh'))).toEqual(['authorized_keys']);
    // A symbolic link stays as it is.
    fs.writeFileSync(path.join(home, 'managed'), `ssh-ed25519 ${BLOB} devspaces@box
`);
    fs.rmSync(file());
    fs.symlinkSync(path.join(home, 'managed'), file());
    expect(remove).toThrow(/is a symbolic link/);
    expect(fs.readFileSync(path.join(home, 'managed'), 'utf8')).toBe(`ssh-ed25519 ${BLOB} devspaces@box
`);
    // Mutation: a folder in place of the file named as a host that allows the key in another way.
    fs.rmSync(file());
    fs.mkdirSync(file());
    expect(fails()).toEqual({ status: 5, stderr: '~/.ssh/authorized_keys is no file' });
  });

  // Mutation: a line without a comment in a file with line ends of Windows has the carriage return in its second field,
  // so that it stays while the key is deleted.
  it('removes the lines of the key from a file with line ends of Windows, also a line without a comment', () => {
    fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
    fs.writeFileSync(file(), `ssh-ed25519 AAAAother ann@desk\r\nssh-ed25519 ${BLOB}\r\nssh-ed25519 ${BLOB} devspaces@box\r\nssh-ed25519 ${BLOB}x\r\n`);
    execFileSync('sh', ['-c', removeKeyLinesCommand(KEY)], { env: { HOME: home, PATH: process.env.PATH }, cwd: os.tmpdir(), stdio: 'pipe' });
    expect(fs.readFileSync(file(), 'utf8')).toBe(`ssh-ed25519 AAAAother ann@desk\r\nssh-ed25519 ${BLOB}x\r\n`);
  });

  it('fails when the file cannot be written', () => {
    fs.mkdirSync(path.join(home, '.ssh', 'authorized_keys'), { recursive: true });
    expect(() => runCommand()).toThrow();
  });
});

describe('the wrapper ssh of the Docker CLI', () => {
  it('is a batch file on Windows that gives -i and the key before the arguments', () => {
    expect(sshWrapper('win32')).toEqual({
      fileName: 'ssh.cmd',
      text: '@echo off\r\n"%DEVSPACES_SSH%" -i "%DEVSPACES_SSH_IDENTITY%" %*\r\n',
    });
  });

  it.skipIf(process.platform === 'win32')('is a shell script elsewhere that runs ssh with -i and the key before the arguments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-ssh-wrapper-'));
    try {
      const wrapper = sshWrapper('linux');
      expect(wrapper.fileName).toBe('ssh');
      const file = path.join(dir, wrapper.fileName);
      fs.writeFileSync(file, wrapper.text, { mode: 0o700 });
      // A fake ssh that prints its arguments, one per line.
      const fake = path.join(dir, 'fake ssh');
      fs.writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o700 });
      const out = execFileSync(file, ['-o', 'ConnectTimeout=30', '-T', '--', 'box', 'docker system dial-stdio'], {
        env: { PATH: process.env.PATH, DEVSPACES_SSH: fake, DEVSPACES_SSH_IDENTITY: '/home/ann/.ssh/devspaces_ed25519' },
      }).toString();
      expect(out.split('\n').slice(0, -1)).toEqual(['-i', '/home/ann/.ssh/devspaces_ed25519', '-o', 'ConnectTimeout=30', '-T', '--', 'box', 'docker system dial-stdio']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
