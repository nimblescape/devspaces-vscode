// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reader of the shared volumes (R-ENG-008, the reports of the view Docker Hosts) on the real engine of the runner,
// with the helper image of the tests and the Docker CLI of Devspaces (BootstrapDocker), as the reports of the view
// Docker Hosts read: it reads the records of the Monitor, also a file and a folder that only their owner may read (the
// capability DAC_READ_SEARCH), the servers and extensions of the store of VS Code and the top level of the cache of the
// workers; it changes nothing in the volumes and leaves no container; a missing image is never pulled. The facts of
// Docker of a volume (readObjectDetails) name the containers that use it with the place and the mode of their mount.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import type { HelperImageUse } from '../../src/core/helper/helperImage';
import { readObjectDetails } from '../../src/core/hosts/objectDetails';
import { readSharedVolumes } from '../../src/core/hosts/volumeReader';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { dockerTestContext, runInVolume, testHelperImage } from './harness';

const COMMIT = 'c'.repeat(40);

describe('the reader of the shared volumes on a real engine', () => {
  const context = dockerTestContext('volumeReader');
  const { run, env, cli, log } = context;
  const docker = new BootstrapDocker(new NodeProcessRunner(), run.dockerPath, env, log);
  const volume = (name: string): string => {
    const full = `devspaces-test-reader-${name}-${run.runId}`;
    cli.ok(['volume', 'create', '--label', `${TEST_RUN_LABEL}=${run.runId}`, full]);
    return full;
  };
  let image: HelperImageUse;
  let monitor: string;
  let vscode: string;
  let cache: string;

  /** The files of `name` with their sizes and times (`find` in a container of the helper image). */
  const listing = async (name: string): Promise<string> => {
    const result = await runInVolume(docker, name, ['sh', '-c', 'cd /workspaces && find . -exec stat -c "%n %s %Y %a %u" {} + | sort']);
    expect(result.exitCode).toBe(0);
    return result.stdout;
  };

  beforeAll(async () => {
    image = await testHelperImage(docker, log, env);
    monitor = volume('monitor');
    vscode = volume('vscode');
    cache = volume('cache');
    const seed = async (name: string, script: string): Promise<void> => {
      const result = await runInVolume(docker, name, ['sh', '-c', `set -e; cd /workspaces; ${script}`]);
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    };
    await seed(
      monitor,
      [
        `printf '{"runs":[]}' > runs.json && chown 1234:1234 runs.json && chmod 600 runs.json`,
        `mkdir -m 700 heartbeats && printf '{}' > heartbeats/a.b.json && chown -R 1234:1234 heartbeats`,
        `printf 'partial' > cache-run.json.1.2.tmp`,
      ].join('; '),
    );
    await seed(
      vscode,
      [
        `mkdir -p server/stable/linux-x64/${COMMIT}/bin used extensions/universal tmp`,
        `printf '{"version":"1.141.0"}' > server/stable/linux-x64/${COMMIT}/product.json`,
        `printf 'node' > server/stable/linux-x64/${COMMIT}/node`,
        `printf 'sh' > server/stable/linux-x64/${COMMIT}/bin/code-server`,
        `touch used/stable-linux-x64-${COMMIT}`,
        `printf 'vsix' > extensions/universal/dbaeumer.vscode-eslint-3.0.16`,
      ].join('; '),
    );
    await seed(cache, `mkdir cli && printf '0123456789' > cli/state`);
  }, 15 * 60_000);

  afterAll(() => {
    removeRunObjects(cli, run.runId);
  });

  it('reads what each volume contains, also what only its owner may read, and changes nothing', async () => {
    const before = await Promise.all([listing(monitor), listing(vscode), listing(cache)]);
    const outcome = await readSharedVolumes(docker, { images: [image.tag], volumes: { monitor, vscode, 'worker-cache': cache } });
    if (outcome.kind !== 'read') throw new Error(`The read failed: ${JSON.stringify(outcome)}`);
    expect(outcome.image).toBe(image.tag);
    const { reading } = outcome;
    expect(reading.stopped).toBe(false);
    expect(reading.unreadable).toBe(0);
    expect(reading.monitor?.files.map(({ path, text }) => ({ path, text }))).toEqual([
      { path: 'runs.json', text: '{"runs":[]}' },
      { path: 'heartbeats/a.b.json', text: '{}' },
    ]);
    expect(reading.vscode?.servers).toEqual([
      { quality: 'stable', platform: 'linux-x64', commit: COMMIT, version: '1.141.0', modifiedAt: expect.any(Number), node: true, script: true, usage: { bytes: 21 + 4 + 2, files: 3, cut: false } },
    ]);
    expect(reading.vscode?.used.map((marker) => marker.name)).toEqual([`stable-linux-x64-${COMMIT}`]);
    expect(reading.vscode?.extensions).toEqual([{ folder: 'universal', name: 'dbaeumer.vscode-eslint-3.0.16', bytes: 4, modifiedAt: expect.any(Number) }]);
    expect(reading.workerCache?.entries.map(({ name, kind, usage }) => ({ name, kind, usage }))).toEqual([{ name: 'cli', kind: 'folder', usage: { bytes: 10, files: 1, cut: false } }]);
    // Nothing changed in the volumes, and no container of the reader is left.
    expect(await Promise.all([listing(monitor), listing(vscode), listing(cache)])).toEqual(before);
    expect(cli.lines(['ps', '-a', '-q', '--filter', 'name=^devspaces-reader-'])).toEqual([]);
  }, 5 * 60_000);

  it('names the containers that use a volume, with the place and the mode of their mount', async () => {
    const name = `devspaces-test-reader-user-${run.runId}`;
    cli.ok(['container', 'create', '--label', `${TEST_RUN_LABEL}=${run.runId}`, '--name', name, '--mount', `type=volume,source=${vscode},target=/vscode,readonly`, image.tag, 'true']);
    const details = await readObjectDetails(docker, { kind: 'volume', id: vscode });
    expect(details).toMatchObject({ kind: 'volume', driver: 'local', moreUsers: false, users: [{ name, state: 'created', destination: '/vscode', readOnly: true }] });
    expect(details.createdAt).toEqual(expect.any(String));
  }, 5 * 60_000);

  it('never pulls: an image that the engine does not have gives the next one, or none', async () => {
    const missing = 'devspaces-worker:000000000000';
    expect(await readSharedVolumes(docker, { images: [missing], volumes: { monitor } })).toEqual({ kind: 'noImage' });
    expect(cli.image(missing)).toBeUndefined();
    expect(await readSharedVolumes(docker, { images: [missing, image.tag], volumes: { monitor } })).toMatchObject({ kind: 'read', image: image.tag });
  }, 5 * 60_000);
});
