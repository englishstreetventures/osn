#!/usr/bin/env bash
# Unpacks the gitleaks binary of release GITLEAKS_VERSION into <dest dir>, from
# the release tarball whose SHA-256 is GITLEAKS_SHA256. The secret scan job in
# .github/workflows/ci.yml runs it.
#
# usage: GITLEAKS_VERSION=<n.n.n> GITLEAKS_SHA256=<hex> install-gitleaks.sh <cache dir> <dest dir>
#
# The tarball comes from <cache dir> when it is there (the workflow restores
# that directory from GitHub's cache) and is downloaded into it otherwise,
# for the workflow to save. GitHub's release download has answered 504, so
# curl retries any failed download, a 404 included, for up to two minutes,
# waiting longer each time; a plain --retry would not retry a connection
# reset part way through.
#
# The SHA-256 is checked on every run, on a cached tarball as on a downloaded
# one, before anything is unpacked: a restored cache is input from outside the
# run, not trust. A tarball that fails the check is deleted.
#
# Exit: 0 with <dest dir>/gitleaks in place; 1 when the tarball fails its
# SHA-256, cannot be downloaded or cannot be unpacked; 2 for a usage error,
# before anything is downloaded.
#
# Tests: scripts/tests/install-gitleaks.cli.test.ts.
set -euo pipefail

usage() {
  echo "usage: GITLEAKS_VERSION=<n.n.n> GITLEAKS_SHA256=<hex> install-gitleaks.sh <cache dir> <dest dir>" >&2
  exit 2
}

[ $# -eq 2 ] || usage
version=${GITLEAKS_VERSION:-}
want=${GITLEAKS_SHA256:-}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
[[ $want =~ ^[0-9a-f]{64}$ ]] || usage
cache=$1
dest=$2

file="gitleaks_${version}_linux_x64.tar.gz"
tarball="$cache/$file"

fail() {
  echo "::error::install-gitleaks: $1"
  exit 1
}

if [ -f "$tarball" ]; then
  echo "install-gitleaks: $file from the cache"
else
  mkdir -p "$cache"
  if ! curl -fsSL --retry 5 --retry-all-errors --retry-max-time 120 \
    --connect-timeout 10 --max-time 60 -o "$tarball.part" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${version}/$file"; then
    rm -f "$tarball.part"
    fail "could not download $file"
  fi
  mv "$tarball.part" "$tarball"
fi

if ! echo "$want  $tarball" | sha256sum -c -; then
  rm -f "$tarball"
  fail "$file does not have the pinned SHA-256, so it was deleted and nothing was unpacked"
fi
tar -xzf "$tarball" -C "$dest" gitleaks || fail "could not unpack gitleaks from $file"
