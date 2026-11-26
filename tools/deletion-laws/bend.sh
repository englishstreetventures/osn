#!/usr/bin/env bash
# Runs the account-deletion proofs and builds the model the agreement tests
# import, with the Bend release pinned in bend.env.
#
#   bend.sh prove          bend PROOF.bend: every law in LAWS.bend proved
#   bend.sh build          bend model.bend -o model.mjs
#   bend.sh check          prove, then build to a scratch file and fail unless
#                          it is byte for byte the committed model.mjs (CI's gate)
#   bend.sh guide [topic]  bend guide: how to write Bend 2
#   bend.sh install        install the pinned Bend into ${BEND_HOME:-~/.bend}
#   bend.sh hook           the pre-commit step: with no pinned Bend here, one
#                          line and exit 0 (CI is the gate); else prove, rebuild
#                          model.mjs, and fail when it differs from the staged copy
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
# shellcheck source=/dev/null
. "$here/bend.env"

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
  local key
  key="$1_$(target | tr 'a-z-' 'A-Z_')"
  echo "${!key:-}"
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
    echo "bend is not installed: bash tools/deletion-laws/bend.sh install" >&2
    return 1
  fi
  want=$(pinned BEND_BIN_SHA256)
  got=$(sha256 "$bend")
  if [ -z "$want" ] || [ "$got" != "$want" ]; then
    echo "bend at $bend is not the pinned Bend $BEND_VERSION build (its SHA-256 is $got): bash tools/deletion-laws/bend.sh install" >&2
    return 1
  fi
  got=$("$bend" version 2>/dev/null || true)
  if [[ ! $got =~ ^bend\ ${BEND_VERSION//./\\.}([^0-9.]|$) ]]; then
    echo "bend at $bend is '${got:-unknown}', not the pinned $BEND_VERSION: bash tools/deletion-laws/bend.sh install" >&2
    return 1
  fi
  echo "$bend"
}

prove() {
  local bend=$1
  (cd "$here" && "$bend" PROOF.bend)
}

build_to() {
  local bend=$1 out=$2
  (cd "$here" && "$bend" model.bend -o "$out" >/dev/null)
}

case ${1:-} in
  prove)
    bend=$(pinned_bend)
    prove "$bend"
    ;;
  build)
    bend=$(pinned_bend)
    build_to "$bend" "$here/model.mjs"
    echo "built tools/deletion-laws/model.mjs"
    ;;
  check)
    bend=$(pinned_bend)
    prove "$bend"
    scratch=$(mktemp -d)
    trap 'rm -rf "$scratch"' EXIT
    build_to "$bend" "$scratch/model.mjs"
    if ! cmp -s "$scratch/model.mjs" "$here/model.mjs"; then
      diff -u "$here/model.mjs" "$scratch/model.mjs" | head -40 || true
      echo "::error::tools/deletion-laws/model.mjs is not what model.bend builds: run bun run --cwd tools/deletion-laws build and commit it" >&2
      exit 1
    fi
    echo "model.mjs matches model.bend"
    ;;
  guide)
    bend=$(pinned_bend)
    shift
    "$bend" guide "$@"
    ;;
  install)
    home=${BEND_HOME:-$HOME/.bend}
    BEND_TARGET=$(target) BEND_SHA256=$(pinned BEND_SHA256) BEND_VERSION=$BEND_VERSION \
      bash "$root/scripts/install-bend.sh" "$home/cache" "$home"
    echo "run Bend through bash tools/deletion-laws/bend.sh, which keeps its version ping off"
    ;;
  hook)
    if ! bend=$(pinned_bend 2>/dev/null); then
      echo "bend-proofs: skipped, this machine has no pinned Bend $BEND_VERSION (CI runs the proofs; to run them here: bash tools/deletion-laws/bend.sh install)"
      exit 0
    fi
    prove "$bend"
    build_to "$bend" "$here/model.mjs"
    if ! git -C "$root" diff --quiet -- tools/deletion-laws/model.mjs; then
      echo "bend-proofs: model.mjs was rebuilt from model.bend: stage tools/deletion-laws/model.mjs and commit again" >&2
      exit 1
    fi
    ;;
  *)
    echo "usage: bend.sh prove | build | check | guide [topic] | install | hook" >&2
    exit 2
    ;;
esac
