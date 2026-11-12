// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The identity and the prunes of the port over the Engine API (engineClient.ts) in detail.
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SWEEP_FILTERS } from '../core/helperChannel/protocol';
import { EngineError } from '../core/worker/dockerEngine';
import { engineHijack, type EngineAnswer, type EngineApi } from './engineApi';
import { dockerEngine } from './engineClient';

function fake(answer: EngineAnswer) {
  const api: EngineApi = async () => answer;
  return dockerEngine(api, engineHijack(path.join(os.tmpdir(), 'devspaces-no-socket')));
}

describe('identity and pruneContainers in detail', () => {
  // The identity is the `ID` of /info only (never `value?.ID ?? value?.Name`), never another field (another name would
  // let a different engine pass as the target's).
  it('identity: an answer without ID is refused even when it has a Name', async () => {
    const engine = fake({ status: 200, body: JSON.stringify({ Name: 'host', DockerRootDir: '/var/lib/docker' }), truncated: false });
    await expect(engine.identity()).rejects.toThrow(new EngineError('The engine answered /info without its ID and root folder.', 200));
  });

  // Only a 200 is a prune answer (not also a 204); any other status is the engine's failure, even with a body that
  // reads as one.
  it('pruneContainers: a status other than 200 is a failure, whatever the body', async () => {
    for (const status of [204, 201]) {
      const engine = fake({ status, body: JSON.stringify({ ContainersDeleted: ['a'.repeat(64)] }), truncated: false });
      await expect(engine.pruneContainers(SWEEP_FILTERS), String(status)).rejects.toMatchObject({ name: 'EngineError', status });
    }
  });
});

describe('pruneBuildCache', () => {
  /** A fake API that records the requests and answers `answer`. */
  function recording(answer: EngineAnswer) {
    const requests: Array<{ method: string; path: string }> = [];
    const api: EngineApi = async (request) => {
      requests.push({ method: request.method, path: request.path });
      return answer;
    };
    return { requests, engine: dockerEngine(api, engineHijack(path.join(os.tmpdir(), 'devspaces-no-socket'))) };
  }

  it('posts /build/prune with all=1 and the filters, and answers the count of the removed records and the bytes', async () => {
    const { requests, engine } = recording({ status: 200, body: JSON.stringify({ CachesDeleted: ['a', 'b'], SpaceReclaimed: 1234 }), truncated: false });
    expect(await engine.pruneBuildCache({ until: ['168h'] })).toEqual({ records: 2, bytes: 1234 });
    expect(requests).toEqual([{ method: 'POST', path: `/build/prune?all=1&filters=${encodeURIComponent(JSON.stringify({ until: ['168h'] }))}` }]);
  });

  it('CachesDeleted is null when nothing was removed', async () => {
    const { engine } = recording({ status: 200, body: JSON.stringify({ CachesDeleted: null, SpaceReclaimed: 0 }), truncated: false });
    expect(await engine.pruneBuildCache({ until: ['168h'] })).toEqual({ records: 0, bytes: 0 });
  });

  it('refuses an invalid answer, a truncated one and a status other than 200', async () => {
    for (const body of ['not json', '[]', 'null', JSON.stringify({ CachesDeleted: 'a' }), JSON.stringify({ SpaceReclaimed: -1 }), JSON.stringify({ SpaceReclaimed: '1' })]) {
      const { engine } = recording({ status: 200, body, truncated: false });
      await expect(engine.pruneBuildCache({}), body).rejects.toThrow(new EngineError('The engine answered the prune of the build cache with an invalid value.', 200));
    }
    const truncated = recording({ status: 200, body: '{"CachesDeleted":[', truncated: true });
    await expect(truncated.engine.pruneBuildCache({})).rejects.toThrow(new EngineError('The engine answered the prune of the build cache with more than can be read.', 200));
    const failed = recording({ status: 500, body: JSON.stringify({ message: 'no builder' }), truncated: false });
    await expect(failed.engine.pruneBuildCache({})).rejects.toMatchObject({ name: 'EngineError', status: 500 });
  });
});
