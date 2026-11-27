#!/usr/bin/env bash
# Unpacks Bend release BEND_VERSION for BEND_TARGET into <dest dir>, from the
# release tarball whose SHA-256 is BEND_SHA256: bin/bend, bend2/ (the base
# library) and guide/. The pin lives in tools/bend/bend.env; its callers
# (`bend.sh install`, and the `bend-proofs` job in .github/workflows/ci.yml)
# read it and pass it here, which also lets the test give a fixture tarball
# its own SHA-256.
#
# usage: BEND_VERSION=<n.n.n> BEND_TARGET=<os-arch> BEND_SHA256=<hex> install-bend.sh <cache dir> <dest dir>
#
# The tarball comes from <cache dir> when it is there (the workflow restores
# that directory from GitHub's cache) and is downloaded into it otherwise, for
# the workflow to save. curl retries any failed download, a 404 included, for
# up to two minutes.
#
# The SHA-256 is checked on every run, on a cached tarball as on a downloaded
# one, before anything is unpacked: a restored cache is input from outside the
# run, not trust. A tarball that fails the check is deleted. `sha256sum` where
# there is one, `shasum -a 256` (macOS) otherwise.
#
# Exit: 0 with <dest dir>/bin/bend in place; 1 when the tarball fails its
# SHA-256, cannot be downloaded or cannot be unpacked; 2 for a usage error,
# before anything is downloaded.
#
# Tests: scripts/tests/install-bend.cli.test.ts.
set -euo pipefail

usage() {
  echo "usage: BEND_VERSION=<n.n.n> BEND_TARGET=<os-arch> BEND_SHA256=<hex> install-bend.sh <cache dir> <dest dir>" >&2
  exit 2
}

[ $# -eq 2 ] || usage
version=${BEND_VERSION:-}
target=${BEND_TARGET:-}
want=${BEND_SHA256:-}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
[[ $target =~ ^(darwin|linux)-(arm64|x64)$ ]] || usage
[[ $want =~ ^[0-9a-f]{64}$ ]] || usage
cache=$1
dest=$2

file="bend-${version}-${target}.tar.gz"
tarball="$cache/$file"

fail() {
  echo "::error::install-bend: $1"
  exit 1
}

if [ -f "$tarball" ]; then
  echo "install-bend: $file from the cache"
else
  mkdir -p "$cache"
  if ! curl --proto '=https' --tlsv1.2 -fsSL --retry 5 --retry-all-errors --retry-max-time 120 \
    --connect-timeout 10 --max-time 120 -o "$tarball.part" \
    "https://github.com/bendlang/bend/releases/download/v${version}/$file"; then
    rm -f "$tarball.part"
    fail "could not download $file"
  fi
  mv "$tarball.part" "$tarball"
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

unpacked=$(mktemp -d)
trap 'rm -rf "$unpacked"' EXIT
tar -xzf "$tarball" -C "$unpacked" || fail "could not unpack $file"
[ -x "$unpacked/bend/bin/bend" ] || fail "$file holds no bend/bin/bend"
mkdir -p "$dest/bin"
rm -rf "$dest/bend2" "$dest/guide"
mv "$unpacked/bend/bend2" "$unpacked/bend/guide" "$dest/"
mv -f "$unpacked/bend/bin/bend" "$dest/bin/bend"
echo "install-bend: bend $version ($target) in $dest/bin"
