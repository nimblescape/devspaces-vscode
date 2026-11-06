// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The processor of the Lima VM of Devspaces and of its Lima (docs/architecture.md "The Lima VM of Devspaces"): the
// processor of this computer, not the one of the process of VS Code. VS Code for Intel runs under Rosetta on a Mac with
// Apple silicon and reports `x64` there, but Apple Virtualization runs only a VM for the processor of the Mac.
import type { Logger, ProcessRunner } from '../ports';

const SYSCTL = '/usr/sbin/sysctl';
/** `sysctl -in sysctl.proc_translated`: 1 in a process under Rosetta; the key is missing on a Mac with Intel. */
const TRANSLATED_ARGS = ['-in', 'sysctl.proc_translated'];
const SYSCTL_TIMEOUT_MS = 5_000;

/** The processor of this computer: `arm64` for a process under Rosetta on macOS (`translated`), else `processArch`. */
export function hardwareArch(platform: NodeJS.Platform, processArch: string, translated: boolean): string {
  return platform === 'darwin' && processArch === 'x64' && translated ? 'arm64' : processArch;
}

/**
 * The processor for the VM and for Lima (`process.arch` as `processArch`). Asks `sysctl` only for `x64` on macOS; when
 * it fails, the VM uses `processArch`.
 */
export async function readVmArch(runner: ProcessRunner, platform: NodeJS.Platform, processArch: string, logger: Logger): Promise<string> {
  if (platform !== 'darwin' || processArch !== 'x64') return processArch;
  const result = await runner.run(SYSCTL, TRANSLATED_ARGS, { timeoutMs: SYSCTL_TIMEOUT_MS }).catch(() => undefined);
  const arch = hardwareArch(platform, processArch, result?.exitCode === 0 && result.stdout.trim() === '1');
  if (arch !== processArch) logger.info(`VS Code runs for Intel under Rosetta on a Mac with Apple silicon: the VM of Devspaces uses ${arch}.`);
  return arch;
}
