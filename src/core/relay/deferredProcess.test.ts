// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { abortError, type StartedByteProcess } from '../ports';
import { deferredByteProcess } from './deferredProcess';

/** A started program that records what it gets, and ends when `finish` is called. */
function program(): { process: StartedByteProcess; log: string[]; out: (text: string) => void; finish: (exitCode: number) => void } {
  const log: string[] = [];
  let stdout: ((chunk: Buffer) => void) | undefined;
  let onEnd: (() => void) | undefined;
  let stderr: ((text: string) => void) | undefined;
  let finish: (exitCode: number) => void = () => undefined;
  const exited = new Promise<{ exitCode: number | null }>((resolve) => {
    finish = (exitCode) => {
      onEnd?.();
      resolve({ exitCode });
    };
  });
  const process: StartedByteProcess = {
    write: (chunk) => log.push(`write ${chunk.toString('utf8')}`) > 0,
    onDrain: () => log.push('onDrain'),
    end: () => log.push('end'),
    kill: () => log.push('kill'),
    killNow: () => log.push('killNow'),
    pid: 42,
    onStdout: (listener, end) => {
      stdout = listener;
      onEnd = end;
    },
    pauseStdout: () => log.push('pause'),
    resumeStdout: () => log.push('resume'),
    onStderr: (listener) => (stderr = listener),
    exited,
  };
  return {
    process,
    log,
    out: (text) => {
      stdout?.(Buffer.from(text));
      stderr?.(`err ${text}`);
    },
    finish: (exitCode) => finish(exitCode),
  };
}

function later(): { promise: Promise<StartedByteProcess>; resolve: (process: StartedByteProcess) => void; reject: (error: Error) => void } {
  let resolve: (process: StartedByteProcess) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<StartedByteProcess>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('deferredByteProcess', () => {
  it('holds back what comes before the start, in order, and then is the started program', async () => {
    const step = later();
    const deferred = deferredByteProcess(() => step.promise);
    const output: string[] = [];
    const errors: string[] = [];
    let ended = false;
    expect(deferred.write(Buffer.from('a'))).toBe(true);
    deferred.write(Buffer.from('b'));
    deferred.onStdout(
      (chunk) => output.push(chunk.toString('utf8')),
      () => (ended = true),
    );
    deferred.onStderr((text) => errors.push(text));
    deferred.pauseStdout();
    deferred.end();
    expect(deferred.pid).toBeUndefined();
    const real = program();
    step.resolve(real.process);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(real.log).toEqual(['pause', 'write a', 'write b', 'end']);
    expect(deferred.pid).toBe(42);
    deferred.resumeStdout();
    deferred.write(Buffer.from('c'));
    real.out('x');
    real.finish(0);
    await expect(deferred.exited).resolves.toEqual({ exitCode: 0 });
    expect(real.log).toEqual(['pause', 'write a', 'write b', 'end', 'resume', 'write c']);
    expect(output).toEqual(['x']);
    expect(errors).toEqual(['err x']);
    expect(ended).toBe(true);
  });

  it('ends as a failed start with the message of the step on its error output', async () => {
    const deferred = deferredByteProcess(() => Promise.reject(new Error('The Lima VM of Devspaces is not set up.')));
    const errors: string[] = [];
    deferred.onStderr((text) => errors.push(text));
    const exit = await deferred.exited;
    expect(exit.exitCode).toBeNull();
    expect(exit.error?.message).toBe('The Lima VM of Devspaces is not set up.');
    expect(errors).toEqual(['The Lima VM of Devspaces is not set up.\n']);
    // A listener that comes after the end gets the end at once.
    let ended = false;
    deferred.onStdout(
      () => undefined,
      () => (ended = true),
    );
    expect(ended).toBe(true);
  });

  it('aborts the step when it is killed before the start, and kills a program that the step gives anyway', async () => {
    let seen: AbortSignal | undefined;
    const refused = deferredByteProcess(async (signal) => {
      seen = signal;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal.aborted) throw abortError();
      return program().process;
    });
    refused.write(Buffer.from('dropped'));
    refused.kill();
    expect(seen?.aborted).toBe(true);
    expect((await refused.exited).error?.name).toBe('AbortError');

    const step = later();
    const given = deferredByteProcess(() => step.promise);
    given.killNow?.();
    const real = program();
    step.resolve(real.process);
    await new Promise((resolve) => setTimeout(resolve, 0));
    real.finish(137);
    await expect(given.exited).resolves.toEqual({ exitCode: 137 });
    expect(real.log).toEqual(['killNow']);
  });
});
