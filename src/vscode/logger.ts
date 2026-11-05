// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Logger on the output channel "Devspaces" (technical logs only on request).
import * as vscode from 'vscode';
import { CommandError, isUserFacingError } from '../core/errors';
import type { Logger } from '../core/ports';

/** Name of the output channel. */
export const OUTPUT_CHANNEL_NAME = 'Devspaces';

// Security: a GitHub token must never reach the log, also not through the output of a tool.
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/** Replaces GitHub tokens in a text. */
export function redactSecrets(text: string): string {
  return text.replace(TOKEN_PATTERN, '***');
}

/**
 * The control sequences of a terminal, which the output channel shows as they are (`ESC[91m`): a CSI sequence
 * (`ESC [`, parameters, a final character; colors, for example the classic builder of Docker, which marks the error
 * output of a RUN step red), an OSC sequence that ends with BEL or `ESC \` (titles, links), a sequence of ESC,
 * intermediate characters and a final one (`ESC ( B`, the character set), and the other sequences of ESC and one
 * character (`ESC 7`, `ESC =`, `ESC c`; every one but `[` and `]`, which start the sequences before).
 */
const CONTROL_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[ -/]+[0-~]|[0-Z\\^-~])/g;
/**
 * The start of a control sequence (CONTROL_SEQUENCE) at the end of a part of the output: its rest comes with the next
 * part. Two programs whose output goes to the log at the same time can mix their parts; a cut sequence then joins the
 * part of the other program (rare: only a sequence that a part cut, and that program's first characters).
 */
const CUT_CONTROL_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*\u001b?|[ -/]+)$/;
/**
 * A lone ESC at the end of a part of the output is dropped, not held: held, it would take the first character of the
 * next output (`ESC B`), also the one of another program after a program that was stopped.
 */
const LONE_ESCAPE = /\u001b$/;
/** A cut sequence longer than this is no sequence: it is written as it is. */
const MAX_CUT_SEQUENCE = 512;
/**
 * A cut sequence that waited longer than this for its rest is dropped: its program wrote no more (it was stopped), and
 * the next output is another one. A program writes a sequence at once, so its rest comes within milliseconds.
 */
const MAX_CUT_WAIT_MS = 1000;

/** The text without the control sequences of a terminal (CONTROL_SEQUENCE). */
export function stripControlSequences(text: string): string {
  return text.includes('\u001b') ? text.replace(CONTROL_SEQUENCE, '') : text;
}

/**
 * Lines have the form `[HH:MM:SS] info|warn|error message`. `output(text)` appends the raw output of a tool as it is,
 * without the control sequences of a terminal (stripControlSequences), also when a sequence is cut between two parts.
 */
export class OutputChannelLogger implements Logger, vscode.Disposable {
  readonly channel: vscode.OutputChannel;
  private disposed = false;
  /** False while the last raw output did not end with a line break. */
  private atLineStart = true;
  /** The start of a control sequence at the end of the last raw output (CUT_CONTROL_SEQUENCE), not written yet. */
  private cutSequence = '';
  /** When cutSequence was held (Date.now()). */
  private cutAt = 0;

  constructor(name: string = OUTPUT_CHANNEL_NAME) {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string): void {
    this.line('info', message);
  }

  warn(message: string): void {
    this.line('warn', message);
  }

  error(message: string, error?: unknown): void {
    const details = error === undefined ? '' : describeError(error);
    let text = message;
    if (details !== '' && details !== message) text = details.startsWith(`${message}\n`) ? details : `${message}\n${details}`;
    this.line('error', text);
  }

  output(text: string): void {
    if (this.disposed || text === '') return;
    const now = Date.now();
    let whole = this.cutSequence !== '' && now - this.cutAt <= MAX_CUT_WAIT_MS ? this.cutSequence + text : text;
    this.cutSequence = '';
    if (whole.includes('\u001b')) {
      const cut = CUT_CONTROL_SEQUENCE.exec(whole);
      if (cut !== null && cut[0].length <= MAX_CUT_SEQUENCE) {
        this.cutSequence = cut[0];
        this.cutAt = now;
        whole = whole.slice(0, cut.index);
      } else {
        whole = whole.replace(LONE_ESCAPE, '');
      }
    }
    const shown = stripControlSequences(whole);
    if (shown === '') return;
    this.channel.append(redactSecrets(shown));
    this.atLineStart = /[\r\n]$/.test(shown);
  }

  show(): void {
    if (!this.disposed) this.channel.show(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.channel.dispose();
  }

  private line(level: 'info' | 'warn' | 'error', message: string): void {
    if (this.disposed) return;
    // A log line never continues a line of tool output that has no line break at its end. A control sequence that the
    // output cut off stays for the next output, which has its rest.
    const prefix = this.atLineStart ? '' : '\n';
    this.channel.appendLine(`${prefix}[${clockTime(new Date())}] ${level} ${redactSecrets(stripControlSequences(message))}`);
    this.atLineStart = true;
  }
}

function clockTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Technical details of an error for the log: the detail of a UserFacingError, the output of a command, or the stack. */
function describeError(error: unknown): string {
  if (isUserFacingError(error)) {
    return error.detail ? `${error.message}\n${error.detail}` : error.message;
  }
  if (error instanceof CommandError) {
    const output = (error.stderr || error.stdout).trim();
    return output ? `${error.command} failed with exit code ${error.exitCode}:\n${output.slice(-8000)}` : error.message;
  }
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}
