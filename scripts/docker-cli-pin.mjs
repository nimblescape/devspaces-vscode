// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `node scripts/docker-cli-pin.mjs [--version <x.y.z>] [--check]`: writes src/core/docker/dockerCliPin.json, the
// version of the Docker CLI that Devspaces downloads for the windows of devspaces on another computer
// (docs/architecture.md "The Docker CLI of Devspaces"), with the size and the SHA-256 of the file of each platform.
// download.docker.com publishes no checksums for these static builds, so the hashes are computed here from the files
// themselves, once, and the extension checks every download against them. Without --version, the version is the
// newest that all platforms of the pin have. The pin also names the Docker API versions that the CLI speaks (`api`,
// its oldest and its newest one), which the extension checks against the engine of a remote host before a window of a
// devspace there opens (src/core/docker/dockerApiVersion.ts); they are measured with the Linux build of this computer,
// so a new pin is written only on Linux x86_64 or aarch64. The workflow "Docker CLI" runs this every week and opens a
// pull request when the file changed. --check writes nothing: it downloads the files of the current pin again and fails
// when a size or a hash differs (Docker replaced a file), or, on Linux, when the CLI speaks other API versions than the
// pin names.
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pinFile = join(root, 'src', 'core', 'docker', 'dockerCliPin.json');
const BASE = 'https://download.docker.com';
/** The folder and the archive type of each platform key of the pin (ownDockerCli.ts dockerCliPlatformKey). */
const PLATFORMS = {
  'windows-x86_64': { folder: 'win/static/stable/x86_64', extension: 'zip' },
  'mac-x86_64': { folder: 'mac/static/stable/x86_64', extension: 'tgz' },
  'mac-aarch64': { folder: 'mac/static/stable/aarch64', extension: 'tgz' },
  'linux-x86_64': { folder: 'linux/static/stable/x86_64', extension: 'tgz' },
  'linux-aarch64': { folder: 'linux/static/stable/aarch64', extension: 'tgz' },
};

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

async function fetchOk(url) {
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response;
}

/** The versions x.y.z of the folder of `platform` (the links of its index page). */
async function versionsOf(platform) {
  const { folder, extension } = PLATFORMS[platform];
  const page = await (await fetchOk(`${BASE}/${folder}/`)).text();
  const pattern = new RegExp(`href="docker-(\\d+\\.\\d+\\.\\d+)\\.${extension}"`, 'g');
  return new Set([...page.matchAll(pattern)].map((match) => match[1]));
}

/**
 * The size and the SHA-256 of the file of `platform` and `version`, from a download of the whole file; its bytes go
 * into `chunks` when given.
 */
async function fileOf(platform, version, chunks) {
  const { folder, extension } = PLATFORMS[platform];
  const url = `${BASE}/${folder}/docker-${version}.${extension}`;
  const response = await fetchOk(url);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.length;
    chunks?.push(chunk);
  }
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== size) throw new Error(`GET ${url}: ${size} of ${length} bytes`);
  return { url, size, sha256: hash.digest('hex') };
}

/** The key of the Linux build that runs on this computer, or undefined (another system). */
function runnablePlatform() {
  if (process.platform !== 'linux') return undefined;
  return { x64: 'linux-x86_64', arm64: 'linux-aarch64' }[process.arch];
}

/**
 * The Docker API versions that the `docker` program of `archive` (a .tgz of download.docker.com) speaks, measured with a
 * fake engine on a Unix socket. The CLI asks the engine for its newest API version (`/_ping`, header `Api-Version`) and
 * then calls `GET /v<version>/version` with the lower of that and its own newest one, or with its own newest one when the
 * engine is older than its oldest one (or it calls nothing then). So its newest one is the one that it calls on an
 * engine of 1.999, and its oldest one is the lowest 1.<n> that it calls on an engine of that version (a search by
 * halves: the CLI speaks every version between its oldest and its newest one).
 */
async function measureApi(archive) {
  const dir = mkdtempSync(join(tmpdir(), 'docker-cli-api-'));
  try {
    const untar = spawnSync('tar', ['-xzf', '-', '-C', dir, 'docker/docker'], { input: archive });
    if (untar.status !== 0) throw new Error(`tar could not take docker/docker out of the archive: ${untar.stderr}`);
    const docker = join(dir, 'docker', 'docker');
    const socket = join(dir, 'engine.sock');
    let engineApi = '';
    let called;
    const server = createServer((request, response) => {
      response.setHeader('Api-Version', engineApi);
      response.setHeader('Content-Type', 'application/json');
      const match = /^\/v(\d+\.\d+)\/version$/.exec(request.url ?? '');
      if (match) called = match[1];
      response.end(match ? JSON.stringify({ Version: '0.0.0', ApiVersion: engineApi, MinAPIVersion: '1.0', Os: 'linux', Arch: 'amd64' }) : 'OK');
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(socket, resolve));
    // The API version that the CLI calls `/version` with on an engine of `api` (undefined: none), and how it ended.
    const calledOn = async (api) => {
      engineApi = api;
      called = undefined;
      // Only these variables: DOCKER_API_VERSION or a context would decide the version or the engine instead.
      const env = { PATH: process.env.PATH ?? '', DOCKER_HOST: `unix://${socket}`, DOCKER_CONFIG: dir };
      const end = await new Promise((resolve) =>
        execFile(docker, ['version', '--format', '{{.Server.APIVersion}}'], { env, timeout: 30_000 }, (error, _stdout, stderr) =>
          resolve(error ? `${error.message} ${String(stderr).trim()}`.trim() : 'exit code 0'),
        ),
      );
      return { version: called, end };
    };
    try {
      const newest = await calledOn('1.999');
      if (newest.version === undefined) throw new Error(`The Docker CLI called no /version on an engine of the API version 1.999: ${newest.end}`);
      const [major, newestMinor] = newest.version.split('.').map(Number);
      // The search covers 1.<n>; a CLI of another major version needs a look at this script first.
      if (major !== 1) throw new Error(`The Docker CLI speaks the API version ${newest.version}: this script measures only the versions 1.<n>.`);
      // On an engine of a version that it speaks, the CLI calls with that version, else with its newest one; a run that
      // calls nothing (a time limit, a failure) stops the measure instead of moving its result.
      const speaks = async (minor) => {
        const call = await calledOn(`${major}.${minor}`);
        if (call.version === `${major}.${minor}`) return true;
        if (call.version === newest.version) return false;
        throw new Error(`The Docker CLI called ${call.version === undefined ? 'no /version' : `/v${call.version}/version`} on an engine of the API version ${major}.${minor}: ${call.end}`);
      };
      // The lowest minor version in [low, high] that the CLI speaks; it speaks `high`.
      let low = 0;
      let high = newestMinor;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (await speaks(middle)) high = middle;
        else low = middle + 1;
      }
      return { min: `${major}.${high}`, max: newest.version };
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const current = existsSync(pinFile) ? JSON.parse(readFileSync(pinFile, 'utf8')) : { version: '0.0.0', files: {} };
  const runnable = runnablePlatform();
  if (args.includes('--check')) {
    const chunks = [];
    for (const [platform, file] of Object.entries(current.files)) {
      const now = await fileOf(platform, current.version, platform === runnable ? chunks : undefined);
      if (now.size !== file.size || now.sha256 !== file.sha256) throw new Error(`${file.url} changed: ${now.size} bytes, SHA-256 ${now.sha256}`);
      console.log(`${file.url}: unchanged`);
    }
    if (runnable === undefined || current.files[runnable] === undefined) {
      console.log(`The API versions of the pin were not measured: that needs Linux on x86_64 or aarch64 with its file in the pin, not ${process.platform} on ${process.arch}.`);
      return;
    }
    const api = await measureApi(Buffer.concat(chunks));
    if (api.min !== current.api?.min || api.max !== current.api?.max) {
      throw new Error(`The Docker CLI ${current.version} speaks the API versions ${api.min} to ${api.max}, and the pin names ${current.api?.min} to ${current.api?.max}.`);
    }
    console.log(`The Docker CLI ${current.version} speaks the API versions ${api.min} to ${api.max}, as the pin names them.`);
    return;
  }
  const at = args.indexOf('--version');
  const given = at < 0 ? undefined : (args[at + 1] ?? '');
  if (given !== undefined && !/^\d+\.\d+\.\d+$/.test(given)) throw new Error(`--version needs x.y.z: "${given}"`);
  let version = given;
  if (version === undefined) {
    const lists = await Promise.all(Object.keys(PLATFORMS).map(versionsOf));
    const common = [...lists[0]].filter((candidate) => lists.every((list) => list.has(candidate)));
    if (common.length === 0) throw new Error('No version of the Docker CLI exists for all platforms.');
    version = common.sort(compareVersions).at(-1);
  }
  if (version === current.version && given === undefined) {
    console.log(`The pin has the newest version already: ${version}`);
    return;
  }
  if (given === undefined && compareVersions(version, current.version) < 0) throw new Error(`The newest version ${version} is older than the pin ${current.version}.`);
  if (runnable === undefined) throw new Error(`A new pin needs Linux on x86_64 or aarch64 for its API versions, not ${process.platform} on ${process.arch}.`);
  const files = {};
  const chunks = [];
  for (const platform of Object.keys(PLATFORMS)) files[platform] = await fileOf(platform, version, platform === runnable ? chunks : undefined);
  const api = await measureApi(Buffer.concat(chunks));
  writeFileSync(pinFile, `${JSON.stringify({ version, api, files }, null, 2)}\n`);
  console.log(`The pin is now ${version}, which speaks the Docker API versions ${api.min} to ${api.max}.`);
}

await main();
