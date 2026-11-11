// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The allow-lists of the Docker pipes: the requests that CI measured (Dev Containers in the window of a devspace on an
// SSH host, and Devspaces itself) go through, and the requests that neither needs are refused.
import { describe, expect, it } from 'vitest';
import { extensionPipeRule, windowPipeRule } from './dockerPipeRules';

const NO_HEADERS = new Map<string, string>();
const ID = 'f'.repeat(64);

function allowed(rule: typeof windowPipeRule, line: string): boolean {
  const [method, path] = line.split(' ');
  return rule({ method, path }, NO_HEADERS) === undefined;
}

describe('the filter of the Docker pipe of a window', () => {
  it.each([
    'HEAD /_ping',
    'GET /_ping',
    'GET /version',
    'GET /info',
    'GET /containers/json',
    'GET /containers/devspaces-acme-api-3f2a9c1e/json',
    `GET /containers/${ID}/json`,
    `POST /containers/${ID}/start`,
    `POST /containers/${ID}/exec`,
    `POST /exec/${ID}/start`,
    `POST /exec/${ID}/resize`,
    `GET /exec/${ID}/json`,
    'GET /images/ghcr.io/majikmate/devcontainer-base:2/json',
    'GET /images/node@sha256:0123/json',
    'GET /events',
  ])('lets %s through, which the Dev Containers extension needs', (line) => {
    expect(allowed(windowPipeRule, line)).toBe(true);
  });

  it.each([
    'POST /containers/create',
    `DELETE /containers/${ID}`,
    `POST /containers/${ID}/stop`,
    `PUT /containers/${ID}/archive`,
    'POST /build',
    'POST /session',
    'POST /images/create',
    'DELETE /images/node:20',
    'POST /volumes/create',
    'POST /plugins/pull',
    'POST /swarm/init',
    'GET /containers/x/json/extra',
    'GET /exec/a/b/json',
  ])('refuses %s, which it does not need', (line) => {
    const [method, path] = line.split(' ');
    expect(windowPipeRule({ method, path }, NO_HEADERS)).toBe('the Dev Containers extension does not need it');
  });

  it.each(['/containers%2Fcreate', '/containers/x/../create', '/containers//json', '/containers/./x/json', '/images/a b/json'])(
    'refuses the path %s, which the Docker CLI never sends',
    (path) => {
      expect(windowPipeRule({ method: 'GET', path }, NO_HEADERS)).toBe('its path is not one that the Docker CLI sends');
    },
  );
});

describe('the filter of the Docker pipe of the extension', () => {
  it.each([
    'HEAD /_ping',
    'GET /version',
    'GET /info',
    'GET /system/df',
    'GET /containers/json',
    'GET /containers/devspaces-monitor/json',
    `DELETE /containers/${ID}`,
    'GET /images/json',
    'GET /images/devspaces-worker:6ef20be64b1e/json',
    'DELETE /images/devspaces-worker:6ef20be64b1e',
    'POST /build',
    'POST /session',
    'POST /grpc',
    'GET /volumes',
    'GET /volumes/devspaces-monitor',
    'DELETE /volumes/devspaces-vscode',
    // The build of the helper image in a container of the build image (buildxImage.ts): the pull and the tag of the
    // build image, then `docker run --rm -i`, which the Docker CLI stops with `kill` at its own stop.
    'POST /images/create',
    'POST /images/docker/buildx-bin@sha256:0b7d9e66e81dd1155639421b8342f9731f8bb67cb11b58663f938d9c6e9b6eef/tag',
    'POST /containers/create',
    `POST /containers/${ID}/attach`,
    `POST /containers/${ID}/wait`,
    `POST /containers/${ID}/start`,
    `POST /containers/${ID}/kill`,
    // The Stop of a helper container in the view "Docker Hosts" (R-ENG-008).
    `POST /containers/${ID}/stop`,
  ])('lets %s through, which Devspaces needs', (line) => {
    expect(allowed(extensionPipeRule, line)).toBe(true);
  });

  it.each([`POST /containers/${ID}/exec`, `POST /exec/${ID}/start`, `PUT /containers/${ID}/archive`, `POST /containers/${ID}/restart`, 'POST /images/load', 'POST /volumes/create', 'GET /events'])(
    'refuses %s, which it does not need',
    (line) => {
      const [method, path] = line.split(' ');
      expect(extensionPipeRule({ method, path }, NO_HEADERS)).toBe('Devspaces does not need it');
    },
  );
});
