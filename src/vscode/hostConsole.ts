// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Open Console of a host row of the view Docker Hosts (docs/requirements.md R-ENG-008): a terminal of VS Code with a
// login shell on the host (core/hosts/hostConsole.ts). The extension serves the terminal itself (vscode.Pseudoterminal),
// because a terminal that VS Code starts runs on the remote computer in a remote window, and the console must start
// its program on this computer, as every connection of Devspaces to a host does. The setting
// devspaces.dockerHostsConsoleButton shows the button; a click while it is off opens nothing.
import * as vscode from 'vscode';
import { hostAccessOf, isVmHost } from '../core/docker/dockerHost';
import { errorMessage } from '../core/errors';
import { ConsoleTtyMark, DEFAULT_CONSOLE_SIZE, consoleSize, type ConsoleSize } from '../core/hosts/hostConsole';
import type { Logger, StartedByteProcess } from '../core/ports';
import { hostOfArgument } from './dockerHostsModel';
import { showInformationMessage } from './notifications';

export const HostConsoleTexts = {
  name: (host: string) => (isVmHost(host) ? 'Console: VM of Devspaces' : `Console: ${host}`),
  off: 'Open Console is off: turn on the setting devspaces.dockerHostsConsoleButton to open a console on a host.',
  noHost: 'Open Console opens a console on a host row of the view Docker Hosts.',
  opening: (host: string) => `Opening a console on ${isVmHost(host) ? 'the VM of Devspaces' : host}…`,
  noTransport: (host: string) =>
    hostAccessOf(host)?.kind === 'wsl'
      ? 'The console cannot open: wsl.exe is not found.'
      : `The console cannot open: ssh is not found${hostAccessOf(host) === undefined ? `, or ${host} is no SSH address` : ''}.`,
  ended: (exitCode: number | null) => `The console ended${exitCode === null ? '' : ` with the exit code ${exitCode}`}. Press any key to close the terminal.`,
};

/** How long a console waits for the size of its terminal before it starts with DEFAULT_CONSOLE_SIZE. */
const SIZE_WAIT_MS = 500;
/** How long a change of the size waits for the next one before it is set on the host (a drag sends many). */
const RESIZE_DELAY_MS = 300;

export interface HostConsolesDeps {
  logger: Logger;
  /** Whether the setting devspaces.dockerHostsConsoleButton is on. */
  allowed(): boolean;
  /**
   * Starts the program of the console of `host` with a terminal of `size` on the host: undefined when the host has no
   * transport. `signal` aborts when the terminal closes (the questions of an SSH login in VS Code end with it).
   */
  start(host: string, size: ConsoleSize, signal: AbortSignal): StartedByteProcess | undefined;
  /** Starts a program that sets the size of the terminal `tty` on `host` and asks nothing; undefined when it cannot. */
  resize(host: string, tty: string, size: ConsoleSize): StartedByteProcess | undefined;
  /** Only for the tests. */
  sizeWaitMs?: number;
  resizeDelayMs?: number;
}

/** The command Open Console (devspaces.openConsole) of a host row. */
export class HostConsoles {
  constructor(private readonly deps: HostConsolesDeps) {}

  async open(argument: unknown): Promise<void> {
    if (!this.deps.allowed()) {
      this.inform(HostConsoleTexts.off);
      return;
    }
    const host = hostOfArgument(argument);
    if (host === undefined) {
      this.inform(HostConsoleTexts.noHost);
      return;
    }
    this.deps.logger.info(`Open Console: a console on ${host}.`);
    const terminal = vscode.window.createTerminal({ name: HostConsoleTexts.name(host), pty: new HostConsole(host, this.deps), iconPath: new vscode.ThemeIcon('terminal') });
    terminal.show();
  }

  private inform(message: string): void {
    showInformationMessage(message).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }
}

/**
 * The terminal of one console: its program starts with the size of the terminal (or DEFAULT_CONSOLE_SIZE after
 * SIZE_WAIT_MS), the keys go to it, and its output comes back without the mark of the start script. A later change of
 * the size is set on the host once the mark named the terminal there. When the program ends with the exit code 0 (the
 * user ended the shell), the terminal closes; otherwise it says how it ended, and the next key closes it. A close of
 * the terminal stops the program.
 */
export class HostConsole implements vscode.Pseudoterminal {
  private readonly writes = new vscode.EventEmitter<string>();
  private readonly closes = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writes.event;
  readonly onDidClose = this.closes.event;
  private readonly abort = new AbortController();
  private readonly mark = new ConsoleTtyMark();
  private readonly decoder = new TextDecoder('utf-8');
  private process: StartedByteProcess | undefined;
  private size: ConsoleSize = DEFAULT_CONSOLE_SIZE;
  /** The size that is set on the host (the start, or the last resize). */
  private sizeOnHost: ConsoleSize | undefined;
  private started = false;
  private ended = false;
  private closed = false;
  private sizeTimer: ReturnType<typeof setTimeout> | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: string,
    private readonly deps: Pick<HostConsolesDeps, 'logger' | 'start' | 'resize' | 'sizeWaitMs' | 'resizeDelayMs'>,
  ) {}

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    if (initialDimensions !== undefined) this.start(consoleSize(initialDimensions.columns, initialDimensions.rows));
    else this.sizeTimer = setTimeout(() => this.start(DEFAULT_CONSOLE_SIZE), this.deps.sizeWaitMs ?? SIZE_WAIT_MS);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    const size = consoleSize(dimensions.columns, dimensions.rows);
    if (!this.started) {
      this.start(size);
      return;
    }
    this.size = size;
    this.scheduleResize();
  }

  handleInput(data: string): void {
    if (this.ended) {
      this.finish();
      return;
    }
    this.process?.write(Buffer.from(data, 'utf8'));
  }

  /** The user closed the terminal. */
  close(): void {
    this.closed = true;
    this.clearTimers();
    this.abort.abort();
    this.process?.kill();
  }

  private start(size: ConsoleSize): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.clearTimers();
    this.size = size;
    this.sizeOnHost = size;
    this.write(`\u001b[2m${HostConsoleTexts.opening(this.host)}\u001b[0m\r\n`);
    let process: StartedByteProcess | undefined;
    try {
      process = this.deps.start(this.host, size, this.abort.signal);
    } catch (error) {
      this.deps.logger.warn(`Open Console: the console on ${this.host} did not start: ${errorMessage(error)}`);
      this.end(null, errorMessage(error));
      return;
    }
    if (process === undefined) {
      this.end(null, HostConsoleTexts.noTransport(this.host));
      return;
    }
    this.process = process;
    process.onStdout(
      (chunk) => {
        const hadTty = this.mark.tty !== undefined;
        this.write(this.mark.take(this.decoder.decode(chunk, { stream: true })));
        if (!hadTty && this.mark.tty !== undefined && !sameSize(this.size, this.sizeOnHost)) this.scheduleResize();
      },
      () => this.write(this.mark.flush() + this.decoder.decode()),
    );
    let stderr = false;
    process.onStderr((text) => {
      stderr = true;
      this.write(text.replace(/\r?\n/g, '\r\n'));
    });
    void process.exited.then(({ exitCode, error }) => {
      this.process = undefined;
      this.deps.logger.info(`Open Console: the console on ${this.host} ended${exitCode === null ? '' : ` with the exit code ${exitCode}`}${error !== undefined ? `: ${errorMessage(error)}` : ''}.`);
      if (exitCode === 0) this.finish();
      // A program that did not start says why only in its error (a deferred start wrote it as its error output).
      else this.end(exitCode, error !== undefined && !stderr ? errorMessage(error) : undefined);
    });
  }

  /** The program ended or never started: the reason, how it ended, and the next key closes the terminal. */
  private end(exitCode: number | null, reason?: string): void {
    if (this.closed) return;
    this.ended = true;
    this.clearTimers();
    if (reason !== undefined) this.write(`${reason.replace(/\r?\n/g, '\r\n')}\r\n`);
    this.write(`\r\n\u001b[2m${HostConsoleTexts.ended(exitCode)}\u001b[0m\r\n`);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.closes.fire();
  }

  private scheduleResize(): void {
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.resizeNow();
    }, this.deps.resizeDelayMs ?? RESIZE_DELAY_MS);
  }

  private resizeNow(): void {
    const tty = this.mark.tty;
    if (tty === undefined || this.ended || this.closed || this.process === undefined || sameSize(this.size, this.sizeOnHost)) return;
    const size = this.size;
    let resize: StartedByteProcess | undefined;
    try {
      resize = this.deps.resize(this.host, tty, size);
    } catch (error) {
      this.deps.logger.warn(`Open Console: the size of the console on ${this.host} was not set: ${errorMessage(error)}`);
      return;
    }
    if (resize === undefined) return;
    this.sizeOnHost = size;
    let stderr = '';
    resize.onStdout(
      () => undefined,
      () => undefined,
    );
    resize.onStderr((text) => {
      stderr += text;
    });
    resize.end();
    void resize.exited.then(({ exitCode, error }) => {
      if (exitCode === 0) return;
      // The size stays as it was: a later change tries again.
      if (sameSize(this.sizeOnHost, size)) this.sizeOnHost = undefined;
      this.deps.logger.info(`Open Console: the size of the console on ${this.host} was not set (exit code ${exitCode ?? 'none'}): ${(error !== undefined ? errorMessage(error) : stderr).trim()}`);
    });
  }

  private write(text: string): void {
    if (text !== '' && !this.closed) this.writes.fire(text);
  }

  private clearTimers(): void {
    if (this.sizeTimer !== undefined) clearTimeout(this.sizeTimer);
    if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
    this.sizeTimer = undefined;
    this.resizeTimer = undefined;
  }
}

function sameSize(a: ConsoleSize | undefined, b: ConsoleSize | undefined): boolean {
  return a !== undefined && b !== undefined && a.columns === b.columns && a.rows === b.rows;
}
