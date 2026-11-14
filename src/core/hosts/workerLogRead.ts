// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The read of Show Log of a worker (workerLogReader.ts): the inspect of the worker's container for its image and the
// volume of the Monitor at LOCK_STATE_DIR, then one run of the reader of its log, within an operation on its host (the
// shared shell, or the Docker pipe of the extension). The times of the lines come in the time zone of this computer
// (readableTimes). No `vscode`.
import type { BootstrapDocker } from '../docker/bootstrapDocker';
import { CommandError } from '../errors';
import { LOCK_STATE_DIR, workerLogName } from '../helperChannel/protocol';
import { readableStderr } from '../loader/pipeLoader';
import { readableTimes } from './monitorLog';
import { readObjectDetails } from './objectDetails';
import { newReaderName } from './volumeReader';
import { NO_WORKER_LOG_EXIT, NoWorkerLogError, WORKER_LOG_READER_TIMEOUT_MS, workerLogReaderArgs } from './workerLogReader';

/** The most characters of the errors of a call that a failure keeps (its end). */
const ERROR_LENGTH = 2000;

export interface WorkerLogReadInput {
  /** The full ID of the worker's container (as the view knows it). */
  container: string;
  /** The time zone of this computer, in which the log gives times. */
  timeZone: string;
  signal?: AbortSignal;
  /** Only for the tests: the name of the container of the reader. */
  name?: () => string;
}

/**
 * The log of the worker `container` on the host of the current operation (Show Log): the inspect of the container for
 * its image and the volume at LOCK_STATE_DIR, then one run of the reader. Throws NoWorkerLogError when the worker has no
 * log, a CommandError when Docker fails (for example when the worker is gone), and an AbortError.
 */
export async function readWorkerLog(docker: Pick<BootstrapDocker, 'run'>, input: WorkerLogReadInput): Promise<string> {
  const name = workerLogName(input.container);
  if (name === undefined) throw new Error(`${JSON.stringify(input.container)} is no ID of a container.`);
  const details = await readObjectDetails(docker, { kind: 'container', id: input.container }, input.signal);
  if (details.kind !== 'container') throw new CommandError(`docker container inspect ${input.container}`, 0, '', 'The object is no container.');
  const volume = details.mounts.find((mount) => mount.type === 'volume' && mount.destination === LOCK_STATE_DIR)?.source;
  if (details.imageId === undefined || volume === undefined) throw new NoWorkerLogError(input.container);
  const args = workerLogReaderArgs({ image: details.imageId, volume, id: name.slice(0, 12), name: (input.name ?? newReaderName)() });
  const result = await docker.run(args, { timeoutMs: WORKER_LOG_READER_TIMEOUT_MS, ...(input.signal !== undefined ? { signal: input.signal } : {}) });
  if (!result.timedOut && result.exitCode === NO_WORKER_LOG_EXIT) throw new NoWorkerLogError(input.container);
  if (result.exitCode !== 0 || result.timedOut) {
    const stderr = result.timedOut ? 'The reader did not end within the time limit.' : readableStderr(result.stderr.slice(-ERROR_LENGTH), ERROR_LENGTH);
    throw new CommandError('the reader of the log of the worker', result.exitCode, '', stderr, result.timedOut);
  }
  return result.stdout
    .split('\n')
    .map((line) => readableTimes(line, input.timeZone))
    .join('\n');
}
