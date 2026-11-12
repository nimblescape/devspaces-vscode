// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The desktop of the README GIF (record.mjs): an X display of Xvfb, real input on it with xdotool (the pointer moves
// in small steps, so that it shows in the GIF), its recording with ffmpeg, and the DOM of the VS Code window through
// the Chrome DevTools Protocol of its remote debugging port, to find where a row, a button or a tab is. The same method
// recorded the GIFs of nimblescape PlantUML, Mindbug and Comment Links.
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';

export const DISPLAY = ':99';
/** The screen is larger than the window (1440 x 816), so that the pointer can rest outside the recorded part. */
export const SCREEN = { width: 1600, height: 900 };
export const WINDOW = { width: 1440, height: 816 };
const env = { ...process.env, DISPLAY };

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts Xvfb on DISPLAY and waits for its socket. Returns the process. */
export async function startXvfb() {
  const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', `${SCREEN.width}x${SCREEN.height}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
  const socket = `/tmp/.X11-unix/X${DISPLAY.slice(1)}`;
  for (let i = 0; i < 100 && !fs.existsSync(socket); i++) await wait(100);
  if (!fs.existsSync(socket)) throw new Error(`Xvfb did not start on ${DISPLAY}.`);
  return xvfb;
}

export const xdo = (...args) => execFileSync('xdotool', args.map(String), { env }).toString().trim();

let pointer = { x: SCREEN.width - 40, y: SCREEN.height - 20 };

/** Moves the pointer to (x, y) in steps of 16 ms, slow at the start and at the end. */
export async function move(x, y, ms = 500) {
  const steps = Math.max(1, Math.round(ms / 16));
  const from = { ...pointer };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    xdo('mousemove', Math.round(from.x + (x - from.x) * e), Math.round(from.y + (y - from.y) * e));
    await wait(16);
  }
  pointer = { x: Math.round(x), y: Math.round(y) };
}

/** Puts the pointer at (x, y) at once. */
export function jump(x, y) {
  xdo('mousemove', Math.round(x), Math.round(y));
  pointer = { x: Math.round(x), y: Math.round(y) };
}

/** Moves to the middle of `rect` and clicks: `count` 2 is a double click. */
export async function click(rect, { count = 1, button = 1, ms = 500, after = 300 } = {}) {
  await move(rect.x + rect.width / 2, rect.y + rect.height / 2, ms);
  await wait(120);
  xdo('click', '--repeat', count, '--delay', 90, button);
  await wait(after);
}

export async function key(name, after = 250) {
  xdo('key', '--clearmodifiers', name);
  await wait(after);
}

/** The window of VS Code at the top left of the screen, with the size of the GIF. */
export async function placeWindow() {
  let id = '';
  for (let i = 0; i < 100 && id === ''; i++) {
    try {
      id = xdo('search', '--onlyvisible', '--class', 'code').split('\n')[0];
    } catch {
      await wait(200);
    }
  }
  if (id === '') throw new Error('The window of VS Code was not found.');
  xdo('windowmove', id, 0, 0);
  xdo('windowsize', id, WINDOW.width, WINDOW.height);
  return id;
}

/** Starts ffmpeg on the window part of the screen (lossless) and returns a function that stops it. */
export function record(file, fps = 20) {
  const ffmpeg = spawn(
    'ffmpeg',
    ['-loglevel', 'error', '-y', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', String(fps), '-video_size', `${WINDOW.width}x${WINDOW.height}`,
      '-i', `${DISPLAY}.0+0,0`, '-c:v', 'libx264rgb', '-preset', 'ultrafast', '-crf', '0', file],
    { env, stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const started = Date.now();
  const stop = () =>
    new Promise((resolve) => {
      ffmpeg.on('exit', resolve);
      ffmpeg.stdin.write('q');
    });
  return { started, stop };
}

/** A screenshot of the window part of the screen into the PNG file `file`. */
export function screenshot(file) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', `${WINDOW.width}x${WINDOW.height}`, '-i', `${DISPLAY}.0+0,0`, '-frames:v', '1', file], { env });
}

/** The targets of the remote debugging port: pages (windows) and frames of webviews. */
export async function targets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

/** A connection to one target of the Chrome DevTools Protocol, with `evaluate` of a function in its page. */
export class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error(`No connection to ${url}.`)), { once: true });
    });
    return new Cdp(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const waiting of this.pending.values()) waiting.reject(new Error('The connection closed.'));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** The JSON value of `fn(arg)`, run in the page. */
  async evaluate(fn, arg) {
    const result = await this.send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg ?? null)})`, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}
