// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The connection attempts of the programs of the tests that download VS Code (scripts/connectAttempts.mjs): Node.js
// gives up a slow IPv4 connection after 250 ms when the IPv6 address of the host fails at once, as on the runners of
// GitHub Actions, and allowSlowConnects keeps such a connection waiting. A slow connection is made with a listener of
// another process whose queue of connections is full: Linux then drops each new SYN packet, so a connection to it stays
// in its connection attempt. The host has its IPv4 address first and then ::1, where nothing listens.
import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONNECT_ATTEMPT_MS, allowSlowConnects } from '../scripts/connectAttempts.mjs';

/**
 * A listener on 127.0.0.1 with room for one connection in its queue, in a process whose event loop then sleeps for
 * 60 s, so that it accepts no connection. It writes its port.
 */
const LISTENER = `const server = require('net').createServer();
server.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => {
  process.stdout.write(server.address().port + '\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
});`;

/** The two addresses of the host, IPv4 first, as the runners of GitHub get them. */
const lookup: net.LookupFunction = (_hostname, _options, callback) => {
  callback(null, [
    { address: '127.0.0.1', family: 4 },
    { address: '::1', family: 6 },
  ]);
};

/** How a connection to `port` of the host ends within `waitMs`: the error code, `connected`, or `connecting`. */
function connectOutcome(port: number, waitMs: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: 'slow.invalid', port, lookup });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('connecting');
    }, waitMs);
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code ?? String(error));
    });
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('connected');
    });
  });
}

/** Whether a connection to 127.0.0.1:`port` still waits for its SYN answer after `waitMs`. */
function staysConnecting(port: number, waitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('error', () => undefined);
    setTimeout(() => {
      resolve(socket.connecting);
      socket.destroy();
    }, waitMs);
  });
}

describe.runIf(process.platform === 'linux')('the connection attempts of the programs that download VS Code', () => {
  const defaultAttemptMs = net.getDefaultAutoSelectFamilyAttemptTimeout();
  let listener: ChildProcess | undefined;
  const fill: net.Socket[] = [];
  let port = 0;

  beforeEach(async () => {
    listener = spawn(process.execPath, ['-e', LISTENER], { stdio: ['ignore', 'pipe', 'inherit'] });
    port = await new Promise<number>((resolve, reject) => {
      listener?.stdout?.once('data', (data: Buffer) => resolve(Number(String(data).trim())));
      listener?.once('error', reject);
    });
    // Connections without an answer until the queue is full: then a new connection stays in its attempt.
    for (let round = 0; round < 10 && !(await staysConnecting(port, 500)); round++) {
      for (let index = 0; index < 4; index++) fill.push(net.connect({ host: '127.0.0.1', port }).on('error', () => undefined));
    }
    expect(await staysConnecting(port, 500)).toBe(true);
  }, 30_000);

  afterEach(() => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(defaultAttemptMs);
    for (const socket of fill.splice(0)) socket.destroy();
    listener?.kill();
  });

  it('by default, Node.js gives up the slow IPv4 connection after its short attempt time and fails with ETIMEDOUT', async () => {
    expect(defaultAttemptMs).toBeLessThan(CONNECT_ATTEMPT_MS);
    expect(await connectOutcome(port, 5_000)).toBe('ETIMEDOUT');
  }, 15_000);

  it(`after allowSlowConnects, the slow IPv4 connection keeps waiting (up to ${CONNECT_ATTEMPT_MS} ms)`, async () => {
    allowSlowConnects();
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_MS);
    expect(await connectOutcome(port, 1_500)).toBe('connecting');
  }, 15_000);
});
