// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The console of a host of the view Docker Hosts (docs/requirements.md R-ENG-008): a login shell on the host itself, not
// in a container. The extension runs on this computer, also in a remote window, so the program of the console runs here
// and gets no terminal of this computer: `ssh -tt` for an SSH host, `wsl.exe … script` for the WSL distribution of
// Devspaces, and the SSH of Lima (`-tt`) for its VM. Each gets a terminal on the host. The start script (consoleScript)
// sets the modes of that terminal as on a terminal of this computer (an `ssh -tt` whose input is no terminal can send
// the modes of no terminal: every mode off, so no echo, no Ctrl+C, and no carriage return before a new line), its
// size, and writes its name with an OSC sequence (ConsoleTtyMark), so that a later change of the size can be set from a
// second connection that asks nothing (consoleResizeCommand). No `vscode`.
import { sshCommandArgs, wslCommandArgs, type SshAddress } from '../docker/dockerHost';
import { LIMA_SSH_HOST, limaSshConfigFile, type LimaPaths } from '../vm/limaInstance';

/** The size of the terminal of a console: its columns and its rows. */
export interface ConsoleSize {
  columns: number;
  rows: number;
}

/** The size before VS Code names one (a terminal that is not shown yet). */
export const DEFAULT_CONSOLE_SIZE: ConsoleSize = { columns: 80, rows: 24 };

/** A size of whole numbers from 1 to 1000 (VS Code gives whole numbers; the script must never get anything else). */
export function consoleSize(columns: number, rows: number): ConsoleSize {
  const clamp = (value: number, fallback: number): number => (Number.isFinite(value) ? Math.min(1000, Math.max(1, Math.round(value))) : fallback);
  return { columns: clamp(columns, DEFAULT_CONSOLE_SIZE.columns), rows: clamp(rows, DEFAULT_CONSOLE_SIZE.rows) };
}

/** The OSC code of the mark: no terminal uses it, so a terminal that gets the mark shows nothing of it. */
const TTY_MARK_START = '\u001b]7717;devspaces-tty=';
const TTY_MARK_END = '\u0007';
/** The name of a terminal on a Linux host, the only one that a resize uses (it goes into a command line). */
const TTY_NAME = /^\/dev\/pts\/\d{1,6}$/;
/** After this much output without a whole mark, the console stops looking for it. */
const TTY_MARK_SEARCH_LIMIT = 64 * 1024;

/**
 * The modes of the terminal on the host, as a terminal of this computer has them: `stty sane` (echo, Ctrl+C and the
 * other control keys, a carriage return before each new line of the output, and Enter as a new line), UTF-8 input,
 * Ctrl+S and Ctrl+Q, and a speed. An `ssh -tt` whose input is a pipe sends the modes of no terminal when it goes
 * through a connection that it shares (ControlMaster, as the SSH configuration of Lima has it): every mode off and
 * the speed 0. A host whose `stty` does not know one of the extra modes still gets `stty sane`.
 */
const TERMINAL_MODES = 'stty sane iutf8 ixon 38400 2>/dev/null || stty sane 2>/dev/null';

/**
 * The start script of the console, for `sh` (POSIX): TERM of the terminal of VS Code, the modes (TERMINAL_MODES) and
 * the size of the terminal on the host, the mark with its name, and then the login shell of the account (SHELL, else
 * the account database, else `/bin/sh`). The script has no double quote, so that the command line of `wsl.exe` on
 * Windows carries it unchanged.
 */
export function consoleScript(size: ConsoleSize): string {
  const { columns, rows } = consoleSize(size.columns, size.rows);
  return [
    'TERM=xterm-256color',
    'export TERM',
    TERMINAL_MODES,
    `stty rows ${rows} cols ${columns} 2>/dev/null`,
    `printf '\\033]7717;devspaces-tty=%s\\007' $(tty)`,
    "case $SHELL in '') SHELL=$(getent passwd $(id -u) 2>/dev/null | cut -d: -f7);; esac",
    'exec ${SHELL:-/bin/sh} -l',
  ].join('; ');
}

/** `value` as one word for a POSIX shell, and for csh and fish, which take the same single quotes. */
function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command for the shell of the account on the host (an SSH host, or `script` in the WSL distribution): `/bin/sh` runs
 * the start script, whatever its login shell is. It has no double quote either.
 */
function remoteConsoleCommand(size: ConsoleSize): string {
  return `/bin/sh -c ${shellWord(consoleScript(size))}`;
}

/**
 * The arguments of `ssh` for the console of an SSH host: a terminal on the host (`-tt`), the key of Devspaces when the
 * host has it, and with `prompts` the questions of the login in VS Code (sshCommandArgs).
 */
export function sshConsoleArgs(target: SshAddress, size: ConsoleSize, options: { prompts: boolean; identity?: string }): string[] {
  return sshCommandArgs(target, remoteConsoleCommand(size), undefined, { prompts: options.prompts, identity: options.identity, terminal: true });
}

/**
 * The arguments of `wsl.exe` for the console of the WSL distribution `distribution`: the user of `wsl -d devspaces`
 * (root, vm/rootfs/etc/wsl.conf) in its home folder, with a terminal of `script` (util-linux) in the distribution.
 * `script` runs its command with SHELL, so the command is the one of an SSH host: `/bin/sh` runs the start script.
 */
export function wslConsoleArgs(distribution: string, size: ConsoleSize): string[] {
  return ['-d', distribution, '--cd', '~', '--exec', 'script', '-qfec', remoteConsoleCommand(size), '/dev/null'];
}

/**
 * The arguments of `ssh` for the console of the Lima VM of Devspaces: the SSH configuration of Lima (its key, the port
 * on this computer), without questions, a terminal on the VM (`-tt`), as the user of Lima, as `limactl shell` does.
 */
export function limaConsoleArgs(paths: LimaPaths, size: ConsoleSize): string[] {
  return ['-F', limaSshConfigFile(paths), '-o', 'BatchMode=yes', '-tt', LIMA_SSH_HOST, remoteConsoleCommand(size)];
}

/**
 * The command that sets the size of the terminal `tty` on the host (`stty` on it as its standard input), for a second
 * connection to the host; undefined for a name that is no terminal of a Linux host.
 */
export function consoleResizeCommand(tty: string, size: ConsoleSize): string | undefined {
  if (!TTY_NAME.test(tty)) return undefined;
  const { columns, rows } = consoleSize(size.columns, size.rows);
  return `stty rows ${rows} cols ${columns} < ${tty}`;
}

/** The arguments of `wsl.exe` that run consoleResizeCommand as root (wslCommandArgs). */
export function wslConsoleResizeArgs(distribution: string, command: string): string[] {
  return wslCommandArgs(distribution, ['sh', '-c', command]);
}

/**
 * Takes the mark of the start script out of the output of the console, also when it comes in parts: `tty` names the
 * terminal on the host once the mark came. Before it, a part at the end that may start the mark waits for the next
 * output. After the mark, or after TTY_MARK_SEARCH_LIMIT of output without it, the output goes through unchanged.
 */
export class ConsoleTtyMark {
  tty: string | undefined;
  private pending = '';
  private seen = 0;
  private done = false;

  /** The output for the terminal of VS Code. */
  take(text: string): string {
    if (this.done) return text;
    const input = this.pending + text;
    this.pending = '';
    this.seen += text.length;
    const start = input.indexOf(TTY_MARK_START);
    if (start >= 0) {
      const end = input.indexOf(TTY_MARK_END, start + TTY_MARK_START.length);
      if (end >= 0) {
        const name = input.slice(start + TTY_MARK_START.length, end);
        if (TTY_NAME.test(name)) this.tty = name;
        this.done = true;
        return input.slice(0, start) + input.slice(end + TTY_MARK_END.length);
      }
      if (this.seen > TTY_MARK_SEARCH_LIMIT) return this.stop(input);
      this.pending = input.slice(start);
      return input.slice(0, start);
    }
    if (this.seen > TTY_MARK_SEARCH_LIMIT) return this.stop(input);
    for (let length = Math.min(TTY_MARK_START.length - 1, input.length); length > 0; length--) {
      if (TTY_MARK_START.startsWith(input.slice(input.length - length))) {
        this.pending = input.slice(input.length - length);
        return input.slice(0, input.length - length);
      }
    }
    return input;
  }

  /** The output that waits for the rest of the mark, at the end of the console. */
  flush(): string {
    return this.stop('');
  }

  private stop(input: string): string {
    this.done = true;
    const rest = this.pending + input;
    this.pending = '';
    return rest;
  }
}
