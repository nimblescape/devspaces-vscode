// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it, vi } from 'vitest';
import { silentLogger, type Logger, type ProcessRunner, type RunResult } from '../ports';
import { hardwareArch, readVmArch } from './vmArch';

function runnerOf(result: RunResult | Error): { runner: ProcessRunner; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { runner: { run } as unknown as ProcessRunner, run };
}

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

describe('hardwareArch', () => {
  it.each<[NodeJS.Platform, string, boolean, string]>([
    ['darwin', 'x64', true, 'arm64'],
    ['darwin', 'x64', false, 'x64'],
    ['darwin', 'arm64', false, 'arm64'],
    ['win32', 'x64', true, 'x64'],
    ['linux', 'x64', true, 'x64'],
  ])('%s %s translated=%s → %s', (platform, arch, translated, expected) => {
    expect(hardwareArch(platform, arch, translated)).toBe(expected);
  });
});

describe('readVmArch', () => {
  it('uses arm64 for VS Code for Intel under Rosetta on a Mac with Apple silicon, and logs it', async () => {
    const { runner, run } = runnerOf(ok('1\n'));
    const info = vi.fn();
    const logger: Logger = { ...silentLogger, info };
    await expect(readVmArch(runner, 'darwin', 'x64', logger)).resolves.toBe('arm64');
    expect(run).toHaveBeenCalledWith('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { timeoutMs: 5_000 });
    expect(info).toHaveBeenCalledWith('VS Code runs for Intel under Rosetta on a Mac with Apple silicon: the VM of Devspaces uses arm64.');
  });

  it('keeps x64 on a Mac with Intel (no key, or 0) and when sysctl fails', async () => {
    for (const result of [ok('0\n'), ok(''), { exitCode: 1, stdout: '1', stderr: 'unknown oid', timedOut: false }, new Error('ENOENT')]) {
      const info = vi.fn();
      await expect(readVmArch(runnerOf(result).runner, 'darwin', 'x64', { ...silentLogger, info })).resolves.toBe('x64');
      expect(info).not.toHaveBeenCalled();
    }
  });

  it('asks nothing for arm64 on macOS and on Linux', async () => {
    for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']] as const) {
      const { runner, run } = runnerOf(ok('1'));
      await expect(readVmArch(runner, platform, arch, silentLogger)).resolves.toBe(arch);
      expect(run).not.toHaveBeenCalled();
    }
  });
});
