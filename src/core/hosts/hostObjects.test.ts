// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The objects on a Docker host (the view "Docker Hosts", R-ENG-008): all objects of `docker system df -v` and of
// `docker network ls`, with every tag of each image from `docker image ls`, those of Devspaces with their purpose, their
// sizes, the build cache, which objects the running containers use, and their start, stop and removal without force.
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger, type RunOptions, type RunResult } from '../ports';
import { resourceName } from '../names';
import type { Devspace } from '../types';
import {
  baseImageReferences,
  BUILD_CACHE_PRUNE_ARGS,
  buildInventory,
  earlierHelperBuildName,
  isEarlierHelperBuild,
  formatSize,
  helperBaseImageReferences,
  IMAGE_TAGS_ARGS,
  imageTagsNowArgs,
  imageUsersNowArgs,
  knownDevspace,
  NETWORK_LS_ARGS,
  NETWORK_USERS_ARGS,
  normalizedReference,
  parseDockerSize,
  pruneBuildCache,
  readHostInventory,
  removeHostObjects,
  RUNNING_USES_BATCH,
  runningUsesArgs,
  RUNNING_DEVSPACES_ARGS,
  runningDevspaces,
  startHostContainer,
  stopHostContainer,
  SYSTEM_DF_ARGS,
  totalSize,
  type HostObject,
  type InventoryInput,
} from './hostObjects';

const DEVSPACE_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '99999999-2222-4333-8444-555555555555';
/** The repository of the images of the devspace (devspaceImageRepository). */
const IMAGE = resourceName('majikmate/web', DEVSPACE_ID);

const silent: Logger = silentLogger;

function devspace(overrides: Partial<Devspace> = {}): Devspace {
  return {
    id: DEVSPACE_ID,
    repository: 'majikmate/web',
    configPath: '.devcontainer/devcontainer.json',
    volumeName: 'devspaces-majikmate-web-config-curious-hopper',
    containerName: 'devspaces-majikmate-web-config-curious-hopper',
    createdAt: '2026-11-10T10:00:00.000Z',
    lastUsedAt: '2026-11-10T10:00:00.000Z',
    ...overrides,
  } as Devspace;
}

function input(df: unknown, overrides: Partial<InventoryInput> = {}): InventoryInput {
  return { df, devspaceImageIds: new Set(), helperImageIds: new Set(), known: [knownDevspace(devspace())], baseImages: new Set(), helperBaseImages: new Set(), ...overrides };
}

describe('sizes', () => {
  it('reads the sizes of the Docker CLI in its decimal units', () => {
    expect(parseDockerSize('0B')).toBe(0);
    expect(parseDockerSize('11.2kB')).toBe(11_200);
    expect(parseDockerSize('412MB')).toBe(412_000_000);
    expect(parseDockerSize('3.1GB')).toBe(3_100_000_000);
    expect(parseDockerSize('4.1kB (virtual 11.2kB)')).toBe(4_100);
    expect(parseDockerSize('N/A')).toBeUndefined();
    expect(parseDockerSize(undefined)).toBeUndefined();
  });

  it('writes sizes for the user', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(840_000)).toBe('840 kB');
    expect(formatSize(412_000_000)).toBe('412 MB');
    expect(formatSize(3_140_000_000)).toBe('3.1 GB');
  });

  it('sums the sizes of a group, the images by the bytes that only they use', () => {
    const objects: HostObject[] = [
      { kind: 'image', id: 'a', name: 'a', purpose: 'other', sizeBytes: 100, uniqueBytes: 10 },
      { kind: 'image', id: 'b', name: 'b', purpose: 'other', sizeBytes: 50 },
    ];
    expect(totalSize(objects)).toEqual({ bytes: 60, complete: true });
    expect(totalSize([{ kind: 'volume', id: 'v', name: 'v', purpose: 'other' }])).toEqual({ bytes: 0, complete: false });
  });
});

describe('references of base images', () => {
  it('compares a reference of a configuration with a tag of docker image ls', () => {
    expect(normalizedReference('ubuntu')).toBe('ubuntu:latest');
    expect(normalizedReference('docker.io/library/ubuntu:24.04')).toBe('ubuntu:24.04');
    expect(normalizedReference('mcr.microsoft.com/devcontainers/base:bookworm@sha256:abc')).toBe('mcr.microsoft.com/devcontainers/base:bookworm');
    expect(normalizedReference('localhost:5000/team/image')).toBe('localhost:5000/team/image:latest');
  });

  it('takes the images of the build records and the default image, not the images of other services', () => {
    const references = baseImageReferences([
      devspace({
        buildRecord: {
          builtAt: '',
          devspaceImage: 'x:1',
          buildNumber: 1,
          configPath: '',
          configHash: '',
          images: { 'mcr.microsoft.com/devcontainers/base:bookworm': 'sha256:1', 'postgres:16': 'sha256:2' },
          features: {},
          compose: { service: 'app', images: [], serviceImages: ['postgres:16'], version: '2', inputsHash: '' },
        },
      }),
      devspace({ defaultImage: 'ghcr.io/majikmate/web:latest' }),
    ]);
    expect([...references].sort()).toEqual(['ghcr.io/majikmate/web:latest', 'mcr.microsoft.com/devcontainers/base:bookworm']);
  });

  it('takes the first FROM of the Dockerfile of the helper image, with the default of its ARG', () => {
    expect([...helperBaseImageReferences('# syntax=docker/dockerfile:1\nARG BASE_IMAGE=node:24-trixie-slim\nFROM ${BASE_IMAGE}\nRUN true\n')]).toEqual(['node:24-trixie-slim']);
    expect([...helperBaseImageReferences('FROM docker.io/library/debian:13 AS base\nFROM base\n')]).toEqual(['debian:13']);
    expect(helperBaseImageReferences('RUN true\n').size).toBe(0);
    expect(helperBaseImageReferences('FROM scratch\n').size).toBe(0);
  });
});

describe('buildInventory', () => {
  const df = {
    Containers: [
      { ID: 'c1', Names: 'devspaces-majikmate-web-config-curious-hopper', State: 'running', Status: 'Up 2 hours', Size: '1.2MB', Networks: 'devspaces-majikmate-web-config-curious-hopper_default', Labels: `nimblescape.devspaces.id=${DEVSPACE_ID},devcontainer.metadata=[{"a":1,"b":2}]` },
      { ID: 'c2', Names: 'devspaces-majikmate-web-config-curious-hopper-db-1', State: 'exited', Networks: 'devspaces-majikmate-web-config-curious-hopper_default', Labels: `nimblescape.devspaces.id=${DEVSPACE_ID},nimblescape.devspaces.compose-service=db` },
      { ID: 'c3', Names: 'devspaces-monitor', State: 'running', Networks: 'bridge', Labels: 'nimblescape.devspaces.monitor=abc' },
      { ID: 'c4', Names: 'devspaces-majikmate-web-config-curious-hopper-worker1', State: 'running', Labels: 'nimblescape.devspaces.worker-run=1' },
      { ID: 'c5', Names: 'devspaces-batch-1', State: 'exited', Labels: 'nimblescape.devspaces.worker-run=1,nimblescape.devspaces.channel-step=s1' },
      { ID: 'c6', Names: 'devspaces-build-1', State: 'running', Labels: 'nimblescape.devspaces.build-run=x' },
      { ID: 'c7', Names: 'devspaces-other-repo-default-brave-curie', State: 'exited', Labels: `nimblescape.devspaces.id=${OTHER_ID},nimblescape.devspaces.repository=someone/repo` },
      { ID: 'c8', Names: 'my-postgres', State: 'running', Networks: 'bridge', Labels: 'com.example=1' },
      { ID: 'c9', Names: 'shop-web-1', State: 'exited', Image: 'node:22', Networks: 'shop_default, bridge', Labels: 'com.docker.compose.project=shop,com.docker.compose.service=web' },
    ],
    Images: [
      { ID: 'sha256:w', Repository: 'devspaces-worker', Tag: '6ba87151934c', Size: '412MB', UniqueSize: '12MB', Containers: '2' },
      { ID: 'sha256:w', Repository: 'devspaces-monitor', Tag: 'abc', Size: '412MB', UniqueSize: '12MB', Containers: '2' },
      { ID: 'sha256:b', Repository: 'devspaces-buildx', Tag: '0.30.1', Size: '80MB' },
      { ID: 'sha256:d', Repository: IMAGE, Tag: '3', Size: '2GB', UniqueSize: '200MB' },
      { ID: 'sha256:p', Repository: IMAGE, Tag: 'prepared', Size: '2GB' },
      { ID: 'sha256:o', Repository: 'devspaces-other-repo-brave-curie', Tag: '1', Size: '1GB' },
      { ID: 'sha256:base', Repository: 'mcr.microsoft.com/devcontainers/base', Tag: 'bookworm', Size: '800MB' },
      { ID: 'sha256:n', Repository: 'node', Tag: '22', Size: '1GB', Containers: '1' },
      { ID: 'sha256:x', Repository: '<none>', Tag: '<none>', Size: '1MB' },
    ],
    Volumes: [
      { Name: 'devspaces-majikmate-web-config-curious-hopper', Size: '1.2GB', Links: '1', Labels: `nimblescape.devspaces.id=${DEVSPACE_ID}` },
      { Name: 'node_modules_cache', Size: '300MB', Links: '1', Labels: '' },
      { Name: 'devspaces-majikmate-web-config-curious-hopper_pgdata', Labels: `nimblescape.devspaces.id=${DEVSPACE_ID},nimblescape.devspaces.service-data=true` },
      { Name: 'devspaces-vscode', Size: '2.3GB', Links: '1', Labels: '' },
      { Name: 'devspaces-monitor', Labels: '' },
      { Name: 'devspaces-worker-cache', Labels: '' },
      { Name: 'devspaces-other-repo-default-brave-curie', Labels: `nimblescape.devspaces.id=${OTHER_ID}` },
      { Name: 'pgdata', Size: '50MB', Links: '0', Labels: '' },
    ],
    // As the Docker CLI writes them: InUse and Shared as text.
    BuildCache: [
      { ID: 'r1', Size: '1.5GB', InUse: 'false', Shared: 'false' },
      { ID: 'r2', Size: '500MB', InUse: 'true', Shared: 'false' },
      { ID: 'r3', Size: '0B', InUse: 'false', Shared: 'false' },
      { ID: 'r4', Size: '6.8MB', InUse: 'false', Shared: 'true' },
    ],
  };
  const networks = [
    { ID: 'n1', Name: 'bridge', Driver: 'bridge', Labels: '' },
    { ID: 'n2', Name: 'host', Driver: 'host', Labels: '' },
    { ID: 'n3', Name: 'none', Driver: 'null', Labels: '' },
    { ID: 'n4', Name: 'devspaces-majikmate-web-config-curious-hopper_default', Driver: 'bridge', Labels: 'com.docker.compose.project=devspaces-majikmate-web-config-curious-hopper,com.docker.compose.network=default' },
    { ID: 'n5', Name: 'shop_default', Driver: 'bridge', Labels: 'com.docker.compose.project=shop,com.docker.compose.network=default' },
    { ID: 'n6', Name: 'mynet', Driver: 'bridge', Labels: '' },
    { ID: 'n7', Name: 'devspaces-other-repo-default-brave-curie_default', Driver: 'bridge', Labels: `nimblescape.devspaces.id=${OTHER_ID}` },
    { Name: 'no ID' },
  ];
  const known = [knownDevspace(devspace({ additionalVolumes: ['node_modules_cache'] }))];
  const inventory = buildInventory(
    input(df, {
      known,
      helperImageIds: new Set(['sha256:w']),
      devspaceImageIds: new Set(['sha256:d', 'sha256:p', 'sha256:o']),
      baseImages: new Set([normalizedReference('mcr.microsoft.com/devcontainers/base:bookworm')]),
      networks,
    }),
  );
  const byName = (objects: HostObject[]) => Object.fromEntries(objects.map((object) => [object.name, object]));
  const ofDevspacesFirst = (objects: HostObject[]) => {
    const others = objects.findIndex((object) => object.purpose === 'notDevspaces');
    return others === -1 || objects.slice(others).every((object) => object.purpose === 'notDevspaces');
  };

  it('shows all containers: those of Devspaces with their purpose, then the others', () => {
    const containers = byName(inventory.containers);
    expect(containers['devspaces-majikmate-web-config-curious-hopper']).toMatchObject({ purpose: 'devspace', devspaceId: DEVSPACE_ID, repository: 'majikmate/web', role: 'dev container', state: 'running', sizeBytes: 1_200_000, networks: ['devspaces-majikmate-web-config-curious-hopper_default'] });
    expect(containers['devspaces-majikmate-web-config-curious-hopper-db-1']).toMatchObject({ purpose: 'devspace', role: 'service db', state: 'exited' });
    expect(containers['devspaces-monitor'].purpose).toBe('monitor');
    // A worker of a devspace window has a name that starts with the name of the devspace: still a worker.
    expect(containers['devspaces-majikmate-web-config-curious-hopper-worker1'].purpose).toBe('worker');
    expect(containers['devspaces-batch-1'].purpose).toBe('batchHelper');
    expect(containers['devspaces-build-1'].purpose).toBe('buildContainer');
    expect(containers['devspaces-other-repo-default-brave-curie']).toMatchObject({ purpose: 'otherDevspace', devspaceId: OTHER_ID, repository: 'someone/repo' });
    expect(containers['my-postgres']).toEqual({ kind: 'container', id: 'c8', name: 'my-postgres', purpose: 'notDevspaces', state: 'running', networks: ['bridge'], active: true });
    // A service of Docker Compose names its project and its service.
    expect(containers['shop-web-1']).toMatchObject({ purpose: 'notDevspaces', role: 'service web of shop', image: 'node:22', networks: ['shop_default', 'bridge'] });
    expect(inventory.containers.slice(-2).map((object) => object.name)).toEqual(['my-postgres', 'shop-web-1']);
    expect(ofDevspacesFirst(inventory.containers)).toBe(true);
  });

  it('shows all images, merged by ID: those of Devspaces and the base images of its devspaces with their purpose, then the others', () => {
    const images = byName(inventory.images);
    expect(Object.keys(images).sort()).toEqual(
      [
        'devspaces-buildx:0.30.1',
        `${IMAGE}:3`,
        `${IMAGE}:prepared`,
        'devspaces-other-repo-brave-curie:1',
        'devspaces-worker:6ba87151934c',
        'mcr.microsoft.com/devcontainers/base:bookworm',
        'node:22',
        '<none> (x)',
      ].sort(),
    );
    expect(images['devspaces-worker:6ba87151934c']).toMatchObject({ purpose: 'helperImage', tags: ['devspaces-worker:6ba87151934c', 'devspaces-monitor:abc'], sizeBytes: 412_000_000, uniqueBytes: 12_000_000, usedBy: 2 });
    expect(images['devspaces-buildx:0.30.1'].purpose).toBe('buildImage');
    expect(images[`${IMAGE}:3`]).toMatchObject({ purpose: 'devspace', devspaceId: DEVSPACE_ID, role: 'image' });
    expect(images[`${IMAGE}:prepared`]).toMatchObject({ purpose: 'devspace', role: 'prepared image' });
    expect(images['devspaces-other-repo-brave-curie:1'].purpose).toBe('otherDevspace');
    expect(images['mcr.microsoft.com/devcontainers/base:bookworm'].purpose).toBe('baseImage');
    expect(images['node:22']).toMatchObject({ purpose: 'notDevspaces', sizeBytes: 1_000_000_000, usedBy: 1 });
    expect(images['<none> (x)']).toMatchObject({ purpose: 'notDevspaces', tags: [] });
    expect(ofDevspacesFirst(inventory.images)).toBe(true);
  });

  it('shows all volumes: those of Devspaces with their purpose, then the others', () => {
    const volumes = byName(inventory.volumes);
    expect(volumes['devspaces-majikmate-web-config-curious-hopper']).toMatchObject({ purpose: 'devspace', role: 'workspace', sizeBytes: 1_200_000_000, usedBy: 1 });
    expect(volumes.node_modules_cache).toMatchObject({ purpose: 'devspace', role: 'additional volume' });
    expect(volumes['devspaces-majikmate-web-config-curious-hopper_pgdata']).toMatchObject({ purpose: 'devspace', role: 'data of a service' });
    expect(volumes['devspaces-vscode']).toMatchObject({ purpose: 'sharedVolume', role: 'VS Code Server and extensions' });
    expect(volumes['devspaces-monitor'].purpose).toBe('sharedVolume');
    expect(volumes['devspaces-worker-cache'].purpose).toBe('sharedVolume');
    expect(volumes['devspaces-other-repo-default-brave-curie']).toMatchObject({ purpose: 'otherDevspace', devspaceId: OTHER_ID });
    expect(volumes.pgdata).toEqual({ kind: 'volume', id: 'pgdata', name: 'pgdata', purpose: 'notDevspaces', sizeBytes: 50_000_000, usedBy: 0 });
    expect(inventory.volumes.at(-1)?.name).toBe('pgdata');
  });

  it('shows all networks with their driver and the number of containers on them; the networks of Docker itself are marked', () => {
    const shown = byName(inventory.networks);
    expect(Object.keys(shown)).not.toContain('no ID');
    expect(shown.bridge).toMatchObject({ kind: 'network', id: 'n1', purpose: 'notDevspaces', builtIn: true, role: 'network of Docker', driver: 'bridge', usedBy: 3 });
    expect(shown.host).toMatchObject({ builtIn: true, usedBy: 0 });
    expect(shown.none).toMatchObject({ builtIn: true, driver: 'null' });
    // The network of Docker Compose of a devspace of this computer, by its project (the name of the devspace).
    expect(shown['devspaces-majikmate-web-config-curious-hopper_default']).toMatchObject({ purpose: 'devspace', devspaceId: DEVSPACE_ID, repository: 'majikmate/web', role: 'network', usedBy: 2 });
    expect(shown['devspaces-other-repo-default-brave-curie_default']).toMatchObject({ purpose: 'otherDevspace', devspaceId: OTHER_ID });
    expect(shown.shop_default).toMatchObject({ purpose: 'notDevspaces', role: 'network of shop', usedBy: 1 });
    expect(shown.mynet).toEqual({ kind: 'network', id: 'n6', name: 'mynet', purpose: 'notDevspaces', usedBy: 0, driver: 'bridge' });
    expect(shown.mynet.builtIn).toBeUndefined();
    expect(ofDevspacesFirst(inventory.networks)).toBe(true);
  });

  it('counts a container for every network whose name its joined networks hold, also a name with a comma (never too few)', () => {
    const result = buildInventory(
      input(
        {
          Containers: [
            { ID: 'c1', Names: 'web', State: 'exited', Networks: 'a,b' },
            { ID: 'c2', Names: 'api', State: 'exited', Networks: 'x, a' },
            // As Docker writes them: names with a space at their start, or with a comma and a space.
            { ID: 'c3', Names: 'job', State: 'exited', Networks: ' sp,c, d' },
          ],
        },
        {
          networks: [
            { ID: 'n1', Name: 'a,b', Driver: 'bridge' },
            { ID: 'n2', Name: 'a', Driver: 'bridge' },
            { ID: 'n3', Name: 'b', Driver: 'bridge' },
            { ID: 'n4', Name: 'x', Driver: 'bridge' },
            { ID: 'n5', Name: 'ab', Driver: 'bridge' },
            { ID: 'n6', Name: ' sp', Driver: 'bridge' },
            { ID: 'n7', Name: 'c, d', Driver: 'bridge' },
          ],
        },
      ),
    );
    const shown = byName(result.networks);
    expect(shown['a,b'].usedBy).toBe(1);
    // `a` and `b` count the container on `a,b` too: a network is kept rather than removed under a container.
    expect(shown.a.usedBy).toBe(2);
    expect(shown.b.usedBy).toBe(1);
    expect(shown.x.usedBy).toBe(1);
    expect(shown.ab.usedBy).toBe(0);
    expect(shown[' sp'].usedBy).toBe(1);
    expect(shown['c, d'].usedBy).toBe(1);
  });

  it('marks the active objects by the fields of docker system df -v when the running containers could not be read', () => {
    const result = buildInventory(
      input(
        {
          Containers: [
            { ID: 'c1', Names: 'db', State: 'running', Image: 'postgres:17', Mounts: 'pgdata,/srv/backup', Networks: 'shop_default' },
            { ID: 'c2', Names: 'cache', State: 'paused', Image: 'sha256:0123456789abcdef', Mounts: '', Networks: 'bridge' },
            { ID: 'c3', Names: 'web', State: 'restarting', Image: 'node', Mounts: 'webdata', Networks: 'bridge, web_default' },
            { ID: 'c4', Names: 'job', State: 'created', Image: 'busybox', Mounts: 'jobdata', Networks: 'none' },
            { ID: 'c5', Names: 'bind', State: 'running', Image: 'alpine', Mounts: '/srv/x,ghost', Networks: '' },
          ],
          Images: [
            { ID: 'sha256:aaa', Repository: 'postgres', Tag: '17' },
            { ID: 'sha256:0123456789abcdef', Repository: 'redis', Tag: '8' },
            { ID: 'sha256:ccc', Repository: 'node', Tag: 'latest' },
            { ID: 'sha256:ddd', Repository: 'busybox', Tag: 'latest' },
            { ID: 'sha256:eee', Repository: 'alpine', Tag: 'latest' },
          ],
          Volumes: [
            { Name: 'pgdata', Links: '1' },
            { Name: 'webdata', Links: '1' },
            { Name: 'backup', Links: '0' },
            { Name: 'jobdata', Links: '1' },
            { Name: 'ghost', Links: '0' },
          ],
        },
        {
          networks: [
            { ID: 'n1', Name: 'shop_default', Driver: 'bridge' },
            { ID: 'n2', Name: 'bridge', Driver: 'bridge' },
            { ID: 'n3', Name: 'web_default', Driver: 'bridge' },
            { ID: 'n4', Name: 'none', Driver: 'null' },
          ],
        },
      ),
    );
    const activeNames = (objects: readonly HostObject[]): string[] => objects.filter((object) => object.active === true).map((object) => object.name);
    // Paused and restarting hold their memory: they count as running; created does not.
    expect(activeNames(result.containers)).toEqual(['bind', 'cache', 'db', 'web']);
    // By tag, also without `:latest` (`node`, `alpine`), or by the ID that Docker names when a tag moved.
    expect(activeNames(result.images)).toEqual(['alpine:latest', 'node:latest', 'postgres:17', 'redis:8']);
    // A bind mount (`/srv/backup`) names no volume; `ghost` follows a comma in a path, and no container of it counts.
    expect(activeNames(result.volumes)).toEqual(['pgdata', 'webdata']);
    // `bridge, web_default`: a network after a comma and a space.
    expect(activeNames(result.networks)).toEqual(['bridge', 'shop_default', 'web_default']);
    // `active` is only set when true.
    expect(Object.keys(result.volumes.find((volume) => volume.name === 'backup') ?? {})).not.toContain('active');
  });

  it('marks the active objects exactly by what the running containers use: the ID of the image, the volumes, the networks', () => {
    const id = (digit: string): string => `sha256:${digit.repeat(64)}`;
    const result = buildInventory(
      input(
        {
          Containers: [
            // Created from a second tag: docker system df -v lists the image with its first tag only.
            { ID: 'c1', Names: 'db', State: 'running', Image: 'postgres:latest', Mounts: 'pgdata', Networks: 'a,b' },
            // Created from a digest: it names neither a tag nor the ID.
            { ID: 'c2', Names: 'pinned', State: 'running', Image: `redis@${id('9')}`, Mounts: '/srv/x,ghost', Networks: 'bridge' },
            { ID: 'c3', Names: 'old', State: 'exited', Image: 'node', Mounts: 'webdata', Networks: 'web_default' },
          ],
          Images: [
            { ID: id('a'), Repository: 'postgres', Tag: '17' },
            { ID: id('b'), Repository: 'redis', Tag: '8' },
            { ID: id('c'), Repository: 'redis', Tag: 'latest' },
            { ID: id('d'), Repository: 'node', Tag: 'latest' },
          ],
          Volumes: [
            { Name: 'pgdata', Links: '1' },
            { Name: 'ghost', Links: '1' },
            { Name: 'webdata', Links: '1' },
          ],
        },
        {
          networks: [
            { ID: 'n1', Name: 'a,b', Driver: 'bridge' },
            { ID: 'n2', Name: 'a', Driver: 'bridge' },
            { ID: 'n3', Name: 'bridge', Driver: 'bridge' },
            { ID: 'n4', Name: 'web_default', Driver: 'bridge' },
          ],
          running: [
            { image: id('a'), mounts: [{ Type: 'volume', Name: 'pgdata', Source: '/var/lib/docker/volumes/pgdata/_data' }], networks: { 'a,b': {} } },
            { image: id('b').replace('sha256:', ''), mounts: [{ Type: 'bind', Source: '/srv/x,ghost' }], networks: { bridge: {} } },
            'not an entry',
          ],
        },
      ),
    );
    const activeNames = (objects: readonly HostObject[]): string[] => objects.filter((object) => object.active === true).map((object) => object.name);
    expect(activeNames(result.containers)).toEqual(['db', 'pinned']);
    expect(activeNames(result.images)).toEqual(['postgres:17', 'redis:8']);
    // A bind mount names no volume, also with a comma in its path; a stopped container uses `webdata`.
    expect(activeNames(result.volumes)).toEqual(['pgdata']);
    expect(activeNames(result.networks)).toEqual(['a,b', 'bridge']);
  });

  it('marks the networks of Docker Swarm as networks of Docker', () => {
    const result = buildInventory(
      input(undefined, {
        networks: [
          { ID: 'n1', Name: 'ingress', Driver: 'overlay', Scope: 'swarm' },
          { ID: 'n2', Name: 'docker_gwbridge', Driver: 'bridge', Scope: 'local' },
          { ID: 'n3', Name: 'ingress', Driver: 'bridge', Scope: 'local' },
        ],
      }),
    );
    expect(result.networks.map((network) => [network.id, network.builtIn === true])).toEqual([
      ['n2', true],
      ['n1', true],
      ['n3', false],
    ]);
  });

  it('sums the build cache as docker system df does: all its records, and those that no build uses and no image shares', () => {
    expect(inventory.buildCache).toEqual({ records: 4, bytes: 2_006_800_000, unusedBytes: 1_500_000_000 });
    expect(buildInventory(input({ BuildCache: [{ Size: '1GB', InUse: true }, 'not a record'] })).buildCache).toEqual({ records: 1, bytes: 1_000_000_000, unusedBytes: 0 });
  });

  it('gives each image every tag of docker image ls, after the tag of docker system df -v, and the tags of Devspaces first', () => {
    const result = buildInventory(
      input(
        { Images: [{ ID: 'sha256:s', Repository: 'shop', Tag: 'a' }, { ID: 'sha256:w', Repository: 'devspaces-worker', Tag: '1' }] },
        {
          imageTags: [
            { ID: 'sha256:s', Repository: 'shop', Tag: 'a' },
            { ID: 'sha256:s', Repository: 'shop', Tag: 'b' },
            { ID: 'sha256:s', Repository: 'registry.example/shop', Tag: 'c' },
            { ID: 'sha256:w', Repository: 'mirror/worker', Tag: '1' },
            { ID: 'sha256:w', Repository: 'devspaces-monitor', Tag: '1' },
            // A dangling image, an image that docker system df -v does not list, and no entry: no tag.
            { ID: 'sha256:s', Repository: '<none>', Tag: '<none>' },
            { ID: 'sha256:gone', Repository: 'gone', Tag: '1' },
            'not an entry',
          ],
        },
      ),
    );
    expect(result.images.map((image) => [image.name, image.tags])).toEqual([
      ['devspaces-worker:1', ['devspaces-worker:1', 'devspaces-monitor:1', 'mirror/worker:1']],
      ['shop:a', ['shop:a', 'shop:b', 'registry.example/shop:c']],
    ]);
  });

  it('marks an image active by the ID in the digest of the field Image when the running containers could not be read', () => {
    const id = (digit: string): string => `sha256:${digit.repeat(64)}`;
    const result = buildInventory(
      input({
        Containers: [
          // Created from a digest; redis:latest is another image. With the classic image store the digest is a digest
          // of the registry: no image.
          { ID: 'c1', Names: 'cache', State: 'running', Image: `redis@${id('a')}` },
          { ID: 'c2', Names: 'queue', State: 'running', Image: `rabbitmq:4@${id('c')}` },
          { ID: 'c3', Names: 'mail', State: 'running', Image: `mail@${id('f')}` },
        ],
        Images: [
          { ID: id('a'), Repository: 'redis', Tag: '8' },
          { ID: id('b'), Repository: 'redis', Tag: 'latest' },
          { ID: id('c'), Repository: 'rabbitmq', Tag: '3' },
          { ID: id('d'), Repository: 'rabbitmq', Tag: '4' },
          { ID: id('e'), Repository: 'mail', Tag: 'latest' },
        ],
      }),
    );
    expect(result.images.filter((image) => image.active === true).map((image) => image.name)).toEqual(['rabbitmq:3', 'redis:8']);
  });

  it('names an image without a tag by its short ID', () => {
    const result = buildInventory(input({ Images: [{ ID: 'sha256:0123456789abcdef', Repository: '<none>', Tag: '<none>' }] }));
    expect(result.images[0]).toMatchObject({ name: '<none> (0123456789ab)', tags: [], purpose: 'notDevspaces' });
  });

  it('names a helper image without a tag as an earlier build of the helper image', () => {
    const result = buildInventory(input({ Images: [{ ID: 'sha256:547784e940da0123', Repository: '<none>', Tag: '<none>' }] }, { helperImageIds: new Set(['sha256:547784e940da0123']) }));
    expect(result.images[0]).toMatchObject({ name: 'devspaces-worker (earlier build, 547784e940da)', tags: [], purpose: 'helperImage' });
    expect(earlierHelperBuildName('547784e940da0123')).toBe('devspaces-worker (earlier build, 547784e940da)');
  });

  it('keeps the tag as the name of an image that the user built from the helper image (it has the label of the helper image)', () => {
    const result = buildInventory(input({ Images: [{ ID: 'sha256:mine', Repository: 'myapp', Tag: '1' }] }, { helperImageIds: new Set(['sha256:mine']) }));
    expect(result.images[0]).toMatchObject({ name: 'myapp:1', purpose: 'helperImage' });
    expect(isEarlierHelperBuild(result.images[0])).toBe(false);
  });

  it('names a helper image that kept only its monitor tag as an earlier build: a rebuild took its helper tag', () => {
    const result = buildInventory(
      input(
        {
          Images: [
            { ID: 'sha256:old', Repository: 'devspaces-monitor', Tag: '6ba87151934c' },
            { ID: 'sha256:new', Repository: 'devspaces-worker', Tag: '6ba87151934c' },
          ],
        },
        { helperImageIds: new Set(['sha256:old', 'sha256:new']) },
      ),
    );
    expect(result.images.map((image) => [image.name, image.tags])).toEqual([
      ['devspaces-worker (earlier build, old)', ['devspaces-monitor:6ba87151934c']],
      ['devspaces-worker:6ba87151934c', ['devspaces-worker:6ba87151934c']],
    ]);
  });

  it('names a helper image by its helper tag, also when docker system df -v lists its monitor tag first', () => {
    const result = buildInventory(
      input(
        { Images: [{ ID: 'sha256:w', Repository: 'devspaces-monitor', Tag: '6ba87151934c', Size: '721MB' }] },
        { helperImageIds: new Set(['sha256:w']), imageTags: [{ ID: 'sha256:w', Repository: 'devspaces-monitor', Tag: '6ba87151934c' }, { ID: 'sha256:w', Repository: 'devspaces-worker', Tag: '6ba87151934c' }] },
      ),
    );
    expect(result.images[0]).toMatchObject({ name: 'devspaces-worker:6ba87151934c', tags: ['devspaces-worker:6ba87151934c', 'devspaces-monitor:6ba87151934c'], purpose: 'helperImage' });
  });

  it('marks the base image of the helper image, unless a devspace names it as its base image too', () => {
    const images = { Images: [{ ID: 'sha256:n', Repository: 'node', Tag: '24-trixie-slim' }] };
    const helperBaseImages = new Set(['node:24-trixie-slim']);
    expect(buildInventory(input(images, { helperBaseImages })).images[0]).toMatchObject({ name: 'node:24-trixie-slim', purpose: 'helperBaseImage' });
    expect(buildInventory(input(images, { helperBaseImages, baseImages: new Set(['node:24-trixie-slim']) })).images[0]).toMatchObject({ purpose: 'baseImage' });
    expect(buildInventory(input(images)).images[0]).toMatchObject({ purpose: 'notDevspaces' });
  });

  it('gives an empty inventory for output without the lists', () => {
    expect(buildInventory(input(undefined))).toEqual({ containers: [], networks: [], images: [], volumes: [], buildCache: { records: 0, bytes: 0, unusedBytes: 0 } });
  });
});

/** A Docker CLI of a test: answers by the first words of the call, and records the calls. */
function fakeDocker(answers: Record<string, RunResult>, images: Record<string, string[]> = {}) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: readonly string[], _options?: RunOptions): Promise<RunResult> => {
      calls.push([...args]);
      const key = Object.keys(answers).find((start) => args.join(' ').startsWith(start));
      return key === undefined ? { exitCode: 0, stdout: '', stderr: '', timedOut: false } : answers[key];
    },
    listImagesByLabel: async (label: string) => (images[label] ?? []).map((id) => ({ id, tags: [], createdAt: '' })),
  };
}

const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr: string): RunResult => ({ exitCode: 1, stdout: '', stderr, timedOut: false });

describe('readHostInventory', () => {
  it('reads one docker system df -v, the images with the labels of Devspaces and docker network ls', async () => {
    const docker = fakeDocker(
      {
        'system df': ok(JSON.stringify({ Images: [{ ID: 'sha256:w', Repository: '<none>', Tag: '<none>' }], Containers: [{ ID: 'c1', Names: 'web', State: 'running', Networks: 'mynet' }], Volumes: [] })),
        'network ls': ok([JSON.stringify({ ID: 'n1', Name: 'bridge', Driver: 'bridge' }), JSON.stringify({ ID: 'n2', Name: 'mynet', Driver: 'bridge' })].join('\n')),
      },
      { 'nimblescape.devspaces.worker=true': ['sha256:w'] },
    );
    const inventory = await readHostInventory(docker, { known: [], baseImages: new Set(), helperBaseImages: new Set() });
    expect(docker.calls).toEqual([[...SYSTEM_DF_ARGS], [...NETWORK_LS_ARGS], [...IMAGE_TAGS_ARGS], runningUsesArgs(['c1'])]);
    expect(SYSTEM_DF_ARGS).toEqual(['system', 'df', '--verbose', '--format', '{{json .}}']);
    expect(IMAGE_TAGS_ARGS).toEqual(['image', 'ls', '--no-trunc', '--format', '{{json .}}']);
    expect(inventory.images.map((image) => image.purpose)).toEqual(['helperImage']);
    expect(inventory.networks.map((network) => [network.name, network.usedBy])).toEqual([
      ['bridge', 0],
      ['mynet', 1],
    ]);
  });

  it('reads what the running containers use with docker container inspect, in batches, and only when containers run', async () => {
    expect(runningUsesArgs(['c1', 'c2'])).toEqual([
      'container',
      'inspect',
      '--format',
      '{"image":{{json .Image}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}',
      'c1',
      'c2',
    ]);
    const containers = Array.from({ length: RUNNING_USES_BATCH + 1 }, (_, index) => ({ ID: `c${index}`, Names: `n${index}`, State: index === 0 ? 'exited' : 'running', Image: 'node' }));
    const many = fakeDocker({ 'system df': ok(JSON.stringify({ Containers: [...containers, { ID: 'p', Names: 'p', State: 'paused' }] })) });
    await readHostInventory(many, { known: [], baseImages: new Set(), helperBaseImages: new Set() });
    const inspects = many.calls.filter((call) => call[0] === 'container');
    expect(inspects.map((call) => call.length - 4)).toEqual([RUNNING_USES_BATCH, 1]);
    expect(inspects.flatMap((call) => call.slice(4))).not.toContain('c0');
    expect(inspects[1].slice(4)).toEqual(['p']);

    const none = fakeDocker({ 'system df': ok(JSON.stringify({ Containers: [{ ID: 'c1', Names: 'web', State: 'exited' }] })) });
    await readHostInventory(none, { known: [], baseImages: new Set(), helperBaseImages: new Set() });
    expect(none.calls.map((call) => call[0])).toEqual(['system', 'network', 'image']);
  });

  it('merges the batches of docker container inspect, takes the fields of docker system df -v when a later batch fails, and passes on a cancel', async () => {
    const id = (digit: string): string => `sha256:${digit.repeat(64)}`;
    const containers = Array.from({ length: RUNNING_USES_BATCH + 1 }, (_, index) => ({ ID: `c${index}`, Names: `n${index}`, State: 'running', Image: 'busybox' }));
    const df = JSON.stringify({
      Containers: containers,
      Images: [
        { ID: id('a'), Repository: 'nginx', Tag: '1' },
        { ID: id('b'), Repository: 'redis', Tag: '8' },
        { ID: id('c'), Repository: 'busybox', Tag: 'latest' },
      ],
      Volumes: [
        { Name: 'first', Links: '1' },
        { Name: 'second', Links: '1' },
      ],
    });
    const line = (image: string, volume: string): string => JSON.stringify({ image, mounts: [{ Type: 'volume', Name: volume }], networks: {} });
    /** A Docker whose inspect of the first batch says nginx:1 and the volume first, and of the second `second`. */
    const batches = (second: RunResult, signals: Array<AbortSignal | undefined> = []) => ({
      run: async (args: readonly string[], options?: RunOptions): Promise<RunResult> => {
        if (args[0] === 'system') return ok(df);
        if (args[0] !== 'container') return ok();
        signals.push(options?.signal);
        return args.length - 4 === RUNNING_USES_BATCH ? ok(line(id('a'), 'first')) : second;
      },
      listImagesByLabel: async () => [],
    });
    const active = (objects: readonly HostObject[]): string[] => objects.filter((object) => object.active === true).map((object) => object.name);
    const merged = await readHostInventory(batches(ok(line(id('b'), 'second'))), { known: [], baseImages: new Set(), helperBaseImages: new Set() });
    expect(active(merged.images)).toEqual(['nginx:1', 'redis:8']);
    expect(active(merged.volumes)).toEqual(['first', 'second']);
    // A later batch that fails or does not end in time: not the uses of the first batch alone, but the fields of
    // docker system df -v (the containers name busybox and no volume).
    for (const second of [fail('permission denied\n'), { exitCode: 0, stdout: '', stderr: '', timedOut: true }]) {
      const fallback = await readHostInventory(batches(second), { known: [], baseImages: new Set(), helperBaseImages: new Set() });
      expect(active(fallback.images)).toEqual(['busybox:latest']);
      expect(active(fallback.volumes)).toEqual([]);
    }
    // The signal reaches each inspect, and a cancel during the inspect ends the read.
    const abort = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    await readHostInventory(batches(ok(), signals), { known: [], baseImages: new Set(), helperBaseImages: new Set(), signal: abort.signal });
    expect(signals).toEqual([abort.signal, abort.signal]);
    const cancelled = {
      ...batches(ok()),
      run: async (args: readonly string[], options?: RunOptions): Promise<RunResult> => {
        if (args[0] === 'system') return ok(df);
        if (args[0] !== 'container') return ok();
        abort.abort();
        if (options?.signal?.aborted === true) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
        return ok();
      },
    };
    await expect(readHostInventory(cancelled, { known: [], baseImages: new Set(), helperBaseImages: new Set(), signal: abort.signal })).rejects.toThrow(/aborted/);
  });

  it('leaves out a container that is gone, and takes the fields of docker system df -v when docker container inspect fails', async () => {
    const df = JSON.stringify({
      Containers: [
        { ID: 'c1', Names: 'web', State: 'running', Image: 'nginx:2', Mounts: '', Networks: 'bridge' },
        { ID: 'c2', Names: 'gone', State: 'running', Image: 'nginx:2', Mounts: '', Networks: 'bridge' },
      ],
      Images: [
        { ID: `sha256:${'a'.repeat(64)}`, Repository: 'nginx', Tag: '1' },
        { ID: `sha256:${'b'.repeat(64)}`, Repository: 'nginx', Tag: '2' },
      ],
    });
    const activeImages = (inventory: { images: HostObject[] }): string[] => inventory.images.filter((image) => image.active === true).map((image) => image.name);
    const line = JSON.stringify({ image: `sha256:${'a'.repeat(64)}`, mounts: [], networks: { bridge: {} } });
    const gone = fakeDocker({ 'system df': ok(df), 'container inspect': { exitCode: 1, stdout: line, stderr: 'Error response from daemon: No such container: c2\n', timedOut: false } });
    // Exact: `web` was created from nginx:2, which now names another image; its image is nginx:1.
    expect(activeImages(await readHostInventory(gone, { known: [], baseImages: new Set(), helperBaseImages: new Set() }))).toEqual(['nginx:1']);
    const failed = fakeDocker({ 'system df': ok(df), 'container inspect': { exitCode: 1, stdout: line, stderr: 'permission denied\n', timedOut: false } });
    expect(activeImages(await readHostInventory(failed, { known: [], baseImages: new Set(), helperBaseImages: new Set() }))).toEqual(['nginx:2']);
    const slow = fakeDocker({ 'system df': ok(df), 'container inspect': { exitCode: 0, stdout: line, stderr: '', timedOut: true } });
    expect(activeImages(await readHostInventory(slow, { known: [], baseImages: new Set(), helperBaseImages: new Set() }))).toEqual(['nginx:2']);
    // The short form of the Docker CLI says that a container is gone too.
    const short = fakeDocker({ 'system df': ok(df), 'container inspect': { exitCode: 1, stdout: line, stderr: 'Error: No such container: c2\n', timedOut: false } });
    expect(activeImages(await readHostInventory(short, { known: [], baseImages: new Set(), helperBaseImages: new Set() }))).toEqual(['nginx:1']);
    // A failure without a reason, and a gone container next to another error: the fields of docker system df -v.
    const silentFailure = fakeDocker({ 'system df': ok(df), 'container inspect': { exitCode: 1, stdout: line, stderr: '', timedOut: false } });
    expect(activeImages(await readHostInventory(silentFailure, { known: [], baseImages: new Set(), helperBaseImages: new Set() }))).toEqual(['nginx:2']);
    const mixed = fakeDocker({ 'system df': ok(df), 'container inspect': { exitCode: 1, stdout: line, stderr: 'Error response from daemon: No such container: c2\npermission denied\n', timedOut: false } });
    expect(activeImages(await readHostInventory(mixed, { known: [], baseImages: new Set(), helperBaseImages: new Set() }))).toEqual(['nginx:2']);
  });

  it('throws when docker system df, docker network ls or docker image ls fails', async () => {
    await expect(readHostInventory(fakeDocker({ 'system df': fail('Cannot connect to the Docker daemon') }), { known: [], baseImages: new Set(), helperBaseImages: new Set() })).rejects.toThrow(/Cannot connect/);
    const docker = fakeDocker({ 'system df': ok('{}'), 'network ls': fail('permission denied') });
    await expect(readHostInventory(docker, { known: [], baseImages: new Set(), helperBaseImages: new Set() })).rejects.toThrow(/permission denied/);
    // Without every tag, a removal would only untag an image.
    const tags = fakeDocker({ 'system df': ok('{}'), 'image ls': fail('Error response from daemon: denied') });
    await expect(readHostInventory(tags, { known: [], baseImages: new Set(), helperBaseImages: new Set() })).rejects.toThrow(/denied/);
  });
});

describe('runningDevspaces', () => {
  it('names each devspace that runs once: by its repository when this computer knows it, else by its container', async () => {
    const line = (id: string, name: string) => JSON.stringify({ Names: name, Labels: `nimblescape.devspaces.id=${id},com.docker.compose.service=app` });
    const docker = fakeDocker({ ps: ok([line(DEVSPACE_ID, 'devspaces-a'), line(DEVSPACE_ID, 'devspaces-a-db'), line(OTHER_ID, 'devspaces-other')].join('\n')) });
    await expect(runningDevspaces(docker, [knownDevspace(devspace())])).resolves.toEqual(['majikmate/web', 'devspaces-other']);
    expect(docker.calls).toEqual([[...RUNNING_DEVSPACES_ARGS]]);
    expect(RUNNING_DEVSPACES_ARGS).toContain('status=running');
  });

  it('throws when Docker fails', async () => {
    await expect(runningDevspaces(fakeDocker({ ps: fail('Cannot connect to the Docker daemon') }), [])).rejects.toThrow(/Cannot connect/);
  });
});

describe('stop and removal', () => {
  const container: HostObject = { kind: 'container', id: 'c1', name: 'devspaces-monitor', purpose: 'monitor', state: 'running' };
  const image: HostObject = { kind: 'image', id: 'sha256:w', name: 'devspaces-monitor:abc', tags: ['devspaces-monitor:abc', 'devspaces-worker:1'], purpose: 'helperImage' };
  const volume: HostObject = { kind: 'volume', id: 'devspaces-vscode', name: 'devspaces-vscode', purpose: 'sharedVolume' };

  it('stops a container by its ID, and says that Docker may still stop it when the stop does not end in time', async () => {
    const docker = fakeDocker({});
    expect(await stopHostContainer(docker, container, silent)).toEqual({ object: container, outcome: 'stopped' });
    expect(docker.calls).toEqual([['container', 'stop', 'c1']]);
    const late = await stopHostContainer(fakeDocker({ 'container stop': { exitCode: -1, stdout: '', stderr: '', timedOut: true } }), container, silent);
    expect(late).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/may still be stopping .*Refresh/) });
  });

  it('starts a container by its ID, and says when it is not there anymore or Docker fails', async () => {
    const stopped: HostObject = { kind: 'container', id: 'c9', name: 'shop-web-1', purpose: 'notDevspaces', state: 'exited' };
    const docker = fakeDocker({});
    expect(await startHostContainer(docker, stopped, silent)).toEqual({ object: stopped, outcome: 'started' });
    expect(docker.calls).toEqual([['container', 'start', 'c9']]);
    const gone = await startHostContainer(fakeDocker({ 'container start': fail('Error response from daemon: No such container: c9') }), stopped, silent);
    expect(gone).toMatchObject({ outcome: 'missing', detail: expect.stringMatching(/No such container/) });
    const port = await startHostContainer(fakeDocker({ 'container start': fail('Error response from daemon: driver failed programming external connectivity: port is already allocated') }), stopped, silent);
    expect(port).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/port is already allocated/) });
    // What a removal would sort as gone or in use is a failure of the start: the container is there.
    const network = await startHostContainer(fakeDocker({ 'container start': fail('Error response from daemon: failed to set up container networking: network 1538 not found') }), stopped, silent);
    expect(network).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/network 1538 not found/) });
    const inUse = await startHostContainer(fakeDocker({ 'container start': fail('Error response from daemon: listen tcp4 0.0.0.0:80: bind: address already in use') }), stopped, silent);
    expect(inUse).toMatchObject({ outcome: 'failed', detail: expect.stringMatching(/address already in use/) });
  });

  it('removes the unused build cache with docker builder prune --all, and logs what Docker counts', async () => {
    const lines: string[] = [];
    const logger: Logger = { ...silent, info: (message) => lines.push(message) };
    const docker = fakeDocker({ 'builder prune': ok('ID\tRECLAIMABLE\tSIZE\tLAST ACCESSED\nr1\ttrue\t1.5GB\t1 hour ago\nTotal:\t1.5GB\n') });
    await pruneBuildCache(docker, logger);
    expect(docker.calls).toEqual([[...BUILD_CACHE_PRUNE_ARGS]]);
    expect(BUILD_CACHE_PRUNE_ARGS).toEqual(['builder', 'prune', '--all', '--force']);
    await pruneBuildCache(fakeDocker({ 'builder prune': ok('Total reclaimed space: 300MB\n') }), logger);
    await pruneBuildCache(fakeDocker({ 'builder prune': ok('') }), logger);
    expect(lines).toEqual([
      'Removed the unused build cache; Docker counts 1.5 GB of removed records.',
      'Removed the unused build cache; Docker counts 300 MB of removed records.',
      'Removed the unused build cache.',
    ]);
    await expect(pruneBuildCache(fakeDocker({ 'builder prune': fail('Error response from daemon: a prune operation is already running') }), silent)).rejects.toThrow(/already running/);
  });

  it('removes containers first, then each tag of an image, then volumes, never with force', async () => {
    const docker = fakeDocker({
      'image inspect': ok('["devspaces-monitor:abc","devspaces-worker:1"]\n'),
      'image rm devspaces-worker:1': ok('Untagged: devspaces-worker:1\nDeleted: sha256:w\n'),
      'image rm': ok('Untagged: devspaces-monitor:abc\n'),
    });
    const results = await removeHostObjects(docker, [volume, image, { ...container, state: 'exited' }], { logger: silent });
    // The tags and the containers of the image are read just before its removal.
    expect(docker.calls).toEqual([
      ['container', 'rm', 'c1'],
      imageTagsNowArgs('sha256:w'),
      imageUsersNowArgs('sha256:w'),
      ['image', 'rm', 'devspaces-monitor:abc'],
      ['image', 'rm', 'devspaces-worker:1'],
      ['volume', 'rm', 'devspaces-vscode'],
    ]);
    expect(imageTagsNowArgs('sha256:w')).toEqual(['image', 'inspect', '--format', '{{json .RepoTags}}', 'sha256:w']);
    expect(imageUsersNowArgs('sha256:w')).toEqual(['container', 'ls', '--all', '--no-trunc', '--filter', 'ancestor=sha256:w', '--format', '{{.ID}}']);
    expect(results.map((result) => result.outcome)).toEqual(['removed', 'removed', 'removed']);
    expect(docker.calls.flat()).not.toContain('-f');
    expect(docker.calls.flat()).not.toContain('--force');
  });

  it('says what Docker refuses: a running container, a volume in use, and what is gone already', async () => {
    const docker = fakeDocker({
      'container rm': fail('Error response from daemon: cannot remove container "/devspaces-monitor": container is running: stop the container before removing or force remove'),
      'volume rm': fail('Error response from daemon: remove devspaces-vscode: volume is in use - [c1]'),
      'image inspect': fail('Error response from daemon: No such image: sha256:w'),
    });
    const results = await removeHostObjects(docker, [container, image, volume], { logger: silent });
    expect(results.map((result) => result.outcome)).toEqual(['inUse', 'missing', 'inUse']);
    expect(results[2].detail).toMatch(/volume is in use/);
  });

  it('keeps an image that a container uses now, also when the read of the view counted none, unless that container goes in the same removal', async () => {
    const tags = ok('["devspaces-monitor:abc","devspaces-worker:1"]');
    const docker = fakeDocker({ 'image inspect': tags, 'container ls': ok('c2\n') });
    const kept = await removeHostObjects(docker, [{ ...image, usedBy: 0 }], { logger: silent });
    expect(kept).toEqual([{ object: { kind: 'image', name: image.name }, outcome: 'inUse', detail: 'A container uses this image.' }]);
    // No call that untags: Docker would untag the first tags and refuse only the last one.
    expect(docker.calls).toEqual([imageTagsNowArgs('sha256:w'), imageUsersNowArgs('sha256:w')]);
    // A container of the same removal is gone when the containers of the image are read.
    const removed = new Set<string>();
    const calls: string[][] = [];
    const engine = {
      run: async (args: readonly string[]): Promise<RunResult> => {
        calls.push([...args]);
        if (args[0] === 'container' && args[1] === 'rm') {
          removed.add(args[2]);
          return ok();
        }
        if (args[0] === 'container' && args[1] === 'ls') return ok(removed.has('c2') ? '' : 'c2\n');
        if (args[1] === 'inspect') return tags;
        return ok(args[2] === 'devspaces-worker:1' ? 'Deleted: sha256:w\n' : `Untagged: ${args[2]}\n`);
      },
    };
    const worker: HostObject = { kind: 'container', id: 'c2', name: 'devspaces-w1-worker1', purpose: 'worker', state: 'exited', image: 'devspaces-worker:1' };
    const both = await removeHostObjects(engine, [{ ...image, usedBy: 1 }, worker], { logger: silent });
    expect(both.map((result) => result.outcome)).toEqual(['removed', 'removed']);
    expect(calls.map((args) => args.slice(0, 2).join(' '))).toEqual(['container rm', 'image inspect', 'container ls', 'image rm', 'image rm']);
    // An image whose containers cannot be read stays.
    const unread = await removeHostObjects(fakeDocker({ 'image inspect': tags, 'container ls': fail('Cannot connect to the Docker daemon') }), [image], { logger: silent });
    expect(unread).toEqual([{ object: { kind: 'image', name: image.name }, outcome: 'failed', detail: 'The containers of this image could not be read: Cannot connect to the Docker daemon' }]);
  });

  it('removes only the tags of the read that still name the image, and keeps an image with a tag that the view did not show', async () => {
    // devspaces-worker:1 names another image since the read: only devspaces-monitor:abc goes.
    const moved = fakeDocker({ 'image inspect': ok('["devspaces-monitor:abc"]'), 'image rm': ok('Untagged: devspaces-monitor:abc\nDeleted: sha256:w\n') });
    expect(await removeHostObjects(moved, [image], { logger: silent })).toMatchObject([{ outcome: 'removed' }]);
    expect(moved.calls.filter((args) => args[1] === 'rm')).toEqual([['image', 'rm', 'devspaces-monitor:abc']]);
    // A tag since the read: no call that untags.
    const tagged = fakeDocker({ 'image inspect': ok('["devspaces-monitor:abc","devspaces-worker:1","mine:1"]') });
    expect(await removeHostObjects(tagged, [image], { logger: silent })).toEqual([
      { object: { kind: 'image', name: image.name }, outcome: 'failed', detail: 'The image has the tag mine:1 now, which the view did not show. Click Refresh.' },
    ]);
    expect(tagged.calls).toEqual([imageTagsNowArgs('sha256:w')]);
    // Gone since the read, or Docker cannot say.
    expect(await removeHostObjects(fakeDocker({ 'image inspect': fail('Error response from daemon: No such image: sha256:w') }), [image], { logger: silent })).toMatchObject([{ outcome: 'missing' }]);
    expect(await removeHostObjects(fakeDocker({ 'image inspect': fail('permission denied') }), [image], { logger: silent })).toEqual([
      { object: { kind: 'image', name: image.name }, outcome: 'failed', detail: 'The tags of this image could not be read: permission denied' },
    ]);
    expect(await removeHostObjects(fakeDocker({ 'image inspect': ok('not json') }), [image], { logger: silent })).toMatchObject([{ outcome: 'failed', detail: expect.stringMatching(/could not be read: Docker wrote not json/) }]);
    // An image without a tag goes by its ID.
    const bare = fakeDocker({ 'image inspect': ok('[]'), 'image rm': ok('Deleted: sha256:w\n') });
    expect(await removeHostObjects(bare, [{ ...image, name: '<none> (w)', tags: [] }], { logger: silent })).toMatchObject([{ outcome: 'removed' }]);
    expect(bare.calls.at(-1)).toEqual(['image', 'rm', 'sha256:w']);
  });

  it('removes the references with a digest that RepoTags lists after the tags, and stops at the image that Docker deleted', async () => {
    const digest = `mirror.example/worker@sha256:${'1'.repeat(64)}`;
    /** An engine whose `docker image rm` answers by reference, and whose reads of the references answer in turn. */
    const engine = (answers: Record<string, RunResult>, reads: RunResult[]) => {
      const calls: string[][] = [];
      return {
        calls,
        run: async (args: readonly string[], options?: RunOptions): Promise<RunResult> => {
          calls.push([...args]);
          if (options?.signal?.aborted === true) {
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
          }
          if (args[1] === 'inspect') return reads.shift() ?? fail('Error response from daemon: No such image: sha256:w');
          if (args[1] === 'rm') return answers[args[2]] ?? ok(`Untagged: ${args[2]}\n`);
          return ok();
        },
      };
    };
    const rms = (calls: string[][]): string[] => calls.filter((args) => args[1] === 'rm').map((args) => args[2]);
    const both = ok('["devspaces-monitor:abc","devspaces-worker:1"]');
    const deleted = ok('Deleted: sha256:w\n');
    const result = (outcome: string, detail?: string) => [{ object: { kind: 'image', name: image.name }, outcome, ...(detail !== undefined ? { detail } : {}) }];

    // The containerd image store lists a pull by digest in RepoTags; the view never showed it, and it names only this image.
    const pinned = engine({ [digest]: deleted }, [ok(`["devspaces-monitor:abc","devspaces-worker:1","${digest}"]`)]);
    expect(await removeHostObjects(pinned, [image], { logger: silent })).toEqual(result('removed'));
    expect(rms(pinned.calls)).toEqual(['devspaces-monitor:abc', 'devspaces-worker:1', digest]);
    const onlyDigest = engine({ [digest]: deleted }, [ok(`["${digest}"]`)]);
    expect(await removeHostObjects(onlyDigest, [{ ...image, tags: [] }], { logger: silent })).toEqual(result('removed'));
    expect(rms(onlyDigest.calls)).toEqual([digest]);
    // Docker deletes the image with its last tag, also the references with a digest of the same repository: no further call.
    const sameDigest = `devspaces-worker@sha256:${'1'.repeat(64)}`;
    const sameRepository = engine({ 'devspaces-worker:1': deleted }, [ok(`["devspaces-monitor:abc","devspaces-worker:1","${sameDigest}"]`)]);
    expect(await removeHostObjects(sameRepository, [image], { logger: silent })).toEqual(result('removed'));
    expect(rms(sameRepository.calls)).toEqual(['devspaces-monitor:abc', 'devspaces-worker:1']);
    // The tags first, then the references with a digest, in whatever order RepoTags lists them.
    const digestFirst = engine({ [digest]: deleted }, [ok(`["${digest}","devspaces-monitor:abc","devspaces-worker:1"]`)]);
    expect(await removeHostObjects(digestFirst, [image], { logger: silent })).toEqual(result('removed'));
    expect(rms(digestFirst.calls)).toEqual(['devspaces-monitor:abc', 'devspaces-worker:1', digest]);
    // An image without a reference that is gone before its removal by ID: gone, with no second read.
    const idGone = engine({ 'sha256:w': fail('Error response from daemon: No such image: sha256:w') }, [ok('[]')]);
    expect(await removeHostObjects(idGone, [{ ...image, tags: [] }], { logger: silent })).toEqual(result('missing'));
    expect(idGone.calls.map((args) => args.slice(0, 3).join(' '))).toEqual(['image inspect --format', 'container ls --all', 'image rm sha256:w']);
    // A tag that is gone meanwhile does not stop the others.
    const gone = engine({ 'devspaces-monitor:abc': fail('Error response from daemon: No such image: devspaces-monitor:abc'), 'devspaces-worker:1': deleted }, [both]);
    expect(await removeHostObjects(gone, [image], { logger: silent })).toEqual(result('removed'));
    expect(rms(gone.calls)).toEqual(['devspaces-monitor:abc', 'devspaces-worker:1']);
    // A refusal of Docker (a container since the read) stops at once, with what Docker said.
    const conflict = fail('Error response from daemon: conflict: unable to remove repository reference "devspaces-monitor:abc" (must force) - container c3 is using its referenced image w');
    const first = engine({ 'devspaces-monitor:abc': conflict }, [both]);
    expect(await removeHostObjects(first, [image], { logger: silent })).toEqual(result('inUse', conflict.stderr));
    expect(rms(first.calls)).toEqual(['devspaces-monitor:abc']);
    const last = engine({ 'devspaces-worker:1': fail('permission denied') }, [both]);
    expect(await removeHostObjects(last, [image], { logger: silent })).toEqual(result('failed', 'permission denied'));
    expect(rms(last.calls)).toEqual(['devspaces-monitor:abc', 'devspaces-worker:1']);
    expect(last.calls.filter((args) => args[1] === 'inspect')).toHaveLength(1);

    // Each reference went, but Docker kept the image: read again.
    const kept = (after: RunResult, answers: Record<string, RunResult> = {}) => engine(answers, [both, after]);
    // Only references with a digest since the read: removed too.
    const digests = kept(ok(`["${digest}"]`), { [digest]: deleted });
    expect(await removeHostObjects(digests, [image], { logger: silent })).toEqual(result('removed'));
    expect(rms(digests.calls)).toEqual(['devspaces-monitor:abc', 'devspaces-worker:1', digest]);
    // No reference: by its ID (Docker keeps an image of the classic image store that a child image needs).
    const childless = kept(ok('[]'), { 'sha256:w': deleted });
    expect(await removeHostObjects(childless, [image], { logger: silent })).toEqual(result('removed'));
    expect(rms(childless.calls).at(-1)).toBe('sha256:w');
    expect(await removeHostObjects(kept(ok('[]'), { 'sha256:w': fail('Error response from daemon: No such image: sha256:w') }), [image], { logger: silent })).toEqual(result('removed'));
    const child = kept(ok('[]'), { 'sha256:w': fail('Error response from daemon: conflict: unable to delete w (cannot be forced) - image has dependent child images') });
    expect(await removeHostObjects(child, [image], { logger: silent })).toMatchObject(result('inUse', expect.stringMatching(/dependent child images/) as unknown as string));
    // Docker untags the new reference too and still keeps the image: it says so.
    const stuck = kept(ok(`["${digest}"]`));
    expect(await removeHostObjects(stuck, [image], { logger: silent })).toEqual(result('failed', 'Docker kept the image. Click Refresh.'));
    expect(rms(stuck.calls)).toEqual(['devspaces-monitor:abc', 'devspaces-worker:1', digest]);
    // A tag since the first read: it stays.
    const late = kept(ok('["late:1"]'));
    expect(await removeHostObjects(late, [image], { logger: silent })).toEqual(result('failed', 'Docker kept the image: it has the tag late:1 now. Click Refresh.'));
    expect(rms(late.calls)).toHaveLength(2);
    // Gone after all, or the read fails.
    expect(await removeHostObjects(kept(fail('Error response from daemon: No such image: sha256:w')), [image], { logger: silent })).toEqual(result('removed'));
    const unread = kept(fail('permission denied'));
    expect(await removeHostObjects(unread, [image], { logger: silent })).toEqual(result('failed', 'The tags of this image could not be read: permission denied'));
    expect(rms(unread.calls)).toHaveLength(2);

    // A cancel during the removal of an image ends the removal: the volume after it stays.
    const abort = new AbortController();
    const cancelled = engine({}, [both]);
    const run = cancelled.run;
    cancelled.run = async (args, options) => {
      if (args[0] === 'container' && args[1] === 'ls') abort.abort();
      return run(args, options);
    };
    await expect(removeHostObjects(cancelled, [image, volume], { logger: silent, signal: abort.signal })).rejects.toThrow(/aborted/);
    expect(cancelled.calls.map((args) => args.slice(0, 2).join(' '))).toEqual(['image inspect', 'container ls']);
  });

  it('removes a network after the containers and before the images, and keeps one that a container uses now or that Docker made', async () => {
    const network: HostObject = { kind: 'network', id: 'n6', name: 'mynet', purpose: 'notDevspaces', usedBy: 0 };
    const docker = fakeDocker({ 'image inspect': ok('["devspaces-monitor:abc","devspaces-worker:1"]'), 'image rm devspaces-worker:1': ok('Deleted: sha256:w\n') });
    const results = await removeHostObjects(docker, [volume, image, network, { ...container, state: 'exited' }], { logger: silent });
    expect(docker.calls.map((args) => args.slice(0, 2).join(' '))).toEqual(['container rm', 'container ls', 'network rm', 'image inspect', 'container ls', 'image rm', 'image rm', 'volume rm']);
    // The containers on the network are read now, with the names of their networks (also those that never ran), and it
    // is removed by its ID.
    expect(docker.calls[1]).toEqual([...NETWORK_USERS_ARGS]);
    expect(NETWORK_USERS_ARGS).toEqual(['container', 'ls', '--all', '--no-trunc', '--format', '{{json .Networks}}']);
    expect(docker.calls[2]).toEqual(['network', 'rm', 'n6']);
    expect(results.map((result) => result.outcome)).toEqual(['removed', 'removed', 'removed', 'removed']);

    // The read of now counts, not the one of the view: here two containers joined the network since the view read it.
    const bridge: HostObject = { kind: 'network', id: 'n1', name: 'bridge', purpose: 'notDevspaces', builtIn: true, usedBy: 0 };
    const joined = fakeDocker({ 'container ls': ok('"mynet"\n"bridge,mynet"\n"bridge"\n""\n') });
    expect(await removeHostObjects(joined, [network, bridge], { logger: silent })).toEqual([
      { object: { kind: 'network', name: 'mynet' }, outcome: 'inUse', detail: '2 containers use this network.' },
      { object: { kind: 'network', name: 'bridge' }, outcome: 'inUse', detail: 'Docker keeps its own networks.' },
    ]);
    expect(joined.calls).toEqual([[...NETWORK_USERS_ARGS]]);

    // A network whose containers cannot be read stays.
    const unread = await removeHostObjects(fakeDocker({ 'container ls': fail('Cannot connect to the Docker daemon') }), [network], { logger: silent });
    expect(unread).toEqual([{ object: { kind: 'network', name: 'mynet' }, outcome: 'failed', detail: 'The containers on this network could not be read: Cannot connect to the Docker daemon' }]);
    const garbled = await removeHostObjects(fakeDocker({ 'container ls': ok('mynet\n') }), [network], { logger: silent });
    expect(garbled).toMatchObject([{ outcome: 'failed', detail: expect.stringMatching(/could not be read: Docker wrote mynet/) }]);

    // Only the whole name counts (a name like `238` is no part of another name or ID), also with spaces at its start.
    const hex: HostObject = { ...network, id: 'n238', name: '238' };
    expect(await removeHostObjects(fakeDocker({ 'container ls': ok('"rvw-other-net"\n"2380"\n') }), [hex], { logger: silent })).toMatchObject([{ outcome: 'removed' }]);
    const spaced: HostObject = { ...network, id: 'nsp', name: ' sp' };
    expect(await removeHostObjects(fakeDocker({ 'container ls': ok('" sp"\n') }), [spaced], { logger: silent })).toMatchObject([{ outcome: 'inUse' }]);

    // A network whose only container goes in the same removal goes too: the read after its removal finds no container.
    const quiet = fakeDocker({});
    const web: HostObject = { kind: 'container', id: 'c9', name: 'shop-web-1', purpose: 'notDevspaces', state: 'exited', networks: ['mynet'] };
    const both = await removeHostObjects(quiet, [{ ...network, usedBy: 1 }, web], { logger: silent });
    expect(both.map((result) => result.outcome)).toEqual(['removed', 'removed']);
    expect(quiet.calls).toEqual([['container', 'rm', 'c9'], [...NETWORK_USERS_ARGS], ['network', 'rm', 'n6']]);
  });

  it('says what Docker says of a network: one with containers, and one that is gone', async () => {
    const network: HostObject = { kind: 'network', id: 'n6', name: 'mynet', purpose: 'notDevspaces', usedBy: 0 };
    const active = await removeHostObjects(fakeDocker({ 'network rm': fail('Error response from daemon: error while removing network: network mynet id n6 has active endpoints') }), [network], { logger: silent });
    expect(active.map((result) => result.outcome)).toEqual(['inUse']);
    const gone = await removeHostObjects(fakeDocker({ 'network rm': fail('Error response from daemon: network n6 not found') }), [network], { logger: silent });
    expect(gone.map((result) => result.outcome)).toEqual(['missing']);
  });

  it('passes on a cancel', async () => {
    const abort = new AbortController();
    abort.abort();
    const docker = {
      run: async (_args: readonly string[], options?: RunOptions): Promise<RunResult> => {
        if (options?.signal?.aborted === true) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
        return ok();
      },
    };
    await expect(removeHostObjects(docker, [volume], { logger: silent, signal: abort.signal })).rejects.toThrow(/aborted/);
  });
});
