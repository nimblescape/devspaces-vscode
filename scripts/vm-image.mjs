// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The image of the VM of Devspaces on ghcr.io (docs/requirements.md R-VM-002, docs/architecture.md "The image of the
// VM"): the workflow "VM image" builds it every day (vm/recipe.sh) and runs this script.
//
// `node scripts/vm-image.mjs key <folder>`: prints the content key of the files that vm/build.sh wrote into <folder>:
// the SHA-256 of the lists of their packages and of the files of the recipe (vm/, without vm/test/). Two builds with
// the same key have the same content, although the bytes of their files differ.
//
// `node scripts/vm-image.mjs push <folder> [--first-push]`: pushes the files to ghcr.io as one OCI artifact of the
// version 13.<date>.<time> (UTC), only when the newest version there has another content key, and writes the pin
// src/core/vm/vmImagePin.json from the version with this content key. Without a version in the pin, it does nothing
// unless --first-push is given: the first push waits for a manual start of the workflow. The workflow then opens the
// pull request of the pin when the file changed. It logs in with GITHUB_TOKEN as GITHUB_ACTOR.
//
// `node scripts/vm-image.mjs prune [--dry-run]`: deletes the versions on ghcr.io that are not kept. Kept are the
// version of each published release of Devspaces (the pin at each tag vX.Y.Z), the version of the pin of this
// checkout, and the newest 5 versions. It uses the REST API of GitHub with GITHUB_TOKEN.
//
// `node scripts/vm-image.mjs check`: reads the files of the current pin from ghcr.io without a login, as Devspaces
// does, and fails when one is missing. Without a version in the pin, there is nothing to check.
//
// For a test with another registry: VM_IMAGE_REGISTRY (default https://ghcr.io) and VM_IMAGE_REPOSITORY (default
// nimblescape/devspaces-vm).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, openAsBlob, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pinFile = join(root, 'src', 'core', 'vm', 'vmImagePin.json');
const recipeDir = join(root, 'vm');
const REGISTRY = process.env.VM_IMAGE_REGISTRY ?? 'https://ghcr.io';
const REPOSITORY = process.env.VM_IMAGE_REPOSITORY ?? 'nimblescape/devspaces-vm';
/** The major version of Debian of the recipe: the first part of each version. */
const DEBIAN_MAJOR = 13;
const ARCHITECTURES = ['amd64', 'arm64'];
const VERSION_PATTERN = /^\d+\.\d{8}\.\d{4}$/;
/** The number of the newest versions that prune keeps, besides the pinned ones. */
const KEEP_NEWEST = 5;
const MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const ARTIFACT_TYPE = 'application/vnd.nimblescape.devspaces.vm.v1';
const KEY_ANNOTATION = 'com.nimblescape.devspaces.vm.content-key';
const TITLE_ANNOTATION = 'org.opencontainers.image.title';
/** The empty configuration of an OCI artifact: the two bytes `{}`. */
const EMPTY_CONFIG = {
  mediaType: 'application/vnd.oci.empty.v1+json',
  digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  size: 2,
};

/** The files of the image in a folder of vm/build.sh, with their media types; `pin` names the ones of the pin. */
function imageFiles() {
  return ARCHITECTURES.flatMap((arch) => [
    { name: `devspaces-vm-${arch}.wsl`, mediaType: 'application/vnd.nimblescape.devspaces.vm.wsl.v1.tar+gzip', pin: [arch, 'wsl'] },
    { name: `devspaces-vm-${arch}.qcow2`, mediaType: 'application/vnd.nimblescape.devspaces.vm.lima.v1.qcow2', pin: [arch, 'lima'] },
    { name: `packages-wsl-${arch}.txt`, mediaType: 'text/plain' },
    { name: `packages-lima-${arch}.txt`, mediaType: 'text/plain' },
  ]);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** The files of the recipe: every file of vm/ but vm/test/, with its path, executable bit and SHA-256, sorted. */
function recipeListing() {
  const lines = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const path = relative(root, full).split('\\').join('/');
      if (path === 'vm/test') continue;
      if (entry.isDirectory()) walk(full);
      else lines.push(`${path} ${statSync(full).mode & 0o111 ? 'x' : '-'} ${sha256(readFileSync(full))}`);
    }
  };
  walk(recipeDir);
  return lines.sort().join('\n');
}

/** The content key of the build in `folder`. */
function contentKey(folder) {
  const lines = [`recipe ${sha256(recipeListing())}`];
  for (const arch of ARCHITECTURES) {
    for (const name of [`packages-wsl-${arch}.txt`, `packages-lima-${arch}.txt`]) {
      lines.push(`${name} ${sha256(readFileSync(join(folder, name)))}`);
    }
  }
  return sha256(lines.join('\n'));
}

function readPin() {
  return JSON.parse(readFileSync(pinFile, 'utf8'));
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

/** The base of the URLs of the repository in the registry. */
function base() {
  return `${REGISTRY}/v2/${REPOSITORY}`;
}

/**
 * A client of the registry for `actions` (pull, or pull,push), with the token that the registry asks for (its
 * header WWW-Authenticate), with the login GITHUB_ACTOR and GITHUB_TOKEN when `login` is set, else anonymous.
 */
async function client(actions, login) {
  let authorization;
  const probe = await fetch(`${REGISTRY}/v2/`);
  if (probe.status === 401) {
    const challenge = probe.headers.get('www-authenticate') ?? '';
    const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
    const service = /service="([^"]+)"/.exec(challenge)?.[1];
    if (realm === undefined) throw new Error(`${REGISTRY}/v2/: HTTP 401 without a realm for a token`);
    const url = new URL(realm);
    if (service !== undefined) url.searchParams.set('service', service);
    url.searchParams.set('scope', `repository:${REPOSITORY}:${actions}`);
    const headers = {};
    if (login) {
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
      if (!token) throw new Error('No GITHUB_TOKEN for the login to the registry.');
      headers.Authorization = `Basic ${Buffer.from(`${process.env.GITHUB_ACTOR ?? 'github-actions'}:${token}`).toString('base64')}`;
    }
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`The token of ${url.origin}: HTTP ${response.status}`);
    const body = await response.json();
    const value = body.token ?? body.access_token;
    if (typeof value !== 'string') throw new Error(`The token of ${url.origin}: none in the answer`);
    authorization = `Bearer ${value}`;
  } else if (!probe.ok) {
    throw new Error(`${REGISTRY}/v2/: HTTP ${probe.status}`);
  }
  return async (url, init = {}) => {
    const headers = { ...(init.headers ?? {}) };
    if (authorization !== undefined) headers.Authorization = authorization;
    return fetch(new URL(url, REGISTRY), { ...init, headers });
  };
}

async function ok(response, what) {
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  return response;
}

/** The versions in the registry, sorted from the oldest to the newest; none when the repository does not exist yet. */
async function versions(registry) {
  const tags = [];
  let url = `${base()}/tags/list?n=1000`;
  for (let page = 0; url !== undefined; page++) {
    if (page === 100) throw new Error(`${REPOSITORY}: more than 100 pages of tags`);
    const response = await registry(url);
    if (response.status === 404) return [];
    await ok(response, `GET ${url}`);
    tags.push(...((await response.json()).tags ?? []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '');
    url = next === null ? undefined : new URL(next[1], REGISTRY).href;
  }
  return tags.filter((tag) => VERSION_PATTERN.test(tag)).sort(compareVersions);
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

async function manifestOf(registry, version) {
  const url = `${base()}/manifests/${version}`;
  const response = await ok(await registry(url, { headers: { Accept: MANIFEST_TYPE } }), `GET ${url}`);
  return JSON.parse(await response.text());
}

/**
 * Uploads a blob with its digest in one request (the source is a path or a Blob, whose size fetch sends), unless the
 * registry has it already. Answers whether it uploaded.
 */
async function uploadBlob(registry, digest, source) {
  const blobUrl = `${base()}/blobs/${digest}`;
  if ((await registry(blobUrl, { method: 'HEAD' })).ok) return false;
  const start = await ok(await registry(`${base()}/blobs/uploads/`, { method: 'POST' }), `POST ${base()}/blobs/uploads/`);
  const location = new URL(start.headers.get('location') ?? '', REGISTRY);
  location.searchParams.set('digest', digest);
  const body = typeof source === 'string' ? await openAsBlob(source) : source;
  await ok(
    await registry(location.href, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    }),
    `PUT the blob ${digest}`,
  );
  return true;
}

/** The pin of `version` from its manifest: the digest and the size of each file of the image. */
function pinOf(version, manifest) {
  const files = {};
  for (const file of imageFiles().filter((entry) => entry.pin !== undefined)) {
    const layer = (manifest.layers ?? []).find((entry) => entry.annotations?.[TITLE_ANNOTATION] === file.name);
    if (layer === undefined) throw new Error(`The version ${version} has no file ${file.name}.`);
    const [arch, kind] = file.pin;
    files[arch] ??= {};
    files[arch][kind] = { name: file.name, digest: layer.digest, size: layer.size };
  }
  return { version, repository: `${new URL(REGISTRY).host}/${REPOSITORY}`, files };
}

function writePin(pin) {
  writeFileSync(pinFile, `${JSON.stringify(pin, undefined, 2)}\n`);
}

/** The version of a push now: 13.<date>.<time> in UTC. */
function newVersion(now = new Date()) {
  const iso = now.toISOString();
  return `${DEBIAN_MAJOR}.${iso.slice(0, 10).replaceAll('-', '')}.${iso.slice(11, 16).replace(':', '')}`;
}

async function push(folder, firstPush) {
  const pin = readPin();
  if (pin.version === null && !firstPush) {
    summary('No version of the image is on ghcr.io yet: the first push waits for a manual start of the workflow with "first push".');
    output('version', '');
    return;
  }
  const key = contentKey(folder);
  const registry = await client('pull,push', true);
  const known = await versions(registry);
  const newest = known.at(-1);
  let version;
  let manifest;
  if (newest !== undefined) {
    const newestManifest = await manifestOf(registry, newest);
    if (newestManifest.annotations?.[KEY_ANNOTATION] === key) {
      version = newest;
      manifest = newestManifest;
      summary(`The packages and the recipe did not change since the version ${newest} on ghcr.io: nothing to push.`);
    }
  }
  if (version === undefined) {
    version = newVersion();
    if (known.includes(version)) throw new Error(`The version ${version} is on ghcr.io already.`);
    const layers = [];
    for (const file of imageFiles()) {
      const path = join(folder, file.name);
      const size = statSync(path).size;
      const digest = `sha256:${await fileSha256(path)}`;
      const uploaded = await uploadBlob(registry, digest, path);
      console.log(`${file.name}: ${size} bytes, ${digest}${uploaded ? '' : ' (on the registry already)'}`);
      layers.push({ mediaType: file.mediaType, digest, size, annotations: { [TITLE_ANNOTATION]: file.name } });
    }
    await uploadBlob(registry, EMPTY_CONFIG.digest, new Blob(['{}']));
    manifest = {
      schemaVersion: 2,
      mediaType: MANIFEST_TYPE,
      artifactType: ARTIFACT_TYPE,
      config: EMPTY_CONFIG,
      layers,
      annotations: {
        'org.opencontainers.image.created': new Date().toISOString(),
        'org.opencontainers.image.version': version,
        'org.opencontainers.image.source': 'https://github.com/nimblescape/devspaces-vscode',
        'org.opencontainers.image.description': 'The image of the VM of nimblescape Devspaces: Debian 13 with Docker Engine, as a .wsl file for WSL and as a disk for Lima.',
        [KEY_ANNOTATION]: key,
      },
    };
    const url = `${base()}/manifests/${version}`;
    await ok(
      await registry(url, { method: 'PUT', headers: { 'Content-Type': MANIFEST_TYPE }, body: JSON.stringify(manifest) }),
      `PUT ${url}`,
    );
    summary(`Pushed the version ${version} to ${new URL(REGISTRY).host}/${REPOSITORY} (content key ${key}).`);
  }
  writePin(pinOf(version, manifest));
  output('version', version);
}

/** The versions of the pins of the published releases of Devspaces: the pin at each tag vX.Y.Z. */
function releaseVersions() {
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  const result = [];
  for (const tag of tags) {
    let text;
    try {
      text = execFileSync('git', ['show', `${tag}:src/core/vm/vmImagePin.json`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      continue;
    }
    const version = JSON.parse(text).version;
    if (typeof version === 'string') result.push(version);
  }
  return result;
}

async function github(path, init = {}) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('No GITHUB_TOKEN for the REST API of GitHub.');
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  return fetch(`${api}${path}`, {
    ...init,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
  });
}

async function prune(dryRun) {
  const [owner, name] = REPOSITORY.split('/');
  const path = `/orgs/${owner}/packages/container/${encodeURIComponent(name)}/versions`;
  const all = [];
  for (let page = 1; ; page++) {
    const response = await github(`${path}?per_page=100&page=${page}`);
    if (response.status === 404) {
      summary(`The package ${REPOSITORY} does not exist: nothing to prune.`);
      return;
    }
    const batch = await (await ok(response, `GET ${path}`)).json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  const tagged = all.flatMap((entry) => (entry.metadata?.container?.tags ?? []).filter((tag) => VERSION_PATTERN.test(tag)));
  const newest = [...new Set(tagged)].sort(compareVersions).slice(-KEEP_NEWEST);
  const pinned = readPin().version;
  const keep = new Set([...newest, ...releaseVersions(), ...(typeof pinned === 'string' ? [pinned] : [])]);
  if (newest.length === 0) {
    summary(`The package ${REPOSITORY} has no version ${VERSION_PATTERN}: nothing is pruned.`);
    return;
  }
  const outdated = all.filter((entry) => !(entry.metadata?.container?.tags ?? []).some((tag) => keep.has(tag)));
  summary(`Kept versions of ${REPOSITORY}: ${[...keep].sort(compareVersions).join(', ')}.`);
  for (const entry of outdated) {
    const label = (entry.metadata?.container?.tags ?? []).join(', ') || entry.name;
    if (dryRun) {
      summary(`Would delete ${label}.`);
      continue;
    }
    await ok(await github(`${path}/${entry.id}`, { method: 'DELETE' }), `DELETE the version ${label}`);
    summary(`Deleted ${label}.`);
  }
  if (outdated.length === 0) summary('No version is outdated.');
}

async function check() {
  const pin = readPin();
  if (pin.version === null) {
    console.log('The pin names no version yet: nothing to check.');
    return;
  }
  const registry = await client('pull', false);
  for (const arch of ARCHITECTURES) {
    for (const kind of ['wsl', 'lima']) {
      const file = pin.files?.[arch]?.[kind];
      if (file === undefined) throw new Error(`The pin has no ${kind} file for ${arch}.`);
      const url = `${base()}/blobs/${file.digest}`;
      const response = await registry(url, { method: 'HEAD' });
      if (!response.ok) throw new Error(`${file.name} of ${pin.version} (${file.digest}): HTTP ${response.status}`);
      const length = Number(response.headers.get('content-length'));
      if (length && length !== file.size) throw new Error(`${file.name} of ${pin.version}: ${length} bytes, the pin says ${file.size}`);
      console.log(`${file.name} of ${pin.version}: on ${new URL(REGISTRY).host}.`);
    }
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'key' && args.length === 1) console.log(contentKey(args[0]));
  else if (command === 'push' && args.length >= 1) await push(args[0], args.includes('--first-push'));
  else if (command === 'prune') await prune(args.includes('--dry-run'));
  else if (command === 'check') await check();
  else {
    console.error('Usage: node scripts/vm-image.mjs key <folder> | push <folder> [--first-push] | prune [--dry-run] | check');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
