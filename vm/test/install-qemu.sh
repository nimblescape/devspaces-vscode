#!/bin/bash
# SPDX-License-Identifier: MIT
# © 2026 Hannes Stauss (scalarion@nimblescape.com)
# Licensed under the MIT License. See LICENSE in the repository root for details.

# Lets the user of a GitHub runner (Ubuntu) use KVM and installs the packages
# that it names, for the start test and the Lima test of the image of the VM:
#
#   vm/test/install-qemu.sh qemu-system-x86 qemu-utils ovmf
#
# On some runs, this step stopped for more than 12 minutes without any output.
# So the steps that use the network have a time limit and up to three tries,
# and the installation then takes only the packages that are already
# downloaded. apt-get writes its lines (-q, not -qq), so that the log shows the
# step that stops.
set -euo pipefail

echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm.rules > /dev/null
sudo udevadm control --reload-rules
sudo udevadm trigger --name-match=kvm

# The runner image rebuilds the index of its manual pages after each installation, which can take minutes.
sudo rm -f /var/lib/man-db/auto-update

apt=(apt-get -q -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o DPkg::Lock::Timeout=120)
for try in 1 2 3; do
  if sudo timeout 240 "${apt[@]}" update && sudo timeout 300 "${apt[@]}" install -y --download-only --no-install-recommends "$@"; then
    break
  fi
  if [ "$try" -eq 3 ]; then
    echo '::error::The packages could not be downloaded in 3 tries.'
    exit 1
  fi
  echo "::warning::The download of the packages failed or took too long; try $((try + 1)) of 3."
  sleep 10
done
sudo "${apt[@]}" install -y --no-install-recommends "$@"
