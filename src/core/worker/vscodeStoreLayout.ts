// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The names of the shared VS Code server store and of the extension lists in the volume of the Monitor
// (vscodeServerStore.ts, vscodeExtensionStore.ts), without their downloads: the report of a resource of the view Docker
// Hosts (src/core/hosts/storeReport.ts, docs/requirements.md R-ENG-010) reads the store with these names in the
// extension, which must not bundle the worker's code of the store. No `vscode`.
import type { VscodePlatform, VscodeServerRef } from '../helperChannel/protocol';

/** The folder of the extension lists in the volume of the Monitor. */
export const STATE_EXTENSION_FOLDER = 'extensions';
/** The folder of the recorded lists (`<state>/extensions/wanted`). */
export const EXTENSION_WANTED_FOLDER = 'wanted';
/** The file of the monitor's failed entries (`<state>/extensions/failures.json`). */
export const EXTENSION_FAILURES_FILE = 'failures.json';
/** The file of the files that the monitor's runs chose (`<state>/extensions/chosen.json`). */
export const EXTENSION_CHOICES_FILE = 'chosen.json';
/** The file of the dependencies of the chosen versions (`<state>/extensions/dependencies.json`). */
export const EXTENSION_DEPENDENCIES_FILE = 'dependencies.json';

/**
 * The platform of the server for the architecture of the engine (`Architecture` of `GET /info`): x86_64/amd64 →
 * linux-x64, aarch64/arm64 → linux-arm64; anything else has no server in the store.
 */
export function serverPlatform(architecture: string): VscodePlatform | undefined {
  const machine = architecture.trim().toLowerCase();
  if (machine === 'x86_64' || machine === 'amd64') return 'linux-x64';
  if (machine === 'aarch64' || machine === 'arm64') return 'linux-arm64';
  return undefined;
}

/** The name of one server version in the store (its lock file and the prefix of its temporary folders). */
export function serverVersionName(server: VscodeServerRef, platform: VscodePlatform): string {
  return `${server.quality}-${platform}-${server.commit}`;
}
