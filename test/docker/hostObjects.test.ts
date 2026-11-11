// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The objects of the view "Docker Hosts" (R-ENG-008) on the real engine of the runner, read and changed with the Docker
// CLI of Devspaces (BootstrapDocker), as the view does: every object, also those that are not of Devspaces, with the
// networks of each container and the build cache as `docker system df` sums it; Stop and Start of a container that is
// not of Devspaces; a network that a stopped container uses stays (Docker would remove it, and the container could not
// start again), also one that a container joined after the read, with a space and a comma in its name; a container and its network go in one removal, never
// with force; an image with two tags goes in one removal, also with a container of its second tag, and a removal after a
// tag moved or a container started since the read; which objects a running container uses (the colors of the view), by
// the ID of its image and its mounts. Not the removal of the build cache: it would remove the build cache of the
// developer who runs the tests.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

  it('removes an image with two tags, also together with a container of its second tag, never with force', async () => {
    // `docker system df -v` names the first tag only: the read takes every tag from `docker image ls`, so that the
    // removal untags each and the last one removes the image (with one tag only, Docker would only untag it).
    const repository = `untag${tag}`;
    const source = `untag-${tag}-source`;
    const user = `untag-${tag}-user`;
    try {
      cli.ok(['create', '--name', source, '--label', runLabel, TEST_BASE_IMAGE, 'true']);
      const imageId = cli.lines(['commit', '--change', `LABEL ${runLabel}`, source, `${repository}:one`])[0];
      cli.ok(['rm', source]);
      cli.ok(['tag', `${repository}:one`, `${repository}:two`]);
      cli.ok(['create', '--name', user, '--label', runLabel, `${repository}:two`, 'true']);
      const inventory = await read();
      const image = inventory.images.find((candidate) => candidate.id === imageId);
      if (image === undefined) throw new Error(`The read found no image ${imageId}.`);
      expect([...(image.tags ?? [])].sort()).toEqual([`${repository}:one`, `${repository}:two`]);
      expect(image.usedBy).toBe(1);
      const results = await removeHostObjects(docker, [image, find(inventory.containers, user)], { logger: log });
      expect(results.map((result) => [result.object.kind, result.outcome])).toEqual([
        ['container', 'removed'],
        ['image', 'removed'],
      ]);
      expect(cli.run(['image', 'inspect', imageId]).code).not.toBe(0);
    } finally {
      cli.run(['rm', '-f', source, user]);
      cli.run(['image', 'rm', `${repository}:one`, `${repository}:two`]);
    }
  });

  it('keeps a tag that names another image since the read, and every tag of an image that a container uses since the read', async () => {
    // The rows of the view can be old: a pull or a build moves a tag, a container starts. The removal reads the tags and
    // the containers of the image again, so it never removes another image and never untags an image that stays.
    const repository = `stale${tag}`;
    const source = `stale-${tag}-source`;
    const user = `stale-${tag}-user`;
    try {
      cli.ok(['create', '--name', source, '--label', runLabel, TEST_BASE_IMAGE, 'true']);
      const first = cli.lines(['commit', '--change', `LABEL ${runLabel}`, '--change', 'LABEL stale=first', source, `${repository}:a`])[0];
      cli.ok(['tag', `${repository}:a`, `${repository}:b`]);
      const used = cli.lines(['commit', '--change', `LABEL ${runLabel}`, '--change', 'LABEL stale=used', source, `${repository}:c`])[0];
      cli.ok(['tag', `${repository}:c`, `${repository}:d`]);
      const inventory = await read();
      const byId = (id: string): HostObject => {
        const image = inventory.images.find((candidate) => candidate.id === id);
        if (image === undefined) throw new Error(`The read found no image ${id}.`);
        return image;
      };
      // Since the read: the tag b names a new image, and a container uses the tag d.
      const moved = cli.lines(['commit', '--change', `LABEL ${runLabel}`, '--change', 'LABEL stale=moved', source, `${repository}:b`])[0];
      cli.ok(['create', '--name', user, '--label', runLabel, `${repository}:d`, 'true']);
      const results = await removeHostObjects(docker, [byId(first), byId(used)], { logger: log });
      expect(results.map((result) => result.outcome)).toEqual(['removed', 'inUse']);
      expect(cli.run(['image', 'inspect', first]).code).not.toBe(0);
      expect(cli.ok(['image', 'inspect', '--format', '{{.Id}}', `${repository}:b`])).toBe(moved);
      expect(JSON.parse(cli.ok(['image', 'inspect', '--format', '{{json .RepoTags}}', used])).sort()).toEqual([`${repository}:c`, `${repository}:d`]);
    } finally {
      cli.run(['rm', '-f', source, user]);
      cli.run(['image', 'rm', `${repository}:a`, `${repository}:b`, `${repository}:c`, `${repository}:d`]);
    }
  });

  it('marks the image of a running container active also when the container names another tag of it, and a volume only when the container mounts it', async () => {
    // An image of its own with two tags: `docker system df -v` lists it with its first tag only, and the container names
    // the other one. A bind mount whose path ends with `,<name of a volume>` does not make that volume active.
    const repository = `colors${tag}`;
    const holder = `colors-${tag}`;
    const unused = `colors-unused-${tag}`;
    const used = `colors-used-${tag}`;
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'colors-'));
    const bind = path.join(folder, `x,${unused}`);
    fs.mkdirSync(bind);
    try {
      cli.ok(['create', '--name', `${holder}-source`, '--label', runLabel, TEST_BASE_IMAGE, 'true']);
      const imageId = cli.lines(['commit', '--change', `LABEL ${runLabel}`, `${holder}-source`, `${repository}:one`])[0];
      cli.ok(['tag', `${repository}:one`, `${repository}:two`]);
      cli.ok(['volume', 'create', '--label', runLabel, unused]);
      cli.ok(['volume', 'create', '--label', runLabel, used]);
      cli.ok(['run', '-d', '--name', holder, '--init', '--label', runLabel, '-v', `${bind}:/bind`, '-v', `${used}:/data`, `${repository}:two`, 'sleep', '600']);
      const inventory = await read();
      const image = inventory.images.find((candidate) => candidate.id === imageId);
      expect(image).toMatchObject({ kind: 'image', purpose: 'notDevspaces', active: true });
      expect([...(image?.tags ?? [])].sort()).toEqual([`${repository}:one`, `${repository}:two`]);
      expect(find(inventory.volumes, used).active).toBe(true);
      expect(find(inventory.volumes, unused).active).toBeUndefined();
      expect(find(inventory.containers, holder).active).toBe(true);
    } finally {
      cli.run(['rm', '-f', holder, `${holder}-source`]);
      cli.run(['volume', 'rm', unused, used]);
      cli.run(['image', 'rm', `${repository}:one`, `${repository}:two`]);
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
