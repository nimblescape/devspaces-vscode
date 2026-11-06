// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { qemuInstallPlan, type QemuInstallInput } from './qemuInstall';

const base: QemuInstallInput = { arch: 'x64', osRelease: { ID: 'ubuntu' }, userName: 'ada', qemu: true, kvmGroup: false };

describe('qemuInstallPlan', () => {
  it('installs QEMU with its UEFI firmware from the package source of the distribution, for the processor', () => {
    expect(qemuInstallPlan(base)).toEqual({
      kind: 'terminal',
      commands: ['sudo apt-get update', 'sudo apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils ovmf'],
      newLogin: false,
    });
    // Linux Mint names Ubuntu in ID_LIKE.
    expect(qemuInstallPlan({ ...base, arch: 'arm64', osRelease: { ID: 'linuxmint', ID_LIKE: 'ubuntu debian' } })).toMatchObject({
      commands: ['sudo apt-get update', 'sudo apt-get install -y --no-install-recommends qemu-system-arm qemu-utils qemu-efi-aarch64'],
    });
    expect(qemuInstallPlan({ ...base, osRelease: { ID: 'fedora' } })).toMatchObject({ commands: ['sudo dnf install -y qemu-system-x86-core qemu-img edk2-ovmf'] });
    expect(qemuInstallPlan({ ...base, osRelease: { ID: 'endeavouros', ID_LIKE: 'arch' } })).toMatchObject({ commands: ['sudo pacman -S --needed --noconfirm qemu-base edk2-ovmf'] });
  });

  it('adds the user to the group kvm, which needs a new login, and needs a user name that the shell takes as one word', () => {
    expect(qemuInstallPlan({ ...base, kvmGroup: true })).toEqual({
      kind: 'terminal',
      commands: ['sudo apt-get update', 'sudo apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils ovmf', 'sudo usermod -aG kvm ada'],
      newLogin: true,
    });
    expect(qemuInstallPlan({ ...base, qemu: false, kvmGroup: true, osRelease: {} })).toEqual({ kind: 'terminal', commands: ['sudo usermod -aG kvm ada'], newLogin: true });
    expect(qemuInstallPlan({ ...base, kvmGroup: true, userName: 'ada; rm -rf ~' })).toEqual({ kind: 'manual' });
    expect(qemuInstallPlan({ ...base, kvmGroup: true, userName: undefined })).toEqual({ kind: 'manual' });
  });

  it('has no plan for a distribution whose package source has no qemu-system of the processor', () => {
    expect(qemuInstallPlan({ ...base, osRelease: { ID: 'rhel', ID_LIKE: 'fedora' } })).toEqual({ kind: 'manual' });
    expect(qemuInstallPlan({ ...base, osRelease: { ID: 'rocky', ID_LIKE: 'rhel centos fedora' } })).toEqual({ kind: 'manual' });
    expect(qemuInstallPlan({ ...base, osRelease: { ID: 'opensuse-tumbleweed', ID_LIKE: 'opensuse suse' } })).toEqual({ kind: 'manual' });
    expect(qemuInstallPlan({ ...base, arch: 'arm64', osRelease: { ID: 'arch' } })).toEqual({ kind: 'manual' });
  });
});
