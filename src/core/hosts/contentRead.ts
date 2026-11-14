// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The read of Show Files (contentReader.ts), within an operation on the host of the volume or the image (the shared
// shell, or the Docker pipe of the extension): the helper images on the host that can run the reader (readerImages),
// for a volume the check that it is still there (a mount of a missing volume would create it), then one run of the
// reader. Only calls that read, and the reader, which only reads; nothing is pulled. No `vscode`.
import type { BootstrapDocker } from '../docker/bootstrapDocker';
import { readableStderr } from '../loader/pipeLoader';
import type { RunResult } from '../ports';
import { CONTENT_READER_TIMEOUT_MS, contentReaderArgs, isContentTarget, parseContentTree, type ContentTarget, type ContentTree } from './contentReader';
import { OLD_CLI_DETAIL, newReaderName, readerImages } from './volumeReader';

/** The time limit of each list before the read. */
const LIST_TIMEOUT_MS = 30_000;
/** The end of an error output that a failure keeps. */
const DETAIL_LENGTH = 2000;

/** The outcome of readContents. */
export type ContentReadOutcome =
  | { kind: 'read'; tree: ContentTree }
  /** The host has no helper image of Devspaces, which the reader needs (it never pulls one). */
  | { kind: 'noImage' }
  /** The Docker Engine or the Docker CLI of the host cannot mount an image (Docker 28 or newer can). */
  | { kind: 'unsupported'; detail: string }
  | { kind: 'failed'; detail: string };

export interface ContentReadInput {
  target: ContentTarget;
  /** The helper tag of this version of Devspaces (helperImageTag): the reader tries it first. */
  currentHelperTag?: string;
  signal?: AbortSignal;
  /** Only for the tests: the name of the container. */
  name?: () => string;
}

/** The errors of Docker that say that it cannot mount an image (an engine before 28, or a Docker CLI that does not know the type). */
const IMAGE_MOUNT_UNSUPPORTED = /mount type[^\n]{0,20}image|type[^\n]{0,5}image[^\n]{0,40}(not supported|unsupported|invalid|unknown)|(invalid|unknown|unsupported)[^\n]{0,40}type[^\n]{0,5}"?image|requires API version|not supported by API version/i;

function detailOf(result: RunResult): string {
  const detail = readableStderr(result.stderr.slice(-DETAIL_LENGTH), DETAIL_LENGTH);
  return detail !== '' ? detail : `The reader ended with exit code ${String(result.exitCode)}.`;
}

async function listed(docker: Pick<BootstrapDocker, 'run'>, args: string[], signal: AbortSignal | undefined): Promise<RunResult> {
  return docker.run(args, { timeoutMs: LIST_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) });
}

/**
 * Show Files of `input.target` on the host of the current operation: the tree of its folders and files. Throws only an
 * AbortError (and the errors of a Docker CLI that cannot run).
 */
export async function readContents(docker: Pick<BootstrapDocker, 'run'>, input: ContentReadInput): Promise<ContentReadOutcome> {
  const { target, signal } = input;
  if (!isContentTarget(target)) return { kind: 'failed', detail: 'The volume or the image has no name or ID that the reader can mount.' };
  if (target.kind === 'volume') {
    const inspected = await listed(docker, ['volume', 'inspect', '--format', '{{.Name}}', target.name], signal);
    if (inspected.exitCode !== 0 || inspected.timedOut) return { kind: 'failed', detail: `The volume is not there anymore, or Docker could not give it: ${detailOf(inspected)}` };
  }
  const images = await listed(docker, ['image', 'ls', '--filter', 'reference=devspaces-worker', '--filter', 'reference=devspaces-monitor', '--format', '{{.Repository}}:{{.Tag}}'], signal);
  if (images.exitCode !== 0 || images.timedOut) return { kind: 'failed', detail: detailOf(images) };
  const tags = images.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  for (const image of readerImages(tags, input.currentHelperTag)) {
    const args = contentReaderArgs({ image, target, name: (input.name ?? newReaderName)() });
    const result = await docker.run(args, { timeoutMs: CONTENT_READER_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) });
    if (result.timedOut) return { kind: 'failed', detail: `The reader did not end within ${CONTENT_READER_TIMEOUT_MS / 1000} s.` };
    if (result.exitCode === 0) {
      const tree = parseContentTree(result.stdout);
      return tree !== undefined ? { kind: 'read', tree } : { kind: 'failed', detail: 'The output of the reader could not be read.' };
    }
    if (new RegExp(`no such image:? *${image.replace(/[.*+?^$()|[\]\\/{}]/g, '\\$&')}`, 'i').test(result.stderr)) continue;
    if (/unknown flag: --pull/.test(result.stderr)) return { kind: 'failed', detail: OLD_CLI_DETAIL };
    if (target.kind === 'image' && IMAGE_MOUNT_UNSUPPORTED.test(result.stderr)) return { kind: 'unsupported', detail: detailOf(result) };
    return { kind: 'failed', detail: detailOf(result) };
  }
  return { kind: 'noImage' };
}
