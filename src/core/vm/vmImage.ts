// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The image of the VM of Devspaces (docs/architecture.md "The image of the VM", R-VM-002): the files of one version on
// ghcr.io, pinned in vmImagePin.json (written by scripts/vm-image.mjs) by their digest and size, for amd64 and arm64:
// the `.wsl` file for WSL and the disk for Lima. Devspaces downloads a file over HTTPS without a login and without a
// Docker CLI: the anonymous token of the registry for a pull, then the blob of its digest, which ghcr.io redirects to the
// storage of GitHub. The SHA-256 of the digest checks the file. No `vscode`.
import { downloadFile, nodeHttpsGet, type HttpGet } from '../docker/dockerDownload';
import pinFile from './vmImagePin.json';

/** One file of the image: its name in the build, its digest (`sha256:<hex>`), and its size in bytes. */
export interface VmImageFile {
  name: string;
  digest: string;
  size: number;
}

/** The kinds of files of the image: the `.wsl` file for WSL, and the disk for Lima (QCOW2). */
export type VmImageKind = 'wsl' | 'lima';

/** The pin of the image: the version (null before the first push), the repository, and the files of each architecture. */
export interface VmImagePin {
  version: string | null;
  repository: string;
  files: Partial<Record<string, Partial<Record<VmImageKind, VmImageFile>>>>;
}

/** The pin of this version of Devspaces (vmImagePin.json). */
export const VM_IMAGE_PIN: VmImagePin = pinFile;
/** A digest of the pin. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** The time limit of the token of the registry. */
const TOKEN_TIMEOUT_MS = 30_000;
/** The largest answer of the token request that is read. */
const MAX_TOKEN_ANSWER = 64 * 1024;
/** A download that receives no bytes for this long stops (also before the answer of the server). */
const STALLED_AFTER_MS = 60_000;

/** The architecture of the image for the processor of this computer (`process.arch`), or undefined for another one. */
export function vmImageArch(arch: string): 'amd64' | 'arm64' | undefined {
  return arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined;
}

/** The file of `kind` for the processor `arch` with the version of the pin; undefined without a pin or such a file. */
export function vmImageFile(kind: VmImageKind, arch: string, pin: VmImagePin = VM_IMAGE_PIN): (VmImageFile & { version: string }) | undefined {
  const imageArch = vmImageArch(arch);
  const file = imageArch === undefined ? undefined : pin.files[imageArch]?.[kind];
  if (pin.version === null || file === undefined || !DIGEST.test(file.digest)) return undefined;
  return { ...file, version: pin.version };
}

/** The registry host and the repository of the pin: `ghcr.io` and `nimblescape/devspaces-vm`. */
function registryOf(pin: VmImagePin): { host: string; repository: string } {
  const [host, ...rest] = pin.repository.split('/');
  return { host, repository: rest.join('/') };
}

export interface DownloadVmImageOptions {
  kind: VmImageKind;
  /** The processor of this computer (`process.arch`). */
  arch: string;
  /** The file to write; a partial download is written next to it and removed on failure. */
  target: string;
  signal?: AbortSignal;
  /** Called while bytes arrive; `total` from Content-Length, when known. */
  onProgress?: (received: number, total: number | undefined) => void;
  /** For tests: another pin than vmImagePin.json. */
  pin?: VmImagePin;
  /** For tests. Default: 60 seconds without a byte stop the download. */
  stalledAfterMs?: number;
  /** For tests. Default: nodeHttpsGet. */
  get?: HttpGet;
}

/**
 * Downloads the file of `kind` of the pinned image for `arch` to `target`, and returns its entry of the pin. Throws
 * without such a file in the pin, when the registry gives no token, when the download or its check fails, when no byte
 * came for a minute, and with an AbortError when the signal aborts.
 */
export async function downloadVmImage(options: DownloadVmImageOptions): Promise<VmImageFile & { version: string }> {
  const pin = options.pin ?? VM_IMAGE_PIN;
  const file = vmImageFile(options.kind, options.arch, pin);
  if (file === undefined) throw new Error(`Devspaces has no image of its VM for ${options.kind} on ${options.arch}.`);
  const { host, repository } = registryOf(pin);
  const get = options.get ?? nodeHttpsGet;
  const signal = options.signal ?? new AbortController().signal;
  const token = await pullToken(host, repository, get, signal);
  await downloadFile({
    url: `https://${host}/v2/${repository}/blobs/${file.digest}`,
    host,
    headers: { Authorization: `Bearer ${token}` },
    expected: { sha256: file.digest.slice('sha256:'.length), size: file.size },
    // ghcr.io answers with a redirect to the storage of GitHub, without the token; the SHA-256 checks the file.
    anyHttpsRedirect: true,
    maxBytes: file.size,
    stalledAfterMs: options.stalledAfterMs ?? STALLED_AFTER_MS,
    target: options.target,
    signal,
    onProgress: options.onProgress,
    get,
  });
  return file;
}

/** The anonymous token of the registry for a pull of `repository` (`GET /token?scope=repository:<name>:pull`). */
async function pullToken(host: string, repository: string, get: HttpGet, signal: AbortSignal): Promise<string> {
  const url = `https://${host}/token?scope=${encodeURIComponent(`repository:${repository}:pull`)}&service=${encodeURIComponent(host)}`;
  const response = await get(url, AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)]));
  let text = '';
  for await (const chunk of response.body) {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.length > MAX_TOKEN_ANSWER) throw new Error(`The token of ${host} has a too long answer.`);
  }
  if (response.statusCode !== 200) throw new Error(`The token of ${host} for ${repository}: HTTP status ${response.statusCode}.`);
  let token: unknown;
  try {
    const body = JSON.parse(text) as { token?: unknown; access_token?: unknown };
    token = body.token ?? body.access_token;
  } catch {
    token = undefined;
  }
  if (typeof token !== 'string' || token === '' || /[\s]/.test(token)) throw new Error(`The token of ${host} for ${repository}: no token in the answer.`);
  return token;
}
