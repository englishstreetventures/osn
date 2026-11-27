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
#   bend.sh prove [set]          bend PROOF.bend: every law of the set proved;
#                                then the verdict, where this machine can run it
#   bend.sh build                bend model.bend -o model.mjs in every set that
#                                has one (all of them, since one set's model may
#                                compile another's module)
#   bend.sh check [set]          prove, then build each model to a scratch file
#                                and fail unless it is byte for byte the
#                                committed model.mjs (CI's gate)
#   bend.sh verdict [set]        bend PROOF.bend --verdict: every set rechecked
#                                by the BendTT kernel; fails with no kernel here
#                                (CI's gate, after check)
#   bend.sh fetch <dir>          CI's kernel from this repository's release for
#                                the pins, into <dir>/bendtt, only with the
#                                SHA-256 lean.env pins; exit 3 when none is
#                                published, so the caller builds it. Prints its
#                                path
#   bend.sh asset                the release tag and asset name fetch reads
#   bend.sh kernel <dir>         CI's kernel: <dir>/bendtt, or one bend builds
#                                with the pinned Lean and copies there; either
#                                way only with the SHA-256 lean.env pins. Prints
#                                its path. <dir> is absolute for both
#   bend.sh guide [topic]        bend guide: how to write Bend 2
#   bend.sh install              install the pinned Bend into ${BEND_HOME:-~/.bend}
#   bend.sh hook                 the pre-commit step: with no pinned Bend here,
#                                one line and exit 0 (CI is the gate); else check
#                                every set, rebuilding each model.mjs, and fail
#                                when one differs from the staged copy. It never
#                                runs the verdict
#
# With no set named, prove, check and verdict run every set; a set is named by
# its directory, relative to the repository root.
#
# The verdict. `bend PROOF.bend` is Bend's own checker, which has no proof of
# its own; `--verdict` rechecks the set with BendTT, a small kernel with a
# proof in Lean, which bend builds from its release's bend2/bendtt.lean with
# Lean LEAN_VERSION (lean.env) the first time, and keeps under
# ~/.bend/bendtt/. A machine can run it with $BENDTT naming a built kernel, or
# with that Lean where bend looks for it: elan's toolchain for the version,
# else `lean` on the PATH. `prove` and `check` run it after each plain run on
# such a machine, and say once that they skipped it on any other, or when the
# kernel does not build or run here; a kernel built here is not checked
# against a pin. `verdict` fails on all of these: CI is where it must run.
#
# Run Bend only through this script. It sets BEND_NO_TELEMETRY=1, without
# which bend asks bend-lang.com for the latest version once a day, and it runs
# a bend only when the binary's SHA-256 is the one bend.env pins for this
# platform, so a bend another installer or `bend update` replaced is refused.
# bend is looked for in ${BEND_HOME:-$HOME/.bend}/bin, then on the PATH.
#
# Tests: scripts/tests/bend-sh.cli.test.ts.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
export BEND_NO_TELEMETRY=1

# A value from a pin file here (bend.env, lean.env), which is read as data and
# never run, so no line in it can change this script's environment.
pin_in() {
  local line value=""
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in "$2="*) value=${line#"$2="} ;; esac
  done <"$here/$1"
  echo "$value"
}

pin() {
  pin_in bend.env "$1"
}

BEND_VERSION=$(pin BEND_VERSION)
if [[ ! $BEND_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "tools/bend/bend.env pins no BEND_VERSION=<major>.<minor>.<patch>" >&2
  exit 1
fi
LEAN_VERSION=$(pin_in lean.env LEAN_VERSION)
if [[ ! $LEAN_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "tools/bend/lean.env pins no LEAN_VERSION=<major>.<minor>.<patch>" >&2
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

# The SHA-256 lean.env pins for the BendTT kernel built on this platform, or
# nothing where it pins none.
kernel_pin() {
  pin_in lean.env "BENDTT_SHA256_$(target | tr 'a-z-' 'A-Z_')"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# The release that holds CI's BendTT kernel. One tag per Bend and Lean
# version; one asset per platform and per set of the three pins the kernel is
# built from and checked against (this platform's Bend tarball, Lean tarball
# and kernel), so a change to any pin names an asset nobody has published and
# CI builds and checks the kernel instead. .github/workflows/bendtt-release.yml
# publishes it; it never replaces an asset, though a repository writer could:
# the pinned SHA-256 is what guards the bytes.
RELEASES=https://github.com/englishstreetventures/osn/releases/download

kernel_tag() {
  echo "bendtt-$BEND_VERSION-lean$LEAN_VERSION"
}

# The asset's name for kernel pin $1 on this platform.
kernel_asset() {
  local platform key
  platform=$(target)
  key=$(printf '%s\n%s\n%s\n' "$(pinned BEND_SHA256)" \
    "$(pin_in lean.env "LEAN_SHA256_$(echo "$platform" | tr 'a-z-' 'A-Z_')")" "$1" \
    | sha256 /dev/stdin)
  echo "bendtt-$platform-${key:0:16}"
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

# Why `lean` on the PATH cannot build the kernel, or nothing when it can: it
# must report LEAN_VERSION, as bend checks before it builds.
path_lean_gap() {
  local got
  if ! command -v lean >/dev/null 2>&1; then
    echo "no lean on the PATH"
    return
  fi
  got=$(lean --version 2>/dev/null | sed -n 's/^Lean (version \([^,) ]*\).*/\1/p' | head -n 1 || true)
  if [ "$got" != "$LEAN_VERSION" ]; then
    echo "the lean on the PATH is ${got:-of no version it reports}, not $LEAN_VERSION"
  fi
}

# Why this machine cannot run the verdict, or nothing when it can: $BENDTT,
# or Lean LEAN_VERSION where bend looks for it.
kernel_gap() {
  local gap
  if [ -n "${BENDTT:-}" ]; then return; fi
  if [ -x "$HOME/.elan/toolchains/leanprover--lean4---v$LEAN_VERSION/bin/lean" ]; then return; fi
  gap=$(path_lean_gap)
  if [ -n "$gap" ]; then
    echo "$gap, no elan toolchain for Lean $LEAN_VERSION, and no \$BENDTT"
  fi
}

# What is wrong with $BENDTT, or nothing. Unset is no kernel named; set, it
# must be an absolute path (bend runs it from each set's directory, and looks
# a bare name up on the PATH) to a file that runs and, where lean.env pins a
# kernel for this platform, has that SHA-256. In CI ($GITHUB_ACTIONS) a
# platform with no pin is refused too. Set but empty is a step that failed to
# provide the kernel, never "no kernel".
bendtt_gap() {
  local want got
  if [ -z "${BENDTT+set}" ]; then return; fi
  if [[ $BENDTT != /* ]] || [ ! -f "$BENDTT" ] || [ ! -x "$BENDTT" ]; then
    echo "\$BENDTT is '$BENDTT', which is not the absolute path of a kernel that can run"
    return
  fi
  want=$(kernel_pin)
  if [ -z "$want" ]; then
    if [ "${GITHUB_ACTIONS:-}" = true ]; then
      echo "\$BENDTT ($BENDTT) cannot be checked: tools/bend/lean.env pins no kernel for $(target), and CI runs only a pinned one"
    fi
    return
  fi
  got=$(sha256 "$BENDTT")
  if [ "$got" != "$want" ]; then
    echo "\$BENDTT ($BENDTT) has SHA-256 $got, not the $want tools/bend/lean.env pins"
  fi
}

# bend PROOF.bend --verdict in one set, printing what bend said. Only
# `ALL PROOFS CHECK` alone passes: a pass from Bend's own checker adds a hint
# to use --verdict, so a run that printed it never reached the kernel.
# Returns 0 on a pass, 2 when the kernel did not build or run (`BendTT
# infrastructure`), 1 on anything else.
verdict_of() {
  local bend=$1 set=$2 out status=0
  echo "== $set --verdict"
  out=$(cd "$root/$set" && "$bend" PROOF.bend --verdict 2>&1) || status=$?
  echo "$out"
  if [ "$status" -eq 0 ] && [ "$out" = "ALL PROOFS CHECK" ]; then return 0; fi
  if [[ $out == *"BendTT infrastructure"* && $out != *"SOME PROOFS FAIL"* ]]; then return 2; fi
  return 1
}

# `prove` and `check` run the verdict after each plain run where this machine
# can (`auto=run`), and say once when they do not.
auto=""
auto_start() {
  local gap
  gap=$(kernel_gap)
  if [ -z "$gap" ]; then
    auto=run
  else
    echo "bend.sh: --verdict skipped: $gap (CI runs it: bash tools/bend/bend.sh verdict)"
  fi
}

auto_verdict() {
  local status=0
  if [ "$auto" != run ]; then return 0; fi
  verdict_of "$1" "$2" || status=$?
  case $status in
    0) ;;
    2)
      auto=""
      echo "bend.sh: --verdict skipped: the BendTT kernel did not build or run here, as bend says above (CI runs it: bash tools/bend/bend.sh verdict)"
      ;;
    *)
      echo "$2: bend PROOF.bend --verdict did not print ALL PROOFS CHECK alone" >&2
      return 1
      ;;
  esac
}

case ${1:-} in
  sets)
    all_sets
    ;;
  prove)
    bend=$(pinned_bend)
    list=$(sets_for "${2:-}")
    auto_start
    for set in $list; do
      prove "$bend" "$set"
      auto_verdict "$bend" "$set"
    done
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
    auto_start
    for set in $list; do
      prove "$bend" "$set"
      auto_verdict "$bend" "$set"
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
  verdict)
    # Every check that needs no bend comes first, so a machine that cannot
    # run the verdict runs nothing.
    gap=$(bendtt_gap)
    if [ -n "$gap" ]; then
      echo "::error::bend.sh verdict: $gap" >&2
      exit 1
    fi
    gap=$(kernel_gap)
    if [ -n "$gap" ]; then
      echo "::error::bend.sh verdict: no BendTT kernel here: $gap" >&2
      exit 1
    fi
    bend=$(pinned_bend)
    list=$(sets_for "${2:-}")
    failed=""
    for set in $list; do
      if ! verdict_of "$bend" "$set"; then
        echo "::error::$set: bend PROOF.bend --verdict did not print ALL PROOFS CHECK alone" >&2
        failed="$failed $set"
      fi
    done
    if [ -n "$failed" ]; then
      echo "bend.sh verdict: the BendTT kernel did not accept:$failed" >&2
      exit 1
    fi
    ;;
  fetch)
    # CI's BendTT kernel from this repository's release for the pins: exit 0
    # with <dir>/bendtt in place and its path printed only when its SHA-256 is
    # the pinned one; 3 when nothing is pinned for this platform or nothing
    # is published under these pins (the caller builds it); 1 for a kernel
    # with other bytes or any failed download; 2 for a usage error.
    if [ $# -ne 2 ] || [[ $2 != /* ]]; then
      echo "usage: bend.sh fetch <absolute dir>" >&2
      exit 2
    fi
    dir=${2%/}
    kernel="$dir/bendtt"
    platform=$(target)
    want=$(kernel_pin)
    if [ -z "$want" ]; then
      echo "bend.sh fetch: tools/bend/lean.env pins no kernel for $platform, so there is none to fetch" >&2
      exit 3
    fi
    url="$RELEASES/$(kernel_tag)/$(kernel_asset "$want")"
    mkdir -p "$dir"
    rm -f "$kernel.part"
    status=0
    code=$(curl --proto '=https' --tlsv1.2 -sSL --retry 5 --retry-connrefused --retry-max-time 120 \
      --connect-timeout 10 --max-time 120 -o "$kernel.part" -w '%{http_code}' "$url") || status=$?
    if [ "$status" -ne 0 ]; then
      rm -f "$kernel.part"
      echo "::error::bend.sh fetch: could not download $url (curl exit $status)" >&2
      exit 1
    fi
    case $code in
      200) ;;
      404)
        rm -f "$kernel.part"
        echo "bend.sh fetch: no kernel is published at $url; build it (bash tools/bend/bend.sh kernel), and once these pins are on main dispatch .github/workflows/bendtt-release.yml" >&2
        exit 3
        ;;
      *)
        rm -f "$kernel.part"
        echo "::error::bend.sh fetch: $url answered HTTP $code" >&2
        exit 1
        ;;
    esac
    got=$(sha256 "$kernel.part")
    if [ "$got" != "$want" ]; then
      rm -f "$kernel.part"
      echo "::error::bend.sh fetch: $url has SHA-256 $got, not the $want tools/bend/lean.env pins, so nothing was kept" >&2
      exit 1
    fi
    chmod 755 "$kernel.part"
    mv "$kernel.part" "$kernel"
    echo "bend.sh fetch: $url, SHA-256 $got as pinned" >&2
    echo "$kernel"
    ;;
  asset)
    # The release tag and asset name `fetch` reads, for the publisher.
    want=$(kernel_pin)
    if [ -z "$want" ]; then
      echo "bend.sh asset: tools/bend/lean.env pins no kernel for $(target)" >&2
      exit 1
    fi
    echo "$(kernel_tag) $(kernel_asset "$want")"
    ;;
  kernel)
    # Its path becomes $BENDTT, which `verdict` takes only when absolute.
    if [ $# -ne 2 ] || [[ $2 != /* ]]; then
      echo "usage: bend.sh kernel <absolute dir>" >&2
      exit 2
    fi
    dir=${2%/}
    kernel="$dir/bendtt"
    want=$(kernel_pin)
    pin_name="BENDTT_SHA256_$(target | tr 'a-z-' 'A-Z_')"
    if [ -f "$kernel" ]; then
      got=$(sha256 "$kernel")
      if [ -z "$want" ] || [ "$got" != "$want" ]; then
        rm -f "$kernel"
        echo "::error::bend.sh kernel: $kernel has SHA-256 $got, not the ${want:-(none)} tools/bend/lean.env pins as $pin_name, so it was deleted" >&2
        exit 1
      fi
      echo "$kernel"
      exit 0
    fi
    gap=$(path_lean_gap)
    if [ -n "$gap" ]; then
      echo "::error::bend.sh kernel: no kernel in $dir, and none can be built here: $gap (it needs Lean $LEAN_VERSION's own lean on the PATH)" >&2
      exit 1
    fi
    bend=$(pinned_bend)
    build=$(mktemp -d)
    trap 'rm -rf "$build"' EXIT
    mkdir "$build/home"
    printf 'import Base\n' >"$build/kernel.bend"
    # bend builds the kernel the first time a --verdict needs one. A scratch
    # HOME makes the one it builds the only kernel there, and hides elan's
    # toolchains from it, so it builds with the lean on the PATH; with BENDTT
    # unset it builds rather than run another. What bend then says about a
    # book with no defs of its own is not the result: the kernel file is.
    (cd "$build" && env -u BENDTT HOME="$build/home" "$bend" kernel.bend --verdict) >&2 || true
    shopt -s nullglob
    built=("$build/home/.bend/bendtt/"*/bendtt)
    shopt -u nullglob
    if [ "${#built[@]}" -ne 1 ] || [ ! -f "${built[0]}" ]; then
      echo "::error::bend.sh kernel: bend built no BendTT kernel; what it said is above" >&2
      exit 1
    fi
    got=$(sha256 "${built[0]}")
    if [ -z "$want" ] || [ "$got" != "$want" ]; then
      echo "::error::bend.sh kernel: the kernel bend built has SHA-256 $got, not the ${want:-(none)} tools/bend/lean.env pins as $pin_name. Pin $pin_name=$got only when this run built it from the Bend and Lean the two pin files name." >&2
      exit 1
    fi
    mkdir -p "$dir"
    cp "${built[0]}" "$kernel.part"
    chmod 755 "$kernel.part"
    mv "$kernel.part" "$kernel"
    echo "$kernel"
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
    echo "usage: bend.sh sets | prove [set] | build | check [set] | verdict [set] | fetch <dir> | asset | kernel <dir> | guide [topic] | install | hook" >&2
    exit 2
    ;;
esac
