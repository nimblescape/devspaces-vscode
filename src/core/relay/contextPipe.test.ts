// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The pipe of the Docker context `devspaces`: with real Unix sockets in place of the named pipe of Windows, two windows
// at one address, and the engine a socket server that answers each request.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Duplex } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger, type Logger } from '../ports';
import { ContextPipe } from './contextPipe';
import { contextPipeAddress, dockerPipeAddress, parseDockerPipeHost } from './pipeAddress';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function base(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'context-pipe-'));
  cleanups.push(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function logger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { ...silentLogger, lines, info: (message) => lines.push(`info ${message}`), warn: (message) => lines.push(`warn ${message}`) };
}

/** An engine that answers each connection with `name` and closes it. */
function engine(name: string): (connection: Duplex) => Promise<void> {
  return async (connection) => {
    connection.on('data', () => connection.end(`HTTP/1.1 200 OK\r\nContent-Length: ${name.length}\r\n\r\n${name}`));
  };
}

function ask(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ path: socketPath });
    let answer = '';
    client.on('data', (chunk: Buffer) => (answer += chunk.toString()));
    client.on('end', () => resolve(answer.split('\r\n\r\n')[1] ?? ''));
    client.on('error', reject);
    client.write('GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\n');
  });
}

function contextPipe(address: ReturnType<typeof dockerPipeAddress>, name: string, log: Logger = silentLogger, retryMs = 60_000): ContextPipe {
  const pipe = new ContextPipe({ logger: log, address, connect: engine(name), retryMs });
  cleanups.push(() => pipe.stop());
  return pipe;
}

describe('the address of the pipe of the Docker context on Windows', () => {
  it('is one fixed named pipe per Windows user, never the pipe of a window', () => {
    const ada = contextPipeAddress('PC\\ada');
    expect(ada).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), path: `\\\\.\\pipe\\devspaces-context-${ada.id}`, dockerHost: `npipe:////./pipe/devspaces-context-${ada.id}` });
    expect(contextPipeAddress('pc\\ADA')).toEqual(ada);
    expect(contextPipeAddress('PC\\grace').id).not.toBe(ada.id);
    expect(parseDockerPipeHost(ada.dockerHost, 'win32')).toBeUndefined();
  });
});

describe('the pipe of the Docker context', () => {
  it('lets every request through to the engine while one window serves it; a second window waits', async () => {
    const address = dockerPipeAddress('0123456789abcdef', 'linux', base());
    const log = logger();
    const first = contextPipe(address, 'first');
    await first.serve();
    expect(first.isServing()).toBe(true);
    expect(await ask(address.path)).toBe('first');
    const second = contextPipe(address, 'second', log);
    await second.serve();
    expect(second.isServing()).toBe(false);
    expect(log.lines.filter((line) => line.includes('does not serve the pipe'))).toHaveLength(1);
    expect(await ask(address.path)).toBe('first');
  });

  it('takes over at its next try after the window that served it stopped, and logs the wait once', async () => {
    const address = dockerPipeAddress('0123456789abcdef', 'linux', base());
    const log = logger();
    const first = contextPipe(address, 'first');
    await first.serve();
    const second = contextPipe(address, 'second', log, 50);
    await second.serve();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(second.isServing()).toBe(false);
    first.stop();
    await vi.waitFor(() => expect(second.isServing()).toBe(true), { timeout: 2000, interval: 20 });
    expect(await ask(address.path)).toBe('second');
    expect(log.lines.filter((line) => line.includes('does not serve the pipe'))).toHaveLength(1);
  });

  it('closes the pipe at stop, also when stop comes while it starts to listen, and tries no more', async () => {
    const address = dockerPipeAddress('0123456789abcdef', 'linux', base());
    const close = vi.fn();
    let resolveListen: (pipe: { close: () => void; isServing: () => boolean }) => void = () => undefined;
    const listen = vi.fn(() => new Promise<{ close: () => void; isServing: () => boolean }>((resolve) => (resolveListen = resolve)));
    const pipe = new ContextPipe({ logger: silentLogger, address, connect: engine('x'), listen, retryMs: 10 });
    const serving = pipe.serve();
    pipe.stop();
    resolveListen({ close, isServing: () => true });
    await serving;
    expect(close).toHaveBeenCalledTimes(1);
    expect(pipe.isServing()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it('listens once for calls at the same time, and not again while it serves', async () => {
    const address = dockerPipeAddress('0123456789abcdef', 'linux', base());
    const listen = vi.fn(async () => ({ close: vi.fn(), isServing: () => true }));
    const pipe = new ContextPipe({ logger: silentLogger, address, connect: engine('x'), listen });
    await Promise.all([pipe.serve(), pipe.serve()]);
    await pipe.serve();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith(expect.objectContaining({ address, inUseWaitMs: 0, name: 'the Docker context devspaces' }));
    expect(listen.mock.calls[0]).not.toHaveProperty('0.requests');
    pipe.stop();
  });
});
