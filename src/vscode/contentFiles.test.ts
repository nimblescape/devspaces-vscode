// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Show Files of a volume or an image row of the view Docker Hosts (R-ENG-008, R-ENG-010): the tree of its folders and
// files as a read-only document, read as a flow of the user; nothing while the setting devspaces.allowContentReads is
// off or while the VM of Devspaces does not run; a host without a helper image, an engine that cannot mount an image,
// and any other failure, said in words.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { LIMA_HOST } from '../core/docker/dockerHost';
import type { ContentReadOutcome } from '../core/hosts/contentRead';
import type { ContentTree } from '../core/hosts/contentReader';
import type { HostObject } from '../core/hosts/hostObjects';
import { sshPromptsAllowed } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import { CONTENT_FILES_SCHEME, ContentFiles, ContentFilesTexts, contentFilesTarget, type ContentFilesDeps } from './contentFiles';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
const IMAGE_ID = `sha256:${'ab'.repeat(32)}`;
const data: HostObject = { kind: 'volume', id: 'shop_data', name: 'shop_data', purpose: 'notDevspaces' };
const nginx: HostObject = { kind: 'image', id: IMAGE_ID, name: 'ghcr.io/acme/nginx:1.27', purpose: 'notDevspaces' };
const row = (host: string, object: HostObject) => ({ hostsNode: 'object', host, object });
// 2026-11-14 07:00 UTC.
const NOW = Date.UTC(2026, 10, 14, 7, 0);
const tree: ContentTree = {
  stopped: false,
  seen: 2,
  root: { name: '', type: 'folder', bytes: 5, modified: NOW, files: 1, folders: 1, entries: [{ name: 'www', type: 'folder', bytes: 5, modified: NOW, files: 1, folders: 0, entries: [{ name: 'index.html', type: 'file', bytes: 5, modified: NOW }] }] },
};

function harness(overrides: Partial<ContentFilesDeps> = {}) {
  const state = { allowed: true, vm: { kind: 'running' } as VmState, flow: false };
  const read = vi.fn(async (): Promise<ContentReadOutcome> => {
    state.flow = sshPromptsAllowed();
    return { kind: 'read', tree };
  });
  const files = new ContentFiles({ logger, allowed: () => state.allowed, vmHost: LIMA_HOST, vmState: async () => state.vm, read, timeZone: () => 'UTC', now: () => NOW, ...overrides });
  return { state, read, files };
}

type Shown = { uri: { scheme: string; path: string }; getText(): string };

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
});

describe('Show Files of a volume or an image row', () => {
  it('opens the tree of a volume by its name, read as a flow of the user, in a tab of its own that a second Show Files updates', async () => {
    const h = harness();
    await h.files.showRow(row('lab', data));
    expect(h.read).toHaveBeenCalledWith('lab', { kind: 'volume', name: 'shop_data' });
    expect(h.state.flow).toBe(true);
    const [document, options] = fakeVscode.window.showTextDocument.mock.calls[0] as [Shown, unknown];
    expect(document.uri).toMatchObject({ scheme: CONTENT_FILES_SCHEME, path: '/lab/volume-shop_data.files' });
    expect(options).toEqual({ preview: false });
    expect(document.getText().split('\n').slice(0, 2)).toEqual(['Files of the volume shop_data on lab', 'Read 2026-11-14 07:00 · 1 file in 1 folder · 5 B (the sizes of the files)']);
    expect(document.getText()).toContain('index.html');
    // A second Show Files shows the newer tree in the same document.
    h.read.mockResolvedValue({ kind: 'read', tree: { ...tree, root: { ...tree.root, files: 0, folders: 0, bytes: 0, entries: [] } } });
    await h.files.showRow(row('lab', data));
    const [again] = fakeVscode.window.showTextDocument.mock.calls[1] as [Shown];
    expect(again.uri.path).toBe('/lab/volume-shop_data.files');
    expect(again.getText()).not.toContain('index.html');
    h.files.dispose();
    expect(fakeVscode.contentProviders.size).toBe(0);
  });

  it('reads an image by its full ID, and keeps one segment of the path for a name with a slash and a colon', async () => {
    const h = harness();
    await h.files.showRow(row('lab', nginx));
    expect(h.read).toHaveBeenCalledWith('lab', { kind: 'image', id: IMAGE_ID });
    const [document] = fakeVscode.window.showTextDocument.mock.calls[0] as [Shown];
    expect(document.uri.path).toBe('/lab/image-ghcr.io_acme_nginx_1.27.files');
    expect(document.getText()).toMatch(/^Files of the image ghcr\.io\/acme\/nginx:1\.27 on lab\n/);
  });

  it('reads nothing for a row that is no volume or image, or an image without its full ID', async () => {
    const h = harness();
    await h.files.showRow(row('lab', { kind: 'container', id: 'f'.repeat(64), name: 'web', purpose: 'notDevspaces', state: 'running' }));
    await h.files.showRow(row('lab', { ...nginx, id: 'ab'.repeat(6) }));
    await h.files.showRow({ hostsNode: 'host', host: 'lab' });
    await h.files.showRow(undefined);
    expect(h.read).not.toHaveBeenCalled();
    expect(contentFilesTarget('lab', data)).toEqual({ host: 'lab', target: { kind: 'volume', name: 'shop_data' }, name: 'shop_data' });
    expect(contentFilesTarget('lab', { kind: 'network', id: 'n', name: 'n' })).toBeUndefined();
  });

  it('reads nothing while the setting devspaces.allowContentReads is off, and says how to turn it on', async () => {
    const h = harness();
    h.state.allowed = false;
    await h.files.showRow(row('lab', data));
    expect(h.read).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ContentFilesTexts.off);
    expect(fakeVscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it('never starts the VM: on a VM that does not run, it reads nothing and says why', async () => {
    const h = harness();
    for (const vm of [{ kind: 'stopped' }, { kind: 'notSetUp' }, { kind: 'unknown' }] as VmState[]) {
      h.state.vm = vm;
      await h.files.showRow(row(LIMA_HOST, data));
    }
    expect(h.read).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ContentFilesTexts.vmNotRunning);
    h.state.vm = { kind: 'running' };
    await h.files.showRow(row(LIMA_HOST, data));
    expect(h.read).toHaveBeenCalledWith(LIMA_HOST, { kind: 'volume', name: 'shop_data' });
  });

  it('says why it could not read, and opens no document', async () => {
    const h = harness();
    const files = contentFilesTarget('lab', nginx);
    if (files === undefined) throw new Error('No target.');
    h.read.mockResolvedValueOnce({ kind: 'noImage' });
    await h.files.showRow(row('lab', nginx));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenLastCalledWith(ContentFilesTexts.noImage(files));
    h.read.mockResolvedValueOnce({ kind: 'unsupported', detail: 'invalid mount type "image"\nSee docker run --help.' });
    await h.files.showRow(row('lab', nginx));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenLastCalledWith(ContentFilesTexts.unsupported(files, 'invalid mount type "image"'));
    h.read.mockResolvedValueOnce({ kind: 'failed', detail: 'The reader ended with exit code 1.' });
    await h.files.showRow(row('lab', nginx));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenLastCalledWith('The files of the image ghcr.io/acme/nginx:1.27 could not be read: The reader ended with exit code 1.');
    h.read.mockRejectedValueOnce(new Error('Docker is not installed'));
    await h.files.showRow(row('lab', nginx));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenLastCalledWith('The files of the image ghcr.io/acme/nginx:1.27 could not be read: Docker is not installed');
    expect(fakeVscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it('says nothing when the user cancels the login of the host', async () => {
    const h = harness();
    h.read.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    await h.files.showRow(row('lab', data));
    expect(fakeVscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(fakeVscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it('opens nothing after its window closed', async () => {
    const h = harness();
    h.files.dispose();
    await h.files.showRow(row('lab', data));
    expect(h.read).not.toHaveBeenCalled();
  });
});
