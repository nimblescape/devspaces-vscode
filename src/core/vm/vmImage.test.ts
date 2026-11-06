// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HttpGet } from '../docker/dockerDownload';
import { downloadVmImage, vmImageArch, vmImageFile, type VmImagePin } from './vmImage';
import pinFile from './vmImagePin.json';

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-vm-image-'));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

const DISK = Buffer.from('a disk for Lima');
const DIGEST = `sha256:${crypto.createHash('sha256').update(DISK).digest('hex')}`;
const PIN: VmImagePin = {
  version: '13.20261106.1200',
  repository: 'ghcr.io/nimblescape/devspaces-vm',
  files: { arm64: { lima: { name: 'devspaces-vm-arm64.qcow2', digest: DIGEST, size: DISK.length } } },
};
const TOKEN_URL = 'https://ghcr.io/token?scope=repository%3Animblescape%2Fdevspaces-vm%3Apull&service=ghcr.io';
const BLOB_URL = `https://ghcr.io/v2/nimblescape/devspaces-vm/blobs/${DIGEST}`;
const STORAGE_URL = 'https://pkg-containers.githubusercontent.com/ghcr1/blobs/sha256:abc?se=2026';

interface Request {
  url: string;
  headers?: Record<string, string>;
}

function registry(answers: Record<string, { status: number; body?: Buffer | string; location?: string }>): { get: HttpGet; requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    get: async (url, _signal, headers) => {
      requests.push(headers === undefined ? { url } : { url, headers });
      const answer = answers[url] ?? { status: 404, body: '' };
      const body = answer.body === undefined ? Buffer.alloc(0) : Buffer.from(answer.body);
      const responseHeaders: Record<string, string> = { 'content-length': String(body.length) };
      if (answer.location !== undefined) responseHeaders.location = answer.location;
      return { statusCode: answer.status, headers: responseHeaders, body: Readable.from([body]) };
    },
  };
}

describe('the pin of the image of the VM', () => {
  it('names no version, or a version with a WSL file and a disk for Lima of amd64 and arm64 on ghcr.io', () => {
    const pin: VmImagePin = pinFile;
    expect(pin.repository).toBe('ghcr.io/nimblescape/devspaces-vm');
    if (pin.version === null) {
      expect(pin.files).toEqual({});
      expect(vmImageFile('lima', 'arm64', pin)).toBeUndefined();
      return;
    }
    expect(pin.version).toMatch(/^13\.\d{8}\.\d{4}$/);
    for (const arch of ['x64', 'arm64']) {
      for (const kind of ['wsl', 'lima'] as const) {
        const file = vmImageFile(kind, arch, pin);
        expect(file?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(file?.size).toBeGreaterThan(0);
      }
    }
  });
});

describe('vmImageArch and vmImageFile', () => {
  it('maps the processors of Node.js to the architectures of the image, and finds the files of the pin', () => {
    expect(vmImageArch('x64')).toBe('amd64');
    expect(vmImageArch('arm64')).toBe('arm64');
    expect(vmImageArch('arm')).toBeUndefined();
    expect(vmImageFile('lima', 'arm64', PIN)).toEqual({ name: 'devspaces-vm-arm64.qcow2', digest: DIGEST, size: DISK.length, version: '13.20261106.1200' });
    expect(vmImageFile('wsl', 'arm64', PIN)).toBeUndefined();
    expect(vmImageFile('lima', 'x64', PIN)).toBeUndefined();
    expect(vmImageFile('lima', 'arm64', { ...PIN, version: null })).toBeUndefined();
    const bad = { ...PIN, files: { arm64: { lima: { name: 'x', digest: 'sha256:../../etc', size: 1 } } } };
    expect(vmImageFile('lima', 'arm64', bad)).toBeUndefined();
  });
});

describe('downloadVmImage', () => {
  it('takes an anonymous token, sends it only to ghcr.io, follows the redirect to the storage, and checks the digest', async () => {
    const { get, requests } = registry({
      [TOKEN_URL]: { status: 200, body: JSON.stringify({ token: 'djE6bmltYmxlc2NhcGU=' }) },
      [BLOB_URL]: { status: 307, location: STORAGE_URL },
      [STORAGE_URL]: { status: 200, body: DISK },
    });
    const target = path.join(folder, 'disk.qcow2');
    await expect(downloadVmImage({ kind: 'lima', arch: 'arm64', target, pin: PIN, get })).resolves.toMatchObject({ digest: DIGEST, version: '13.20261106.1200' });
    expect(fs.readFileSync(target)).toEqual(DISK);
    expect(requests).toEqual([{ url: TOKEN_URL }, { url: BLOB_URL, headers: { Authorization: 'Bearer djE6bmltYmxlc2NhcGU=' } }, { url: STORAGE_URL }]);
  });

  it('keeps nothing of a file with another digest, and fails without a token or without a file in the pin', async () => {
    const target = path.join(folder, 'disk.qcow2');
    const other = registry({ [TOKEN_URL]: { status: 200, body: '{"token":"t"}' }, [BLOB_URL]: { status: 200, body: Buffer.from('another disk!!!') } });
    await expect(downloadVmImage({ kind: 'lima', arch: 'arm64', target, pin: PIN, get: other.get })).rejects.toThrow('is not the file of its pin');
    expect(fs.readdirSync(folder)).toEqual([]);
    const denied = registry({ [TOKEN_URL]: { status: 401, body: '{"errors":[]}' } });
    await expect(downloadVmImage({ kind: 'lima', arch: 'arm64', target, pin: PIN, get: denied.get })).rejects.toThrow(
      'The token of ghcr.io for nimblescape/devspaces-vm: HTTP status 401.',
    );
    const empty = registry({ [TOKEN_URL]: { status: 200, body: '{}' } });
    await expect(downloadVmImage({ kind: 'lima', arch: 'arm64', target, pin: PIN, get: empty.get })).rejects.toThrow('no token in the answer');
    await expect(downloadVmImage({ kind: 'wsl', arch: 'arm64', target, pin: PIN, get: empty.get })).rejects.toThrow(
      'Devspaces has no image of its VM for wsl on arm64.',
    );
    expect(fs.readdirSync(folder)).toEqual([]);
  });
});
