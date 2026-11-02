// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The requests of the Docker API on one connection of a Docker pipe (dockerPipe.ts), for the filter of the pipe of a
// window (windowPipeRequests.ts): an HTTP/1.1 parser that follows the requests that a client sends one after the other
// on the connection (keep-alive), with their bodies (a length, or chunked), and decides about each request before any
// byte of it goes on. A request that takes the connection over (an exec or an attach: `Upgrade`) holds the next bytes
// of the client until the answer of the engine: after `101` they are those of the program in the container and go on
// as they come; after any other answer the connection takes no further request. No `vscode`.
import type * as net from 'net';
import { Duplex } from 'stream';

/** One request of a Docker client: its method and its path without the version of the API and without the query. */
export interface DockerRequest {
  method: string;
  path: string;
}

/** A request that the filter refused, and why. */
export type RefusedDockerRequest = DockerRequest & { reason: string };

/**
 * Decides about one request: undefined lets it go on, a text refuses it for that reason. `headers` has the names in
 * lower case.
 */
export type DockerRequestRule = (request: DockerRequest, headers: ReadonlyMap<string, string>) => string | undefined;

/** The most bytes of the head of one request (request line and headers); a longer head is refused. */
export const MAX_REQUEST_HEAD_BYTES = 64 * 1024;
/** The most bytes of one line of a chunked body that names the size of its chunk. */
const MAX_CHUNK_LINE_BYTES = 1024;
/** The most bytes of the start of the answer of the engine to a takeover that are read to find its status line. */
const MAX_STATUS_LINE_BYTES = 1024;
/** How long a refused connection may take to read its answer before it is closed. */
export const REFUSED_CLOSE_MS = 5_000;

/** What the parser gives back for the bytes that came: the bytes that go on, and what happens with the connection. */
export interface ParsedBytes {
  forward: Buffer[];
  /** The request that is refused; nothing of it, and nothing after it, goes on. */
  refused?: RefusedDockerRequest;
  /** The direction of the client ends after `forward`: the engine refused a takeover. */
  end?: boolean;
}

type State =
  | { kind: 'head' }
  /** The body of a request with a length; `takeover` when the request takes the connection over after it. */
  | { kind: 'body'; left: number; takeover: boolean }
  | { kind: 'chunkSize' }
  | { kind: 'chunkData'; left: number }
  | { kind: 'chunkEnd'; left: number }
  | { kind: 'trailers' }
  /** After the request of a takeover: the bytes of the client wait for the answer of the engine. */
  | { kind: 'takeover'; held: Buffer[] }
  | { kind: 'raw' }
  /** The engine refused a takeover: the connection takes no further request. */
  | { kind: 'ended' }
  | { kind: 'refused' };

/** The paths of the Docker API that take the connection over (hijack): the engine answers with `101` to `Upgrade`. */
const HIJACK_PATHS = [/^\/exec\/[^/]+\/start$/, /^\/containers\/[^/]+\/attach$/];

/** The request line of HTTP/1.x: the method, the target, the version. */
const REQUEST_LINE = /^([A-Z]{1,16}) (\S+) HTTP\/1\.[01]$/;

/**
 * The path of a request target (`/v1.47/containers/json?all=1`): without the query, and without the version of the API,
 * whose form the Docker CLI uses (`/v` and two numbers). The path keeps its percent escapes, as the client sent them;
 * undefined for a target that is no absolute path.
 */
export function dockerRequestPath(target: string): string | undefined {
  if (!target.startsWith('/')) return undefined;
  const query = target.indexOf('?');
  const path = query < 0 ? target : target.slice(0, query);
  return path.replace(/^\/v\d+\.\d+(?=\/)/, '');
}

/** The request in a log line: printable characters only, and at most 200 of them. */
export function requestText(request: DockerRequest): string {
  const text = `${request.method} ${request.path}`.replace(/[^\x21-\x7e ]/g, '?');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * The parser of the requests of one connection. `rule` decides about each request. Not for the answers of the engine:
 * they go back to the client as they come; only the status of the answer to a takeover is given to `answer`.
 */
export class DockerRequestParser {
  private state: State = { kind: 'head' };
  private pending: Buffer = Buffer.alloc(0);
  /** The answer of the engine to the takeover that the parser waits for: undefined while it did not come. */
  private takeoverAnswer: boolean | undefined;
  private awaiting = false;

  constructor(private readonly rule: DockerRequestRule) {}

  /** True after a request took the connection over: every byte goes on as it comes. */
  get passthrough(): boolean {
    return this.state.kind === 'raw';
  }

  /** True while a takeover waits for the status of the answer of the engine (answer). */
  get awaitingAnswer(): boolean {
    return this.awaiting;
  }

  /** True while bytes of the client wait for that answer: the client should send no more meanwhile. */
  get holding(): boolean {
    return this.state.kind === 'takeover';
  }

  /** The bytes of the client that came now. */
  push(chunk: Buffer): ParsedBytes {
    const forward: Buffer[] = [];
    let data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    while (data.length > 0) {
      const state: State = this.state;
      switch (state.kind) {
        case 'raw':
          forward.push(data);
          return { forward };
        case 'refused':
        case 'ended':
          return { forward };
        case 'takeover':
          state.held.push(data);
          return { forward };
        case 'body':
        case 'chunkData': {
          const take = Math.min(state.left, data.length);
          forward.push(data.subarray(0, take));
          data = data.subarray(take);
          state.left -= take;
          if (state.left > 0) break;
          if (state.kind === 'chunkData') this.state = { kind: 'chunkEnd', left: 2 };
          else if (!state.takeover) this.state = { kind: 'head' };
          else {
            const after = this.takeOver();
            if (after.end === true) return { forward, end: true };
          }
          break;
        }
        case 'chunkEnd': {
          // The CRLF after the data of a chunk.
          const take = Math.min(state.left, data.length);
          const expected = '\r\n'.slice(2 - state.left, 2 - state.left + take);
          if (data.subarray(0, take).toString('latin1') !== expected) return this.refuse(forward, undefined, 'the chunked body of the request is not valid');
          forward.push(data.subarray(0, take));
          data = data.subarray(take);
          state.left -= take;
          if (state.left === 0) this.state = { kind: 'chunkSize' };
          break;
        }
        case 'chunkSize': {
          const end = data.indexOf('\r\n');
          if (end < 0) {
            if (data.length > MAX_CHUNK_LINE_BYTES) return this.refuse(forward, undefined, 'the chunked body of the request is not valid');
            this.pending = data;
            return { forward };
          }
          const size = /^([0-9A-Fa-f]{1,15})(?:;.*)?$/.exec(data.subarray(0, end).toString('latin1'));
          if (size === null) return this.refuse(forward, undefined, 'the chunked body of the request is not valid');
          forward.push(data.subarray(0, end + 2));
          data = data.subarray(end + 2);
          const length = parseInt(size[1], 16);
          this.state = length === 0 ? { kind: 'trailers' } : { kind: 'chunkData', left: length };
          break;
        }
        case 'trailers': {
          // The trailer fields after the last chunk, up to an empty line.
          const end = data.indexOf('\r\n');
          if (end < 0) {
            if (data.length > MAX_REQUEST_HEAD_BYTES) return this.refuse(forward, undefined, 'the chunked body of the request is not valid');
            this.pending = data;
            return { forward };
          }
          forward.push(data.subarray(0, end + 2));
          data = data.subarray(end + 2);
          if (end === 0) this.state = { kind: 'head' };
          break;
        }
        case 'head': {
          const end = data.indexOf('\r\n\r\n');
          if (end < 0) {
            if (data.length > MAX_REQUEST_HEAD_BYTES) return this.refuse(forward, undefined, 'the head of the request is too long');
            this.pending = data;
            return { forward };
          }
          if (end + 4 > MAX_REQUEST_HEAD_BYTES) return this.refuse(forward, undefined, 'the head of the request is too long');
          const head = data.subarray(0, end + 4);
          const parsed = parseHead(head.toString('latin1'));
          if (typeof parsed === 'string') return this.refuse(forward, undefined, parsed);
          const reason = this.rule(parsed.request, parsed.headers) ?? bodyProblem(parsed.request, parsed.headers);
          if (reason !== undefined) return this.refuse(forward, parsed.request, reason);
          forward.push(head);
          data = data.subarray(end + 4);
          const takeover = isTakeover(parsed.headers);
          if (takeover) {
            this.awaiting = true;
            this.takeoverAnswer = undefined;
          }
          const length = parsed.headers.get('content-length');
          const left = length === undefined ? 0 : Number(length);
          if (parsed.headers.has('transfer-encoding')) this.state = { kind: 'chunkSize' };
          else if (left > 0) this.state = { kind: 'body', left, takeover };
          else if (!takeover) this.state = { kind: 'head' };
          else {
            const after = this.takeOver();
            if (after.end === true) return { forward, end: true };
          }
          break;
        }
      }
    }
    return { forward };
  }

  /**
   * The status of the answer of the engine to the takeover came: `upgraded` for `101`. The bytes of the client that
   * waited for it go on after `101`; after any other answer the direction of the client ends (`end`).
   */
  answer(upgraded: boolean): ParsedBytes {
    if (!this.awaiting) return { forward: [] };
    this.awaiting = false;
    this.takeoverAnswer = upgraded;
    const state: State = this.state;
    // The engine answered before the end of the body of the request (an error): it is applied after the body.
    if (state.kind !== 'takeover') return { forward: [] };
    if (!upgraded) {
      this.state = { kind: 'ended' };
      return { forward: [], end: true };
    }
    this.state = { kind: 'raw' };
    return { forward: state.held };
  }

  /** The request of a takeover was sent: wait for the answer of the engine, or apply the answer that came already. */
  private takeOver(): { end?: boolean } {
    if (this.takeoverAnswer === undefined) {
      this.state = { kind: 'takeover', held: [] };
      return {};
    }
    this.state = this.takeoverAnswer ? { kind: 'raw' } : { kind: 'ended' };
    return this.takeoverAnswer ? {} : { end: true };
  }

  private refuse(forward: Buffer[], request: DockerRequest | undefined, reason: string): ParsedBytes {
    this.state = { kind: 'refused' };
    this.pending = Buffer.alloc(0);
    return { forward, refused: { ...(request ?? { method: '', path: '' }), reason } };
  }
}

/** True for a request that takes the connection over: an `Upgrade` header, or `upgrade` in its Connection header. */
function isTakeover(headers: ReadonlyMap<string, string>): boolean {
  return headers.has('upgrade') || /(^|,)\s*upgrade\s*(,|$)/i.test(headers.get('connection') ?? '');
}

/** The request and its headers (names in lower case) from the head `text`, or the reason why it is not valid. */
function parseHead(text: string): { request: DockerRequest; headers: Map<string, string> } | string {
  const lines = text.slice(0, -4).split('\r\n');
  const match = REQUEST_LINE.exec(lines[0] ?? '');
  if (match === null) return 'the request is no HTTP/1 request';
  const path = dockerRequestPath(match[2]);
  if (path === undefined) return 'the target of the request is no path';
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0 || /[\s\x00-\x1f\x7f]/.test(line.slice(0, colon))) return 'a header of the request is not valid';
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    // Two lengths, or a length and a transfer coding, could make the engine read another body than this parser.
    if (headers.has(name) && (name === 'content-length' || name === 'transfer-encoding')) return `the request has two ${name} headers`;
    headers.set(name, value);
  }
  return { request: { method: match[1], path }, headers };
}

/** Why the body of the request cannot be followed, or undefined: a length, a chunked body, or none. */
function bodyProblem(request: DockerRequest, headers: ReadonlyMap<string, string>): string | undefined {
  const encoding = headers.get('transfer-encoding');
  const length = headers.get('content-length');
  if (encoding !== undefined && length !== undefined) return 'the request has a length and a transfer coding';
  if (encoding !== undefined && encoding.toLowerCase() !== 'chunked') return `the transfer coding ${encoding} is not supported`;
  if (length !== undefined && !/^\d{1,15}$/.test(length)) return 'the length of the request is not valid';
  const takeover = isTakeover(headers);
  // The Docker CLI sends the body of an exec or an attach with its length; the bytes after a chunked body would wait
  // for an answer that the parser could not place.
  if (takeover && encoding !== undefined) return 'a request that takes the connection over must have a length';
  // Without `Upgrade` the engine takes these connections over with the answer `200`, which the filter does not follow.
  if (!takeover && HIJACK_PATHS.some((pattern) => pattern.test(request.path))) return 'the request takes the connection over without an Upgrade header';
  return undefined;
}

/** The answer to a refused request: the status 403 and the message of the Docker API (`{"message": …}`). */
export function refusalResponse(message: string): Buffer {
  const body = JSON.stringify({ message });
  return Buffer.from(
    `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    'utf8',
  );
}

/**
 * One connection of a Docker pipe with its requests filtered: what the client sends goes on (readable side) only as far
 * as the parser allows it; what the engine answers (writable side) goes to the client as it comes. A refused request
 * gets the answer of refusalResponse, after which the socket closes and this connection ends (`close` without `end`,
 * so that the stream to the engine closes). `onRefused` is called once then.
 */
export class FilteredConnection extends Duplex {
  private readonly parser: DockerRequestParser;
  /** The start of the answer of the engine while the parser waits for its status line. */
  private statusLine = '';
  private refusedRequest = false;
  private endedClient = false;

  constructor(
    private readonly socket: net.Socket,
    rule: DockerRequestRule,
    private readonly onRefused: (request: RefusedDockerRequest) => void,
    private readonly refusedCloseMs = REFUSED_CLOSE_MS,
  ) {
    super({ allowHalfOpen: true });
    this.parser = new DockerRequestParser(rule);
    // bridgeStream and processDockerDial report the errors of the connection; without a listener, an error would end
    // the extension host.
    this.on('error', () => {});
    socket.on('data', (chunk: Buffer) => this.fromClient(chunk));
    socket.on('end', () => this.endClient());
    socket.on('error', (error: Error) => {
      if (!this.refusedRequest) this.destroy(error);
    });
    socket.on('close', () => {
      if (!this.destroyed) this.destroy();
    });
  }

  override _read(): void {
    if (!this.refusedRequest && !this.parser.holding && !this.socket.destroyed) this.socket.resume();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.toClient([chunk], callback);
  }

  override _writev(chunks: { chunk: Buffer }[], callback: (error?: Error | null) => void): void {
    this.toClient(
      chunks.map(({ chunk }) => chunk),
      callback,
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.socket.destroyed || this.socket.writableEnded) return callback();
    this.socket.end(() => callback());
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    // A refused request: the socket closes itself once its answer is written (refuse).
    if (!this.refusedRequest) this.socket.destroy();
    callback(error);
  }

  private fromClient(chunk: Buffer): void {
    if (this.refusedRequest || this.endedClient) return;
    const parsed = this.parser.push(chunk);
    this.apply(parsed);
    // The bytes after a takeover wait for the answer of the engine; the client sends no more meanwhile (a Docker
    // client reads the answer first).
    if (this.parser.holding) this.socket.pause();
  }

  private apply(parsed: ParsedBytes): void {
    for (const bytes of parsed.forward) {
      if (!this.push(bytes)) this.socket.pause();
    }
    if (parsed.refused !== undefined) this.refuse(parsed.refused);
    else if (parsed.end === true) this.endClient();
  }

  /** The direction of the client ends: its end, or the refusal of a takeover by the engine. */
  private endClient(): void {
    if (this.endedClient || this.refusedRequest) return;
    this.endedClient = true;
    this.push(null);
    // What the client still sends is dropped, so that its end comes.
    this.socket.resume();
  }

  private toClient(chunks: Buffer[], callback: (error?: Error | null) => void): void {
    if (this.parser.awaitingAnswer) this.readStatus(chunks);
    if (this.socket.destroyed || this.socket.writableEnded) return callback();
    for (const chunk of chunks.slice(0, -1)) this.socket.write(chunk);
    this.socket.write(chunks[chunks.length - 1], () => callback());
  }

  /** Reads the status line of the answer of the engine to a takeover, and gives it to the parser. */
  private readStatus(chunks: Buffer[]): void {
    for (const chunk of chunks) {
      this.statusLine += chunk.subarray(0, MAX_STATUS_LINE_BYTES - this.statusLine.length).toString('latin1');
      const end = this.statusLine.indexOf('\r\n');
      if (end < 0 && this.statusLine.length < MAX_STATUS_LINE_BYTES) continue;
      const upgraded = /^HTTP\/1\.1 101[ \r]/.test(this.statusLine);
      this.statusLine = '';
      const parsed = this.parser.answer(upgraded);
      this.apply(parsed);
      if (upgraded && !this.parser.holding && !this.socket.destroyed) this.socket.resume();
      return;
    }
  }

  private refuse(request: RefusedDockerRequest): void {
    this.refusedRequest = true;
    this.onRefused(request);
    const socket = this.socket;
    if (!socket.destroyed) {
      const timer = setTimeout(() => socket.destroy(), this.refusedCloseMs);
      timer.unref?.();
      socket.once('close', () => clearTimeout(timer));
      if (!socket.writableEnded) socket.end(refusalResponse(`Devspaces does not allow ${requestText(request)} through the Docker pipe of this window: ${request.reason}.`));
      // What the client still sends is dropped, so that its end comes.
      socket.resume();
    }
    // The stream to the engine closes: nothing of the refused request went there.
    this.destroy();
  }
}
