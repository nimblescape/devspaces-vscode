#!/bin/bash
# SPDX-License-Identifier: MIT
# © 2026 Hannes Stauss (scalarion@nimblescape.com)
# Licensed under the MIT License. See LICENSE in the repository root for details.

# The start test of the disk for Lima of the image of the VM of Devspaces
# (docs/requirements.md R-VM-009), on Linux x86_64 with KVM: QEMU starts the
# disk with UEFI and a NoCloud disk for cloud-init, as Lima does, and the test
# logs in over SSH and checks
#
#   - that cloud-init ended well, grew the root file system to the size of the
#     disk, and that every service started (systemctl is-system-running),
#   - the kernel check of the start (R-VM-003),
#   - Docker Engine: a container with a download of an image,
#   - the package upgrade (R-VM-007): it runs when it is due, and the running
#     container and Docker Engine go on during it,
#   - the idle check (R-VM-004): the VM powers itself off about two minutes
#     after the last container stopped.
#
# A container runs from the first minute on, so that the idle check does not
# power the VM off during the test. It needs qemu-system-x86, ovmf,
# cloud-image-utils and the OpenSSH client.
#
# Usage: vm/test/start-test.sh <devspaces-vm-amd64.qcow2> [<log folder>]
set -euo pipefail

disk=$(realpath "${1:?Usage: start-test.sh <qcow2> [<log folder>]}")
logs=$(mkdir -p "${2:-.}" && cd "${2:-.}" && pwd)
work=$(mktemp -d)
port=2222
qemu_pid=

fail() {
  echo "FAILED: $*" >&2
  echo "The last lines of the serial console:" >&2
  tail -n 60 "$logs/serial.log" >&2 || true
  exit 1
}
cleanup() {
  if [ -n "$qemu_pid" ] && kill -0 "$qemu_pid" 2>/dev/null; then
    kill "$qemu_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N '' -f "$work/key"
cat > "$work/user-data" <<EOF
#cloud-config
users:
  - name: ci
    groups: [docker]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat "$work/key.pub")
EOF
printf 'instance-id: devspaces-start-test\nlocal-hostname: devspaces\n' > "$work/meta-data"
cloud-localds "$work/seed.iso" "$work/user-data" "$work/meta-data"
qemu-img create -q -f qcow2 -F qcow2 -b "$disk" "$work/disk.qcow2" 20G
cp /usr/share/OVMF/OVMF_VARS_4M.fd "$work/vars.fd"

echo "== The start of the VM"
qemu-system-x86_64 -machine q35,accel=kvm -cpu host -m 2048 -smp 2 \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
  -drive if=pflash,format=raw,file="$work/vars.fd" \
  -drive if=virtio,format=qcow2,file="$work/disk.qcow2" \
  -drive if=virtio,format=raw,readonly=on,file="$work/seed.iso" \
  -nic user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:$port-:22 \
  -display none -serial "file:$logs/serial.log" &
qemu_pid=$!

vm() {
  ssh -n -q -i "$work/key" -p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 -o BatchMode=yes ci@127.0.0.1 "$@"
}

start=$SECONDS
until vm true 2>/dev/null; do
  kill -0 "$qemu_pid" 2>/dev/null || fail "QEMU ended before the login."
  [ $((SECONDS - start)) -lt 300 ] || fail "No SSH login within 5 minutes."
  sleep 2
done
echo "SSH login after $((SECONDS - start)) seconds."

echo "== A container that runs during the test"
vm docker run --detach --name keep mirror.gcr.io/library/busybox:latest sleep 3600 > /dev/null || fail "docker run"
vm docker run --rm mirror.gcr.io/library/busybox:latest echo "A container ran." || fail "docker run --rm"
vm docker version --format 'Docker Engine {{.Server.Version}}'

echo "== cloud-init and the services"
# Exit status 2: cloud-init ended with a warning, which the output shows.
vm cloud-init status --wait --long || [ $? -eq 2 ] || fail "cloud-init did not end well."
state=$(vm systemctl is-system-running --wait || true)
if [ "$state" != running ]; then
  vm systemctl --failed --no-pager || true
  fail "The state of the system is \"$state\", not running."
fi
vm systemctl is-active devspaces-idle.service devspaces-upgrade.timer docker.service ssh.service systemd-networkd.service systemd-resolved.service > /dev/null ||
  fail "A service of the VM does not run."
size=$(vm df --output=size --block-size=1G / | tail -n 1 | tr -d ' ')
[ "$size" -ge 18 ] || fail "The root file system has $size GiB, not about 20 GiB: cloud-init did not grow it."
echo "Root file system: $size GiB."

echo "== The kernel check"
vm sudo /usr/lib/devspaces/kernel-check || fail "The kernel lacks options that Docker Engine requires."
[ "$(vm sudo wc -l /var/lib/devspaces/kernel-check | awk '{ print $1 }')" = 1 ] ||
  fail "The kernel check of the start found missing options: $(vm sudo cat /var/lib/devspaces/kernel-check)"

echo "== The package upgrade"
before=$(vm 'systemctl show --property=MainPID --value docker.service; docker inspect --format "{{.State.StartedAt}}" keep')
vm sudo rm -f /var/lib/devspaces/upgraded /var/lib/devspaces/upgrade-tried
vm sudo systemctl start devspaces-upgrade.service || {
  vm sudo tail -n 40 /var/log/devspaces-upgrade.log || true
  fail "The package upgrade failed."
}
vm sudo journalctl --unit devspaces-upgrade.service --no-pager --output=cat | grep '^devspaces-upgrade done' ||
  fail "The package upgrade did not run."
vm sudo test -s /var/lib/devspaces/upgraded || fail "The package upgrade wrote no time."
vm test ! -e /usr/sbin/policy-rc.d || fail "The package upgrade left /usr/sbin/policy-rc.d."
after=$(vm 'systemctl show --property=MainPID --value docker.service; docker inspect --format "{{.State.StartedAt}}" keep')
[ "$before" = "$after" ] || fail "Docker Engine or the container started again during the upgrade: $before / $after"
[ "$(vm docker inspect --format '{{.State.Running}}' keep)" = true ] || fail "The container stopped during the upgrade."

echo "== The idle check"
vm docker rm --force keep > /dev/null
stopped=$SECONDS
while kill -0 "$qemu_pid" 2>/dev/null; do
  [ $((SECONDS - stopped)) -lt 300 ] || fail "The VM still runs 5 minutes after its last container stopped."
  sleep 5
done
qemu_pid=
grep -q 'reboot: Power down' "$logs/serial.log" || fail "QEMU ended, but not by a power-off of the VM."
echo "The VM powered itself off $((SECONDS - stopped)) seconds after its last container stopped."
echo "The start test passed."
