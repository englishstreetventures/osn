#!/usr/bin/env bash
# Proves the repository's Bend law sets and builds the models their agreement
# tests import, with the Bend release pinned in bend.env.
#
# A law set is a directory `<workspace>/laws/<topic>/` holding a `LAWS.bend`
# and the `PROOF.bend` that proves it, beside the code it is about; one that
# has a `model.bend` also commits the `model.mjs` it compiles to. `sets` lists
# every set the index holds at that path (`git add` a new one).
#
#   bend.sh sets                 the law sets, one directory a line
#   bend.sh prove [set]          bend PROOF.bend: every law of the set proved
#   bend.sh build                bend model.bend -o model.mjs in every set that
#                                has one (all of them, since one set's model may
#                                compile another's module)
#   bend.sh check [set]          prove, then build each model to a scratch file
#                                and fail unless it is byte for byte the
#                                committed model.mjs (CI's gate)
#   bend.sh guide [topic]        bend guide: how to write Bend 2
#   bend.sh install              install the pinned Bend into ${BEND_HOME:-~/.bend}
#   bend.sh hook                 the pre-commit step: with no pinned Bend here,
#                                one line and exit 0 (CI is the gate); else check
#                                every set, rebuilding each model.mjs, and fail
#                                when one differs from the staged copy
#
# With no set named, prove and check run every set; a set is named by its
# directory, relative to the repository root.
#
# Run Bend only through this script. It sets BEND_NO_TELEMETRY=1, without
# which bend asks bend-lang.com for the latest version once a day, and it runs
# a bend only when the binary's SHA-256 is the one bend.env pins for this
# platform, so a bend another installer or `bend update` replaced is refused.
# bend is looked for in ${BEND_HOME:-$HOME/.bend}/bin, then on the PATH.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
export BEND_NO_TELEMETRY=1

# A value from bend.env, which is read as data and never run, so no line in it
# can change this script's environment.
pin() {
  local line value=""
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in "$1="*) value=${line#"$1="} ;; esac
  done <"$here/bend.env"
  echo "$value"
}

BEND_VERSION=$(pin BEND_VERSION)
if [[ ! $BEND_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "tools/bend/bend.env pins no BEND_VERSION=<major>.<minor>.<patch>" >&2
  exit 1
fi

target() {
  local os arch
  case $(uname -s) in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) echo "Bend runs on Linux and macOS, not $(uname -s)" >&2; return 1 ;;
  esac
  case $(uname -m) in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) echo "Bend runs on arm64 and x64, not $(uname -m)" >&2; return 1 ;;
  esac
  echo "$os-$arch"
}

# The value of bend.env's `<prefix>_<TARGET>` for this machine.
pinned() {
  pin "$1_$(target | tr 'a-z-' 'A-Z_')"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

find_bend() {
  if [ -x "${BEND_HOME:-$HOME/.bend}/bin/bend" ]; then
    echo "${BEND_HOME:-$HOME/.bend}/bin/bend"
  elif command -v bend >/dev/null 2>&1; then
    command -v bend
  fi
}

# The pinned bend, or a reason this machine does not have it.
pinned_bend() {
  local bend got want
  bend=$(find_bend)
  if [ -z "$bend" ]; then
    echo "bend is not installed: bash tools/bend/bend.sh install" >&2
    return 1
  fi
  want=$(pinned BEND_BIN_SHA256)
  got=$(sha256 "$bend")
  if [ -z "$want" ] || [ "$got" != "$want" ]; then
    echo "bend at $bend is not the pinned Bend $BEND_VERSION build (its SHA-256 is $got): bash tools/bend/bend.sh install" >&2
    return 1
  fi
  got=$("$bend" version 2>/dev/null || true)
  if [[ ! $got =~ ^bend\ ${BEND_VERSION//./\\.}([^0-9.]|$) ]]; then
    echo "bend at $bend is '${got:-unknown}', not the pinned $BEND_VERSION: bash tools/bend/bend.sh install" >&2
    return 1
  fi
  echo "$bend"
}

# A law set's folders use these characters only, so a set name never needs
# quoting: git prints it as it is, and a list of sets splits on whitespace.
SAFE_SET='^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/laws/[A-Za-z0-9._-]+$'

# Every law set: a `PROOF.bend` in a topic folder of a `laws/` directory that
# sits directly in a workspace (`<top>/<package>/laws/<topic>/`), as the index
# holds it (so a staged new set counts and an untracked one does not), and
# still on disk. A set named with any other character fails, never drops out.
all_sets() {
  local proof set
  git -C "$root" ls-files -z --cached -- '*/laws/*/PROOF.bend' \
    | while IFS= read -r -d '' proof; do
        set=${proof%/PROOF.bend}
        if [[ ! $proof =~ ^[^/]+/[^/]+/laws/[^/]+/PROOF\.bend$ ]]; then continue; fi
        if [[ ! $set =~ $SAFE_SET ]]; then
          echo "law set '$set': name its folders with A-Z, a-z, 0-9, '.', '_' and '-' only" >&2
          exit 1
        fi
        if [ -f "$root/$proof" ]; then echo "$set"; fi
      done \
    | sort -u
}

# The sets a command runs: the one named, or all of them.
sets_for() {
  if [ -n "${1:-}" ]; then
    local set=${1%/}
    if [[ ! $set =~ $SAFE_SET ]] || [ ! -f "$root/$set/PROOF.bend" ]; then
      echo "no law set at $set: it needs a PROOF.bend (bash tools/bend/bend.sh sets lists them)" >&2
      return 1
    fi
    echo "$set"
  else
    local found
    found=$(all_sets) || return 1
    if [ -z "$found" ]; then
      echo "no law set found: none of the index's */laws/*/PROOF.bend is <workspace>/laws/<topic>/PROOF.bend" >&2
      return 1
    fi
    echo "$found"
  fi
}

prove() {
  local bend=$1 set=$2
  echo "== $set"
  if ! grep -qE '^import \./LAWS\.bend as ' "$root/$set/PROOF.bend"; then
    echo "$set/PROOF.bend does not import ./LAWS.bend, so it proves no law of the set" >&2
    return 1
  fi
  local out status=0
  out=$(cd "$root/$set" && "$bend" PROOF.bend 2>&1) || status=$?
  echo "$out"
  if [ "$status" -ne 0 ]; then return "$status"; fi
  # The verdict is the text as well as the exit status, so a bend that prints
  # a failure and exits 0 does not pass.
  if [[ $out != *"ALL PROOFS CHECK"* || $out == *"SOME PROOFS FAIL"* ]]; then
    echo "$set: bend exited 0 but did not print ALL PROOFS CHECK" >&2
    return 1
  fi
}

build_to() {
  local bend=$1 set=$2 out=$3
  (cd "$root/$set" && "$bend" model.bend -o "$out" >/dev/null)
}

case ${1:-} in
  sets)
    all_sets
    ;;
  prove)
    bend=$(pinned_bend)
    list=$(sets_for "${2:-}")
    for set in $list; do prove "$bend" "$set"; done
    ;;
  build)
    bend=$(pinned_bend)
    list=$(sets_for)
    for set in $list; do
      [ -f "$root/$set/model.bend" ] || continue
      build_to "$bend" "$set" "$root/$set/model.mjs"
      echo "built $set/model.mjs"
    done
    ;;
  check)
    bend=$(pinned_bend)
    scratch=$(mktemp -d)
    trap 'rm -rf "$scratch"' EXIT
    failed=0
    list=$(sets_for "${2:-}")
    for set in $list; do
      prove "$bend" "$set"
      [ -f "$root/$set/model.bend" ] || continue
      build_to "$bend" "$set" "$scratch/model.mjs"
      if ! cmp -s "$scratch/model.mjs" "$root/$set/model.mjs"; then
        diff -u "$root/$set/model.mjs" "$scratch/model.mjs" | head -40 || true
        echo "::error::$set/model.mjs is not what $set/model.bend builds: run bun run --cwd tools/bend build and commit it" >&2
        failed=1
        continue
      fi
      echo "$set/model.mjs matches model.bend"
    done
    exit "$failed"
    ;;
  guide)
    bend=$(pinned_bend)
    shift
    "$bend" guide "$@"
    ;;
  install)
    home=${BEND_HOME:-$HOME/.bend}
    BEND_TARGET=$(target) BEND_SHA256=$(pinned BEND_SHA256) BEND_VERSION=$BEND_VERSION \
      bash "$here/install-bend.sh" "$home/cache" "$home"
    echo "run Bend through bash tools/bend/bend.sh, which keeps its version ping off"
    ;;
  hook)
    if ! bend=$(pinned_bend 2>/dev/null); then
      echo "bend-proofs: skipped, this machine has no pinned Bend $BEND_VERSION (CI runs the proofs; to run them here: bash tools/bend/bend.sh install)"
      exit 0
    fi
    stale=""
    list=$(sets_for)
    for set in $list; do
      prove "$bend" "$set"
      [ -f "$root/$set/model.bend" ] || continue
      build_to "$bend" "$set" "$root/$set/model.mjs"
      if ! git -C "$root" diff --quiet -- "$set/model.mjs"; then stale="$stale $set/model.mjs"; fi
    done
    if [ -n "$stale" ]; then
      echo "bend-proofs: rebuilt from model.bend:$stale: stage it and commit again" >&2
      exit 1
    fi
    ;;
  *)
    echo "usage: bend.sh sets | prove [set] | build | check [set] | guide [topic] | install | hook" >&2
    exit 2
    ;;
esac
