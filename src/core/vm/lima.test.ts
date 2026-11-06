// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import * as zlib from 'zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HttpGet } from '../docker/dockerDownload';
import { silentLogger, type Logger } from '../ports';
import { installLima, LIMA_DOWNLOAD_HOST, limactlPath, limaDownload, limaPlatformKey, limaVersion, presentLima, type LimaPin } from './lima';
import pinFile from './limaPin.json';

let folder: string;

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-lima-'));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

const LIMACTL = Buffer.from('#!/bin/sh\necho "limactl version 9.9.9"\n');
const AGENT = Buffer.from('guest agent');
const AGENT_ENTRY = 'share/lima/lima-guestagent.Linux-x86_64.gz';

/** One entry of a tar archive in the GNU form, with its data padded to 512 bytes. */
function tarEntry(name: string, data: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(type === '5' ? '0000755\0' : '0000644\0', 100, 'latin1');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  header.write(type, 156, 'latin1');
  header.write('ustar  \0', 257, 'latin1');
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/** An archive with the layout of the archives of Lima: folders, limactl, a link, documents, and the guest agent. */
function limaArchive(agentEntry = AGENT_ENTRY): Buffer {
  return zlib.gzipSync(
    Buffer.concat([
      tarEntry('./bin/', Buffer.alloc(0), '5'),
      tarEntry('./bin/limactl', LIMACTL),
      tarEntry('./bin/lima', Buffer.alloc(0), '2'),
      tarEntry('./share/doc/lima/README.md', Buffer.from('docs')),
      tarEntry(`./${agentEntry}`, AGENT),
      Buffer.alloc(1024),
    ]),
  );
}

function pinOf(version: string, key: string, archive: Buffer, guestAgent = AGENT_ENTRY): LimaPin {
  return {
    version,
    files: {
      [key]: {
        url: `https://${LIMA_DOWNLOAD_HOST}/lima-vm/lima/releases/download/v${version}/lima-${version}-Linux-x86_64.tar.gz`,
        size: archive.length,
        sha256: crypto.createHash('sha256').update(archive).digest('hex'),
        guestAgent,
      },
    },
  };
}

/** Serves each URL of `files`; `redirects` maps a URL to the place that github.com sends it to. */
function serving(files: Record<string, Buffer>, redirects: Record<string, string> = {}): { get: HttpGet; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    get: async (url) => {
      urls.push(url);
      const location = redirects[url];
      if (location !== undefined) return { statusCode: 302, headers: { location }, body: Readable.from([]) };
      const body = files[url];
      if (body === undefined) return { statusCode: 404, headers: {}, body: Readable.from([]) };
      return { statusCode: 200, headers: { 'content-length': String(body.length) }, body: Readable.from([body]) };
    },
  };
}

function logged(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: { ...silentLogger, info: (line) => lines.push(line), warn: (line) => lines.push(line) }, lines };
}

describe('the pin of Lima', () => {
  it('names no version or a version x.y.z with an archive of github.com for each platform of macOS and Linux', () => {
    const pin: LimaPin = pinFile;
    if (pin.version === null) {
      expect(pin.files).toEqual({});
      expect(limaVersion(pin)).toBeUndefined();
      return;
    }
    expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(pin.files).sort()).toEqual(['linux-aarch64', 'linux-x86_64', 'mac-aarch64', 'mac-x86_64']);
    for (const [key, file] of Object.entries(pin.files)) {
      expect(file.url.startsWith(`https://${LIMA_DOWNLOAD_HOST}/lima-vm/lima/releases/download/v${pin.version}/`)).toBe(true);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.size).toBeGreaterThan(0);
      expect(file.guestAgent).toMatch(new RegExp(`^share/lima/lima-guestagent\\.Linux-${key.split('-')[1]}(\\.gz)?$`));
    }
  });
});

describe('limaPlatformKey and limaDownload', () => {
  it('maps macOS and Linux on x64 and arm64 to the keys of the pin, and nothing else', () => {
    expect(limaPlatformKey('darwin', 'arm64')).toBe('mac-aarch64');
    expect(limaPlatformKey('darwin', 'x64')).toBe('mac-x86_64');
    expect(limaPlatformKey('linux', 'arm64')).toBe('linux-aarch64');
    expect(limaPlatformKey('linux', 'x64')).toBe('linux-x86_64');
    expect(limaPlatformKey('win32', 'x64')).toBeUndefined();
    expect(limaPlatformKey('linux', 'arm')).toBeUndefined();
  });

  it('gives nothing before the first pin, for a platform without a file, or for a guest agent of another form', () => {
    const archive = limaArchive();
    const pin = pinOf('2.2.1', 'linux-x86_64', archive);
    expect(limaDownload('linux', 'x64', pin)).toEqual({ ...pin.files['linux-x86_64'], version: '2.2.1' });
    expect(limaDownload('linux', 'x64', { version: null, files: {} })).toBeUndefined();
    expect(limaDownload('darwin', 'x64', pin)).toBeUndefined();
    expect(limaDownload('linux', 'x64', pinOf('2.2.1', 'linux-x86_64', archive, '../bin/sh'))).toBeUndefined();
  });
});

describe('installLima', () => {
  const archive = limaArchive();
  const current = pinOf('2.2.1', 'linux-x86_64', archive);
  const url = current.files['linux-x86_64'].url;
  const storage = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/lima.tar.gz';

  it('downloads the pinned archive once, follows the redirect of GitHub, keeps limactl and the guest agent, and removes older versions', async () => {
    fs.mkdirSync(path.join(folder, '1.0.0', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(folder, '1.0.0', 'bin', 'limactl'), 'old');
    // A newer version (of a newer Devspaces in another window), the folder of the VM and what is no version stay.
    for (const name of ['2.10.0', 'home', 'notes']) fs.mkdirSync(path.join(folder, name));
    const { get, urls } = serving({ [storage]: archive }, { [url]: storage });
    const { logger, lines } = logged();
    const options = { folder, platform: 'linux' as const, arch: 'x64', logger, pin: current, get };
    const [first, second] = await Promise.all([installLima(options), installLima(options)]);
    const program = limactlPath(folder, '2.2.1');
    expect([first, second]).toEqual([program, program]);
    expect(urls).toEqual([url, storage]);
    expect(fs.readFileSync(program)).toEqual(LIMACTL);
    expect(fs.readFileSync(path.join(folder, '2.2.1', 'share', 'lima', 'lima-guestagent.Linux-x86_64.gz'))).toEqual(AGENT);
    expect(fs.statSync(program).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(folder).sort()).toEqual(['2.10.0', '2.2.1', 'home', 'notes']);
    expect(fs.readdirSync(path.join(folder, '2.2.1')).sort()).toEqual(['bin', 'share']);
    expect(fs.readdirSync(path.join(folder, '2.2.1', 'bin'))).toEqual(['limactl']);
    expect(lines).toEqual(['Lima 1.0.0 was removed.', `Lima 2.2.1 is downloaded from ${url}.`, `Lima 2.2.1 is installed: ${program}`]);
    expect(presentLima(folder, 'linux', 'x64', current)).toBe(program);
    // Installed: no download.
    await expect(installLima(options)).resolves.toBe(program);
    expect(urls).toEqual([url, storage]);
  });

  it('keeps nothing of a file that is not the pinned one or lacks a file, and refuses a platform without a pin', async () => {
    const other = Buffer.from(archive);
    other[20] ^= 0xff;
    await expect(installLima({ folder, platform: 'linux', arch: 'x64', logger: silentLogger, pin: current, get: serving({ [url]: other }).get })).rejects.toThrow(
      'is not the file of its pin',
    );
    expect(fs.readdirSync(folder)).toEqual([]);
    const withoutAgent = limaArchive('share/lima/lima-guestagent.Linux-aarch64.gz');
    const pin = pinOf('2.2.1', 'linux-x86_64', withoutAgent);
    await expect(installLima({ folder, platform: 'linux', arch: 'x64', logger: silentLogger, pin, get: serving({ [url]: withoutAgent }).get })).rejects.toThrow(
      `${AGENT_ENTRY} is not in the archive`,
    );
    expect(fs.readdirSync(folder)).toEqual([]);
    await expect(installLima({ folder, platform: 'win32', arch: 'x64', logger: silentLogger, pin: current })).rejects.toThrow('Devspaces has no Lima for win32 on x64.');
    await expect(installLima({ folder, platform: 'linux', arch: 'x64', logger: silentLogger, pin: { version: null, files: {} } })).rejects.toThrow(
      'Devspaces has no Lima for linux on x64.',
    );
  });

  it('stops a download that receives no bytes for the stall time, and keeps nothing of it', async () => {
    const get: HttpGet = async () => ({ statusCode: 200, headers: { 'content-length': String(archive.length) }, body: new Readable({ read() {} }) });
    await expect(installLima({ folder, platform: 'linux', arch: 'x64', logger: silentLogger, pin: current, get, stalledAfterMs: 50 })).rejects.toThrow(
      `The download of ${url} received no bytes for 0 seconds.`,
    );
    expect(fs.readdirSync(folder)).toEqual([]);
  });

  it('removes the parts of an earlier install after an hour, and takes a version that another window installed meanwhile', async () => {
    const old = Date.now() / 1000 - 2 * 3600;
    for (const name of ['2.2.1.part-0123abcd', '2.2.1.part-89abcdef']) fs.mkdirSync(path.join(folder, name));
    fs.utimesSync(path.join(folder, '2.2.1.part-0123abcd'), old, old);
    // Another window renamed its folder first.
    const { get } = serving({ [url]: archive });
    const racing: HttpGet = async (requested, signal) => {
      const response = await get(requested, signal);
      fs.mkdirSync(path.join(folder, '2.2.1', 'bin'), { recursive: true });
      fs.mkdirSync(path.join(folder, '2.2.1', 'share', 'lima'), { recursive: true });
      fs.writeFileSync(path.join(folder, '2.2.1', 'bin', 'limactl'), LIMACTL);
      fs.writeFileSync(path.join(folder, '2.2.1', 'share', 'lima', 'lima-guestagent.Linux-x86_64.gz'), AGENT);
      return response;
    };
    await expect(installLima({ folder, platform: 'linux', arch: 'x64', logger: silentLogger, pin: current, get: racing })).resolves.toBe(limactlPath(folder, '2.2.1'));
    expect(fs.readdirSync(folder).sort()).toEqual(['2.2.1', '2.2.1.part-89abcdef']);
  });
});
