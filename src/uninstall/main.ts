// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The uninstall hook of the extension (R-GEN-008), bundled to dist/uninstall.js: `vscode:uninstall` in the `scripts` of
// package.json. VS Code runs it once, at its next start after the extension was uninstalled from every profile, as a
// Node.js program without a window and without the `vscode` API, and ends it after 5 seconds; then VS Code deletes the
// global storage folder of the extension itself (the records, the list of remote hosts and the downloaded Docker CLI).
// The hook removes what would otherwise go on working by itself or stay unused on this computer: the Docker context
// `devspaces`, the scheduled task and the folder of Devspaces outside of VS Code (src/core/devspacesFiles.ts). It never
// deletes the VM of Devspaces, the WSL distribution or a devspace: they can hold work that is not pushed, and the hook
// cannot ask. VS Code writes the output into its log of the shared process.
import * as os from 'os';
import { removeDevspacesFiles, type DevspacesFilesDeps } from '../core/devspacesFiles';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/ports';
import { NodeProcessRunner } from '../core/process';

/** Runs the three steps of the hook (removeDevspacesFiles). Never rejects. */
export async function runUninstall(deps: DevspacesFilesDeps): Promise<void> {
  deps.logger.info('nimblescape Devspaces 2 was uninstalled: Devspaces checks its Docker context, its scheduled task and its folder outside of VS Code. The next lines tell what was removed and what stays.');
  await removeDevspacesFiles(deps);
}

/** A logger for the log of VS Code: each line on stdout, an error on stderr. */
export function consoleLogger(out: (text: string) => void, err: (text: string) => void): Logger {
  return {
    info: (text) => out(`INFO ${text}\n`),
    warn: (text) => out(`WARN ${text}\n`),
    error: (text, error) => err(`ERROR ${error === undefined ? text : `${text} ${errorMessage(error)}`}\n`),
    output: (text) => out(text),
  };
}

/** Runs the hook when this file is the main module. */
async function main(): Promise<void> {
  await runUninstall({
    runner: new NodeProcessRunner(),
    logger: consoleLogger(
      (text) => process.stdout.write(text),
      (text) => process.stderr.write(text),
    ),
    platform: process.platform,
    env: process.env,
    homeDir: os.homedir(),
    uid: () => os.userInfo().uid,
  });
  process.exitCode = 0;
}

if (require.main === module) void main();
