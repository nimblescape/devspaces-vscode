// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The read of Show Files (R-ENG-010): for a volume the check that it is still there, the helper images of the host,
// then one run of the reader per image until one is there; each call is one that the shared shell of a host carries;
// an engine or a Docker CLI that cannot mount an image gives `unsupported`, a host without a helper image `noImage`.
import { describe, expect, it } from 'vitest';
import { isSharedShellCall } from '../docker/bootstrapDocker';
import type { RunOptions, RunResult } from '../ports';
import { readContents } from './contentRead';
import { CONTENT_READER_TIMEOUT_MS, contentReaderArgs, type ContentTarget } from './contentReader';
import { OLD_CLI_DETAIL } from './volumeReader';

const HELPER = 'devspaces-worker:0123456789ab';
const OTHER = 'devspaces-monitor:111111111111';
const NAME = 'devspaces-reader-0a1b2c3d';
const IMAGE_ID = `sha256:${'cd'.repeat(32)}`;
const volume: ContentTarget = { kind: 'volume', name: 'shop_data' };
const image: ContentTarget = { kind: 'image', id: IMAGE_ID };
const output = JSON.stringify({ reader: 1, stopped: false, entries: 1, tree: { n: '', t: 'd', s: 3, m: 0, f: 1, d: 0, x: 0, c: [{ n: 'a.txt', t: 'f', s: 3, m: 0 }] } });

const result = (overrides: Partial<RunResult>): RunResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...overrides });

function fakeDocker(results: RunResult[]): { run: (args: readonly string[], options?: RunOptions) => Promise<RunResult>; calls: { args: readonly string[]; options?: RunOptions }[] } {
  const calls: { args: readonly string[]; options?: RunOptions }[] = [];
  return {
    calls,
    run: async (args, options) => {
      calls.push({ args, ...(options !== undefined ? { options } : {}) });
      const next = results.shift();
      if (next === undefined) throw new Error('No more results.');
      return next;
    },
  };
}

const listedImages = result({ stdout: `${OTHER}\n${HELPER}\n` });

describe('a read of Show Files', () => {
  it('checks that the volume is there, lists the helper images, and reads with the current one first, each through a call of the shared shell', async () => {
    const docker = fakeDocker([result({ stdout: 'shop_data\n' }), listedImages, result({ stdout: output })]);
    const outcome = await readContents(docker, { target: volume, currentHelperTag: HELPER, name: () => NAME });
    expect(outcome).toMatchObject({ kind: 'read', tree: { stopped: false, seen: 1, root: { files: 1 } } });
    expect(docker.calls.map((call) => call.args)).toEqual([
      ['volume', 'inspect', '--format', '{{.Name}}', 'shop_data'],
      ['image', 'ls', '--filter', 'reference=devspaces-worker', '--filter', 'reference=devspaces-monitor', '--format', '{{.Repository}}:{{.Tag}}'],
      contentReaderArgs({ image: HELPER, target: volume, name: NAME }),
    ]);
    expect(docker.calls[2].options?.timeoutMs).toBe(CONTENT_READER_TIMEOUT_MS);
    for (const call of docker.calls) {
      expect(isSharedShellCall(call.args, false)).toBe(true);
      expect(isSharedShellCall(call.args, true)).toBe(true);
    }
  });

  it('reads an image without a check of a volume, and tries the next image when Docker has the first one no longer', async () => {
    const docker = fakeDocker([listedImages, result({ exitCode: 125, stderr: `Unable to find image '${HELPER}' locally\ndocker: Error response from daemon: No such image: ${HELPER}\n` }), result({ stdout: output })]);
    expect(await readContents(docker, { target: image, currentHelperTag: HELPER, name: () => NAME })).toMatchObject({ kind: 'read' });
    expect(docker.calls.map((call) => call.args[0])).toEqual(['image', 'run', 'run']);
    expect(docker.calls[2].args).toEqual(contentReaderArgs({ image: OTHER, target: image, name: NAME }));
    // The image store of containerd names the image with its registry.
    const containerd = fakeDocker([listedImages, result({ exitCode: 125, stderr: `docker: Error response from daemon: No such image: docker.io/library/${HELPER}\n` }), result({ stdout: output })]);
    expect(await readContents(containerd, { target: image, currentHelperTag: HELPER, name: () => NAME })).toMatchObject({ kind: 'read' });
    expect(containerd.calls[2].args).toEqual(contentReaderArgs({ image: OTHER, target: image, name: NAME }));
  });

  it('says noImage when the host has no helper image, or none of them anymore', async () => {
    expect(await readContents(fakeDocker([result({ stdout: 'devspaces-worker:<none>\n' })]), { target: image, name: () => NAME })).toEqual({ kind: 'noImage' });
    const gone = (tag: string) => result({ exitCode: 125, stderr: `docker: Error response from daemon: No such image: ${tag}\n` });
    expect(await readContents(fakeDocker([listedImages, gone(HELPER), gone(OTHER)]), { target: image, currentHelperTag: HELPER, name: () => NAME })).toEqual({ kind: 'noImage' });
  });

  it('never mounts a volume that is not there anymore (the mount would create it)', async () => {
    const docker = fakeDocker([result({ exitCode: 1, stderr: 'Error response from daemon: get shop_data: no such volume\n' })]);
    expect(await readContents(docker, { target: volume, name: () => NAME })).toEqual({ kind: 'failed', detail: 'The volume is not there anymore, or Docker could not give it: Error response from daemon: get shop_data: no such volume' });
    expect(docker.calls).toHaveLength(1);
  });

  it('says unsupported when the engine or the Docker CLI cannot mount an image, and failed for the other errors', async () => {
    for (const stderr of [
      'docker: Error response from daemon: mount type "image" is not supported.\n',
      'invalid argument "type=image,source=sha256:cd" for "--mount" flag: invalid mount type "image"\n',
      'docker: Error response from daemon: client version 1.48 is too new. Maximum supported API version is 1.47: requires API version 1.48\n',
    ]) {
      expect(await readContents(fakeDocker([listedImages, result({ exitCode: 125, stderr })]), { target: image, currentHelperTag: HELPER, name: () => NAME })).toMatchObject({ kind: 'unsupported' });
    }
    // The same words for a volume are an error of the call, not of an image mount.
    expect(await readContents(fakeDocker([result({ stdout: 'shop_data\n' }), listedImages, result({ exitCode: 125, stderr: 'invalid mount type "image"\n' })]), { target: volume, name: () => NAME })).toEqual({
      kind: 'failed',
      detail: 'invalid mount type "image"',
    });
    expect(await readContents(fakeDocker([listedImages, result({ exitCode: 125, stderr: 'unknown flag: --pull\nSee docker run --help.\n' })]), { target: image, name: () => NAME })).toEqual({ kind: 'failed', detail: OLD_CLI_DETAIL });
    expect(await readContents(fakeDocker([listedImages, result({ exitCode: 1 })]), { target: image, name: () => NAME })).toEqual({ kind: 'failed', detail: 'The reader ended with exit code 1.' });
    expect(await readContents(fakeDocker([listedImages, result({ exitCode: null, timedOut: true })]), { target: image, name: () => NAME })).toEqual({ kind: 'failed', detail: 'The reader did not end within 90 s.' });
    expect(await readContents(fakeDocker([listedImages, result({ stdout: 'garbage' })]), { target: image, name: () => NAME })).toEqual({ kind: 'failed', detail: 'The output of the reader could not be read.' });
    expect(await readContents(fakeDocker([result({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon\n' })]), { target: image, name: () => NAME })).toEqual({ kind: 'failed', detail: 'Cannot connect to the Docker daemon' });
  });

  it('runs nothing for a target that the call cannot carry', async () => {
    const docker = fakeDocker([]);
    expect(await readContents(docker, { target: { kind: 'image', id: 'nginx:latest' }, name: () => NAME })).toMatchObject({ kind: 'failed' });
    expect(await readContents(docker, { target: { kind: 'volume', name: '-v' }, name: () => NAME })).toMatchObject({ kind: 'failed' });
    expect(docker.calls).toEqual([]);
  });

  it('passes its signal to each call and lets an abort through', async () => {
    const controller = new AbortController();
    const docker = fakeDocker([listedImages, result({ stdout: output })]);
    await readContents(docker, { target: image, signal: controller.signal, name: () => NAME });
    expect(docker.calls.every((call) => call.options?.signal === controller.signal)).toBe(true);
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    await expect(readContents({ run: () => Promise.reject(abort) }, { target: image, name: () => NAME })).rejects.toBe(abort);
  });
});
