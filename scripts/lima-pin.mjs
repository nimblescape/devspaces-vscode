// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `node scripts/lima-pin.mjs [--version <x.y.z>] [--check]`: writes src/core/vm/limaPin.json, the version of Lima that
// Devspaces downloads on macOS and Linux to manage its VM (docs/requirements.md R-VM-001), with the URL, the size and
// the SHA-256 of the archive of each platform. Lima publishes the file SHA256SUMS with each release; the script
// downloads each archive, computes its SHA-256 and size, and checks them against that file, so the pin holds only
// hashes that both agree on. It also checks that each archive has `bin/limactl` and the guest agent of its
// architecture, the files that Devspaces takes from it. The extension checks every download against the pin. Without
// --version, the version is the newest release of lima-vm/lima on GitHub (no pre-release). The workflow "Lima" runs
// this every day (called by the workflow "Daily checks") and opens a pull request when the file changed. --check writes
// nothing: it downloads the files of the current pin again and fails when a size or a hash differs (a release file was
// replaced). GITHUB_TOKEN, when set, is used for the API of GitHub (more requests per hour); the downloads need no
// login.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pinFile = join(root, 'src', 'core', 'vm', 'limaPin.json');
const REPOSITORY = 'lima-vm/lima';
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const DOWNLOADS = `https://github.com/${REPOSITORY}/releases/download`;
/**
 * The platform keys of the pin (the ones of the Docker CLI of Devspaces, ownDockerCli.ts) and the name of the archive of
 * Lima for each. The archive of a platform has the guest agent for the architecture of that computer, the only one that
 * the VM of Devspaces needs; the archives "lima-additional-guestagents" are not needed.
 */
const PLATFORMS = {
  'mac-aarch64': 'Darwin-arm64',
  'mac-x86_64': 'Darwin-x86_64',
  'linux-aarch64': 'Linux-aarch64',
  'linux-x86_64': 'Linux-x86_64',
};
/** The guest agent that the archive of each platform must have: Linux of the architecture of that computer. */
const GUEST_AGENT = /^share\/lima\/lima-guestagent\.Linux-(aarch64|x86_64)(\.gz)?$/;
/** Every archive must have arrived within this time. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function archiveName(version, platform) {
  return `lima-${version}-${PLATFORMS[platform]}.tar.gz`;
}

async function fetchOk(url, init = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), ...init });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response;
}

/** The version x.y.z of the newest release of Lima that is no pre-release. */
async function newestVersion() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const headers = { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const release = await (await fetchOk(`${API}/repos/${REPOSITORY}/releases/latest`, { headers })).json();
  const match = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? '');
  if (!match) throw new Error(`The newest release of ${REPOSITORY} has the tag "${release.tag_name}", not vX.Y.Z.`);
  if (release.prerelease || release.draft) throw new Error(`The newest release of ${REPOSITORY}, ${release.tag_name}, is a pre-release.`);
  return match[1];
}

/** The SHA-256 of each file of the release `version`, from its file SHA256SUMS ("<hash>  <name>" per line). */
async function publishedSums(version) {
  const text = await (await fetchOk(`${DOWNLOADS}/v${version}/SHA256SUMS`)).text();
  const sums = new Map();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

/**
 * The names of the regular files of a tar archive (ustar, with the long names of GNU and pax), without a leading "./".
 * Enough to check the content of an archive of Lima; it extracts nothing.
 */
function tarFiles(tar) {
  const files = [];
  let longName;
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (from, to) => header.subarray(from, to).toString('utf8').replace(/\0.*$/s, '');
    if (header[124] & 0x80) throw new Error('The archive has a file that is too large for this script.');
    const size = parseInt(text(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const data = tar.subarray(at + 512, at + 512 + size);
    const prefix = text(257, 263).startsWith('ustar') ? text(345, 500) : '';
    const name = longName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '');
    else if (type === 'x') longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1];
    else {
      if (type === '0') files.push(name.replace(/^\.\//, ''));
      longName = undefined;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Fails unless `files` of the archive of `platform` and `version` has `bin/limactl` and only the guest agent of its architecture. */
function checkContent(platform, version, files) {
  const name = archiveName(version, platform);
  if (!files.includes('bin/limactl')) throw new Error(`${name} has no bin/limactl.`);
  const agents = files.filter((file) => GUEST_AGENT.test(file));
  const architecture = platform.split('-')[1];
  if (agents.length !== 1 || GUEST_AGENT.exec(agents[0])[1] !== architecture) {
    throw new Error(`${name} has the guest agents [${agents.join(', ')}], not the one of ${architecture}.`);
  }
}

/** The URL, the size and the SHA-256 of the archive of `platform` and `version`, from a download of the whole file. */
async function fileOf(platform, version) {
  const url = `${DOWNLOADS}/v${version}/${archiveName(version, platform)}`;
  // GitHub answers with a redirect to its storage; the SHA-256 checks the file wherever it comes from.
  const response = await fetchOk(url);
  const hash = createHash('sha256');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    chunks.push(chunk);
    size += chunk.length;
  }
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== size) throw new Error(`GET ${url}: ${size} of ${length} bytes`);
  checkContent(platform, version, tarFiles(gunzipSync(Buffer.concat(chunks))));
  return { url, size, sha256: hash.digest('hex') };
}

async function main() {
  const args = process.argv.slice(2);
  const current = existsSync(pinFile) ? JSON.parse(readFileSync(pinFile, 'utf8')) : { version: null, files: {} };
  if (args.includes('--check')) {
    if (current.version === null) {
      console.log('The pin names no version of Lima yet: nothing to check.');
      return;
    }
    for (const [platform, file] of Object.entries(current.files)) {
      const now = await fileOf(platform, current.version);
      if (now.url !== file.url || now.size !== file.size || now.sha256 !== file.sha256) {
        throw new Error(`${file.url} changed: ${now.size} bytes, SHA-256 ${now.sha256}`);
      }
      console.log(`${file.url}: unchanged`);
    }
    return;
  }
  const at = args.indexOf('--version');
  const given = at < 0 ? undefined : (args[at + 1] ?? '');
  if (given !== undefined && !/^\d+\.\d+\.\d+$/.test(given)) throw new Error(`--version needs x.y.z: "${given}"`);
  const version = given ?? (await newestVersion());
  if (version === current.version && given === undefined) {
    console.log(`The pin has the newest version of Lima already: ${version}`);
    return;
  }
  if (given === undefined && current.version !== null && compareVersions(version, current.version) < 0) {
    throw new Error(`The newest version of Lima ${version} is older than the pin ${current.version}.`);
  }
  const sums = await publishedSums(version);
  const files = {};
  for (const platform of Object.keys(PLATFORMS)) {
    const file = await fileOf(platform, version);
    const published = sums.get(archiveName(version, platform));
    if (published === undefined) throw new Error(`SHA256SUMS of Lima ${version} names no ${archiveName(version, platform)}.`);
    if (published !== file.sha256) throw new Error(`${file.url} has the SHA-256 ${file.sha256}, and SHA256SUMS names ${published}.`);
    files[platform] = file;
    console.log(`${file.url}: ${file.size} bytes, SHA-256 ${file.sha256}`);
  }
  writeFileSync(pinFile, `${JSON.stringify({ version, files }, null, 2)}\n`);
  console.log(`The pin is now Lima ${version}.`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
