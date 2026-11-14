// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The read of Show Log of a worker (R-ENG-008, R-ENG-010): the inspect of the worker for its image and the volume of the
// Monitor, then one run of the reader, only with calls that the shared shell of a host carries; a worker without a log
// (an older version started it) gives NoWorkerLogError, other failures a CommandError.
import { describe, expect, it } from 'vitest';
import { isSharedShellCall } from '../docker/bootstrapDocker';
import { CommandError } from '../errors';
import { LOCK_STATE_DIR } from '../helperChannel/protocol';
import type { RunOptions, RunResult } from '../ports';
import { readWorkerLog } from './workerLogRead';
import { NO_WORKER_LOG_EXIT, NoWorkerLogError, WORKER_LOG_READER_TIMEOUT_MS, isWorkerLogReaderCall } from './workerLogReader';

const ID = `0123456789ab${'cd'.repeat(26)}`;
const IMAGE = `sha256:${'ef'.repeat(32)}`;
const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const WORKER = {
  Id: ID,
  Image: IMAGE,
  Config: { Image: 'devspaces-worker:abc', Labels: { 'nimblescape.devspaces.worker-run': 'true' } },
  State: { Status: 'running' },
  HostConfig: { LogConfig: { Type: 'none' } },
  Mounts: [
    { Type: 'bind', Source: '/run/user/1000/docker.sock', Destination: '/var/run/docker.sock', RW: true },
    { Type: 'volume', Name: 'devspaces-monitor', Destination: LOCK_STATE_DIR, RW: true },
    { Type: 'volume', Name: 'devspaces-vscode', Destination: '/vscode', RW: true },
  ],
};

/** A Docker that answers the inspect with `inspect` and the reader with `reader`, and records the calls. */
function fakeDocker(inspect: unknown, reader: RunResult) {
  const calls: Array<{ args: string[]; options: RunOptions | undefined }> = [];
  return {
    calls,
    run: async (args: string[], options?: RunOptions): Promise<RunResult> => {
      calls.push({ args, options });
      if (args[0] === 'container' && args[1] === 'inspect') return ok(`${JSON.stringify(inspect)}\n`);
      if (args[0] === 'run') return reader;
      throw new Error(`No answer for docker ${args.join(' ')}`);
    },
  };
}

describe('readWorkerLog', () => {
  it('runs the reader with the image of the worker on its volume of the Monitor, and gives the lines with local times', async () => {
    const docker = fakeDocker(WORKER, ok('2026-11-14T07:00:00.000Z The worker started.\n2026-11-14T07:00:01.250Z #1 probe started.\n    a further line'));
    const text = await readWorkerLog(docker, { container: ID, timeZone: 'Europe/Vienna', name: () => 'devspaces-reader-0a1b2c3d' });
    expect(text).toBe('2026-11-14 08:00:00.000 The worker started.\n2026-11-14 08:00:01.250 #1 probe started.\n    a further line');
    expect(docker.calls.map((call) => call.args.slice(0, 2).join(' '))).toEqual(['container inspect', 'run --rm']);
    const reader = docker.calls[1];
    expect(isWorkerLogReaderCall(reader.args)).toBe(true);
    expect(reader.args).toContain(IMAGE);
    expect(reader.args).toContain('type=volume,source=devspaces-monitor,target=/devspaces/monitor,readonly');
    expect(reader.args.at(-1)).toBe('0123456789ab');
    expect(reader.options?.timeoutMs).toBe(WORKER_LOG_READER_TIMEOUT_MS);
    for (const call of docker.calls) expect(isSharedShellCall(call.args, false)).toBe(true);
  });

  it('says that the worker has no log when the reader finds none, or the worker has no volume of the Monitor', async () => {
    await expect(readWorkerLog(fakeDocker(WORKER, { exitCode: NO_WORKER_LOG_EXIT, stdout: '', stderr: '', timedOut: false }), { container: ID, timeZone: 'UTC' })).rejects.toBeInstanceOf(
      NoWorkerLogError,
    );
    const withoutVolume = fakeDocker({ ...WORKER, Mounts: WORKER.Mounts.filter((mount) => mount.Destination !== LOCK_STATE_DIR) }, ok());
    await expect(readWorkerLog(withoutVolume, { container: ID, timeZone: 'UTC' })).rejects.toBeInstanceOf(NoWorkerLogError);
    expect(withoutVolume.calls.map((call) => call.args[0])).toEqual(['container']);
  });

  it('fails with a CommandError when the reader fails or does not end in time, and reads nothing for a value that is no ID', async () => {
    const failed = readWorkerLog(fakeDocker(WORKER, { exitCode: 125, stdout: '', stderr: 'Error response from daemon: No such image\n', timedOut: false }), { container: ID, timeZone: 'UTC' });
    await expect(failed).rejects.toBeInstanceOf(CommandError);
    await expect(failed).rejects.toThrow(/No such image/);
    const slow = readWorkerLog(fakeDocker(WORKER, { exitCode: NO_WORKER_LOG_EXIT, stdout: '', stderr: '', timedOut: true }), { container: ID, timeZone: 'UTC' });
    await expect(slow).rejects.toThrow(/time limit/);
    const docker = fakeDocker(WORKER, ok());
    await expect(readWorkerLog(docker, { container: 'devspaces-api-worker1', timeZone: 'UTC' })).rejects.toThrow(/no ID of a container/);
    expect(docker.calls).toEqual([]);
  });
});
