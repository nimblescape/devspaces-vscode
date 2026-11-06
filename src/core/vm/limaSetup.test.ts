// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger, type ProcessRunner, type RunResult } from '../ports';
import { limaPaths } from './limaInstance';
import { LimaSetup, LimaSetupError, type LimaSetupDeps, type LimaSetupStep } from './limaSetup';
import { LimaVm } from './limaVm';

const GIB = 2 ** 30;
const DIGEST = `sha256:${'b'.repeat(64)}`;
let home: string;
let bin: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-lima-setup-'));
  bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['ssh', 'qemu-system-x86_64', 'qemu-img']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A runner for `limactl` (list answers with `state`) and for `ssh … docker info`; it records the calls. */
function fakeRunner(state: { status: string }, docker: Partial<RunResult> = { stdout: '29.1.0\n' }): { runner: ProcessRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      run: async (file, args): Promise<RunResult> => {
        calls.push([path.basename(file), ...args]);
        const base = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        if (path.basename(file) === 'ssh') return { ...base, ...docker };
        if (args[0] === 'list') return { ...base, stdout: state.status === '' ? '' : JSON.stringify({ name: 'devspaces', status: state.status }) };
        if (args[0] === 'create') state.status = 'Stopped';
        if (args[0] === 'start') state.status = 'Running';
        return base;
      },
    },
  };
}

function setup(runner: ProcessRunner, overrides: Partial<LimaSetupDeps> = {}): LimaSetup {
  const paths = limaPaths(home);
  const platform = overrides.platform ?? 'darwin';
  const vm = new LimaVm({ runner, logger: silentLogger, platform, arch: 'arm64', paths, install: async () => '/lima/bin/limactl' });
  return new LimaSetup({
    vm,
    runner,
    logger: silentLogger,
    platform,
    arch: 'arm64',
    env: { PATH: bin },
    machine: { totalMemory: 16 * GIB, cpus: 10 },
    imageDigest: () => DIGEST,
    downloadImage: async (options) => {
      options.onProgress?.(5, 10);
      fs.writeFileSync(options.target, 'disk');
    },
    ...overrides,
  });
}

describe('LimaSetup', () => {
  it('downloads the disk, creates the VM with the configuration of Devspaces, starts it, and waits for Docker Engine', async () => {
    const state = { status: '' };
    const { runner, calls } = fakeRunner(state);
    const steps: LimaSetupStep[] = [];
    await setup(runner, { resources: () => ({ memoryGiB: 6 }) }).setUp((step) => steps.push(step));
    expect(steps.map((step) => step.kind)).toEqual(['lima', 'download', 'download', 'create', 'start', 'docker']);
    expect(steps[2]).toEqual({ kind: 'download', received: 5, total: 10 });
    const config = path.join(home, '.nimblescape', 'devspaces', 'lima.yaml');
    expect(calls.map((call) => call.slice(0, 2).join(' '))).toEqual(['limactl list', 'limactl create', 'limactl list', 'limactl start', 'ssh -F']);
    expect(calls[1]).toEqual(['limactl', 'create', '--name=devspaces', '--tty=false', config]);
    const written = JSON.parse(fs.readFileSync(config, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({ vmType: 'vz', arch: 'aarch64', memory: '6GiB', cpus: 4 });
    expect(written.images).toEqual([{ location: path.join(home, '.nimblescape', 'devspaces', 'download', 'devspaces-vm-arm64.qcow2'), arch: 'aarch64', digest: DIGEST }]);
    expect(calls[4].at(-1)).toBe("sudo -n docker info --format '{{.ServerVersion}}'");
    // Lima keeps its own copy of the disk.
    expect(fs.readdirSync(path.join(home, '.nimblescape', 'devspaces', 'download'))).toEqual([]);
  });

  it('never creates a VM that exists, and refuses a broken one', async () => {
    const stopped = fakeRunner({ status: 'Stopped' });
    await setup(stopped.runner).setUp(() => undefined);
    expect(stopped.calls.map((call) => call[1])).toEqual(['list', 'list', 'start', '-F']);
    await expect(setup(fakeRunner({ status: 'Broken' }).runner).setUp(() => undefined)).rejects.toMatchObject({ problem: 'broken' });
  });

  it('stops before a download without a published image, and names a Docker Engine that does not answer', async () => {
    await expect(setup(fakeRunner({ status: '' }).runner, { imageDigest: () => undefined }).setUp(() => undefined)).rejects.toMatchObject({ problem: 'imageMissing' });
    const silent = fakeRunner({ status: 'Running' }, { exitCode: 1, stderr: 'Cannot connect to the Docker daemon' });
    await expect(setup(silent.runner).setUp(() => undefined)).rejects.toThrow(
      new LimaSetupError('failed', 'Docker Engine in the VM of Devspaces did not answer: Cannot connect to the Docker daemon'),
    );
  });

  it('needs /dev/kvm with access and QEMU on Linux, and a processor of the VM', () => {
    const { runner } = fakeRunner({ status: '' });
    expect(setup(runner, { platform: 'linux', kvm: () => 'missing' }).precondition()?.problem).toBe('kvmMissing');
    expect(setup(runner, { platform: 'linux', kvm: () => 'access' }).precondition()?.problem).toBe('kvmAccess');
    fs.rmSync(path.join(bin, 'qemu-img'));
    expect(setup(runner, { platform: 'linux', kvm: () => 'ok', arch: 'x64' }).precondition()).toEqual(new LimaSetupError('qemuMissing', 'QEMU is not installed: qemu-img not found.'));
    expect(setup(runner, { platform: 'darwin' }).precondition()).toBeUndefined();
    expect(setup(runner, { platform: 'win32' }).precondition()?.problem).toBe('platform');
    expect(setup(runner, { arch: 'ia32' }).precondition()?.problem).toBe('platform');
  });
});
