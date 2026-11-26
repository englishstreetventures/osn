#!/usr/bin/env bash
# Unpacks Lean release LEAN_VERSION for LEAN_TARGET into <dest dir>, from the
# release tarball whose SHA-256 is LEAN_SHA256: bin/lean, bin/leanc and the
# libraries they build with, without the toolchain's own sources. The pin
# lives in tools/bend/lean.env; its caller (the `bend-proofs` job in
# .github/workflows/ci.yml) reads it and passes it here, which also lets the
# test give a fixture tarball its own SHA-256. bend builds the BendTT kernel
# `--verdict` runs with this toolchain (bash tools/bend/bend.sh kernel).
#
# usage: LEAN_VERSION=<n.n.n> LEAN_TARGET=<os-arch> LEAN_SHA256=<hex> install-lean.sh <dest dir>
#
# LEAN_TARGET is named as bend.env names Bend's (linux-x64, linux-arm64,
# darwin-x64, darwin-arm64) and maps to the name Lean gives that build. The
# tarball (about 580 MB) is downloaded into a temporary directory, never
# cached, and deleted on every exit: CI caches the kernel built from it, not
# the toolchain. curl retries any failed download, a 404 included, for up to
# ten minutes. <dest dir> must not exist.
#
# The SHA-256 is checked before anything is unpacked; a tarball that fails it
# is deleted. `sha256sum` where there is one, `shasum -a 256` (macOS)
# otherwise. Unpacking needs `zstd`.
#
# Exit: 0 with <dest dir>/bin/lean and <dest dir>/bin/leanc in place; 1 when
# the tarball fails its SHA-256, cannot be downloaded or cannot be unpacked;
# 2 for a usage error, before anything is downloaded.
#
# Tests: scripts/tests/install-lean.cli.test.ts.
set -euo pipefail

usage() {
  echo "usage: LEAN_VERSION=<n.n.n> LEAN_TARGET=<os-arch> LEAN_SHA256=<hex> install-lean.sh <dest dir>" >&2
  exit 2
}

[ $# -eq 1 ] || usage
version=${LEAN_VERSION:-}
want=${LEAN_SHA256:-}
dest=$1
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
[[ $want =~ ^[0-9a-f]{64}$ ]] || usage
case ${LEAN_TARGET:-} in
  linux-x64) build=linux ;;
  linux-arm64) build=linux_aarch64 ;;
  darwin-x64) build=darwin ;;
  darwin-arm64) build=darwin_aarch64 ;;
  *) usage ;;
esac
if [ -e "$dest" ]; then
  echo "install-lean: $dest already exists" >&2
  usage
fi

name="lean-${version}-${build}"
file="$name.tar.zst"

fail() {
  echo "::error::install-lean: $1"
  exit 1
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tarball="$work/$file"

if ! curl --proto '=https' --tlsv1.2 -fsSL --retry 5 --retry-all-errors --retry-max-time 600 \
  --connect-timeout 10 --max-time 600 -o "$tarball" \
  "https://github.com/leanprover/lean4/releases/download/v${version}/$file"; then
  fail "could not download $file"
fi

if command -v sha256sum >/dev/null 2>&1; then
  check() { echo "$want  $tarball" | sha256sum -c - >/dev/null; }
else
  check() { echo "$want  $tarball" | shasum -a 256 -c - >/dev/null; }
fi
if ! check; then
  rm -f "$tarball"
  fail "$file does not have the pinned SHA-256, so it was deleted and nothing was unpacked"
fi

mkdir "$work/unpacked"
zstd -dc "$tarball" | tar -xf - -C "$work/unpacked" --exclude="$name/src" \
  || fail "could not unpack $file"
rm -f "$tarball"
for tool in lean leanc; do
  [ -x "$work/unpacked/$name/bin/$tool" ] || fail "$file holds no $name/bin/$tool"
done
mkdir -p "$(dirname "$dest")"
mv "$work/unpacked/$name" "$dest"
echo "install-lean: Lean $version ($build) in $dest/bin"
