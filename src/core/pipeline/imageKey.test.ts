// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { DEVSPACE_IMAGE_LABELS, LABEL_BUILD_RECORD, LABEL_DEVSPACE_ID, LABEL_IMAGE_KEY, isImageKey } from '../names';
import type { BuildRecord, Devspace } from '../types';
import { buildRecordLabel, imageRecordLabels, preparedImageLabels } from './imageRecord';
import { NOT_IN_IMAGE_PROPERTIES, canonicalJson, chosenSharedImage, imageKey, isSharedImage, sharedImageInputs, type ImageKeyInput, type SharedImageFacts } from './imageKey';

const BASE: ImageKeyInput = {
  cliVersion: '0.90.0',
  written: { image: 'ghcr.io/acme/base:1', customizations: { vscode: { extensions: ['a.b'] } } },
  resolved: { image: 'ghcr.io/acme/base:1', customizations: { vscode: { extensions: ['a.b'] } } },
  images: { 'ghcr.io/acme/base:1': `sha256:${'1'.repeat(64)}` },
  features: {},
  lockfileText: null,
};

describe('imageKey', () => {
  it('is an image key, the same for the same inputs whatever the order of their keys', () => {
    const key = imageKey(BASE);
    expect(isImageKey(key)).toBe(true);
    expect(imageKey({ ...BASE, written: { customizations: { vscode: { extensions: ['a.b'] } }, image: 'ghcr.io/acme/base:1' } })).toBe(key);
  });

  it('leaves out the properties that are not in the image, also the path of the file that read-configuration adds', () => {
    const key = imageKey(BASE);
    const other = {
      name: 'Other',
      workspaceFolder: '/workspaces/other',
      workspaceMount: 'source=x,target=/w,type=volume',
      runArgs: ['--cpus=2'],
      appPort: 3000,
      initializeCommand: 'echo',
      configFilePath: { path: '/workspaces/other/.devcontainer/devcontainer.json' },
    };
    expect(imageKey({ ...BASE, written: { ...BASE.written, ...other }, resolved: { ...BASE.resolved, ...other } })).toBe(key);
  });

  it('differs for each input that the build reads', () => {
    const key = imageKey(BASE);
    const changes: Array<Partial<ImageKeyInput>> = [
      { cliVersion: '0.91.0' },
      { written: { ...BASE.written, remoteEnv: { A: '${containerWorkspaceFolder}' } } },
      { resolved: { ...BASE.resolved, remoteEnv: { A: '/workspaces/api' } } },
      { images: { 'ghcr.io/acme/base:1': `sha256:${'2'.repeat(64)}` } },
      { features: { 'ghcr.io/acme/features/node:1': `sha256:${'3'.repeat(64)}` } },
      { lockfileText: '{}' },
      { lockfileText: '' },
      // An unknown property counts.
      { written: { ...BASE.written, somethingNew: true } },
    ];
    const keys = changes.map((change) => imageKey({ ...BASE, ...change }));
    for (const other of keys) expect(other).not.toBe(key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('stays the key of a configuration with an image that R-DS-010 gave first (no field of a Dockerfile in it)', () => {
    expect(imageKey(BASE)).toBe(imageKey({ ...BASE, dockerfile: undefined }));
    expect(imageKey(BASE)).toBe('sha256:' + crypto.createHash('sha256').update(canonicalJson({ v: 1, cli: BASE.cliVersion, written: BASE.written, resolved: BASE.resolved, images: BASE.images, features: {}, lockfile: null })).digest('hex'));
  });

  it('holds the Dockerfile, its path in the build context and the hash of the build context', () => {
    const dockerfile = { text: 'FROM node:24\n', path: 'Dockerfile', contextHash: `sha256:${'a'.repeat(64)}` };
    const key = imageKey({ ...BASE, dockerfile });
    expect(key).not.toBe(imageKey(BASE));
    const changes = [{ text: 'FROM node:24\nRUN true\n' }, { path: 'docker/Dockerfile' }, { contextHash: `sha256:${'b'.repeat(64)}` }];
    const keys = changes.map((change) => imageKey({ ...BASE, dockerfile: { ...dockerfile, ...change } }));
    for (const other of keys) expect(other).not.toBe(key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('canonicalJson', () => {
  it('sorts the keys of each object, keeps the order of arrays, and keeps a property named __proto__', () => {
    const value = JSON.parse('{"b":[2,1,{"d":1,"c":2}],"a":null,"__proto__":{"x":1}}') as unknown;
    expect(canonicalJson(value)).toBe('{"__proto__":{"x":1},"a":null,"b":[2,1,{"c":2,"d":1}]}');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('NOT_IN_IMAGE_PROPERTIES', () => {
  // Dev Container CLI of the pinned version (devDependency @devcontainers/cli, the version of the helper image).
  const bundle = fs.readFileSync(path.resolve(__dirname, '../../../node_modules/@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js'), 'utf8');

  it('holds none of the properties that the CLI writes into the label devcontainer.metadata', () => {
    const list = /\["onCreateCommand","updateContentCommand","postCreateCommand","postStartCommand","postAttachCommand","waitFor"(?:,"[A-Za-z]+")*\]/.exec(bundle);
    expect(list).not.toBeNull();
    const properties = JSON.parse(list![0]) as string[];
    expect(properties).toContain('containerEnv');
    expect(properties).toContain('remoteEnv');
    expect(NOT_IN_IMAGE_PROPERTIES.filter((property) => properties.includes(property))).toEqual([]);
  });

  it('is next to a label that holds the configuration as written (its variables not resolved), so the key holds it too', () => {
    const name = /var ([A-Za-z_$][\w$]*)="devcontainer\.metadata"/.exec(bundle)?.[1];
    expect(name).toBeDefined();
    const escaped = name!.replace(/\$/g, '\\$');
    // Without Features, and with Features (the Dockerfile that the CLI writes).
    expect(bundle).toMatch(new RegExp(`\\[${escaped}\\]:JSON\\.stringify\\([^;]*\\)\\.raw\\)`));
    expect(bundle).toMatch(new RegExp(`let A=e\\.raw;if\\(!A\\.length\\)return"";[^;]*;return\`LABEL \\$\\{${escaped}\\}=`));
  });
});

describe('sharedImageInputs', () => {
  const FEATURE = 'ghcr.io/acme/features/node:1';
  const PINNED = `ghcr.io/acme/features/go@sha256:${'5'.repeat(64)}`;
  const facts = (change: Partial<SharedImageFacts> = {}): SharedImageFacts => ({
    compose: false,
    written: { image: 'ghcr.io/acme/base:1' },
    resolved: { image: 'ghcr.io/acme/base:1' },
    configPath: '.devcontainer/devcontainer.json',
    hostAccessChecks: 'on',
    lockfileUnreadable: false,
    answeredFeatures: {},
    ...change,
  });

  it('gives the image reference and the answered digests of the Features', () => {
    expect(sharedImageInputs(facts())).toEqual({ images: ['ghcr.io/acme/base:1'], features: {}, written: { image: 'ghcr.io/acme/base:1' } });
    const digest = `sha256:${'4'.repeat(64)}`;
    expect(sharedImageInputs(facts({ resolved: { image: ' ghcr.io/acme/base:1 ', features: { [FEATURE]: { version: '1' } } }, answeredFeatures: { [FEATURE]: digest } }))).toEqual({
      images: ['ghcr.io/acme/base:1'],
      features: { [FEATURE]: digest },
      written: { image: 'ghcr.io/acme/base:1' },
    });
  });

  it('says why a build gives no shared image', () => {
    const reasons: Array<[Partial<SharedImageFacts>, string]> = [
      [{ compose: true }, 'it is a Docker Compose configuration'],
      [{ resolved: { build: { dockerfile: 'Dockerfile' } } }, 'its Dockerfile could not be read'],
      [{ resolved: { image: 'x', dockerFile: 'Dockerfile' } }, 'its Dockerfile could not be read'],
      [{ resolved: { image: 'x', build: { dockerfile: 3 } as unknown as Record<string, unknown> }, dockerfileText: 'FROM x' }, 'its Dockerfile could not be read'],
      [{ resolved: { image: ' ' } }, 'its configuration names no image'],
      [{ hostAccessChecks: 'off' }, 'the host access checks are off for it'],
      [{ written: undefined }, 'its configuration is no JSON object'],
      [{ lockfileUnreadable: true }, 'its lockfile cannot be read'],
      [{ resolved: { image: 'x', features: ['a'] as unknown as Record<string, unknown> } }, 'its Features are not an object'],
      [{ resolved: { image: 'x', features: { './local': {} } } }, 'its Feature ./local is not in a registry'],
      [{ resolved: { image: 'x', features: { 'https://example.com/f.tgz': {} } } }, 'its Feature https://example.com/f.tgz is not in a registry'],
      [{ resolved: { image: 'x', features: { [FEATURE]: {} } } }, `the digest of its Feature ${FEATURE} is not known in this open`],
      [{ resolved: { image: 'x', features: { [FEATURE]: {} } }, answeredFeatures: undefined }, `the digest of its Feature ${FEATURE} is not known in this open`],
      // The registry never answers a reference with a digest: it does not show that the account can read the Feature.
      [{ resolved: { image: 'x', features: { [PINNED]: {} } }, answeredFeatures: { [PINNED]: `sha256:${'5'.repeat(64)}` } }, `its Feature ${PINNED} has a digest, so the registry was not asked for it in this open`],
    ];
    for (const [change, reason] of reasons) expect(sharedImageInputs(facts(change))).toEqual({ reason });
  });

  describe('of a configuration with a Dockerfile', () => {
    const TEXT = 'FROM mcr.microsoft.com/devcontainers/base:trixie\nRUN apt-get update\n';
    const dockerfile = (build: Record<string, unknown>, change: Partial<SharedImageFacts> = {}) =>
      facts({ written: { build }, resolved: { build }, dockerfileText: TEXT, ...change });

    it('gives the images of the Dockerfile, the build context, the Dockerfile in it, and its text', () => {
      // Without a build context: the folder of the Dockerfile (as the Dev Container CLI 0.90.0 resolves it).
      expect(sharedImageInputs(dockerfile({ dockerfile: 'Dockerfile' }))).toEqual({
        images: ['mcr.microsoft.com/devcontainers/base:trixie'],
        features: {},
        written: { build: { dockerfile: 'Dockerfile' } },
        dockerfile: { context: '.devcontainer', path: 'Dockerfile', text: TEXT },
      });
      expect(sharedImageInputs(dockerfile({ dockerfile: 'docker/Dockerfile', context: '..' })).valueOf()).toMatchObject({ dockerfile: { context: '.', path: '.devcontainer/docker/Dockerfile' } });
      // The older dockerFile and context; a configuration file at the top of the repository.
      expect(sharedImageInputs(facts({ resolved: { dockerFile: 'Dockerfile', context: '.' }, written: {}, dockerfileText: TEXT, configPath: '.devcontainer.json' }))).toMatchObject({
        dockerfile: { context: '.', path: 'Dockerfile' },
      });
      // A Dockerfile of `scratch` only reads no image; the Features as with an image.
      const digest = `sha256:${'4'.repeat(64)}`;
      expect(sharedImageInputs(facts({ resolved: { build: { dockerfile: 'Dockerfile' }, features: { [FEATURE]: {} } }, dockerfileText: 'FROM scratch\nCOPY a /a\n', answeredFeatures: { [FEATURE]: digest } }))).toMatchObject({
        images: [],
        features: { [FEATURE]: digest },
      });
    });

    it('says why a Dockerfile gives no shared image', () => {
      const reasons: Array<[SharedImageFacts, string]> = [
        [dockerfile({ dockerfile: 'Dockerfile' }, { dockerfileText: undefined }), 'its Dockerfile could not be read'],
        [dockerfile({ dockerfile: 'Dockerfile', options: ['--network=host'] }), 'its build passes options to Docker (build.options)'],
        [dockerfile({ dockerfile: 'Dockerfile', cacheFrom: 'ghcr.io/acme/cache' }), 'its build imports a build cache (build.cacheFrom)'],
        [dockerfile({ dockerfile: 'Dockerfile', context: '../..' }), 'its build context is outside of the repository'],
        [dockerfile({ dockerfile: 'Dockerfile', context: 'app' }), 'its Dockerfile is outside of its build context'],
        [dockerfile({ dockerfile: '/etc/Dockerfile' }), 'its Dockerfile or its build context has an absolute path'],
        // Also an absolute path that happens to name the folder that stands for the repository in the check.
        [dockerfile({ dockerfile: '/repository/Dockerfile', context: '/repository' }), 'its Dockerfile or its build context has an absolute path'],
        [dockerfile({ dockerfile: 'Dockerfile', context: '/workspaces/api' }), 'its Dockerfile or its build context has an absolute path'],
        [dockerfile({ dockerfile: '${localEnv:DOCKERFILE}' }), 'its Dockerfile or its build context has a variable that is not resolved'],
        [dockerfile({ dockerfile: 'Dockerfile' }, { dockerfileText: 'FROM --platform=linux/arm64 node:24\n' }), 'its Dockerfile has a FROM with --platform=linux/arm64'],
        [dockerfile({ dockerfile: 'Dockerfile' }, { dockerfileText: 'FROM node:$TARGETARCH\n' }), 'its Dockerfile has the FROM node:$TARGETARCH, whose image is not known'],
        [dockerfile({ dockerfile: 'Dockerfile' }, { dockerfileText: 'FROM node:24\nCOPY --from=ghcr.io/acme/tools:1 /bin/x /x\n' }), 'its Dockerfile copies from the image ghcr.io/acme/tools:1 (COPY --from)'],
        [dockerfile({ dockerfile: 'Dockerfile' }, { dockerfileText: 'FROM node:24\nADD https://example.com/x.tgz /x\n' }), 'its Dockerfile adds a file from the network (ADD of a URL or a Git address)'],
        [dockerfile({ dockerfile: 'Dockerfile' }, { dockerfileText: 'FROM node:24\nRUN --mount=type=secret,id=npm npm ci\n' }), 'its Dockerfile has a RUN that mounts a secret'],
        [dockerfile({ dockerfile: 'Dockerfile' }, { dockerfileText: '# syntax=ghcr.io/acme/frontend:1\nFROM node:24\n' }), 'its Dockerfile names the frontend ghcr.io/acme/frontend:1'],
        [dockerfile({ dockerfile: 'Dockerfile', args: { BUILDKIT_SYNTAX: 'ghcr.io/acme/frontend:1' } }), 'its build arguments name a frontend (BUILDKIT_SYNTAX)'],
        [dockerfile({ dockerfile: 'Dockerfile' }, { hostAccessChecks: 'off' }), 'the host access checks are off for it'],
      ];
      for (const [change, reason] of reasons) expect(sharedImageInputs(change)).toEqual({ reason });
    });
  });
});

describe('isSharedImage', () => {
  const KEY = `sha256:${'6'.repeat(64)}`;
  const TAG = 'devspaces-acme-api-config-curious-hopper:3';
  const ID = `sha256:${'8'.repeat(64)}`;
  const RECORD: BuildRecord = { builtAt: '2026-11-12T10:00:00Z', devspaceImage: TAG, buildNumber: 3, configPath: '.devcontainer/devcontainer.json', configHash: 'h', images: {}, features: {}, imageKey: KEY };
  /** A dev container created from the image `imageId` with the build record `record` (buildRecordLabel). */
  const container = (imageId: string | undefined, record: Partial<BuildRecord> = {}) => ({
    ...(imageId !== undefined ? { imageId } : {}),
    labels: { [LABEL_DEVSPACE_ID]: 'api', [LABEL_BUILD_RECORD]: buildRecordLabel({ ...RECORD, ...record }) },
  });
  const VOUCHED = [container(ID.toUpperCase())];

  it('takes an image with the key, the tag of a devspace image, none of the labels of a devspace, and a dev container that vouches for it', () => {
    expect(isSharedImage({ id: ID, tags: ['other:latest', TAG], labels: { [LABEL_IMAGE_KEY]: KEY, 'org.opencontainers.image.title': 'x' } }, KEY, VOUCHED)).toBe(true);
  });

  it('takes the image with the tag of a prepared devspace image too (a shared image that a prepare built or tagged)', () => {
    expect(isSharedImage({ id: ID, tags: ['devspaces-acme-web-config-happy-turing:prepared'], labels: { [LABEL_IMAGE_KEY]: KEY } }, KEY, VOUCHED)).toBe(true);
  });

  it('takes an image that the record of a prepare for the key names, without a dev container; never another image', () => {
    const image = { id: ID, tags: ['devspaces-acme-web-config-happy-turing:prepared'], labels: { [LABEL_IMAGE_KEY]: KEY } };
    expect(isSharedImage(image, KEY, [], ID.toUpperCase())).toBe(true);
    expect(isSharedImage(image, KEY, [], `sha256:${'9'.repeat(64)}`)).toBe(false);
    expect(isSharedImage(image, KEY, [])).toBe(false);
    // The record vouches only for a candidate: the key, no label of a devspace, the tag of a devspace image.
    expect(isSharedImage({ ...image, labels: { [LABEL_IMAGE_KEY]: `sha256:${'7'.repeat(64)}` } }, KEY, [], ID)).toBe(false);
    expect(isSharedImage({ ...image, labels: { [LABEL_IMAGE_KEY]: KEY, [LABEL_DEVSPACE_ID]: 'web' } }, KEY, [], ID)).toBe(false);
    expect(isSharedImage({ ...image, tags: ['devspaces-acme-web-config-happy-turing:prepared-db'] }, KEY, [], ID)).toBe(false);
  });

  it('refuses another key, a label of a devspace, and an image without the tag of a devspace image', () => {
    expect(isSharedImage({ id: ID, tags: [TAG], labels: { [LABEL_IMAGE_KEY]: `sha256:${'7'.repeat(64)}` } }, KEY, VOUCHED)).toBe(false);
    for (const label of DEVSPACE_IMAGE_LABELS) {
      expect(isSharedImage({ id: ID, tags: [TAG], labels: { [LABEL_IMAGE_KEY]: KEY, [label]: '' } }, KEY, VOUCHED)).toBe(false);
    }
    for (const tag of ['devspaces-acme-api-config-curious-hopper:prepared-db', 'devspaces-acme-api-config-curious-hopper:0', 'devspaces-tools:prepared', 'ghcr.io/x/devspaces-acme-api-config-curious-hopper:3', 'devspaces-tools:3']) {
      expect(isSharedImage({ id: ID, tags: [tag], labels: { [LABEL_IMAGE_KEY]: KEY } }, KEY, VOUCHED)).toBe(false);
    }
    expect(isSharedImage({ id: ID, tags: [], labels: { [LABEL_IMAGE_KEY]: KEY } }, KEY, VOUCHED)).toBe(false);
  });

  it('refuses an image that no dev container with a build record of the key was created from (a key that a Dockerfile wrote)', () => {
    const image = { id: ID, tags: [TAG], labels: { [LABEL_IMAGE_KEY]: KEY } };
    const { imageKey: _none, ...withoutKey } = RECORD;
    const refused = [
      [],
      [container(`sha256:${'9'.repeat(64)}`)],
      [container(undefined)],
      [container(ID, { imageKey: `sha256:${'7'.repeat(64)}` })],
      [{ imageId: ID, labels: { [LABEL_DEVSPACE_ID]: 'api', [LABEL_BUILD_RECORD]: JSON.stringify(withoutKey) } }],
      [{ imageId: ID, labels: { [LABEL_DEVSPACE_ID]: 'api', [LABEL_BUILD_RECORD]: '' } }],
      [{ imageId: ID, labels: { [LABEL_DEVSPACE_ID]: 'api', [LABEL_BUILD_RECORD]: JSON.stringify({ imageKey: KEY }) } }],
      [{ imageId: ID, labels: { [LABEL_DEVSPACE_ID]: 'api', [LABEL_IMAGE_KEY]: KEY } }],
    ];
    for (const containers of refused) expect(isSharedImage(image, KEY, containers), JSON.stringify(containers)).toBe(false);
  });

  it('lists the labels that the extension gives an image built for one devspace', () => {
    const env = { id: 'api', repository: 'acme/api', owner: { id: '1', login: 'a' } } as unknown as Devspace;
    const keys = [...Object.keys(imageRecordLabels(env, RECORD)), ...Object.keys(preparedImageLabels(env, { key: { configPath: '', configHash: '', images: {}, features: {} }, helperImage: '' }))];
    expect([...new Set(keys)].sort()).toEqual([...DEVSPACE_IMAGE_LABELS].sort());
  });
});

describe('chosenSharedImage', () => {
  it('takes the newest image, then the smallest ID', () => {
    const a = { id: 'sha256:b', createdAt: '2026-11-01T00:00:00Z' };
    const b = { id: 'sha256:a', createdAt: '2026-11-01T00:00:00Z' };
    const c = { id: 'sha256:c', createdAt: '2026-10-01T00:00:00Z' };
    expect(chosenSharedImage([c, a, b])).toBe(b);
    expect(chosenSharedImage([c, { id: 'sha256:d', createdAt: '2026-11-02T00:00:00Z' }, a])?.id).toBe('sha256:d');
    expect(chosenSharedImage([])).toBeUndefined();
    // The image of the record of a prepare first (by its ID, without case), when it is one of them.
    expect(chosenSharedImage([c, a, b], c.id.toUpperCase().replace('SHA256', 'sha256'))).toBe(c);
    expect(chosenSharedImage([c, a, b], 'sha256:gone')).toBe(b);
  });
});
