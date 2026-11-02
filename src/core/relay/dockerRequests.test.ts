// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The parser of the requests of a Docker pipe connection, and the filtered connection with real Unix sockets: the
// client a socket, the engine a server that answers each request.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerRequestParser, FilteredConnection, dockerRequestPath, refusalResponse, requestText, type DockerRequest, type ParsedBytes, type RefusedDockerRequest } from './dockerRequests';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Allows every request except those to /forbidden, and records each one. */
function recordingRule(): { seen: string[]; rule: (request: DockerRequest) => string | undefined } {
  const seen: string[] = [];
  return {
    seen,
    rule: (request) => {
      seen.push(`${request.method} ${request.path}`);
      return request.path.startsWith('/forbidden') ? 'it is forbidden' : undefined;
    },
  };
}

/** The bytes that `parsed` lets go on, as text. */
function text(parsed: ParsedBytes): string {
  return Buffer.concat(parsed.forward).toString('latin1');
}

describe('dockerRequestPath', () => {
  it('removes the version of the API and the query, and keeps the escapes', () => {
    expect(dockerRequestPath('/v1.47/containers/json?all=1')).toBe('/containers/json');
    expect(dockerRequestPath('/_ping')).toBe('/_ping');
    expect(dockerRequestPath('/v1.47/images/a%2Fb/json')).toBe('/images/a%2Fb/json');
    // Only a version in front of a path.
    expect(dockerRequestPath('/v1.47')).toBe('/v1.47');
    expect(dockerRequestPath('http://engine/_ping')).toBeUndefined();
    expect(dockerRequestPath('*')).toBeUndefined();
  });

  it('names a request in a log line with printable characters only, and shortened', () => {
    expect(requestText({ method: 'GET', path: '/a\u0000b' })).toBe('GET /a?b');
    expect(requestText({ method: 'GET', path: `/${'x'.repeat(300)}` })).toHaveLength(201);
  });
});

describe('DockerRequestParser', () => {
  it('checks each request of a connection, also when its head comes in pieces', () => {
    const { seen, rule } = recordingRule();
    const parser = new DockerRequestParser(rule);
    const requests = 'HEAD /_ping HTTP/1.1\r\nHost: api.moby.localhost\r\n\r\nGET /v1.47/containers/json?all=1 HTTP/1.1\r\nHost: x\r\n\r\n';
    let forwarded = '';
    for (const byte of Buffer.from(requests)) forwarded += text(parser.push(Buffer.from([byte])));
    expect(forwarded).toBe(requests);
    expect(seen).toEqual(['HEAD /_ping', 'GET /containers/json']);
  });

  it('passes a body with a length as it is, and checks the request after it', () => {
    const { seen, rule } = recordingRule();
    const parser = new DockerRequestParser(rule);
    // The body looks like a request: it is not one.
    const body = 'GET /forbidden HTTP/1.1\r\n\r\n';
    const first = `POST /containers/abc/exec HTTP/1.1\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    expect(text(parser.push(Buffer.from(first)))).toBe(first);
    const second = parser.push(Buffer.from('GET /forbidden/too HTTP/1.1\r\n\r\n'));
    expect(text(second)).toBe('');
    expect(second.refused).toEqual({ method: 'GET', path: '/forbidden/too', reason: 'it is forbidden' });
    expect(seen).toEqual(['POST /containers/abc/exec', 'GET /forbidden/too']);
  });

  it('passes a chunked body with extensions and trailers, and checks the request after it', () => {
    const { seen, rule } = recordingRule();
    const parser = new DockerRequestParser(rule);
    const request = 'PUT /containers/abc/archive HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5;name=x\r\nhello\r\n0\r\nX-Trailer: 1\r\n\r\n';
    let forwarded = '';
    for (const piece of [request.slice(0, 60), request.slice(60, 75), request.slice(75)]) forwarded += text(parser.push(Buffer.from(piece)));
    expect(forwarded).toBe(request);
    const next = parser.push(Buffer.from('GET /forbidden HTTP/1.1\r\n\r\n'));
    expect(next.refused?.path).toBe('/forbidden');
    expect(seen).toEqual(['PUT /containers/abc/archive', 'GET /forbidden']);
  });

  it('lets nothing of a refused request and nothing after it go on', () => {
    const parser = new DockerRequestParser(recordingRule().rule);
    const parsed = parser.push(Buffer.from('GET /_ping HTTP/1.1\r\n\r\nPOST /forbidden HTTP/1.1\r\nContent-Length: 2\r\n\r\nxxGET /_ping HTTP/1.1\r\n\r\n'));
    expect(text(parsed)).toBe('GET /_ping HTTP/1.1\r\n\r\n');
    expect(parsed.refused?.method).toBe('POST');
    expect(parser.push(Buffer.from('GET /_ping HTTP/1.1\r\n\r\n')).forward).toEqual([]);
  });

  it.each([
    ['two lengths', 'POST /a HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n', 'the request has two content-length headers'],
    ['a length and a transfer coding', 'POST /a HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n', 'the request has a length and a transfer coding'],
    ['another transfer coding', 'POST /a HTTP/1.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\n', 'the transfer coding gzip, chunked is not supported'],
    ['a length that is no number', 'POST /a HTTP/1.1\r\nContent-Length: +1\r\n\r\n', 'the length of the request is not valid'],
    ['no HTTP/1 request', 'PRI * HTTP/2.0\r\n\r\n', 'the request is no HTTP/1 request'],
    ['a target that is no path', 'GET http://engine/_ping HTTP/1.1\r\n\r\n', 'the target of the request is no path'],
    ['a header with a space in its name', 'GET /a HTTP/1.1\r\nContent Length: 1\r\n\r\n', 'a header of the request is not valid'],
    ['a header line without a name', 'GET /a HTTP/1.1\r\n folded\r\n\r\n', 'a header of the request is not valid'],
    ['an exec without Upgrade', 'POST /exec/abc/start HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}', 'the request takes the connection over without an Upgrade header'],
    ['a chunked takeover', 'POST /exec/abc/start HTTP/1.1\r\nUpgrade: tcp\r\nTransfer-Encoding: chunked\r\n\r\n', 'a request that takes the connection over must have a length'],
  ])('refuses a request with %s', (_name, request, reason) => {
    const parsed = new DockerRequestParser(() => undefined).push(Buffer.from(request));
    expect(parsed.forward).toEqual([]);
    expect(parsed.refused?.reason).toBe(reason);
  });

  it('refuses a head that is too long, also before its end came', () => {
    const parser = new DockerRequestParser(() => undefined);
    const parsed = parser.push(Buffer.from(`GET /a HTTP/1.1\r\nX: ${'x'.repeat(70 * 1024)}`));
    expect(parsed.refused?.reason).toBe('the head of the request is too long');
  });

  it('holds the bytes after a takeover until the engine answers 101, then lets every byte go on', () => {
    const parser = new DockerRequestParser(recordingRule().rule);
    const request = 'POST /v1.47/exec/abc/start HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 2\r\n\r\n{}';
    expect(text(parser.push(Buffer.from(`${request}early input`)))).toBe(request);
    expect(parser.awaitingAnswer).toBe(true);
    expect(parser.holding).toBe(true);
    expect(text(parser.answer(true))).toBe('early input');
    expect(parser.passthrough).toBe(true);
    // The input of the program: no request, also when it looks like one.
    expect(text(parser.push(Buffer.from('GET /forbidden HTTP/1.1\r\n\r\n')))).toBe('GET /forbidden HTTP/1.1\r\n\r\n');
  });

  it('ends the direction of the client when the engine refuses a takeover', () => {
    const parser = new DockerRequestParser(recordingRule().rule);
    parser.push(Buffer.from('POST /exec/abc/start HTTP/1.1\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n'));
    // The bytes of a client that does not wait for the answer: a request that the filter would refuse.
    expect(parser.push(Buffer.from('GET /forbidden HTTP/1.1\r\n\r\n')).forward).toEqual([]);
    expect(parser.answer(false)).toEqual({ forward: [], end: true });
    expect(parser.push(Buffer.from('GET /_ping HTTP/1.1\r\n\r\n')).forward).toEqual([]);
  });

  it('applies an answer that came before the end of the body of the takeover after that body', () => {
    const parser = new DockerRequestParser(recordingRule().rule);
    parser.push(Buffer.from('POST /exec/abc/start HTTP/1.1\r\nUpgrade: tcp\r\nContent-Length: 4\r\n\r\n{'));
    expect(parser.answer(false)).toEqual({ forward: [] });
    const rest = parser.push(Buffer.from('"a"GET /forbidden HTTP/1.1\r\n\r\n'));
    expect(rest).toEqual({ forward: [Buffer.from('"a"')], end: true });
  });

  it('treats any request with an Upgrade header as a takeover, and the answer 200 as a refusal', () => {
    const parser = new DockerRequestParser(() => undefined);
    parser.push(Buffer.from('GET /containers/json HTTP/1.1\r\nUpgrade: tcp\r\n\r\n'));
    expect(parser.awaitingAnswer).toBe(true);
    expect(parser.answer(false).end).toBe(true);
  });
});

describe('FilteredConnection', () => {
  function folder(): string {
    const created = fs.mkdtempSync(path.join(os.tmpdir(), 'filter-'));
    cleanups.push(() => fs.rmSync(created, { recursive: true, force: true }));
    return created;
  }

  /**
   * A pipe whose connections are filtered by `rule` and go to `engine` (a socket per connection, which the test answers),
   * and a client: the bytes that the engine got and the refusals.
   */
  async function setup(
    engine: (socket: net.Socket, received: () => string) => void,
    rule: (request: DockerRequest) => string | undefined = recordingRule().rule,
  ): Promise<{ client: net.Socket; engineGot: () => string; refusals: RefusedDockerRequest[]; closed: Promise<void> }> {
    const dir = folder();
    const enginePath = path.join(dir, 'engine.sock');
    let got = '';
    const engineServer = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.on('data', (chunk: Buffer) => (got += chunk.toString('latin1')));
      engine(socket, () => got);
    });
    await new Promise<void>((resolve) => engineServer.listen(enginePath, resolve));
    cleanups.push(() => engineServer.close());
    const refusals: RefusedDockerRequest[] = [];
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
    const pipePath = path.join(dir, 'pipe.sock');
    const pipeServer = net.createServer({ allowHalfOpen: true }, (socket) => {
      const connection = new FilteredConnection(socket, rule, 'devspaces-acme-api', (request) => refusals.push(request), 1_000);
      connection.on('close', () => resolveClosed());
      const upstream = net.connect({ path: enginePath, allowHalfOpen: true });
      cleanups.push(() => upstream.destroy());
      upstream.on('error', () => {});
      connection.pipe(upstream);
      upstream.pipe(connection);
      connection.on('close', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => pipeServer.listen(pipePath, resolve));
    cleanups.push(() => pipeServer.close());
    const client = net.connect({ path: pipePath, allowHalfOpen: true });
    client.on('error', () => {});
    cleanups.push(() => client.destroy());
    return { client, engineGot: () => got, refusals, closed };
  }

  /** All that the client reads until the connection closes; the client ends its direction at the end of the other, as a Docker client does. */
  function readAll(client: net.Socket): Promise<string> {
    return new Promise((resolve) => {
      let answer = '';
      client.on('data', (chunk: Buffer) => (answer += chunk.toString('latin1')));
      client.on('end', () => client.end());
      client.on('close', () => resolve(answer));
    });
  }

  it('passes an allowed request and its answer', async () => {
    const { client, engineGot } = await setup((socket, received) =>
      socket.on('data', () => {
        if (received().endsWith('\r\n\r\n')) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');
      }),
    );
    const answer = readAll(client);
    client.end('GET /_ping HTTP/1.1\r\n\r\n');
    await expect(answer).resolves.toBe('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');
    expect(engineGot()).toBe('GET /_ping HTTP/1.1\r\n\r\n');
  });

  it('answers a refused request with 403 and closes, and the engine gets nothing of it', async () => {
    const { client, engineGot, refusals, closed } = await setup((socket) =>
      socket.on('data', () => socket.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n')),
    );
    const answer = readAll(client);
    client.write('GET /_ping HTTP/1.1\r\n\r\n');
    await vi.waitFor(() => expect(engineGot()).toBe('GET /_ping HTTP/1.1\r\n\r\n'));
    client.write('DELETE /forbidden/x HTTP/1.1\r\n\r\n');
    const body = JSON.stringify({ message: 'Devspaces does not allow DELETE /forbidden/x through the Docker pipe of devspaces-acme-api: it is forbidden.' });
    // The client keeps its direction open: the pipe closes the connection itself.
    await expect(answer).resolves.toBe(`HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n${refusalResponse(JSON.parse(body).message as string).toString()}`);
    await closed;
    expect(engineGot()).toBe('GET /_ping HTTP/1.1\r\n\r\n');
    expect(refusals).toEqual([{ method: 'DELETE', path: '/forbidden/x', reason: 'it is forbidden' }]);
  });

  it('lets the input of a program go on after the engine took the connection over', async () => {
    const { client, engineGot } = await setup((socket, received) =>
      socket.on('data', () => {
        if (received().endsWith('{}')) socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
        if (received().endsWith('exit\n')) socket.end('bye');
      }),
    );
    const answer = readAll(client);
    client.write('POST /exec/abc/start HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 2\r\n\r\n{}');
    await vi.waitFor(() => expect(engineGot()).toContain('{}'));
    client.end('GET /forbidden HTTP/1.1\r\n\r\nexit\n');
    await expect(answer).resolves.toBe('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nbye');
    expect(engineGot()).toBe('POST /exec/abc/start HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 2\r\n\r\n{}GET /forbidden HTTP/1.1\r\n\r\nexit\n');
  });

  it('passes the input that a client sent before the answer 101, and its end after it', async () => {
    const { client, engineGot } = await setup((socket, received) => {
      socket.on('data', () => {
        if (received().endsWith('{}')) setTimeout(() => socket.write('HTTP/1.1 101 UPGRADED\r\n\r\n'), 50);
      });
      socket.on('end', () => socket.end(`got ${received().length} bytes`));
    });
    const answer = readAll(client);
    const request = 'POST /exec/abc/start HTTP/1.1\r\nUpgrade: tcp\r\nContent-Length: 2\r\n\r\n{}';
    client.end(`${request}early input`);
    await expect(answer).resolves.toBe(`HTTP/1.1 101 UPGRADED\r\n\r\ngot ${request.length + 'early input'.length} bytes`);
    expect(engineGot()).toBe(`${request}early input`);
  });

  it('ends the direction to the engine when the engine refused a takeover', async () => {
    let engineEnded = false;
    const { client, engineGot } = await setup((socket, received) => {
      socket.on('data', () => {
        if (received().endsWith('\r\n\r\n')) socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\nNO');
      });
      socket.on('end', () => {
        engineEnded = true;
        socket.end();
      });
    });
    const answer = readAll(client);
    client.write('POST /exec/missing/start HTTP/1.1\r\nUpgrade: tcp\r\n\r\n');
    await vi.waitFor(() => expect(engineEnded).toBe(true));
    client.end('DELETE /containers/abc HTTP/1.1\r\n\r\n');
    await expect(answer).resolves.toBe('HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\nNO');
    expect(engineGot()).toBe('POST /exec/missing/start HTTP/1.1\r\nUpgrade: tcp\r\n\r\n');
  });
});
