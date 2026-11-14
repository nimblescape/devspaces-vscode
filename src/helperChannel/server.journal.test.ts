// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The journal of the channel script, which goes into the log of a worker (protocol.ts "The log of a worker", R-ENG-010):
// each operation with its name and its result, the log messages of the operations as they are sent (masked), and why
// the worker ends; never the parameters, the secrets, the output or a name of an operation that it does not know.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_SILENCE_EXIT_MS, encodeMessage, type ClientMessage } from '../core/helperChannel/protocol';
import { abortError } from '../core/ports';
import { ChannelServer, OperationError, type OperationHandler } from './server';

const SECRET = 'ghp_secretTOKEN123';

function setup(operations: Record<string, OperationHandler>, journal: (text: string) => void) {
  const server = new ChannelServer({ write: () => true, operations, exit: () => {}, journal });
  server.start();
  const send = (message: ClientMessage) => server.input(encodeMessage(message));
  return { server, send };
}

describe('the journal of the channel script', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-11-14T07:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('notes each operation with its result and time, and the log messages of the operations, masked', async () => {
    const entries: string[] = [];
    let release!: () => void;
    const { send } = setup(
      {
        works: async (_params, context) => {
          context.log(`pulled the image with ${SECRET}`);
          context.log('the registry is slow', 'warn');
          context.output('stdout', `output ${SECRET}\n`);
          await new Promise<void>((resolve) => (release = resolve));
          return { token: SECRET };
        },
        fails: async () => {
          throw new OperationError('failed', `the registry said: bad credentials ${SECRET}`);
        },
      },
      (text) => entries.push(text),
    );
    send({ t: 'op', id: 1, op: 'works', params: { repository: 'acme/private-repo', path: '/secret/place' }, secrets: { token: SECRET } });
    await vi.advanceTimersByTimeAsync(2500);
    release();
    await vi.advanceTimersByTimeAsync(0);
    send({ t: 'op', id: 2, op: 'fails', params: null, secrets: { token: SECRET } });
    await vi.advanceTimersByTimeAsync(0);
    expect(entries).toEqual([
      '#1 works started.',
      '#1 works: pulled the image with ***',
      '#1 works warning: the registry is slow',
      '#1 works ended after 2.5 s.',
      '#2 fails started.',
      '#2 fails failed after 0.0 s: failed: the registry said: bad credentials ***',
    ]);
    const all = entries.join('\n');
    for (const hidden of [SECRET, 'acme/private-repo', '/secret/place', 'output']) expect(all).not.toContain(hidden);
  });

  it('notes a cancel, a time limit, an operation that it does not know (without its name), and why the worker ends', async () => {
    const entries: string[] = [];
    const waits: OperationHandler = (_params, context) =>
      new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(abortError()), { once: true }));
    const { send, server } = setup({ waits }, (text) => entries.push(text));
    send({ t: 'op', id: 1, op: 'waits', params: null });
    send({ t: 'cancel', id: 1 });
    send({ t: 'op', id: 2, op: 'waits', params: null, timeoutMs: 1000 });
    send({ t: 'op', id: 3, op: 'secretlyNamedOperation', params: null });
    await vi.advanceTimersByTimeAsync(1000);
    server.inputEnded();
    server.inputEnded();
    await vi.advanceTimersByTimeAsync(0);
    expect(entries).toEqual([
      '#1 waits started.',
      '#2 waits started.',
      '#3 was refused: the helper does not know its operation.',
      '#1 waits was cancelled (after 0.0 s).',
      '#2 waits did not end in time (after 1.0 s).',
      'The worker ends: its input ended: the connection closed.',
    ]);
    expect(entries.join('\n')).not.toContain('secretlyNamedOperation');
  });

  it('notes the end after the silence of the extension', async () => {
    const entries: string[] = [];
    setup({}, (text) => entries.push(text));
    await vi.advanceTimersByTimeAsync(CHANNEL_SILENCE_EXIT_MS);
    expect(entries).toEqual([`The worker ends: no message came for ${Math.round(CHANNEL_SILENCE_EXIT_MS / 1000)} s.`]);
  });

  it('goes on when the journal fails', async () => {
    const results: unknown[] = [];
    const server = new ChannelServer({
      write: (text) => {
        for (const line of text.split('\n').filter((part) => part !== '')) results.push(JSON.parse(line));
        return true;
      },
      operations: { works: async (_params, context) => (context.log('a message'), 'done') },
      exit: () => {},
      journal: () => {
        throw new Error('the disk is full');
      },
    });
    server.start();
    server.input(encodeMessage({ t: 'op', id: 1, op: 'works', params: null }));
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([
      { t: 'log', id: 1, level: 'info', text: 'a message' },
      { t: 'result', id: 1, ok: true, value: 'done' },
    ]);
  });
});
