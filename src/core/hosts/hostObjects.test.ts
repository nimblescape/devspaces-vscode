// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The objects of Devspaces on a Docker host (the view "Docker Hosts", R-ENG-008): which objects of `docker system df -v`
// it shows, with which purpose and size, and their stop and removal without force.
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger, type RunOptions, type RunResult } from '../ports';
import { resourceName } from '../names';
import type { Devspace } from '../types';
import {
  baseImageReferences,
  buildInventory,
  formatSize,
  knownDevspace,
  normalizedReference,
  parseDockerSize,
  readHostInventory,
  removeHostObjects,
  RUNNING_DEVSPACES_ARGS,
  runningDevspaces,
  stopHostContainer,
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
      { ID: 'c1', Names: 'devspaces-majikmate-web-config-curious-hopper', State: 'running', Status: 'Up 2 hours', Size: '1.2MB', Labels: `nimblescape.devspaces.id=${DEVSPACE_ID},devcontainer.metadata=[{"a":1,"b":2}]` },
      { ID: 'c2', Names: 'devspaces-majikmate-web-config-curious-hopper-db-1', State: 'exited', Labels: `nimblescape.devspaces.id=${DEVSPACE_ID},nimblescape.devspaces.compose-service=db` },
      { ID: 'c3', Names: 'devspaces-monitor', State: 'running', Labels: 'nimblescape.devspaces.monitor=abc' },
      { ID: 'c4', Names: 'devspaces-majikmate-web-config-curious-hopper-worker1', State: 'running', Labels: 'nimblescape.devspaces.worker-run=1' },
      { ID: 'c5', Names: 'devspaces-batch-1', State: 'exited', Labels: 'nimblescape.devspaces.worker-run=1,nimblescape.devspaces.channel-step=s1' },
      { ID: 'c6', Names: 'devspaces-build-1', State: 'running', Labels: 'nimblescape.devspaces.build-run=x' },
      { ID: 'c7', Names: 'devspaces-other-repo-default-brave-curie', State: 'exited', Labels: `nimblescape.devspaces.id=${OTHER_ID},nimblescape.devspaces.repository=someone/repo` },
      { ID: 'c8', Names: 'my-postgres', State: 'running', Labels: 'com.example=1' },
    ],
    Images: [
      { ID: 'sha256:w', Repository: 'devspaces-worker', Tag: '6ba87151', Size: '412MB', UniqueSize: '12MB', Containers: '2' },
      { ID: 'sha256:w', Repository: 'devspaces-monitor', Tag: 'abc', Size: '412MB', UniqueSize: '12MB', Containers: '2' },
      { ID: 'sha256:b', Repository: 'devspaces-buildx', Tag: '0.30.1', Size: '80MB' },
      { ID: 'sha256:d', Repository: IMAGE, Tag: '3', Size: '2GB', UniqueSize: '200MB' },
      { ID: 'sha256:p', Repository: IMAGE, Tag: 'prepared', Size: '2GB' },
      { ID: 'sha256:o', Repository: 'devspaces-other-repo-brave-curie', Tag: '1', Size: '1GB' },
      { ID: 'sha256:base', Repository: 'mcr.microsoft.com/devcontainers/base', Tag: 'bookworm', Size: '800MB' },
      { ID: 'sha256:n', Repository: 'node', Tag: '22', Size: '1GB' },
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
      { Name: 'pgdata', Labels: '' },
    ],
  };
  const known = [knownDevspace(devspace({ additionalVolumes: ['node_modules_cache'] }))];
  const inventory = buildInventory(
    input(df, {
      known,
      helperImageIds: new Set(['sha256:w']),
      devspaceImageIds: new Set(['sha256:d', 'sha256:p', 'sha256:o']),
      baseImages: new Set([normalizedReference('mcr.microsoft.com/devcontainers/base:bookworm')]),
    }),
  );
  const byName = (objects: HostObject[]) => Object.fromEntries(objects.map((object) => [object.name, object]));

  it('shows only the containers of Devspaces, each with its purpose', () => {
    const containers = byName(inventory.containers);
    expect(Object.keys(containers)).not.toContain('my-postgres');
    expect(containers['devspaces-majikmate-web-config-curious-hopper']).toMatchObject({ purpose: 'devspace', devspaceId: DEVSPACE_ID, repository: 'majikmate/web', role: 'dev container', state: 'running', sizeBytes: 1_200_000 });
    expect(containers['devspaces-majikmate-web-config-curious-hopper-db-1']).toMatchObject({ purpose: 'devspace', role: 'service db', state: 'exited' });
    expect(containers['devspaces-monitor'].purpose).toBe('monitor');
    // A worker of a devspace window has a name that starts with the name of the devspace: still a worker.
    expect(containers['devspaces-majikmate-web-config-curious-hopper-worker1'].purpose).toBe('worker');
    expect(containers['devspaces-batch-1'].purpose).toBe('batchHelper');
    expect(containers['devspaces-build-1'].purpose).toBe('buildContainer');
    expect(containers['devspaces-other-repo-default-brave-curie']).toMatchObject({ purpose: 'otherDevspace', devspaceId: OTHER_ID, repository: 'someone/repo' });
  });

  it('shows only the images of Devspaces and the base images of its devspaces, merged by ID', () => {
    const images = byName(inventory.images);
    expect(Object.keys(images).sort()).toEqual(
      [
        'devspaces-buildx:0.30.1',
        `${IMAGE}:3`,
        `${IMAGE}:prepared`,
        'devspaces-other-repo-brave-curie:1',
        'devspaces-worker:6ba87151',
        'mcr.microsoft.com/devcontainers/base:bookworm',
      ].sort(),
    );
    expect(images['devspaces-worker:6ba87151']).toMatchObject({ purpose: 'helperImage', tags: ['devspaces-worker:6ba87151', 'devspaces-monitor:abc'], sizeBytes: 412_000_000, uniqueBytes: 12_000_000, usedBy: 2 });
    expect(images['devspaces-buildx:0.30.1'].purpose).toBe('buildImage');
    expect(images[`${IMAGE}:3`]).toMatchObject({ purpose: 'devspace', devspaceId: DEVSPACE_ID, role: 'image' });
    expect(images[`${IMAGE}:prepared`]).toMatchObject({ purpose: 'devspace', role: 'prepared image' });
    expect(images['devspaces-other-repo-brave-curie:1'].purpose).toBe('otherDevspace');
    expect(images['mcr.microsoft.com/devcontainers/base:bookworm'].purpose).toBe('baseImage');
  });

  it('shows only the volumes of Devspaces, each with its purpose', () => {
    const volumes = byName(inventory.volumes);
    expect(Object.keys(volumes)).not.toContain('pgdata');
    expect(volumes['devspaces-majikmate-web-config-curious-hopper']).toMatchObject({ purpose: 'devspace', role: 'workspace', sizeBytes: 1_200_000_000, usedBy: 1 });
    expect(volumes.node_modules_cache).toMatchObject({ purpose: 'devspace', role: 'additional volume' });
    expect(volumes['devspaces-majikmate-web-config-curious-hopper_pgdata']).toMatchObject({ purpose: 'devspace', role: 'data of a service' });
    expect(volumes['devspaces-vscode']).toMatchObject({ purpose: 'sharedVolume', role: 'VS Code Server and extensions' });
    expect(volumes['devspaces-monitor'].purpose).toBe('sharedVolume');
    expect(volumes['devspaces-worker-cache'].purpose).toBe('sharedVolume');
    expect(volumes['devspaces-other-repo-default-brave-curie']).toMatchObject({ purpose: 'otherDevspace', devspaceId: OTHER_ID });
  });

  it('names an image without a tag by its short ID', () => {
    const result = buildInventory(input({ Images: [{ ID: 'sha256:0123456789abcdef', Repository: '<none>', Tag: '<none>' }] }, { helperImageIds: new Set(['sha256:0123456789abcdef']) }));
    expect(result.images[0]).toMatchObject({ name: '<none> (0123456789ab)', tags: [], purpose: 'helperImage' });
  });

  it('gives an empty inventory for output without the lists', () => {
    expect(buildInventory(input(undefined))).toEqual({ containers: [], images: [], volumes: [] });
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
  it('reads one docker system df -v and the images with the labels of Devspaces', async () => {
    const docker = fakeDocker(
      { 'system df': ok(JSON.stringify({ Images: [{ ID: 'sha256:w', Repository: '<none>', Tag: '<none>' }], Containers: [], Volumes: [] })) },
      { 'nimblescape.devspaces.worker=true': ['sha256:w'] },
    );
    const inventory = await readHostInventory(docker, { known: [], baseImages: new Set() });
    expect(docker.calls[0]).toEqual(['system', 'df', '--verbose', '--format', '{{json .}}']);
    expect(inventory.images.map((image) => image.purpose)).toEqual(['helperImage']);
  });

  it('throws when docker system df fails', async () => {
    const docker = fakeDocker({ 'system df': fail('Cannot connect to the Docker daemon') });
    await expect(readHostInventory(docker, { known: [], baseImages: new Set() })).rejects.toThrow(/Cannot connect/);
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

  it('stops a container by its ID', async () => {
    const docker = fakeDocker({});
    expect(await stopHostContainer(docker, container, silent)).toEqual({ object: container, outcome: 'stopped' });
    expect(docker.calls).toEqual([['container', 'stop', 'c1']]);
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
