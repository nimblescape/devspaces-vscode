// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The objects on a Docker host (the view "Docker Hosts", R-ENG-008): all objects of `docker system df -v` and of
// `docker network ls`, those of Devspaces with their purpose, their sizes, the build cache, and their start, stop and
// removal without force.
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger, type RunOptions, type RunResult } from '../ports';
import { resourceName } from '../names';
import type { Devspace } from '../types';
import {
  baseImageReferences,
  BUILD_CACHE_PRUNE_ARGS,
  buildInventory,
  formatSize,
  knownDevspace,
  NETWORK_LS_ARGS,
  NETWORK_USERS_ARGS,
  normalizedReference,
  parseDockerSize,
  pruneBuildCache,
  readHostInventory,
  removeHostObjects,
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
  return { df, devspaceImageIds: new Set(), helperImageIds: new Set(), known: [knownDevspace(devspace())], baseImages: new Set(), ...overrides };
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
      { ID: 'sha256:w', Repository: 'devspaces-worker', Tag: '6ba87151', Size: '412MB', UniqueSize: '12MB', Containers: '2' },
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
    expect(containers['my-postgres']).toEqual({ kind: 'container', id: 'c8', name: 'my-postgres', purpose: 'notDevspaces', state: 'running', networks: ['bridge'] });
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
        'devspaces-worker:6ba87151',
        'mcr.microsoft.com/devcontainers/base:bookworm',
        'node:22',
        '<none> (x)',
      ].sort(),
    );
    expect(images['devspaces-worker:6ba87151']).toMatchObject({ purpose: 'helperImage', tags: ['devspaces-worker:6ba87151', 'devspaces-monitor:abc'], sizeBytes: 412_000_000, uniqueBytes: 12_000_000, usedBy: 2 });
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

  it('names an image without a tag by its short ID', () => {
    const result = buildInventory(input({ Images: [{ ID: 'sha256:0123456789abcdef', Repository: '<none>', Tag: '<none>' }] }, { helperImageIds: new Set(['sha256:0123456789abcdef']) }));
    expect(result.images[0]).toMatchObject({ name: '<none> (0123456789ab)', tags: [], purpose: 'helperImage' });
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
    const inventory = await readHostInventory(docker, { known: [], baseImages: new Set() });
    expect(docker.calls).toEqual([[...SYSTEM_DF_ARGS], [...NETWORK_LS_ARGS]]);
    expect(SYSTEM_DF_ARGS).toEqual(['system', 'df', '--verbose', '--format', '{{json .}}']);
    expect(inventory.images.map((image) => image.purpose)).toEqual(['helperImage']);
    expect(inventory.networks.map((network) => [network.name, network.usedBy])).toEqual([
      ['bridge', 0],
      ['mynet', 1],
    ]);
  });

  it('throws when docker system df or docker network ls fails', async () => {
    await expect(readHostInventory(fakeDocker({ 'system df': fail('Cannot connect to the Docker daemon') }), { known: [], baseImages: new Set() })).rejects.toThrow(/Cannot connect/);
    const docker = fakeDocker({ 'system df': ok('{}'), 'network ls': fail('permission denied') });
    await expect(readHostInventory(docker, { known: [], baseImages: new Set() })).rejects.toThrow(/permission denied/);
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
    const docker = fakeDocker({});
    const results = await removeHostObjects(docker, [volume, image, { ...container, state: 'exited' }], { logger: silent });
    expect(docker.calls).toEqual([
      ['container', 'rm', 'c1'],
      ['image', 'rm', 'devspaces-monitor:abc'],
      ['image', 'rm', 'devspaces-worker:1'],
      ['volume', 'rm', 'devspaces-vscode'],
    ]);
    expect(results.map((result) => result.outcome)).toEqual(['removed', 'removed', 'removed']);
    expect(docker.calls.flat()).not.toContain('-f');
    expect(docker.calls.flat()).not.toContain('--force');
  });

  it('says what Docker refuses: a running container, a volume in use, and what is gone already', async () => {
    const docker = fakeDocker({
      'container rm': fail('Error response from daemon: cannot remove container "/devspaces-monitor": container is running: stop the container before removing or force remove'),
      'volume rm': fail('Error response from daemon: remove devspaces-vscode: volume is in use - [c1]'),
      'image rm': fail('Error response from daemon: No such image: devspaces-monitor:abc'),
    });
    const results = await removeHostObjects(docker, [container, image, volume], { logger: silent });
    expect(results.map((result) => result.outcome)).toEqual(['inUse', 'missing', 'inUse']);
    expect(results[2].detail).toMatch(/volume is in use/);
  });

  it('keeps every tag of an image that a container uses, unless that container goes in the same removal', async () => {
    const used = { ...image, usedBy: 1 };
    const docker = fakeDocker({});
    const kept = await removeHostObjects(docker, [used], { logger: silent });
    expect(kept).toEqual([{ object: { kind: 'image', name: used.name }, outcome: 'inUse', detail: 'A container uses this image.' }]);
    expect(docker.calls).toEqual([]);
    const worker: HostObject = { kind: 'container', id: 'c2', name: 'devspaces-w1-worker1', purpose: 'worker', state: 'exited', image: 'devspaces-worker:1' };
    const both = await removeHostObjects(docker, [used, worker], { logger: silent });
    expect(both.map((result) => result.outcome)).toEqual(['removed', 'removed']);
    expect(docker.calls.map((args) => args.slice(0, 2).join(' '))).toEqual(['container rm', 'image rm', 'image rm']);
  });

  it('removes a network after the containers and before the images, and keeps one that a container uses now or that Docker made', async () => {
    const network: HostObject = { kind: 'network', id: 'n6', name: 'mynet', purpose: 'notDevspaces', usedBy: 0 };
    const docker = fakeDocker({});
    const results = await removeHostObjects(docker, [volume, image, network, { ...container, state: 'exited' }], { logger: silent });
    expect(docker.calls.map((args) => args.slice(0, 2).join(' '))).toEqual(['container rm', 'container ls', 'network rm', 'image rm', 'image rm', 'volume rm']);
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
