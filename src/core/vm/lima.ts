// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Lima of Devspaces (docs/architecture.md "The Lima VM of Devspaces", R-VM-001): on macOS and Linux, Devspaces manages
// its VM with one tested version of Lima, which it downloads into a folder of the user, so that macOS needs no
// administrator rights. The version, and the URL, the size and the SHA-256 of the archive of each platform, are pinned in
// limaPin.json (written by scripts/lima-pin.mjs, which checks them against the file SHA256SUMS of the release). The
// download is checked against the pin before anything is taken out of it, and only `bin/limactl` and the guest agent of
// the architecture of this computer are kept, in the layout that `limactl` needs: `<folder>/<version>/bin/limactl` and
// `<folder>/<version>/share/lima/<guest agent>`. A new version comes only with a new version of Devspaces; the folders of
// older versions are removed. No `vscode`.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { extractTarGzEntry } from '../docker/archive';
import { downloadFile, type HttpGet } from '../docker/dockerDownload';
import type { Logger } from '../ports';
import { compareVersions } from '../vscodeExtensions';
import pinFile from './limaPin.json';

/** The host of the pinned URLs of Lima; its downloads are redirected to the storage of GitHub, which the SHA-256 checks. */
export const LIMA_DOWNLOAD_HOST = 'github.com';
/** The largest program that is taken out of the archive (limactl 2.2.1 has about 30 MB, its guest agent less). */
const MAX_FILE_SIZE = 200 * 1024 * 1024;
/** A download that receives no bytes for this long stops (also before the answer of the server). */
const STALLED_AFTER_MS = 30_000;
/** A part of an earlier install (a window that was closed during it) that is older than this is removed. */
const STALE_PART_MS = 60 * 60_000;
/** The folder of a version, and a part of an install: `<version>.part-<8 hex>`. */
const VERSION_NAME = /^\d+\.\d+\.\d+$/;
const PART_NAME = /^\d+\.\d+\.\d+\.part-[0-9a-f]{8}$/;

/** One archive of the pin: its URL on github.com, its size in bytes, its SHA-256 (hex), and its guest agent. */
export interface LimaFile {
  url: string;
  size: number;
  sha256: string;
  /** The path of the guest agent in the archive, for example `share/lima/lima-guestagent.Linux-aarch64.gz`. */
  guestAgent: string;
}

/** The pin of Lima: the version (null before the first pin) and the archive of each platform key (limaPlatformKey). */
export interface LimaPin {
  version: string | null;
  files: Record<string, LimaFile>;
}

const PIN: LimaPin = pinFile;

/** The pinned version of Lima, or undefined before the first pin. */
export function limaVersion(pin: LimaPin = PIN): string | undefined {
  return pin.version ?? undefined;
}

/**
 * The key of the platform in the pin (`mac-aarch64`, `mac-x86_64`, `linux-aarch64`, `linux-x86_64`), the keys of the
 * Docker CLI of Devspaces; undefined where Devspaces runs no Lima (Windows, and other processors).
 */
export function limaPlatformKey(platform: NodeJS.Platform, arch: string): string | undefined {
  const cpu = limaCpu(arch);
  if (cpu === undefined) return undefined;
  if (platform === 'darwin') return `mac-${cpu}`;
  if (platform === 'linux') return `linux-${cpu}`;
  return undefined;
}

/** The name of the processor `arch` (`process.arch`) in the files of Lima, or undefined for another one. */
function limaCpu(arch: string): 'aarch64' | 'x86_64' | undefined {
  return arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : undefined;
}

/**
 * The archive of Lima for the platform from the pin, with its version; undefined without a pin or a file for it, and
 * when the pin names another file than the guest agent of Linux for this processor (compressed or not).
 */
export function limaDownload(platform: NodeJS.Platform, arch: string, pin: LimaPin = PIN): (LimaFile & { version: string }) | undefined {
  const key = limaPlatformKey(platform, arch);
  const file = key === undefined ? undefined : pin.files[key];
  if (pin.version === null || file === undefined) return undefined;
  const agents = [`share/lima/lima-guestagent.Linux-${limaCpu(arch)}`, `share/lima/lima-guestagent.Linux-${limaCpu(arch)}.gz`];
  if (!agents.includes(file.guestAgent)) return undefined;
  return { ...file, version: pin.version };
}

/** `<folder>/<version>/bin/limactl`: the program of Lima of `version` in its folder. */
export function limactlPath(folder: string, version: string): string {
  return path.join(folder, version, 'bin', 'limactl');
}

/** The program of the pinned Lima when it is installed (installLima), else undefined. */
export function presentLima(folder: string, platform: NodeJS.Platform, arch: string, pin: LimaPin = PIN): string | undefined {
  const download = limaDownload(platform, arch, pin);
  if (download === undefined) return undefined;
  const program = limactlPath(folder, download.version);
  const agent = path.join(folder, download.version, ...download.guestAgent.split('/'));
  return isFileSync(program) && isFileSync(agent) ? program : undefined;
}

export interface InstallLimaOptions {
  /** The folder of the versions of Lima (LimaPaths.lima, limaInstance.ts). */
  folder: string;
  platform: NodeJS.Platform;
  arch: string;
  logger: Logger;
  signal?: AbortSignal;
  /** Called while bytes arrive; `total` from Content-Length, when known. */
  onProgress?: (received: number, total: number | undefined) => void;
  /** For tests: another pin than limaPin.json. */
  pin?: LimaPin;
  /** For tests. Default: 30 seconds without a byte stop the download. */
  stalledAfterMs?: number;
  /** For tests. Default: nodeHttpsGet. */
  get?: HttpGet;
}

/** The installs that run in this extension host, by the folder of the version. */
const installing = new Map<string, Promise<string>>();

/**
 * The pinned Lima: the path of `limactl` when it is installed, else after a download from github.com that has the
 * pinned size and SHA-256, out of which only `bin/limactl` and the guest agent are kept. The calls of this extension host
 * at the same time share one download; another window may install the same version meanwhile (the first rename of the
 * folder wins, with the same content). Throws without a pin for the platform, when the download or its check fails, when
 * no byte came for 30 seconds, and with an AbortError when the signal aborts.
 */
export function installLima(options: InstallLimaOptions): Promise<string> {
  const pin = options.pin ?? PIN;
  const download = limaDownload(options.platform, options.arch, pin);
  if (download === undefined) return Promise.reject(new Error(`Devspaces has no Lima for ${options.platform} on ${options.arch}.`));
  const target = path.join(options.folder, download.version);
  const running = installing.get(target);
  if (running !== undefined) return running;
  const install = installNow(options, download, pin).finally(() => installing.delete(target));
  installing.set(target, install);
  return install;
}

async function installNow(options: InstallLimaOptions, download: LimaFile & { version: string }, pin: LimaPin): Promise<string> {
  const { folder, logger } = options;
  const present = presentLima(folder, options.platform, options.arch, pin);
  if (present !== undefined) return present;
  await fs.promises.mkdir(folder, { recursive: true });
  await removeOtherVersions(folder, download.version, logger);
  await removeStaleParts(folder);
  const part = path.join(folder, `${download.version}.part-${crypto.randomBytes(4).toString('hex')}`);
  await fs.promises.mkdir(part);
  const archive = path.join(part, 'lima.tar.gz');
  try {
    logger.info(`Lima ${download.version} is downloaded from ${download.url}.`);
    await downloadFile({
      url: download.url,
      target: archive,
      host: LIMA_DOWNLOAD_HOST,
      expected: { size: download.size, sha256: download.sha256 },
      // github.com answers with a redirect to its storage for release files; the SHA-256 checks the file.
      anyHttpsRedirect: true,
      maxBytes: download.size,
      stalledAfterMs: options.stalledAfterMs ?? STALLED_AFTER_MS,
      signal: options.signal,
      onProgress: options.onProgress,
      get: options.get,
    });
    for (const entry of ['bin/limactl', download.guestAgent]) {
      const file = path.join(part, ...entry.split('/'));
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await extractTarGzEntry(archive, entry, file, MAX_FILE_SIZE);
    }
    await fs.promises.chmod(path.join(part, 'bin', 'limactl'), 0o755);
    await fs.promises.rm(archive, { force: true });
    const target = path.join(folder, download.version);
    try {
      await fs.promises.rename(part, target);
    } catch (error) {
      // Another window installed it meanwhile (the folder exists and is not empty).
      if (presentLima(folder, options.platform, options.arch, pin) === undefined) throw error;
    }
    const program = presentLima(folder, options.platform, options.arch, pin);
    if (program === undefined) throw new Error(`Lima ${download.version} is not complete in ${target}.`);
    logger.info(`Lima ${download.version} is installed: ${program}`);
    return program;
  } finally {
    await fs.promises.rm(part, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isFileSync(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Removes the folders of older versions (a link is removed, never what it points to). A newer version stays: an older
 * version of Devspaces in a window that was not reloaded after an update must not remove the Lima of the newer one.
 */
async function removeOtherVersions(folder: string, version: string, logger: Logger): Promise<void> {
  for (const name of await names(folder)) {
    if (!VERSION_NAME.test(name) || compareVersions(name, version) >= 0) continue;
    try {
      await fs.promises.rm(path.join(folder, name), { recursive: true, force: true });
      logger.info(`Lima ${name} was removed.`);
    } catch (error) {
      logger.warn(`Lima ${name} could not be removed: ${(error as Error).message}`);
    }
  }
}

/** Removes the parts of earlier installs that are older than STALE_PART_MS. */
async function removeStaleParts(folder: string): Promise<void> {
  for (const name of await names(folder)) {
    if (!PART_NAME.test(name)) continue;
    const part = path.join(folder, name);
    try {
      const stat = await fs.promises.lstat(part);
      if (Date.now() - stat.mtimeMs > STALE_PART_MS) await fs.promises.rm(part, { recursive: true, force: true });
    } catch {
      // Removed by another window meanwhile.
    }
  }
}

async function names(folder: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(folder);
  } catch {
    return [];
  }
}
