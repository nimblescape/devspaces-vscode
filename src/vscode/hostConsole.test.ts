// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Open Console of a host row of the view Docker Hosts (docs/requirements.md R-ENG-008): only with its setting and a host
// row; the terminal of the extension starts the program of the console with the size of the terminal, carries the keys
// and the output (without the mark of the start script), sets a new size on the host, and closes as a terminal does.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { LIMA_HOST } from '../core/docker/dockerHost';
import type { ConsoleSize } from '../core/hosts/hostConsole';
import type { StartedByteProcess } from '../core/ports';
import { HostConsole, HostConsoleTexts, HostConsoles, type HostConsolesDeps } from './hostConsole';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };

/** A program of the console: what it got, and the controls of its output and its end. */
interface FakeProcess {
  process: StartedByteProcess;
  written: string[];
  ended: boolean;
  killed: number;
  stdout(text: string | Buffer): void;
  stderr(text: string): void;
  exit(exitCode: number | null): void;
}

function fakeProcess(): FakeProcess {
  let onStdout: (chunk: Buffer) => void = () => undefined;
  let onStdoutEnd: () => void = () => undefined;
  let onStderr: (text: string) => void = () => undefined;
  let finish: (exit: { exitCode: number | null }) => void = () => undefined;
  const fake: FakeProcess = {
    written: [],
    ended: false,
    killed: 0,
    process: {
      write: (chunk) => fake.written.push(chunk.toString('utf8')) > 0,
      onDrain: () => undefined,
      end: () => {
        fake.ended = true;
      },
      kill: () => {
        fake.killed++;
      },
      onStdout: (listener, onEnd) => {
        onStdout = listener;
        onStdoutEnd = onEnd;
      },
      pauseStdout: () => undefined,
      resumeStdout: () => undefined,
      onStderr: (listener) => {
        onStderr = listener;
      },
      exited: new Promise((resolve) => (finish = resolve)),
    },
    stdout: (text) => onStdout(typeof text === 'string' ? Buffer.from(text, 'utf8') : text),
    stderr: (text) => onStderr(text),
    exit: (exitCode) => {
      onStdoutEnd();
      finish({ exitCode });
    },
  };
  return fake;
}

interface Harness {
  deps: HostConsolesDeps;
  starts: Array<{ host: string; size: ConsoleSize; signal: AbortSignal; fake: FakeProcess }>;
  resizes: Array<{ host: string; tty: string; size: ConsoleSize; fake: FakeProcess }>;
  allowed: boolean;
  noTransport: boolean;
}

function harness(): Harness {
  const h: Harness = { starts: [], resizes: [], allowed: true, noTransport: false } as unknown as Harness;
  h.deps = {
    logger,
    allowed: () => h.allowed,
    start: (host, size, signal) => {
      if (h.noTransport) return undefined;
      const fake = fakeProcess();
      h.starts.push({ host, size, signal, fake });
      return fake.process;
    },
    resize: (host, tty, size) => {
      const fake = fakeProcess();
      h.resizes.push({ host, tty, size, fake });
      return fake.process;
    },
    sizeWaitMs: 20,
    resizeDelayMs: 10,
  };
  return h;
}

/** A terminal of a console, with what it wrote and whether it closed. */
function terminal(h: Harness, host = 'lab'): { pty: HostConsole; output: () => string; closed: () => number } {
  const pty = new HostConsole(host, h.deps);
  const writes: string[] = [];
  let closed = 0;
  pty.onDidWrite((text) => writes.push(text));
  pty.onDidClose(() => closed++);
  return { pty, output: () => writes.join(''), closed: () => closed };
}

const MARK = (tty: string): string => `\u001b]7717;devspaces-tty=${tty}\u0007`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
});

describe('HostConsoles', () => {
  it('opens a terminal of the extension with the name of the host, only with the setting and a host row', async () => {
    const h = harness();
    const consoles = new HostConsoles(h.deps);
    await consoles.open({ hostsNode: 'host', host: 'lab', vm: false, selected: false });
    expect(fakeVscode.terminals).toHaveLength(1);
    expect(fakeVscode.terminals[0]).toMatchObject({ name: 'Console: lab', shown: 1 });
    expect(fakeVscode.terminals[0].pty).toBeInstanceOf(HostConsole);
    await consoles.open({ hostsNode: 'host', host: LIMA_HOST, vm: true, selected: true });
    expect(fakeVscode.terminals[1].name).toBe('Console: VM of Devspaces');
    // No host row (a key binding): it says where the command works.
    await consoles.open(undefined);
    await consoles.open({ hostsNode: 'object', host: 'lab' });
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(HostConsoleTexts.noHost);
    // The setting is off: nothing opens, and it says why.
    h.allowed = false;
    await consoles.open({ hostsNode: 'host', host: 'lab', vm: false, selected: false });
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(HostConsoleTexts.off);
    expect(fakeVscode.terminals).toHaveLength(2);
  });
});

describe('HostConsole', () => {
  it('starts with the size of the terminal, carries the keys and the output without the mark, and closes after `exit`', async () => {
    const h = harness();
    const t = terminal(h);
    t.pty.open({ columns: 120, rows: 30 });
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]).toMatchObject({ host: 'lab', size: { columns: 120, rows: 30 } });
    expect(t.output()).toContain(HostConsoleTexts.opening('lab'));
    const { fake } = h.starts[0];
    fake.stdout(`Linux lab 6.1\r\n${MARK('/dev/pts/4')}me@lab:~$ `);
    expect(t.output()).toContain('Linux lab 6.1\r\nme@lab:~$ ');
    expect(t.output()).not.toContain('devspaces-tty');
    t.pty.handleInput('ls\r');
    t.pty.handleInput('\u0003');
    expect(fake.written).toEqual(['ls\r', '\u0003']);
    // The errors of ssh itself get the line ends of a terminal.
    fake.stderr('Warning: Permanently added lab\nsecond line\n');
    expect(t.output()).toContain('Warning: Permanently added lab\r\nsecond line\r\n');
    fake.exit(0);
    await settle();
    expect(t.closed()).toBe(1);
  });

  it('decodes a character whose bytes come in two parts', () => {
    const h = harness();
    const t = terminal(h);
    t.pty.open({ columns: 80, rows: 24 });
    const bytes = Buffer.from('a€b', 'utf8');
    h.starts[0].fake.stdout(bytes.subarray(0, 2));
    h.starts[0].fake.stdout(bytes.subarray(2));
    expect(t.output()).toContain('a€b');
    expect(t.output()).not.toContain('\ufffd');
  });

  it('says how the program ended when it fails, and the next key closes the terminal', async () => {
    const h = harness();
    const t = terminal(h);
    t.pty.open({ columns: 80, rows: 24 });
    h.starts[0].fake.stderr('ssh: connect to host lab port 22: Connection refused\n');
    h.starts[0].fake.exit(255);
    await settle();
    expect(t.output()).toContain('ssh: connect to host lab port 22: Connection refused\r\n');
    expect(t.output()).toContain(HostConsoleTexts.ended(255));
    expect(t.closed()).toBe(0);
    t.pty.handleInput('x');
    expect(t.closed()).toBe(1);
    expect(h.starts[0].fake.written).toEqual([]);
    expect(h.starts[0].fake.killed).toBe(0);
  });

  it('says that the console cannot open when the host has no transport', () => {
    const h = harness();
    h.noTransport = true;
    const t = terminal(h, 'wsl:devspaces');
    t.pty.open({ columns: 80, rows: 24 });
    expect(t.output()).toContain(HostConsoleTexts.noTransport('wsl:devspaces'));
    expect(t.output()).toContain(HostConsoleTexts.ended(null));
    t.pty.handleInput('\r');
    expect(t.closed()).toBe(1);
  });

  it('stops the program and ends the questions of its login when the user closes the terminal', async () => {
    const h = harness();
    const t = terminal(h);
    t.pty.open({ columns: 80, rows: 24 });
    const { fake, signal } = h.starts[0];
    t.pty.close();
    expect(fake.killed).toBe(1);
    expect(signal.aborted).toBe(true);
    fake.exit(null);
    await settle();
    // VS Code closed the terminal itself: no onDidClose and no more output.
    expect(t.closed()).toBe(0);
    expect(t.output()).not.toContain('The console ended');
  });

  it('waits for the size of the terminal before it starts, else starts with 80 x 24', async () => {
    const h = harness();
    const t = terminal(h);
    t.pty.open(undefined);
    expect(h.starts).toHaveLength(0);
    t.pty.setDimensions({ columns: 100, rows: 50 });
    expect(h.starts[0].size).toEqual({ columns: 100, rows: 50 });
    await wait(40);
    expect(h.starts).toHaveLength(1);
    const late = terminal(h, 'other');
    late.pty.open(undefined);
    await wait(40);
    expect(h.starts[1]).toMatchObject({ host: 'other', size: { columns: 80, rows: 24 } });
  });

  it('sets a new size on the host once the mark named its terminal, only the last of several changes', async () => {
    const h = harness();
    const t = terminal(h);
    t.pty.open({ columns: 80, rows: 24 });
    const { fake } = h.starts[0];
    // Before the mark, the size waits.
    t.pty.setDimensions({ columns: 90, rows: 24 });
    await wait(30);
    expect(h.resizes).toHaveLength(0);
    // The mark comes: the size that changed meanwhile is set.
    fake.stdout(`${MARK('/dev/pts/4')}$ `);
    await wait(30);
    expect(h.resizes).toHaveLength(1);
    expect(h.resizes[0]).toMatchObject({ host: 'lab', tty: '/dev/pts/4', size: { columns: 90, rows: 24 } });
    expect(h.resizes[0].fake.ended).toBe(true);
    h.resizes[0].fake.exit(0);
    // A drag: only the last size is set.
    for (const columns of [91, 92, 93, 94]) t.pty.setDimensions({ columns, rows: 30 });
    await wait(30);
    expect(h.resizes).toHaveLength(2);
    expect(h.resizes[1].size).toEqual({ columns: 94, rows: 30 });
    h.resizes[1].fake.exit(0);
    await settle();
    // The same size again sets nothing.
    t.pty.setDimensions({ columns: 94, rows: 30 });
    await wait(30);
    expect(h.resizes).toHaveLength(2);
  });

  it('tries a size again after a resize that failed (a remote host without the key of Devspaces), and logs why', async () => {
    const h = harness();
    const t = terminal(h);
    t.pty.open({ columns: 80, rows: 24 });
    h.starts[0].fake.stdout(MARK('/dev/pts/4'));
    t.pty.setDimensions({ columns: 100, rows: 24 });
    await wait(30);
    h.resizes[0].fake.stderr('me@lab: Permission denied (publickey,password).\n');
    h.resizes[0].fake.exit(255);
    await settle();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Permission denied (publickey,password).'));
    t.pty.setDimensions({ columns: 100, rows: 24 });
    await wait(30);
    expect(h.resizes).toHaveLength(2);
  });

  it('sets no size without the mark (a host whose terminal has another name), and none after the end', async () => {
    const h = harness();
    const t = terminal(h);
    t.pty.open({ columns: 80, rows: 24 });
    h.starts[0].fake.stdout(`${MARK('/dev/ttys004')}% `);
    expect(t.output()).toContain('% ');
    t.pty.setDimensions({ columns: 100, rows: 24 });
    await wait(30);
    expect(h.resizes).toHaveLength(0);
    h.starts[0].fake.exit(1);
    await settle();
    t.pty.setDimensions({ columns: 110, rows: 24 });
    await wait(30);
    expect(h.resizes).toHaveLength(0);
  });
});
