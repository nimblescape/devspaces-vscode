// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The console of a host of the view Docker Hosts (docs/requirements.md R-ENG-008): the arguments of its programs, its
// start script (also run in a real `sh`, with and without a terminal), the command that sets its size, and the mark
// with the name of its terminal, also when it comes in parts.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import { limaPaths, limaSshConfigFile } from '../vm/limaInstance';
import {
  ConsoleTtyMark,
  DEFAULT_CONSOLE_SIZE,
  consoleResizeCommand,
  consoleScript,
  consoleSize,
  limaConsoleArgs,
  sshConsoleArgs,
  wslConsoleArgs,
  wslConsoleResizeArgs,
} from './hostConsole';

const MARK = (tty: string): string => `\u001b]7717;devspaces-tty=${tty}\u0007`;
const SIZE = { columns: 132, rows: 40 };

describe('consoleSize', () => {
  it('takes whole numbers from 1 to 1000, and the default for a value that is no number', () => {
    expect(consoleSize(132, 40)).toEqual({ columns: 132, rows: 40 });
    expect(consoleSize(0, -3)).toEqual({ columns: 1, rows: 1 });
    expect(consoleSize(5000, 1e9)).toEqual({ columns: 1000, rows: 1000 });
    expect(consoleSize(80.6, 23.4)).toEqual({ columns: 81, rows: 23 });
    expect(consoleSize(Number.NaN, Number.POSITIVE_INFINITY)).toEqual(DEFAULT_CONSOLE_SIZE);
  });
});

describe('consoleScript', () => {
  it('sets TERM and the size, writes the mark, and runs the login shell; it has no double quote for wsl.exe', () => {
    const script = consoleScript(SIZE);
    expect(script).toContain('TERM=xterm-256color; export TERM');
    expect(script).toContain('stty rows 40 cols 132 2>/dev/null');
    expect(script).toContain(`printf '\\033]7717;devspaces-tty=%s\\007' $(tty)`);
    expect(script.endsWith('exec ${SHELL:-/bin/sh} -l')).toBe(true);
    expect(script).not.toContain('"');
    // A size from outside is clamped before it goes into the script.
    expect(consoleScript({ columns: Number.NaN, rows: 1e6 })).toContain('stty rows 1000 cols 80 ');
  });

  it('runs in sh without a terminal: no mark with a name, and the login shell of SHELL with -l', () => {
    const result = spawnSync('/bin/sh', ['-c', consoleScript(SIZE)], { env: { PATH: process.env.PATH, SHELL: '/bin/echo' }, encoding: 'utf8' });
    const mark = new ConsoleTtyMark();
    const shown = mark.take(result.stdout);
    expect(mark.tty).toBeUndefined();
    // `echo -l` prints "-l": the script ended with the login shell.
    expect(shown.trim().endsWith('-l')).toBe(true);
  });

  it.runIf(process.platform === 'linux' && fs.existsSync('/usr/bin/script'))('runs in a terminal of `script` (as in the WSL distribution): the mark names the terminal, and the size is set', () => {
    // The login shell here prints the size of its terminal instead of a prompt; `script` runs its command with it (-c).
    const folder = fs.mkdtempSync('/tmp/console-');
    const shell = `${folder}/shell`;
    fs.writeFileSync(shell, '#!/bin/sh\nif [ "$1" = -c ]; then exec /bin/sh "$@"; fi\nstty size\n', { mode: 0o755 });
    try {
      const args = wslConsoleArgs('devspaces', SIZE);
      const result = spawnSync(args[5], args.slice(6), { env: { PATH: process.env.PATH, SHELL: shell }, encoding: 'utf8', input: '' });
      const mark = new ConsoleTtyMark();
      const shown = mark.take(result.stdout) + mark.flush();
      expect(mark.tty).toMatch(/^\/dev\/pts\/\d+$/);
      expect(shown).not.toContain('devspaces-tty');
      expect(shown).toContain('40 132');
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('the arguments of the programs of the console', () => {
  it('ssh: a terminal on the host, the start script in /bin/sh as one word for any login shell, the key, the port and the user', () => {
    const args = sshConsoleArgs({ host: 'lab.example.org', port: 2222, user: 'me' }, SIZE, { prompts: false, identity: '/keys/devspaces' });
    expect(args).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      '-tt',
      '-i',
      '/keys/devspaces',
      '-p',
      '2222',
      '-l',
      'me',
      '--',
      'lab.example.org',
      `/bin/sh -c '${consoleScript(SIZE).replace(/'/g, `'\\''`)}'`,
    ]);
    // The command that the login shell gets runs the script unchanged.
    const result = spawnSync('/bin/sh', ['-c', `${args.at(-1)!.replace('/bin/sh -c', 'printf %s')}`], { encoding: 'utf8' });
    expect(result.stdout).toBe(consoleScript(SIZE));
  });

  it('ssh with the questions of a login in VS Code: no BatchMode, and no X11 forwarding', () => {
    const args = sshConsoleArgs({ host: 'lab' }, SIZE, { prompts: true });
    expect(args.slice(0, 4)).toEqual(['-x', '-o', 'ConnectTimeout=15', '-tt']);
    expect(args).not.toContain('BatchMode=yes');
    expect(args.slice(-2, -1)).toEqual(['lab']);
  });

  it('wsl.exe: the user of `wsl -d devspaces` in its home folder, with a terminal of `script`', () => {
    const args = wslConsoleArgs('devspaces', SIZE);
    expect(args).toEqual(['-d', 'devspaces', '--cd', '~', '--exec', 'script', '-qfec', `/bin/sh -c '${consoleScript(SIZE).replace(/'/g, `'\\''`)}'`, '/dev/null']);
    // No double quote, which the command line of wsl.exe on Windows would have to escape.
    expect(args.join(' ')).not.toContain('"');
  });

  it('Lima: the SSH configuration of Lima, without questions, a terminal on the VM, as the user of Lima', () => {
    const paths = limaPaths('/home/me');
    const args = limaConsoleArgs(paths, SIZE);
    expect(args.slice(0, 6)).toEqual(['-F', limaSshConfigFile(paths), '-o', 'BatchMode=yes', '-tt', 'lima-devspaces']);
    expect(args[6]).toMatch(/^\/bin\/sh -c '/);
    expect(args.join(' ')).not.toContain('sudo');
  });
});

describe('consoleResizeCommand', () => {
  it('sets the size with `stty` on the terminal as its input, only for a terminal of a Linux host', () => {
    expect(consoleResizeCommand('/dev/pts/3', SIZE)).toBe('stty rows 40 cols 132 < /dev/pts/3');
    for (const tty of ['/dev/pts/3; rm -rf /', '/dev/tty1', 'not', '/dev/pts/', '/dev/pts/12345678', '']) expect(consoleResizeCommand(tty, SIZE), tty).toBeUndefined();
    expect(wslConsoleResizeArgs('devspaces', 'stty rows 40 cols 132 < /dev/pts/3')).toEqual(['-d', 'devspaces', '-u', 'root', '--cd', '/', '--exec', 'sh', '-c', 'stty rows 40 cols 132 < /dev/pts/3']);
  });
});

describe('ConsoleTtyMark', () => {
  it('takes the mark out of the output and names the terminal', () => {
    const mark = new ConsoleTtyMark();
    expect(mark.take(`motd\r\n${MARK('/dev/pts/7')}root@host:~# `)).toBe('motd\r\nroot@host:~# ');
    expect(mark.tty).toBe('/dev/pts/7');
    // After the mark, the output goes through unchanged, also a second mark.
    expect(mark.take(MARK('/dev/pts/9'))).toBe(MARK('/dev/pts/9'));
    expect(mark.tty).toBe('/dev/pts/7');
  });

  it('finds the mark when the output comes in parts, at every place of a cut', () => {
    const output = `Welcome\r\n${MARK('/dev/pts/12')}$ ls\r\n`;
    for (let cut = 0; cut <= output.length; cut++) {
      for (let second = cut; second <= output.length; second++) {
        const mark = new ConsoleTtyMark();
        const shown = mark.take(output.slice(0, cut)) + mark.take(output.slice(cut, second)) + mark.take(output.slice(second)) + mark.flush();
        expect(shown, `${cut}/${second}`).toBe('Welcome\r\n$ ls\r\n');
        expect(mark.tty).toBe('/dev/pts/12');
      }
    }
  });

  it('takes out a mark whose name is no terminal, without a name', () => {
    const mark = new ConsoleTtyMark();
    expect(mark.take(`${MARK('not')}${MARK('a')}`)).toBe(MARK('a'));
    expect(mark.tty).toBeUndefined();
  });

  it('lets an escape sequence that only starts as the mark through, and stops looking after 64 KiB', () => {
    const mark = new ConsoleTtyMark();
    expect(mark.take('\u001b]0;title\u0007$ ')).toBe('\u001b]0;title\u0007$ ');
    expect(mark.take('\u001b]77')).toBe('');
    expect(mark.take('x')).toBe('\u001b]77x');
    const late = new ConsoleTtyMark();
    const big = 'a'.repeat(64 * 1024 + 1);
    expect(late.take(big)).toBe(big);
    expect(late.take(MARK('/dev/pts/1'))).toBe(MARK('/dev/pts/1'));
    expect(late.tty).toBeUndefined();
    // A mark without its end gives its output back at the end.
    const open = new ConsoleTtyMark();
    expect(open.take(`$ \u001b]7717;devspaces-tty=/dev/pts/1`)).toBe('$ ');
    expect(open.flush()).toBe('\u001b]7717;devspaces-tty=/dev/pts/1');
  });
});
