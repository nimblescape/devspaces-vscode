// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// A program that starts after a step that takes time, as one StartedByteProcess from the beginning: the transport to the
// Lima VM of Devspaces, whose `ssh` starts only when the VM runs (LimaVm.ready). What is written before the start waits
// for it, in order; a kill before the start aborts the signal of the step, and the program never starts. A failed step
// ends it as a failed start, with the message of the step on its error output. No `vscode`.
import { errorMessage } from '../errors';
import { heldOutput, type StartedByteProcess } from '../ports';

/**
 * The process that `start` gives, with everything before it held back. `signal` aborts when the process is killed
 * before `start` gave it: then `start` should start nothing and reject (a process that it gives anyway is killed).
 */
export function deferredByteProcess(start: (signal: AbortSignal) => Promise<StartedByteProcess>): StartedByteProcess {
  const cancel = new AbortController();
  let inner: StartedByteProcess | undefined;
  let failed = false;
  let killed: 'kill' | 'killNow' | undefined;
  let ended = false;
  const writes: Buffer[] = [];
  let drainListener: (() => void) | undefined;
  let stdoutListener: ((chunk: Buffer) => void) | undefined;
  let stdoutEnd: (() => void) | undefined;
  let paused = false;
  const stderr = heldOutput<string>();
  let resolveExit: (exit: { exitCode: number | null; error?: Error }) => void = () => undefined;
  const exited = new Promise<{ exitCode: number | null; error?: Error }>((resolve) => {
    resolveExit = resolve;
  });
  const fail = (error: Error): void => {
    failed = true;
    stderr.deliver(`${error.message}\n`);
    stdoutEnd?.();
    resolveExit({ exitCode: null, error });
  };

  void start(cancel.signal).then(
    (process) => {
      if (killed !== undefined) {
        if (killed === 'killNow' && process.killNow !== undefined) process.killNow();
        else process.kill();
      }
      inner = process;
      process.onStderr((text) => stderr.deliver(text));
      if (stdoutListener !== undefined) process.onStdout(stdoutListener, stdoutEnd ?? (() => undefined));
      if (paused) process.pauseStdout();
      for (const chunk of writes.splice(0)) process.write(chunk);
      if (drainListener !== undefined) process.onDrain(drainListener);
      if (ended) process.end();
      void process.exited.then(resolveExit);
    },
    (error: unknown) => fail(error instanceof Error ? error : new Error(errorMessage(error))),
  );

  return {
    write: (chunk) => {
      if (inner !== undefined) return inner.write(chunk);
      if (!ended && killed === undefined) writes.push(chunk);
      return true;
    },
    onDrain: (listener) => {
      if (inner !== undefined) inner.onDrain(listener);
      else drainListener = listener;
    },
    end: () => {
      if (inner !== undefined) inner.end();
      else ended = true;
    },
    kill: () => {
      if (inner !== undefined) return inner.kill();
      killed ??= 'kill';
      cancel.abort();
    },
    killNow: () => {
      if (inner !== undefined) return (inner.killNow ?? inner.kill).call(inner);
      killed = 'killNow';
      cancel.abort();
    },
    get pid() {
      return inner?.pid;
    },
    onStdout: (listener, onEnd) => {
      if (inner !== undefined) inner.onStdout(listener, onEnd);
      else if (failed) onEnd();
      else {
        stdoutListener = listener;
        stdoutEnd = onEnd;
      }
    },
    pauseStdout: () => {
      if (inner !== undefined) inner.pauseStdout();
      else paused = true;
    },
    resumeStdout: () => {
      if (inner !== undefined) inner.resumeStdout();
      else paused = false;
    },
    onStderr: (listener) => stderr.listen(listener),
    exited,
  };
}
