#!/bin/bash
# SPDX-License-Identifier: MIT
# © 2026 Hannes Stauss (scalarion@nimblescape.com)
# Licensed under the MIT License. See LICENSE in the repository root for details.

# Builds the image of the VM of Devspaces for one architecture (vm/recipe.sh)
# in a privileged container of Debian 13 of that architecture, on a Linux
# computer of the same architecture with Docker. The workflow "VM image"
# (.github/workflows/vm-image.yml) runs it on a runner of each architecture.
#
# Usage: vm/build.sh <amd64|arm64> <out>
set -euo pipefail

arch=${1:-}
out=${2:-}
case "$arch" in
  amd64|arm64) ;;
  *)
    echo "Usage: vm/build.sh <amd64|arm64> <out>" >&2
    exit 2
    ;;
esac
if [ -z "$out" ]; then
  echo "Usage: vm/build.sh <amd64|arm64> <out>" >&2
  exit 2
fi
case "$(uname -m)" in
  x86_64) host=amd64 ;;
  aarch64|arm64) host=arm64 ;;
  *) host=$(uname -m) ;;
esac
if [ "$host" != "$arch" ]; then
  echo "The image of $arch is built on a computer of $arch, not of $host." >&2
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
out=$(cd "$out" && pwd)
# The image of Debian 13 from the mirror of Google, without the limits of
# Docker Hub for downloads without an account.
image=mirror.gcr.io/library/debian:trixie
docker pull --quiet --platform "linux/$arch" "$image"
docker run --rm --privileged --platform "linux/$arch" \
  --env HOST_UID="$(id -u)" --env HOST_GID="$(id -g)" \
  --volume "$here:/recipe:ro" --volume "$out:/out" \
  "$image" /recipe/recipe.sh "$arch" /out
