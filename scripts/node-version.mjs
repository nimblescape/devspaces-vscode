// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// `node scripts/node-version.mjs`: keeps `.node-version`, the Node.js release of the builds, the tests, CI and the
// release of Devspaces (docs/requirements.md R-VM-007), on the newest LTS release of its major version, from the list
// of the releases of Node.js (https://nodejs.org/dist/index.json; `lts` names the line of an LTS release, for example
// "Krypton", and is false for the others). The major version stays as it is, because it follows the Node.js of VS Code
// (CONTRIBUTING.md "Development"), and a new major version is a change by hand; an older release never replaces the one
// of the file. The workflow "Node.js" runs this every day (called by the workflow "Daily checks") and opens a pull
// request when the file changed.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const versionFile = join(root, '.node-version');
const INDEX = 'https://nodejs.org/dist/index.json';
/** The list must have arrived within this time. */
const TIMEOUT_MS = 60 * 1000;

/** The numbers of a version `x.y.z` (also `vx.y.z`), or undefined. */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match === null ? undefined : match.slice(1).map(Number);
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

async function main() {
  const current = parseVersion(readFileSync(versionFile, 'utf8'));
  if (current === undefined) throw new Error('.node-version names no version x.y.z.');
  const response = await fetch(INDEX, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GET ${INDEX}: HTTP ${response.status}`);
  const releases = await response.json();
  if (!Array.isArray(releases)) throw new Error(`${INDEX} is no list of releases.`);
  let newest = current;
  let found = false;
  for (const release of releases) {
    const version = typeof release?.version === 'string' ? parseVersion(release.version) : undefined;
    if (version === undefined || version[0] !== current[0] || typeof release.lts !== 'string') continue;
    found = true;
    if (compareVersions(version, newest) > 0) newest = version;
  }
  if (!found) throw new Error(`${INDEX} lists no LTS release of Node.js ${current[0]}.`);
  if (compareVersions(newest, current) > 0) {
    writeFileSync(versionFile, `${newest.join('.')}\n`);
    console.log(`.node-version: ${current.join('.')} -> ${newest.join('.')}`);
  } else {
    console.log(`.node-version names the newest LTS release of Node.js ${current[0]}, ${current.join('.')}.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
