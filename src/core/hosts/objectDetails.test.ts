// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The facts of Docker about one object of a host (docs/requirements.md R-ENG-008): its inspect, for a volume also the
// containers that use it with the place of their mount, only with read-only calls that the shared shell carries; and the
// sections of its report.
import { describe, expect, it } from 'vitest';
import { isShellCall } from '../docker/bootstrapDocker';
import { CommandError } from '../errors';
import type { RunOptions, RunResult } from '../ports';
import type { HostObject } from './hostObjects';
import { MAX_VOLUME_USERS, dockerFactsSections, inspectArgs, parseObjectDetails, readObjectDetails, volumeUsersArgs, type ObjectDetails } from './objectDetails';
import { CLOCK } from './reportFixtures.testkit';
import type { ReportBody, ReportSection } from './reportModel';

const result = (overrides: Partial<RunResult>): RunResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...overrides });

function fakeDocker(answers: Record<string, RunResult>): { run: (args: readonly string[], options?: RunOptions) => Promise<RunResult>; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      const answer = answers[args.slice(0, 2).join(' ')];
      if (answer === undefined) throw new Error(`Unexpected call ${args.join(' ')}`);
      return answer;
    },
  };
}

function facts(sections: readonly ReportSection[]): Record<string, string> {
  const body: ReportBody | undefined = sections.find((section) => section.title === 'Facts of Docker')?.body;
  if (body?.kind !== 'facts') throw new Error('No facts');
  return Object.fromEntries(body.facts.map((entry) => [entry.label, `${entry.value.text}${entry.value.chip !== undefined ? ` [${entry.value.chip.text}]` : ''}`]));
}

function table(sections: readonly ReportSection[], title: string): string[][] {
  const body = sections.find((section) => section.title === title)?.body;
  if (body?.kind !== 'table') throw new Error(`No table ${title}`);
  return body.rows.map((row) => row.map((entry) => entry.text));
}

const CONTAINER_INSPECT = {
  Id: 'c1',
  Created: '2026-11-09T08:00:00Z',
  Image: 'sha256:abc',
  Config: { Image: 'nginx:1.27', Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'web' }, Env: ['API_TOKEN=secret', 'DEVSPACE_IMAGE_TZ=Europe/Vienna', 'DEVSPACE_IMAGE_SCHEDULE=7 6 * * *', 'NOVALUE'] },
  State: { Status: 'running', StartedAt: '2026-11-12T07:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', ExitCode: 0 },
  HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
  NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }, { HostIp: '::', HostPort: '8080' }], '443/tcp': null }, Networks: { shop_default: {} } },
  Mounts: [
    { Type: 'volume', Name: 'shop_static', Source: '/var/lib/docker/volumes/shop_static/_data', Destination: '/usr/share/nginx/html', RW: false },
    { Type: 'bind', Source: '/srv/conf', Destination: '/etc/nginx/conf.d', RW: true },
  ],
};

describe('the facts of Docker about an object', () => {
  it('reads only with calls that the shared shell carries', () => {
    expect(isShellCall(inspectArgs('container', ['c1', 'c2']))).toBe(true);
    expect(isShellCall(inspectArgs('volume', ['v']))).toBe(true);
    expect(isShellCall(inspectArgs('image', ['sha256:x']))).toBe(true);
    expect(isShellCall(inspectArgs('network', ['n']))).toBe(true);
    expect(isShellCall(volumeUsersArgs('devspaces-vscode'))).toBe(true);
  });

  it('parses the inspect of each kind', () => {
    expect(parseObjectDetails('container', CONTAINER_INSPECT)).toEqual({
      kind: 'container',
      labels: new Map([
        ['com.docker.compose.project', 'shop'],
        ['com.docker.compose.service', 'web'],
      ]),
      createdAt: '2026-11-09T08:00:00Z',
      image: 'nginx:1.27',
      imageId: 'sha256:abc',
      startedAt: '2026-11-12T07:00:00Z',
      finishedAt: '0001-01-01T00:00:00Z',
      exitCode: 0,
      restartPolicy: 'unless-stopped',
      // Only the schedule of the Monitor and its time zone: other variables can hold secrets.
      env: new Map([
        ['DEVSPACE_IMAGE_TZ', 'Europe/Vienna'],
        ['DEVSPACE_IMAGE_SCHEDULE', '7 6 * * *'],
      ]),
      mounts: [
        { type: 'volume', source: 'shop_static', destination: '/usr/share/nginx/html', readOnly: true },
        { type: 'bind', source: '/srv/conf', destination: '/etc/nginx/conf.d', readOnly: false },
      ],
      ports: ['8080 → 80/tcp', '443/tcp'],
      networks: ['shop_default'],
    });
    expect(parseObjectDetails('image', { Created: '2026-10-21T00:00:00Z', RepoDigests: ['nginx@sha256:1', 3], Architecture: 'arm64', Os: 'linux', Config: { Labels: null } })).toEqual({
      kind: 'image',
      labels: new Map(),
      createdAt: '2026-10-21T00:00:00Z',
      repoDigests: ['nginx@sha256:1'],
      architecture: 'arm64',
      os: 'linux',
    });
    expect(parseObjectDetails('network', { Driver: 'bridge', Scope: 'local', Internal: false, IPAM: { Config: [{ Subnet: '172.18.0.0/16' }] }, Containers: { a: { Name: 'shop-web-1' }, b: { Name: 'shop-db-1' } }, Labels: {} })).toEqual({
      kind: 'network',
      labels: new Map(),
      driver: 'bridge',
      scope: 'local',
      internal: false,
      subnets: ['172.18.0.0/16'],
      containers: ['shop-db-1', 'shop-web-1'],
    });
    expect(parseObjectDetails('volume', 'nothing')).toBeUndefined();
  });

  it('reads a volume with the containers that use it and the place of their mount', async () => {
    const docker = fakeDocker({
      'volume inspect': result({ stdout: `${JSON.stringify({ Name: 'devspaces-vscode', Driver: 'local', Scope: 'local', CreatedAt: '2026-11-01T10:00:00Z', Labels: {} })}\n` }),
      'container ls': result({ stdout: `${JSON.stringify({ ID: 'w1', Names: 'devspaces-x-worker1', State: 'running' })}\n${JSON.stringify({ ID: 'gone', Names: 'old', State: 'exited' })}\n` }),
      // The container `gone` went after the list: Docker prints the one that is there and ends with exit code 1.
      'container inspect': result({ exitCode: 1, stdout: `${JSON.stringify({ Id: 'w1', Mounts: [{ Type: 'volume', Name: 'devspaces-vscode', Destination: '/vscode', RW: true }] })}\n`, stderr: 'Error response from daemon: No such container: gone\n' }),
    });
    const details = await readObjectDetails(docker, { kind: 'volume', id: 'devspaces-vscode' });
    expect(details).toMatchObject({
      kind: 'volume',
      driver: 'local',
      users: [
        { id: 'w1', name: 'devspaces-x-worker1', state: 'running', destination: '/vscode', readOnly: false },
        { id: 'gone', name: 'old', state: 'exited' },
      ],
      moreUsers: false,
    });
    expect(docker.calls).toEqual([inspectArgs('volume', ['devspaces-vscode']), volumeUsersArgs('devspaces-vscode'), inspectArgs('container', ['w1', 'gone'])]);
  });

  it('inspects at most MAX_VOLUME_USERS users, and keeps their rows when their inspect fails', async () => {
    const users = Array.from({ length: MAX_VOLUME_USERS + 1 }, (_, index) => JSON.stringify({ ID: `id${index}`, Names: `c${index}` })).join('\n');
    const docker = fakeDocker({
      'volume inspect': result({ stdout: JSON.stringify({ Name: 'v' }) }),
      'container ls': result({ stdout: users }),
      'container inspect': result({ exitCode: 1, stdout: JSON.stringify({ Id: 'id0', Mounts: [{ Type: 'volume', Name: 'v', Destination: '/v' }] }), stderr: 'permission denied' }),
    });
    const details = await readObjectDetails(docker, { kind: 'volume', id: 'v' });
    expect(details.kind === 'volume' ? [details.users.length, details.moreUsers, details.users[0]] : undefined).toEqual([MAX_VOLUME_USERS, true, { id: 'id0', name: 'c0' }]);
  });

  it('throws an abort during the inspect of the containers that use a volume', async () => {
    const controller = new AbortController();
    const docker = fakeDocker({
      'volume inspect': result({ stdout: JSON.stringify({ Name: 'v' }) }),
      'container ls': result({ stdout: JSON.stringify({ ID: 'id0', Names: 'c0' }) }),
    });
    const run = docker.run;
    docker.run = async (args, options) => {
      if (args[0] !== 'container' || args[1] !== 'inspect') return run(args, options);
      controller.abort();
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    };
    await expect(readObjectDetails(docker, { kind: 'volume', id: 'v' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws the failure of Docker, also for an object that went', async () => {
    const docker = fakeDocker({ 'image inspect': result({ exitCode: 1, stderr: 'Error: No such image: sha256:x' }) });
    await expect(readObjectDetails(docker, { kind: 'image', id: 'sha256:x' })).rejects.toBeInstanceOf(CommandError);
    await expect(readObjectDetails(fakeDocker({ 'image inspect': result({ stdout: '' }) }), { kind: 'image', id: 'sha256:x' })).rejects.toThrow(/Unexpected output/);
  });
});

describe('the sections of the facts of Docker', () => {
  const object = (overrides: Partial<HostObject>): HostObject => ({ kind: 'container', id: 'c1', name: 'shop-web-1', purpose: 'notDevspaces', ...overrides });

  it('gives a container with its restart policy, Compose, ports, networks and mounts', () => {
    const details = parseObjectDetails('container', CONTAINER_INSPECT);
    const sections = dockerFactsSections(object({ state: 'running', status: 'Up 1 hour', image: 'nginx:1.27' }), details, CLOCK);
    expect(facts(sections)).toEqual({
      Image: 'nginx:1.27',
      Status: 'Up 1 hour',
      Created: '2026-11-09 09:00',
      'Last start': 'today 08:00',
      'Restart policy': 'unless-stopped [Docker starts it again after a restart of the engine]',
      'Docker Compose': 'service web of the project shop',
      Ports: '8080 → 80/tcp, 443/tcp',
      Networks: 'shop_default',
      ID: 'c1',
    });
    expect(table(sections, 'Mounts')).toEqual([
      ['shop_static', '/usr/share/nginx/html', 'read-only'],
      ['/srv/conf (bind)', '/etc/nginx/conf.d', 'read-write'],
    ]);
  });

  it('gives an image with its version labels, digests and use', () => {
    const details: ObjectDetails = {
      kind: 'image',
      labels: new Map([
        ['org.opencontainers.image.version', '2.0.35'],
        ['org.opencontainers.image.revision', '4e7a2b1c9d0e1f2a'],
        ['org.opencontainers.image.created', '2026-11-11T01:14:00Z'],
      ]),
      repoDigests: [`ghcr.io/majikmate/devcontainer-classroom-web@sha256:${'3f'.repeat(32)}`],
      os: 'linux',
      architecture: 'arm64',
    };
    const sections = dockerFactsSections(object({ kind: 'image', id: 'sha256:img', name: 'ghcr.io/majikmate/devcontainer-classroom-web:latest', tags: ['ghcr.io/majikmate/devcontainer-classroom-web:latest'], purpose: 'baseImage', sizeBytes: 1_900_000_000, usedBy: 0 }), details, CLOCK);
    expect(facts(sections)).toEqual({
      Tags: 'ghcr.io/majikmate/devcontainer-classroom-web:latest',
      Version: '2.0.35 · revision 4e7a2b1c9d0e',
      'Built by its publisher': 'yesterday 02:14',
      Digests: 'ghcr.io/majikmate/devcontainer-classroom-web@sha256:3f3f3f3f3f3f…',
      Platform: 'linux/arm64',
      Size: '1.9 GB',
      'Used by': 'no container',
      ID: 'sha256:img',
    });
  });

  it('gives a volume with the containers that use it, and only the inventory when its inspect failed', () => {
    const details: ObjectDetails = { kind: 'volume', labels: new Map([['com.docker.compose.project', 'shop'], ['com.docker.compose.volume', 'pgdata']]), driver: 'local', createdAt: '2026-10-02T10:00:00Z', users: [{ id: 'd', name: 'shop-db-1', state: 'running', destination: '/var/lib/postgresql/data', readOnly: false }], moreUsers: false };
    const volume = object({ kind: 'volume', id: 'shop_pgdata', name: 'shop_pgdata', sizeBytes: 1_200_000_000, usedBy: 1 });
    const sections = dockerFactsSections(volume, details, CLOCK);
    expect(facts(sections)).toEqual({ 'Docker Compose': 'volume pgdata of the project shop', Driver: 'local', Created: '2026-10-02 12:00', Size: '1.2 GB', 'Used by': '1 container' });
    expect(table(sections, 'Used by')).toEqual([['shop-db-1', 'running', '/var/lib/postgresql/data', 'read-write']]);
    expect(dockerFactsSections(volume, undefined, CLOCK).map((section) => section.title)).toEqual(['Facts of Docker']);
    // Without its inspect, the time of the inventory (the form of the lists of the Docker CLI).
    expect(facts(dockerFactsSections({ ...volume, createdAt: '2026-10-02 12:00:00 +0200 CEST' }, undefined, CLOCK)).Created).toBe('2026-10-02 12:00');
  });

  it('gives a network with its containers, and one that Docker creates itself', () => {
    const details: ObjectDetails = { kind: 'network', labels: new Map([['com.docker.compose.project', 'shop']]), driver: 'bridge', scope: 'local', internal: false, subnets: ['172.18.0.0/16'], containers: ['shop-db-1', 'shop-web-1'] };
    const sections = dockerFactsSections(object({ kind: 'network', id: 'n1', name: 'shop_default', driver: 'bridge' }), details, CLOCK);
    expect(facts(sections)).toEqual({ 'Docker Compose': 'project shop', Driver: 'bridge', Scope: 'local', Subnets: '172.18.0.0/16', ID: 'n1' });
    expect(table(sections, 'Containers')).toEqual([['shop-db-1'], ['shop-web-1']]);
    expect(facts(dockerFactsSections(object({ kind: 'network', id: 'n0', name: 'bridge', driver: 'bridge', builtIn: true }), undefined, CLOCK))['Created by']).toBe('Docker itself [Devspaces does not remove it]');
  });
});
