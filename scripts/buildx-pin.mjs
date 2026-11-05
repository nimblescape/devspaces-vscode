// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `node scripts/buildx-pin.mjs [--version <x.y.z>] [--check]`: writes src/core/docker/buildxPin.json, the build image
// of Devspaces (docs/architecture.md "The helper image"): the version of buildx, the repository docker/buildx-bin of
// Docker Hub, and the digest of the image index of that version, by which every engine pulls it
// (src/core/docker/buildxImage.ts). Without --version, the version is the newest tag x.y.z of the repository (no
// release candidate). The index must have an image for linux/amd64 and for linux/arm64, the engines of Devspaces. The
// script reads the registry anonymously, as the pull of the engine does, and checks the digest of each index against
// its own SHA-256 of the bytes. The workflow "Buildx image" runs this every week and opens a pull request when the file
// changed. --check writes nothing: it reads the index of the current pin by its digest and fails when the registry no
// longer has it or when an engine platform is missing.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pinFile = join(root, 'src', 'core', 'docker', 'buildxPin.json');
const IMAGE = 'docker/buildx-bin';
const REGISTRY = 'https://registry-1.docker.io';
const TOKEN_URL = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${IMAGE}:pull`;
/** The media types of an image index (OCI and Docker). */
const INDEX_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
/** The platforms of the engines of Devspaces, which the index must have. */
const PLATFORMS = ['linux/amd64', 'linux/arm64'];

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

async function fetchOk(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response;
}

/** An anonymous token of Docker Hub that may read IMAGE. */
async function token() {
  const body = await (await fetchOk(TOKEN_URL)).json();
  if (typeof body.token !== 'string') throw new Error(`${TOKEN_URL}: no token in the answer`);
  return body.token;
}

/** The tags x.y.z of IMAGE, from all pages of the list (the header Link names the next one). */
async function versions(auth) {
  const tags = [];
  let url = `${REGISTRY}/v2/${IMAGE}/tags/list?n=1000`;
  for (let page = 0; url !== undefined; page++) {
    if (page === 100) throw new Error(`${IMAGE}: more than 100 pages of tags`);
    const response = await fetchOk(url, { Authorization: `Bearer ${auth}` });
    tags.push(...((await response.json()).tags ?? []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '');
    url = next === null ? undefined : new URL(next[1], REGISTRY).href;
  }
  return tags.filter((tag) => /^\d+\.\d+\.\d+$/.test(tag));
}

/**
 * The image index of `reference` (a tag or a digest) and its digest, the SHA-256 of its bytes. Fails when the answer
 * is not an index, when its digest differs from the one that the registry names, or when a platform of PLATFORMS is
 * missing.
 */
async function indexOf(auth, reference) {
  const url = `${REGISTRY}/v2/${IMAGE}/manifests/${reference}`;
  const response = await fetchOk(url, { Authorization: `Bearer ${auth}`, Accept: INDEX_TYPES.join(', ') });
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const named = response.headers.get('docker-content-digest');
  if (named !== null && named !== digest) throw new Error(`GET ${url}: the registry names the digest ${named}, the bytes have ${digest}`);
  if (reference.startsWith('sha256:') && reference !== digest) throw new Error(`GET ${url}: the bytes have the digest ${digest}`);
  const index = JSON.parse(bytes.toString('utf8'));
  if (!INDEX_TYPES.includes(index.mediaType ?? response.headers.get('content-type'))) throw new Error(`GET ${url}: not an image index (${index.mediaType})`);
  const platforms = new Set((index.manifests ?? []).map((entry) => `${entry.platform?.os}/${entry.platform?.architecture}`));
  const missing = PLATFORMS.filter((platform) => !platforms.has(platform));
  if (missing.length > 0) throw new Error(`${IMAGE}@${digest} (${reference}) has no image for ${missing.join(' and ')}.`);
  return digest;
}

async function main() {
  const args = process.argv.slice(2);
  const current = JSON.parse(readFileSync(pinFile, 'utf8'));
  if (current.image !== IMAGE) throw new Error(`The pin names the repository ${current.image}, not ${IMAGE}.`);
  const auth = await token();
  if (args.includes('--check')) {
    await indexOf(auth, current.digest);
    console.log(`${IMAGE}@${current.digest} (buildx ${current.version}) exists, with an image for ${PLATFORMS.join(' and ')}.`);
    return;
  }
  const at = args.indexOf('--version');
  const given = at < 0 ? undefined : (args[at + 1] ?? '');
  if (given !== undefined && !/^\d+\.\d+\.\d+$/.test(given)) throw new Error(`--version needs x.y.z: "${given}"`);
  let version = given;
  if (version === undefined) {
    const tags = await versions(auth);
    if (tags.length === 0) throw new Error(`${IMAGE} has no tag x.y.z.`);
    version = tags.sort(compareVersions).at(-1);
    if (compareVersions(version, current.version) < 0) throw new Error(`The newest version ${version} is older than the pin ${current.version}.`);
    if (version === current.version) {
      console.log(`The pin has the newest version already: ${version}`);
      return;
    }
  }
  const digest = await indexOf(auth, version);
  writeFileSync(pinFile, `${JSON.stringify({ version, image: IMAGE, digest }, null, 2)}\n`);
  console.log(`The pin is now buildx ${version}: ${IMAGE}@${digest}.`);
}

await main();
