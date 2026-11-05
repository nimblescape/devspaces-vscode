// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The build image of Devspaces: its pin, its tag on an engine, the removal of older versions, and the `docker run` of
// a build in a container of it.
import { describe, expect, it } from 'vitest';
import { BUILDX_PIN, PROXY_BUILD_ARG_NAMES, buildxImageTag, buildxPulledReference, buildxRunArgs, isOlderBuildxTag } from './buildxImage';

const PIN = { version: '0.38.2', image: 'docker/buildx-bin', digest: `sha256:${'1'.repeat(64)}` };

describe('the pin of the build image', () => {
  it('names a version x.y.z of docker/buildx-bin and the digest of its image index (scripts/buildx-pin.mjs)', () => {
    expect(BUILDX_PIN.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BUILDX_PIN.image).toBe('docker/buildx-bin');
    expect(BUILDX_PIN.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is pulled by its digest and tagged devspaces-buildx:<version>', () => {
    expect(buildxPulledReference(PIN)).toBe(`docker/buildx-bin@sha256:${'1'.repeat(64)}`);
    expect(buildxImageTag(PIN)).toBe('devspaces-buildx:0.38.2');
  });
});

describe('isOlderBuildxTag', () => {
  it.each([
    ['devspaces-buildx:0.38.1', true],
    ['devspaces-buildx:0.9.9', true],
    ['devspaces-buildx:0.38.10', false],
    ['devspaces-buildx:0.38.2', false],
    ['devspaces-buildx:1.0.0', false],
    ['devspaces-buildx:latest', false],
    ['devspaces-buildx:0.38', false],
    ['other:0.1.0', false],
  ])('%s is older than 0.38.2: %s', (tag, older) => {
    expect(isOlderBuildxTag(tag, PIN)).toBe(older);
  });
});

describe('buildxRunArgs', () => {
  const args = buildxRunArgs({
    name: 'devspaces-build-0123456789abcdef',
    image: 'devspaces-buildx:0.38.2',
    socket: '/run/user/1000/docker.sock',
    tag: 'devspaces-worker:abc',
    dockerfile: 'Dockerfile',
    buildArgs: ['--pull', '--build-arg', 'HTTP_PROXY=http://given:3128'],
  });

  it('runs buildx without network and capabilities, with the socket of the engine and the context on stdin', () => {
    expect(args.slice(0, 22)).toEqual([
      'run',
      '--rm',
      '-i',
      '--pull',
      'never',
      '--name',
      'devspaces-build-0123456789abcdef',
      '--label',
      'nimblescape.devspaces.build-run=true',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--mount',
      'type=bind,source=/run/user/1000/docker.sock,target=/var/run/docker.sock',
      '--entrypoint',
      '/buildx',
      'devspaces-buildx:0.38.2',
      'build',
      '--builder',
    ]);
    expect(args.at(-1)).toBe('-');
  });

  it('gives the build the proxy variables of the container by name only, before the arguments of the caller', () => {
    expect(PROXY_BUILD_ARG_NAMES).toEqual(['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'FTP_PROXY', 'ftp_proxy', 'ALL_PROXY', 'all_proxy']);
    const proxyArgs = PROXY_BUILD_ARG_NAMES.flatMap((name) => ['--build-arg', name]);
    const start = args.indexOf('--build-arg');
    expect(args.slice(start, start + proxyArgs.length)).toEqual(proxyArgs);
    // buildx takes the last value of a name, so the build argument of the caller wins.
    expect(args.slice(start + proxyArgs.length)).toEqual(['--pull', '--build-arg', 'HTTP_PROXY=http://given:3128', '-']);
  });
});
