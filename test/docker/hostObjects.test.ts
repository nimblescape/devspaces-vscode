// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The objects of the view "Docker Hosts" (R-ENG-008) on the real engine of the runner, read and changed with the Docker
// CLI of Devspaces (BootstrapDocker), as the view does: every object, also those that are not of Devspaces, with the
// networks of each container and the build cache as `docker system df` sums it; Stop and Start of a container that is
// not of Devspaces; a network that a stopped container uses stays (Docker would remove it, and the container could not
// start again), also one that a container joined after the read, with a space and a comma in its name; a container and its network go in one removal, never
// with force. Not the removal of the build cache:
// it would remove the build cache of the developer who runs the tests.
import * as crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { normalizedReference, parseDockerSize, readHostInventory, removeHostObjects, startHostContainer, stopHostContainer, type HostInventory, type HostObject } from '../../src/core/hosts/hostObjects';
import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from '../../src/core/names';
import { NodeProcessRunner } from '../../src/core/process';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { dockerTestContext } from './harness';

describe('the objects of the view "Docker Hosts" on a real engine', () => {
  const { run, env, cli, log } = dockerTestContext('hostObjects');
  const docker = new BootstrapDocker(new NodeProcessRunner(), run.dockerPath, env, log);
  const tag = crypto.randomBytes(4).toString('hex');
  // A service of Docker Compose that is not of Devspaces: its labels, without a name or a label of Devspaces.
  const project = `shop${tag}`;
  const network = `${project}_default`;
  const web = `${project}-web-1`;
  const runLabel = `${TEST_RUN_LABEL}=${run.runId}`;

  const read = (): Promise<HostInventory> => readHostInventory(docker, { known: [], baseImages: new Set() });
  const find = (objects: readonly HostObject[], name: string): HostObject => {
    const object = objects.find((candidate) => candidate.name === name);
    if (object === undefined) throw new Error(`The read found no ${name}.`);
    return object;
  };

  beforeAll(() => {
    cli.ok(['network', 'create', '--label', runLabel, '--label', `${COMPOSE_PROJECT_LABEL}=${project}`, network]);
    const labels = ['--label', runLabel, '--label', `${COMPOSE_PROJECT_LABEL}=${project}`, '--label', `${COMPOSE_SERVICE_LABEL}=web`];
    cli.ok(['run', '-d', '--name', web, '--init', '--network', network, ...labels, TEST_BASE_IMAGE, 'sleep', '600']);
  });

  afterAll(() => {
    removeRunObjects(cli, run.runId);
    cli.run(['network', 'rm', network]);
  });

  it('reads every object, also those that are not of Devspaces, with the networks of each container and the build cache', async () => {
    const inventory = await read();
    expect(find(inventory.containers, web)).toMatchObject({ kind: 'container', purpose: 'notDevspaces', role: `service web of ${project}`, state: 'running', networks: [network] });
    const own = find(inventory.networks, network);
    expect(own).toMatchObject({ kind: 'network', purpose: 'notDevspaces', role: `network of ${project}`, driver: 'bridge', usedBy: 1 });
    expect(own.builtIn).toBeUndefined();
    expect(
      inventory.networks
        .filter((object) => object.builtIn === true)
        .map((object) => object.name)
        .sort(),
    ).toEqual(['bridge', 'host', 'none']);
    // The image of the container, which is not of Devspaces either.
    const base = inventory.images.find((image) => (image.tags ?? []).some((reference) => normalizedReference(reference) === normalizedReference(TEST_BASE_IMAGE)));
    expect(base).toMatchObject({ kind: 'image', purpose: 'notDevspaces' });
    expect(base?.usedBy).toBeGreaterThanOrEqual(1);
    // The build cache as `docker system df` sums it, its size and its reclaimable space (its summary rounds to three or
    // four digits).
    const summary = cli
      .lines(['system', 'df', '--format', '{{json .}}'])
      .map((line) => JSON.parse(line) as { Type?: string; Size?: string; Reclaimable?: string })
      .find((entry) => entry.Type === 'Build Cache');
    const near = (bytes: number, text: string | undefined): void => {
      const expected = parseDockerSize(text?.replace(/\s*\(.*\)$/, '')) ?? 0;
      expect(Math.abs(bytes - expected)).toBeLessThanOrEqual(Math.max(expected * 0.01, 1_000));
    };
    near(inventory.buildCache.bytes, summary?.Size);
    near(inventory.buildCache.unusedBytes, summary?.Reclaimable);
  });

  it('stops and starts a container that is not of Devspaces, and keeps a network that the stopped container uses', async () => {
    const container = find((await read()).containers, web);
    await expect(stopHostContainer(docker, container, log)).resolves.toMatchObject({ outcome: 'stopped' });
    const stopped = await read();
    expect(find(stopped.containers, web).state).toBe('exited');
    const own = find(stopped.networks, network);
    expect(own.usedBy).toBe(1);
    await expect(removeHostObjects(docker, [own], { logger: log })).resolves.toEqual([{ object: { kind: 'network', name: network }, outcome: 'inUse', detail: 'A container uses this network.' }]);
    expect(cli.lines(['network', 'ls', '-q', '--filter', `label=${runLabel}`])).toHaveLength(1);
    await expect(startHostContainer(docker, container, log)).resolves.toMatchObject({ outcome: 'started' });
    expect(find((await read()).containers, web).state).toBe('running');
  });

  it('keeps a running container, and removes a stopped container and its network in one removal, never with force', async () => {
    const running = find((await read()).containers, web);
    await expect(removeHostObjects(docker, [running], { logger: log })).resolves.toMatchObject([{ outcome: 'inUse' }]);
    await stopHostContainer(docker, running, log);
    const stopped = await read();
    const results = await removeHostObjects(docker, [find(stopped.networks, network), find(stopped.containers, web)], { logger: log });
    expect(results.map((result) => [result.object.kind, result.outcome])).toEqual([
      ['container', 'removed'],
      ['network', 'removed'],
    ]);
    const after = await read();
    expect(after.containers.map((object) => object.name)).not.toContain(web);
    expect(after.networks.map((object) => object.name)).not.toContain(network);
  });

  it('keeps a network with a space and a comma in its name that a container joined after the read and never started', async () => {
    // The Docker CLI drops the spaces at the start and end of a name in a filter and in `network rm <name>`: the removal
    // reads the names of the networks of all containers, and removes by ID.
    const late = ` late,${tag}`;
    const lateWeb = `late-${tag}`;
    const lateId = cli.lines(['network', 'create', '--label', runLabel, late])[0];
    try {
      const seen = find((await read()).networks, late);
      expect(seen.usedBy).toBe(0);
      // A container that never ran has no ID of its network yet: the removal finds it by the name of the network.
      cli.ok(['create', '--name', lateWeb, '--label', runLabel, '--network', late, TEST_BASE_IMAGE, 'true']);
      await expect(removeHostObjects(docker, [seen], { logger: log })).resolves.toEqual([{ object: { kind: 'network', name: late }, outcome: 'inUse', detail: 'A container uses this network.' }]);
      expect(find((await read()).networks, late).usedBy).toBe(1);
      cli.ok(['rm', lateWeb]);
      await expect(removeHostObjects(docker, [seen], { logger: log })).resolves.toMatchObject([{ outcome: 'removed' }]);
    } finally {
      cli.run(['rm', lateWeb]);
      cli.run(['network', 'rm', lateId]);
    }
  });
});
