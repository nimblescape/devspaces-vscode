#!/bin/bash
# SPDX-License-Identifier: MIT
# © 2026 Hannes Stauss (scalarion@nimblescape.com)
# Licensed under the MIT License. See LICENSE in the repository root for details.

# The recipe of the image of the VM of Devspaces (docs/requirements.md
# R-VM-002): one Debian 13 (trixie) system with Docker Engine, as a .wsl file
# for WSL and as a disk for Lima, which differ only in the kernel. It runs as
# root in a privileged container of Debian 13 of the architecture of the
# image (vm/build.sh starts it), and writes into the folder <out>:
#
#   devspaces-vm-<arch>.wsl     the .wsl file: a tar archive with gzip of the
#                               system without a kernel (WSL runs its own)
#   devspaces-vm-<arch>.qcow2   the disk for Lima (QCOW2 with zlib): a GPT with
#                               an EFI system partition, whose GRUB starts
#                               /boot/vmlinuz, and the ext4 root file system
#                               with the label devspaces-root, which cloud-init
#                               grows to the size of the disk of the VM
#   packages-wsl-<arch>.txt     the installed packages of each file (name,
#   packages-lima-<arch>.txt    version, architecture), sorted
#   kernel-config-<arch>        the configuration of the kernel of the disk,
#                               for the kernel check of the daily workflow
#
# mmdebstrap installs the variant "minbase" with the packages of
# vm/packages and vm/packages-lima, without the packages that they only
# recommend, from deb.debian.org and from download.docker.com, whose key the
# recipe checks against its fingerprint. The files of vm/rootfs go into the
# system before these packages. The .wsl file is a copy of the system after
# `apt-get purge` of the packages of vm/packages-lima. The build time counts
# as the last package upgrade (rootfs/usr/lib/devspaces/upgrade). The system
# has no SSH host keys and no machine ID: each VM creates its own at its
# first start.
#
# Usage: recipe.sh <amd64|arm64> <out>
#
# The hooks of mmdebstrap and the format of dpkg-query take $1 and ${...}
# literally, for mmdebstrap and dpkg-query to expand.
# shellcheck disable=SC2016
set -euo pipefail

arch=${1:-}
out=${2:-}
recipe=$(cd "$(dirname "$0")" && pwd)
# The fingerprint of the key of the Debian packages of Docker
# (https://docs.docker.com/engine/install/debian/).
docker_key_fingerprint=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
root_label=devspaces-root
esp_mib=128

case "$arch" in
  amd64)
    efi_format=x86_64-efi
    efi_file=BOOTX64.EFI
    console='console=tty0 console=hvc0 console=ttyS0,115200n8'
    ;;
  arm64)
    efi_format=arm64-efi
    efi_file=BOOTAA64.EFI
    console='console=tty0 console=hvc0 console=ttyAMA0,115200n8'
    ;;
  *)
    echo "Usage: recipe.sh <amd64|arm64> <out>" >&2
    exit 2
    ;;
esac
if [ -z "$out" ]; then
  echo "Usage: recipe.sh <amd64|arm64> <out>" >&2
  exit 2
fi
if [ "$(dpkg --print-architecture)" != "$arch" ]; then
  echo "The recipe of $arch runs in a container of $(dpkg --print-architecture)." >&2
  exit 2
fi
mkdir -p "$out"

export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8
step() { echo "== $*"; }

step "The tools of the build"
apt-get update
apt-get install -y --no-install-recommends mmdebstrap ca-certificates curl gpg dosfstools mtools fdisk qemu-utils e2fsprogs

step "The key of the packages of Docker"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
fingerprints=$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc | awk -F: '$1 == "pub" { primary = 1; next } $1 == "fpr" && primary { print $10; primary = 0 }')
if [ "$fingerprints" != "$docker_key_fingerprint" ]; then
  echo "The key of download.docker.com has the fingerprints ${fingerprints//$'\n'/ }, not $docker_key_fingerprint." >&2
  exit 1
fi

# The lines of a list of packages, without comments, for this architecture.
list() { grep -hv -e '^#' -e '^[[:space:]]*$' "$@" | sed "s/ARCH/$arch/g"; }
packages=$(list "$recipe/packages" "$recipe/packages-lima" | paste -sd, -)
lima_only=$(list "$recipe/packages-lima" | paste -sd' ' -)

work=$(mktemp -d)
tree=$work/lima
wsl=$work/wsl
# The files of vm/rootfs, owned by root (the checkout belongs to the user of
# the runner).
cp -r "$recipe/rootfs" "$work/rootfs"

step "The system (mmdebstrap)"
mmdebstrap --mode=root --variant=minbase --format=directory --arch="$arch" \
  --aptopt='APT::Install-Recommends "false"' \
  --include="$packages" \
  --essential-hook='mkdir -p "$1/etc/apt/keyrings"' \
  --essential-hook='copy-in /etc/apt/keyrings/docker.asc /etc/apt/keyrings/' \
  --essential-hook="sync-in $work/rootfs /" \
  --customize-hook='chroot "$1" systemctl enable docker.service containerd.service systemd-networkd.service systemd-resolved.service devspaces-idle.service devspaces-kernel-check.service devspaces-upgrade.timer' \
  --customize-hook='chroot "$1" systemctl mask apt-daily.timer apt-daily-upgrade.timer' \
  --customize-hook='rm -f "$1"/etc/ssh/ssh_host_* "$1/etc/apt/apt.conf.d/99mmdebstrap" "$1/var/lib/dbus/machine-id"' \
  --customize-hook='printf "uninitialized\n" > "$1/etc/machine-id"' \
  --customize-hook='printf "devspaces\n" > "$1/etc/hostname"' \
  --customize-hook='mkdir -p "$1/var/lib/devspaces" && date +%s > "$1/var/lib/devspaces/upgraded"' \
  trixie "$tree" \
  "deb https://deb.debian.org/debian trixie main" \
  "deb https://deb.debian.org/debian trixie-updates main" \
  "deb https://deb.debian.org/debian-security trixie-security main" \
  "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable"

# The installed packages of a system, one per line, sorted.
packages_of() { chroot "$1" dpkg-query -W -f '${Package} ${Version} ${Architecture}\n' | LC_ALL=C sort; }
packages_of "$tree" > "$out/packages-lima-$arch.txt"

kernel=$(readlink "$tree/boot/vmlinuz" || true)
release=${kernel#vmlinuz-}
if [ -z "$kernel" ] || [ ! -f "$tree/boot/$kernel" ] || [ ! -f "$tree/boot/config-$release" ] || [ ! -e "$tree/boot/initrd.img" ]; then
  echo "The system has no /boot/vmlinuz, /boot/initrd.img and configuration of its kernel:" >&2
  ls -l "$tree/boot" >&2
  exit 1
fi
cp "$tree/boot/config-$release" "$out/kernel-config-$arch"

step "The .wsl file: the system without the packages of the disk for Lima"
cp -a "$tree" "$wsl"
mount -t proc proc "$wsl/proc"
trap 'umount "$wsl/proc" 2>/dev/null || true' EXIT
# The kernel itself too: apt keeps the newest kernel from an autoremove.
kernels=$(chroot "$wsl" dpkg-query -W -f '${Package}\n' 'linux-image-[0-9]*' 2>/dev/null || true)
# shellcheck disable=SC2086 # one word for each package
chroot "$wsl" apt-get -y purge --autoremove $lima_only $kernels
umount "$wsl/proc"
trap - EXIT
packages_of "$wsl" > "$out/packages-wsl-$arch.txt"
if grep -E '^(linux-image|initramfs-tools|grub-)' "$out/packages-wsl-$arch.txt"; then
  echo "The .wsl file still has these packages of the disk for Lima." >&2
  exit 1
fi
# WSL writes /etc/resolv.conf itself; systemd-resolved runs only in Lima.
rm -f "$wsl/etc/resolv.conf"
rm -rf "${wsl:?}/boot" "${wsl:?}/usr/lib/modules"
mkdir -m 0755 "$wsl/boot" "$wsl/usr/lib/modules"
tar --create --gzip --numeric-owner --file="$out/devspaces-vm-$arch.wsl" --directory="$wsl" \
  --exclude='./dev/*' --exclude='./proc/*' --exclude='./sys/*' --exclude='./run/*' --exclude='./tmp/*' .
contents=$(tar --list --gzip --file="$out/devspaces-vm-$arch.wsl")
for file in ./etc/wsl.conf ./etc/wsl-distribution.conf ./usr/bin/dockerd ./usr/lib/devspaces/idle ./usr/lib/devspaces/upgrade; do
  grep -qxF "$file" <<< "$contents" || { echo "The .wsl file has no $file." >&2; exit 1; }
done
if grep -q -e '^\./boot/.' -e '^\./usr/lib/modules/.' <<< "$contents"; then
  echo "The .wsl file has a kernel." >&2
  exit 1
fi
rm -rf "$wsl"

step "The disk for Lima"
cat > "$tree/etc/fstab" <<EOF
# Written by the recipe of the image of the VM of Devspaces (vm/recipe.sh).
LABEL=$root_label / ext4 errors=remount-ro 0 1
EOF
mkdir -p "$tree/boot/grub"
cat > "$tree/boot/grub/grub.cfg" <<EOF
# Written by the recipe of the image of the VM of Devspaces (vm/recipe.sh):
# the boot loader starts the newest kernel (/etc/kernel-img.conf).
set timeout=0
insmod part_gpt
insmod ext2
insmod gzio
search --no-floppy --label --set=root $root_label
linux /boot/vmlinuz root=LABEL=$root_label ro $console
initrd /boot/initrd.img
boot
EOF
# GRUB as one EFI program, made with the GRUB of the system: it finds the
# root file system by its label and reads /boot/grub/grub.cfg there.
cat > "$tree/tmp/early.cfg" <<EOF
search --no-floppy --label --set=root $root_label
set prefix=(\$root)/boot/grub
configfile \$prefix/grub.cfg
EOF
chroot "$tree" grub-mkimage --format="$efi_format" --output="/tmp/$efi_file" --prefix=/boot/grub --config=/tmp/early.cfg \
  part_gpt fat ext2 normal linux configfile search search_label echo test gzio efi_gop
mv "$tree/tmp/$efi_file" "$work/$efi_file"
rm -f "$tree/tmp/early.cfg"

# The root file system: the size of the system, 30 % more and 256 MiB, in
# steps of 128 MiB.
used_mib=$(du -s --block-size=1M "$tree" | cut -f1)
root_mib=$(( (used_mib * 13 / 10 + 256 + 127) / 128 * 128 ))
mkfs.ext4 -q -L "$root_label" -d "$tree" "$work/root.img" "${root_mib}M"
mkfs.vfat -F 32 -n EFI -C "$work/esp.img" $((esp_mib * 1024))
mmd -i "$work/esp.img" ::/EFI ::/EFI/BOOT
mcopy -i "$work/esp.img" "$work/$efi_file" "::/EFI/BOOT/$efi_file"

# The disk: 1 MiB for the GPT, the EFI system partition, the root file
# system, and 1 MiB for the copy of the GPT at the end.
disk=$work/disk.raw
truncate -s $((1 + esp_mib + root_mib + 1))M "$disk"
sfdisk --quiet "$disk" <<EOF
label: gpt
unit: sectors
start=2048, size=$((esp_mib * 2048)), type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, name="EFI system"
start=$((2048 + esp_mib * 2048)), size=$((root_mib * 2048)), type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name="$root_label"
EOF
dd if="$work/esp.img" of="$disk" bs=1M seek=1 conv=notrunc,sparse status=none
dd if="$work/root.img" of="$disk" bs=1M seek=$((1 + esp_mib)) conv=notrunc,sparse status=none
qemu-img convert -f raw -O qcow2 -c -o compression_type=zlib "$disk" "$out/devspaces-vm-$arch.qcow2"
rm -rf "$work"

step "The files"
if [ -n "${HOST_UID:-}" ]; then
  chown "$HOST_UID:${HOST_GID:-$HOST_UID}" "$out"/*
fi
ls -l "$out"
echo "Kernel of the disk: $release"
echo "Root file system: ${used_mib} MiB used of ${root_mib} MiB"
