// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { silentLogger, type ProcessRunner, type RunOptions, type RunResult } from '../ports';
import {
  LIMA_INSTANCE,
  LimaError,
  LimaInstance,
  limaConfig,
  limaDockerSocket,
  limaEnv,
  limaPaths,
  limaResources,
  limaSshArgs,
  parseLimaInfo,
  parseLimaList,
  VM_DISK_GIB,
} from './limaInstance';

const GIB = 2 ** 30;
const PATHS = limaPaths('/home/ada');

interface Call {
  file: string;
  args: readonly string[];
  options?: RunOptions;
}

/** A runner that answers each `limactl` call with the next result of `results`. */
function runner(results: Partial<RunResult>[], output: { stdout?: string[]; stderr?: string[] } = {}): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    runner: {
      run: async (file, args, options) => {
        calls.push({ file, args, options });
        for (const text of output.stdout ?? []) options?.onStdout?.(text);
        for (const text of output.stderr ?? []) options?.onStderr?.(text);
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...(results.shift() ?? {}) };
      },
    },
  };
}

describe('the folders, the environment and the SSH of the Lima VM', () => {
  it('keeps everything in a short folder of the home folder, with LIMA_HOME of its own', () => {
    expect(PATHS).toEqual({
      root: path.join('/home/ada', '.nimblescape', 'devspaces'),
      lima: path.join('/home/ada', '.nimblescape', 'devspaces', 'lima'),
      home: path.join('/home/ada', '.nimblescape', 'devspaces', 'vm'),
      download: path.join('/home/ada', '.nimblescape', 'devspaces', 'download'),
    });
    expect(limaEnv({ PATH: '/usr/bin', LIMA_HOME: '/elsewhere' }, PATHS)).toEqual({ PATH: '/usr/bin', LIMA_HOME: PATHS.home });
    // The longest socket of Lima (the master of ssh, with the 17 characters that ssh adds while it makes it) stays below
    // the 104 bytes of macOS for a home folder of 35 characters.
    const socket = path.join(limaPaths(`/Users/${'a'.repeat(28)}`).home, LIMA_INSTANCE, 'ssh.sock.0123456789abcdef');
    expect(Buffer.byteLength(socket)).toBeLessThan(104);
  });

  it('runs a command as root with the SSH configuration of Lima, without questions and without a terminal', () => {
    expect(limaSshArgs(PATHS, 'sh -s')).toEqual([
      '-F',
      path.join(PATHS.home, 'devspaces', 'ssh.config'),
      '-o',
      'BatchMode=yes',
      '-T',
      'lima-devspaces',
      'sudo -n sh -s',
    ]);
  });
});

describe('limaResources', () => {
  it('gives 4 GiB and 4 CPUs by default, each at most half of the computer and at least 1', () => {
    expect(limaResources(32 * GIB, 16)).toEqual({ memoryGiB: 4, cpus: 4 });
    expect(limaResources(8 * GIB, 8)).toEqual({ memoryGiB: 4, cpus: 4 });
    expect(limaResources(6 * GIB, 6)).toEqual({ memoryGiB: 3, cpus: 3 });
    expect(limaResources(1 * GIB, 1)).toEqual({ memoryGiB: 1, cpus: 1 });
  });

  it('takes the settings within the same limits, and ignores a value that is no positive whole number', () => {
    expect(limaResources(32 * GIB, 16, { memoryGiB: 12, cpus: 6 })).toEqual({ memoryGiB: 12, cpus: 6 });
    expect(limaResources(16 * GIB, 8, { memoryGiB: 12, cpus: 6 })).toEqual({ memoryGiB: 8, cpus: 4 });
    expect(limaResources(32 * GIB, 16, { memoryGiB: 0, cpus: 2.5 })).toEqual({ memoryGiB: 4, cpus: 4 });
  });
});

describe('limaConfig', () => {
  const image = { file: '/home/ada/.nimblescape/devspaces/download/devspaces-vm-arm64.qcow2', digest: `sha256:${'a'.repeat(64)}` };

  it('uses Apple Virtualization on macOS and QEMU on Linux, the disk of the image, and nothing of this computer', () => {
    const mac = JSON.parse(limaConfig({ platform: 'darwin', arch: 'arm64', image, resources: { memoryGiB: 4, cpus: 4 } })) as Record<string, unknown>;
    expect(mac).toEqual({
      vmType: 'vz',
      os: 'Linux',
      arch: 'aarch64',
      images: [{ location: image.file, arch: 'aarch64', digest: image.digest }],
      cpus: 4,
      memory: '4GiB',
      disk: `${VM_DISK_GIB}GiB`,
      mounts: [],
      containerd: { system: false, user: false },
      ssh: { localPort: 0, loadDotSSHPubKeys: false, forwardAgent: false, forwardX11: false },
      portForwards: [
        { guestSocket: '/run/docker.sock', hostSocket: '{{.Dir}}/sock/docker.sock' },
        { guestIP: '127.0.0.1', guestPortRange: [1, 65535], ignore: true },
        { guestIP: '0.0.0.0', guestPortRange: [1, 65535], ignore: true },
      ],
      provision: [
        {
          mode: 'system',
          script: [
            '#!/bin/sh',
            'mkdir -p /run/systemd/system/docker.socket.d',
            "printf '[Socket]\\nExecStartPost=-/bin/chown {{.UID}} /run/docker.sock\\n' > /run/systemd/system/docker.socket.d/50-devspaces-lima.conf",
            'systemctl daemon-reload',
            '[ ! -S /run/docker.sock ] || chown {{.UID}} /run/docker.sock',
            '',
          ].join('\n'),
        },
      ],
      upgradePackages: false,
      video: { display: 'none' },
    });
    const linux = JSON.parse(limaConfig({ platform: 'linux', arch: 'x64', image, resources: { memoryGiB: 2, cpus: 1 } })) as Record<string, unknown>;
    expect(linux).toMatchObject({ vmType: 'qemu', arch: 'x86_64', cpus: 1, memory: '2GiB' });
    // The Docker socket of the VM on this computer, where the template {{.Dir}} of the instance puts it.
    expect(limaDockerSocket(limaPaths('/home/ada'))).toBe('/home/ada/.nimblescape/devspaces/vm/devspaces/sock/docker.sock');
  });
});

describe('parseLimaList', () => {
  it('finds the state of the instance of Devspaces among the lines of limactl list --json', () => {
    const other = JSON.stringify({ name: 'default', status: 'Running' });
    expect(parseLimaList('')).toBe('missing');
    expect(parseLimaList(`${other}\n`)).toBe('missing');
    expect(parseLimaList(`${other}\n${JSON.stringify({ name: 'devspaces', status: 'Running', dir: '/x' })}\n`)).toBe('running');
    expect(parseLimaList(JSON.stringify({ name: 'devspaces', status: 'Stopped' }))).toBe('stopped');
    expect(parseLimaList(JSON.stringify({ name: 'devspaces', status: 'Broken' }))).toBe('broken');
    expect(parseLimaList(JSON.stringify({ name: 'devspaces', status: '' }))).toBe('other');
    expect(parseLimaList('time="..." level=warning msg="..."\n{not json')).toBe('missing');
  });
});

describe('parseLimaInfo', () => {
  it('reads the CPUs and the memory of the instance, where limactl list names them', () => {
    const line = JSON.stringify({ name: 'devspaces', status: 'Stopped', cpus: 4, memory: 6 * 2 ** 30 });
    expect(parseLimaInfo(line)).toEqual({ status: 'stopped', resources: { cpus: 4, memoryGiB: 6 } });
    expect(parseLimaInfo(JSON.stringify({ name: 'devspaces', status: 'Running', cpus: 2 }))).toEqual({ status: 'running' });
    expect(parseLimaInfo('')).toEqual({ status: 'missing' });
  });
});

describe('LimaInstance', () => {
  const env = { PATH: '/usr/bin' };

  it('runs limactl with LIMA_HOME of Devspaces, and starts a stopped instance only', async () => {
    const running = JSON.stringify({ name: 'devspaces', status: 'Running' });
    const stopped = JSON.stringify({ name: 'devspaces', status: 'Stopped' });
    const fake = runner([{ stdout: stopped }, {}, { stdout: running }]);
    const instance = new LimaInstance({ limactl: '/lima/bin/limactl', paths: PATHS, runner: fake.runner, logger: silentLogger, env });
    await expect(instance.ensureRunning()).resolves.toBe(true);
    await expect(instance.ensureRunning()).resolves.toBe(true);
    expect(fake.calls.map((call) => call.args)).toEqual([['list', '--json'], ['start', '--tty=false', '--timeout=10m', 'devspaces'], ['list', '--json']]);
    expect(fake.calls.every((call) => call.file === '/lima/bin/limactl' && call.options?.env?.LIMA_HOME === PATHS.home && call.options.env.PATH === '/usr/bin')).toBe(true);
  });

  it('starts no missing instance, and logs a failed start', async () => {
    const lines: string[] = [];
    const logger = { ...silentLogger, warn: (line: string) => lines.push(line) };
    const missing = new LimaInstance({ limactl: 'limactl', paths: PATHS, runner: runner([{ stdout: '' }]).runner, logger, env });
    await expect(missing.ensureRunning()).resolves.toBe(false);
    const stopped = JSON.stringify({ name: 'devspaces', status: 'Stopped' });
    const failing = new LimaInstance({ limactl: 'limactl', paths: PATHS, runner: runner([{ stdout: stopped }, { exitCode: 1, stderr: 'level=fatal msg="exiting, status={Running:false Degraded:false}"' }]).runner, logger, env });
    await expect(failing.ensureRunning()).resolves.toBe(false);
    expect(lines).toEqual(['The Lima VM of Devspaces could not be started: limactl start failed: level=fatal msg="exiting, status={Running:false Degraded:false}"']);
  });

  it('creates the instance from its configuration and gives the output line by line, also a last line without its end', async () => {
    const fake = runner([{}], { stdout: ['level=info msg="Attempting to download', ' the image"\nlevel=info msg="Run `limactl start devspaces`"\n'], stderr: ['warning\n', 'last line'] });
    const instance = new LimaInstance({ limactl: 'limactl', paths: PATHS, runner: fake.runner, logger: silentLogger, env });
    const lines: string[] = [];
    await instance.create('/tmp/lima.yaml', undefined, (line) => lines.push(line));
    expect(fake.calls[0].args).toEqual(['create', '--name=devspaces', '--tty=false', '/tmp/lima.yaml']);
    expect(lines).toEqual(['level=info msg="Attempting to download the image"', 'level=info msg="Run `limactl start devspaces`"', 'warning', 'last line']);
  });

  it('gives the stopped instance other CPUs and memory with limactl edit, without a question', async () => {
    const fake = runner([{}, { exitCode: 1, stderr: 'cannot edit a running instance' }]);
    const instance = new LimaInstance({ limactl: 'limactl', paths: PATHS, runner: fake.runner, logger: silentLogger, env });
    await instance.setResources({ memoryGiB: 6, cpus: 2 });
    expect(fake.calls[0].args).toEqual(['edit', '--tty=false', '--cpus=2', '--memory=6', 'devspaces']);
    await expect(instance.setResources({ memoryGiB: 6, cpus: 2 })).rejects.toThrow(new LimaError('edit', 'cannot edit a running instance'));
  });

  it('names the step and the end of the output of a failed limactl, or the time limit', async () => {
    const instance = new LimaInstance({ limactl: 'limactl', paths: PATHS, runner: runner([{ exitCode: 1, stderr: 'disk is locked' }, { exitCode: null, timedOut: true }]).runner, logger: silentLogger, env });
    await expect(instance.delete()).rejects.toThrow(new LimaError('delete', 'disk is locked'));
    await expect(instance.stop()).rejects.toThrow('limactl stop failed: it did not end in time');
  });
});
