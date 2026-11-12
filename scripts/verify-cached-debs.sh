#!/usr/bin/env bash
# Moves into apt's archive only the cached packages whose bytes apt's signed
# index names, so apt never installs one a cache holds unchecked.
#
# usage: verify-cached-debs.sh <cache dir> <archives dir>
#
# Run as root, after `apt-get update`, so it reads the index apt holds then,
# which apt checked against the repository's signature when it fetched it:
# just now, or earlier when the update kept the copy on disk. apt installs, as
# root, a file it finds in its archive under the name it expects; a cache is
# restored from outside the runner, so each file must earn its place. For each
# <cache dir>/*.deb:
#
# - its name must be <name>_<version>_<arch>.deb as apt writes it (`:` in a
#   version is `%3a`), and it must be a regular file — not a symlink, a FIFO
#   or a directory;
# - it is copied into a directory only root can write, and the copy is hashed,
#   so a file changed after the check cannot be the one apt reads;
# - `apt-cache show <name>=<version>` must hold a record with that SHA-256
#   whose architecture is <arch>, or of which <arch> is a variant: apt on an
#   Ubuntu 26.04 runner names a file `_amd64v3.deb` when its record says
#   `Architecture: amd64`;
# - then it is moved into <archives dir>. Any other file is dropped with a
#   ::warning::, and apt downloads that package instead.
#
# Exit: 0 whatever it drops; 2 for a usage error; 1 when it cannot work
# (no staging directory), which fails the attempt it runs in.
#
# Tests: scripts/tests/install-chromium-system-libraries.cli.test.ts.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: verify-cached-debs.sh <cache dir> <archives dir>" >&2
  exit 2
fi
cache=$1
archives=$2

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

# A ::warning:: for a dropped file. The names it prints hold no CR or LF (see
# below); a % is escaped, as GitHub reads one in a workflow command's data as
# the start of an escape.
drop() {
  local message="dropped $1: $2; apt downloads it instead"
  echo "::warning::verify-cached-debs: ${message//%/%25}"
}

# Debian's package name, apt's quoted version, and an architecture.
pattern='^([a-z0-9][a-z0-9+.-]*)_([A-Za-z0-9.+~%-]+)_([a-z0-9-]+)\.deb$'

shopt -s nullglob
found=0
kept=0
for path in "$cache"/*.deb; do
  found=$((found + 1))
  file=${path##*/}
  if ! [[ $file =~ $pattern ]]; then
    # Only characters the pattern allows reach the log, each other one as ?,
    # so a name cannot start a workflow command of its own.
    drop "$(printf '%s' "$file" | tr -c 'A-Za-z0-9._+~%-' '?')" \
      "its name is not <name>_<version>_<arch>.deb"
    continue
  fi
  name=${BASH_REMATCH[1]}
  arch=${BASH_REMATCH[3]}
  version=${BASH_REMATCH[2]//"%3a"/:}
  version=${version//"%3A"/:}
  if [[ $version == *%* ]]; then
    drop "$file" "its version holds an escape apt does not write"
    continue
  fi
  if [ -L "$path" ] || ! [ -f "$path" ]; then
    drop "$file" "not a regular file"
    continue
  fi
  copy="$stage/candidate.deb"
  rm -f "$copy"
  if ! cp "$path" "$copy"; then
    drop "$file" "it could not be copied"
    continue
  fi
  sha=$(sha256sum "$copy" | cut -d' ' -f1)
  # One "<arch> <sha256>" line per record of <name>=<version> in the index.
  records=$(apt-cache show --no-all-versions "$name=$version" 2>/dev/null |
    awk '/^Architecture: /{a=$2} /^SHA256: /{s=$2} /^$/{if(a!=""&&s!="")print a" "s; a=""; s=""} END{if(a!=""&&s!="")print a" "s}') ||
    records=""
  # The architecture <arch> is a variant of, when it is one (amd64v3 of
  # amd64); otherwise <arch> itself. No record names an architecture that a
  # name such as riscv64 would reduce to.
  base=$arch
  if [[ $arch =~ ^(.+)v[0-9]+$ ]]; then base=${BASH_REMATCH[1]}; fi
  if ! grep -qxF -e "$arch $sha" -e "$base $sha" <<<"$records"; then
    drop "$file" "no record of $name=$version ($arch) in apt's index has its SHA-256"
    rm -f "$copy"
    continue
  fi
  chmod 0644 "$copy"
  mv -f "$copy" "$archives/$file"
  kept=$((kept + 1))
done
echo "verify-cached-debs: $kept of $found cached packages match apt's index"
