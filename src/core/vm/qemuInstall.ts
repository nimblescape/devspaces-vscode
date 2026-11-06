// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The installation of QEMU on Linux for the Lima VM of Devspaces (R-VM-001, docs/architecture.md "The Lima VM of
// Devspaces"): one administrator prompt (`sudo` in a visible terminal of VS Code) installs QEMU and its UEFI firmware
// from the package source of the distribution, and adds the user to the group `kvm` when the user may not use
// `/dev/kvm`. As the installation of WSL on Windows, it asks no question of Devspaces: the click on the setup or the
// link is the decision, and the terminal shows each command. Distributions that this does not know get the names of the
// packages instead. No `vscode`.

/** A user name that `usermod` accepts and that the shell reads as one word, without quotes. */
const USER_NAME_PATTERN = /^[a-z_][a-z0-9_.-]*\$?$/i;

/** The packages of QEMU for the processor of this computer, by the package manager of the distribution. */
const PACKAGES: Record<'apt' | 'dnf' | 'pacman', Partial<Record<string, string>>> = {
  // qemu-system-x86 or -arm brings qemu-system-x86_64 or -aarch64; ovmf and qemu-efi-aarch64 the UEFI firmware that
  // Lima starts the VM with.
  apt: { x64: 'qemu-system-x86 qemu-utils ovmf', arm64: 'qemu-system-arm qemu-utils qemu-efi-aarch64' },
  dnf: { x64: 'qemu-system-x86-core qemu-img edk2-ovmf', arm64: 'qemu-system-aarch64-core qemu-img edk2-aarch64' },
  // Arch Linux: qemu-base is QEMU without a display.
  pacman: { x64: 'qemu-base edk2-ovmf' },
};

export interface QemuInstallInput {
  /** `process.arch`: `x64` or `arm64`. */
  arch: string;
  /** Fields of /etc/os-release (parseOsRelease). */
  osRelease: Readonly<Record<string, string>>;
  /** The login name of the user, for the group `kvm`. */
  userName: string | undefined;
  /** QEMU is missing (`qemu-system-<arch>` or `qemu-img`). */
  qemu: boolean;
  /** `/dev/kvm` exists, but the user may not use it: the user joins the group `kvm`. */
  kvmGroup: boolean;
}

export type QemuInstallPlan =
  | {
      kind: 'terminal';
      /** Run in this order in a visible terminal; each one only when the one before succeeded. */
      commands: string[];
      /** The user joins the group `kvm`, which counts only after a new login. */
      newLogin: boolean;
    }
  /** A distribution that this does not know, or a user name that the shell cannot take: the message says what to do. */
  | { kind: 'manual' };

/** The package manager of the distribution of /etc/os-release: its ID, else the IDs of ID_LIKE. */
function packageManager(osRelease: Readonly<Record<string, string>>): keyof typeof PACKAGES | undefined {
  const ids = [osRelease.ID ?? '', ...(osRelease.ID_LIKE ?? '').split(/\s+/)].map((id) => id.toLowerCase()).filter((id) => id !== '');
  // RHEL and its rebuilds (CentOS, Rocky, AlmaLinux) name fedora in ID_LIKE, but have no qemu-system-<arch>.
  if (ids.includes('rhel') || ids.includes('centos')) return undefined;
  for (const id of ids) {
    if (id === 'debian' || id === 'ubuntu') return 'apt';
    if (id === 'fedora') return 'dnf';
    if (id === 'arch') return 'pacman';
  }
  return undefined;
}

/**
 * The commands that install QEMU and add the user to the group `kvm`, as far as they are needed. RHEL and CentOS have
 * no `qemu-system-<arch>` in their package source (only `qemu-kvm` outside of PATH, which Lima does not find), so they
 * are `manual`, as every distribution that is not Debian, Ubuntu, Fedora, Arch Linux or one that names them in ID_LIKE.
 */
export function qemuInstallPlan(input: QemuInstallInput): QemuInstallPlan {
  const commands: string[] = [];
  if (input.qemu) {
    const manager = packageManager(input.osRelease);
    const packages = manager === undefined ? undefined : PACKAGES[manager][input.arch];
    if (manager === undefined || packages === undefined) return { kind: 'manual' };
    if (manager === 'apt') commands.push('sudo apt-get update', `sudo apt-get install -y --no-install-recommends ${packages}`);
    else if (manager === 'dnf') commands.push(`sudo dnf install -y ${packages}`);
    else commands.push(`sudo pacman -S --needed --noconfirm ${packages}`);
  }
  if (input.kvmGroup) {
    if (input.userName === undefined || !USER_NAME_PATTERN.test(input.userName)) return { kind: 'manual' };
    commands.push(`sudo usermod -aG kvm ${input.userName}`);
  }
  return { kind: 'terminal', commands, newLogin: input.kvmGroup };
}
