#!/usr/bin/env bash
# Guard the size of an Astro app's deployed bundle.
#
# Tracker #287: cire/invites' SSR Worker bundle reached 470 KB gzip unnoticed,
# from two separate mistakes. Three `.motion.ts` modules dragged the whole
# `motion` library into the SSR module graph though nothing there ever ran it
# (fixed by stubbing `motion` out of the SSR build only, see
# cire/invites/astro.config.mjs); and three drift-guard tests sat un-prefixed
# under `src/pages`, so Astro routed them, deployed them, and pulled 119 KB
# gzip of vitest along with them (fixed by the `_` prefix Astro's router
# excludes). This guard measures the same total again on every build and
# fails the moment it grows past a set point, rather than the growth being
# found from a tracker issue months later.
#
# Tracker #619 generalised it: cire/invites is the only `output: "server"`
# Astro app in the repo (it emits `dist/server`, a Worker, plus `dist/client`,
# its Static Assets). `cire/host`, `cire/landing`, `cire/vendor`, `osn/landing`
# and `pulse/landing` are all `output: "static"` — no Worker, no `dist/server`,
# no `dist/client` split; they deploy `dist` wholesale to Cloudflare Pages. The
# two shapes need different measurements, so this script takes a MODE rather
# than trying to force one glob to fit both:
#
#   worker  — cire/invites. Measures `dist/server`, and separately refuses any
#             `*.map` under the sibling `dist/client`.
#   static  — the other five. Measures `dist/_astro/*.js` and
#             `dist/_astro/*.css` only.
#
# Every app's mode and threshold is a row in scripts/bundle-size-budgets.txt —
# that file, not this script, not a workflow, not a package.json, is the
# single source of truth. A threshold living in one place is the whole point:
# it used to be a `<package-dir> <mode> <threshold>` argument, copied by hand
# into six package.json build scripts, a ci.yml step and eight deploy.yml
# steps — eight to fourteen copies of the same number, silently divergeable by
# missing one on a re-baseline. There is deliberately no way to pass a
# threshold on the command line any more.
#
# Usage:
#   guard-bundle-size.sh <package-dir>   — look up <package-dir>'s own record
#                                           in bundle-size-budgets.txt and run
#                                           it. What every package.json build
#                                           script and every deploy.yml step
#                                           calls.
#   guard-bundle-size.sh --all           — run every record in the budgets
#                                           file. What ci.yml's single step
#                                           calls.
#
# <package-dir> is resolved and `cd`'d into, so it can be a relative path from
# wherever the caller runs (a workflow step's cwd, or `.` from inside the
# package's own `build` script) or an absolute one. It is then matched against
# the budgets file by the LABEL derived from the resolved directory — the last
# two path segments (e.g. "cire/host") — so `.` and `../../cire/host` both key
# off the same row. A package directory with no matching row is an error, not
# a skip: a guard that silently does nothing for an app nobody added is
# exactly the failure mode this family of guards exists to prevent.
#
# BUNDLE_SIZE_BUDGETS_FILE overrides the budgets file path, and
# BUNDLE_SIZE_BUDGETS_ROOT overrides the root `--all` resolves each of its
# package-dir paths against (real usage: the repo root, since a row is a
# repo-relative path; the CLI test points both at a fixture tree instead).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUDGETS_FILE="${BUNDLE_SIZE_BUDGETS_FILE:-$SCRIPT_DIR/bundle-size-budgets.txt}"
BUDGETS_ROOT="${BUNDLE_SIZE_BUDGETS_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

if [ ! -f "$BUDGETS_FILE" ]; then
  echo "::error::guard-bundle-size.sh: budgets file not found: ${BUDGETS_FILE}" >&2
  exit 1
fi

# Populated by parse_record: REC_PKG, REC_MODE, REC_THRESHOLD.
# `read` splits on IFS and does NOT glob. An unquoted array assignment
# (`local fields=($stripped)`) would: bash pathname-expands it against the
# caller's working directory, so a row containing a `*` would silently become
# whatever files happen to sit beside the caller — a guard measuring the wrong
# directory and passing. Fail-closed matters more here than anywhere, because
# a bundle-size guard that passes vacuously is worse than no guard at all.
parse_record() {
  local stripped="${1%%#*}"
  REC_PKG=""
  REC_MODE=""
  REC_THRESHOLD=""
  read -r REC_PKG REC_MODE REC_THRESHOLD _ <<<"$stripped" || true
}

# Fails closed on a malformed row rather than silently mis-parsing it (too few
# fields, an unrecognised mode, a non-numeric threshold) — one bad edit to
# this file should not quietly stop guarding every app after it. Blank lines
# and comment-only lines (`#...`, after stripping any trailing `# measured …`
# annotation first) are the only lines skipped.
validate_budgets_file() {
  local lineno=0 line stripped mode threshold
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    stripped="${line%%#*}"
    [[ "$stripped" =~ ^[[:space:]]*$ ]] && continue
    # `read`, not an unquoted array assignment — see parse_record above for why.
    # `extra` catches a fourth field, which the three-name `read` would
    # otherwise fold into the third.
    local pkg="" extra=""
    read -r pkg mode threshold extra <<<"$stripped" || true
    if [ -z "$pkg" ] || [ -z "$mode" ] || [ -z "$threshold" ] || [ -n "$extra" ]; then
      echo "::error::guard-bundle-size.sh: ${BUDGETS_FILE}:${lineno}: expected '<package-dir> <worker|static> <threshold>', got '${stripped}'" >&2
      return 1
    fi
    if [ "$mode" != "worker" ] && [ "$mode" != "static" ]; then
      echo "::error::guard-bundle-size.sh: ${BUDGETS_FILE}:${lineno}: mode must be 'worker' or 'static', got '${mode}'" >&2
      return 1
    fi
    if ! [[ "$threshold" =~ ^[0-9]+$ ]]; then
      echo "::error::guard-bundle-size.sh: ${BUDGETS_FILE}:${lineno}: threshold must be a positive integer, got '${threshold}'" >&2
      return 1
    fi
  done < "$BUDGETS_FILE"
}

# The last two path segments of the RESOLVED directory — "." and
# "../../cire/host" both label themselves "cire/host" — which is also the key
# a budgets-file row is matched by. Fails if the directory does not exist.
resolve_label() {
  local abs
  abs="$(cd "$1" && pwd)" || return 1
  echo "$(basename "$(dirname "$abs")")/$(basename "$abs")"
}

# Runs the actual measurement for one app, in a subshell so its `cd` and any
# `exit` never escape to affect a sibling record in --all's loop. Args:
# <label for messages> <directory to cd into> <worker|static> <threshold>.
run_guard() {
  local label="$1" pkg_dir="$2" mode="$3" threshold="$4"
  (
    set -euo pipefail
    cd "$pkg_dir"

    # validate_budgets_file already rejects any mode but worker/static before
    # either dispatch path (lookup_and_run, run_all) ever calls run_guard, so
    # this arm cannot fire through the script's own two call sites today.
    # Left in as defence in depth against a future third caller of run_guard
    # that skips validation — the alternative is `measure_dir` staying unset
    # and the next line dying to `set -u` with an unrelated-looking error.
    case "$mode" in
      worker) measure_dir="dist/server" ;;
      static) measure_dir="dist/_astro" ;;
      *)
        echo "::error::guard-bundle-size.sh: unknown mode '${mode}' for ${label} — expected 'worker' or 'static'." >&2
        exit 1
        ;;
    esac

    if [ ! -d "$measure_dir" ]; then
      echo "::error::${label} ${measure_dir} is missing — run \`astro build\` before this guard."
      exit 1
    fi

    # Source maps belong in `dist/server` and NOWHERE ELSE, and only the
    # worker shape has a `dist/client` to check. `dist/client` is that
    # Worker's Static Assets directory (the adapter writes
    # `"assets": { "directory": "../client" }` into the generated wrangler
    # config) and Cloudflare serves every file there verbatim, so a `.map`
    # that lands in it publishes the guest site's unminified source at
    # `/_astro/<chunk>.js.map` to anyone who asks. That is exactly what a
    # plain `vite: { build: { sourcemap: true } }` does, because the client
    # environment reads the top-level value at
    # `astro/dist/core/build/vite-build-config.js:135` — which is why
    # `cire/invites/astro.config.mjs` sets `sourcemap` inside the
    # `astro:build:setup` hook instead. This check is the tripwire for that
    # mistake coming back. The static apps have no `dist/client` at all —
    # their whole `dist` IS the public asset tree — so the check is scoped to
    # `worker` mode rather than trying to run it (harmlessly, but
    # pointlessly) everywhere.
    if [ "$mode" = "worker" ] && [ -d dist/client ]; then
      client_maps=$(find dist/client -type f -name '*.map' | wc -l | tr -d ' ')
      if [ "$client_maps" -ne 0 ]; then
        echo "::error::${label} dist/client holds ${client_maps} source map(s). dist/client is served publicly as Static Assets, so these would publish the guest site's unminified source. Scope \`sourcemap\` to the server build (see the minifySsrBuild() comment in cire/invites/astro.config.mjs)."
        exit 1
      fi
    fi

    total=0
    count=0
    if [ "$mode" = "worker" ]; then
      # `no_bundle: true` (the adapter's generated config) means `wrangler
      # deploy` ships every file in `dist/server` as its own module rather
      # than concatenating them, so the sum of each file's OWN gzip size is
      # what crosses the wire — not the gzip of the directory as a whole.
      # Everything except `wrangler.json` is uploaded, so measure exactly
      # that set: matching on `*.mjs` would coincide with it today and stop
      # matching the moment the adapter emitted a `.js` chunk, which its own
      # generated `rules` already declare as an ES module. `.map` files are
      # excluded too: they're uploaded to Cloudflare for symbolication
      # (`upload_source_maps` in `wrangler.jsonc`), not part of the script
      # the Worker runs, and roughly double the reading if left in.
      while IFS= read -r -d '' f; do
        # `-n` keeps the source filename out of the gzip header. Without it
        # the measured total shifts by tens of bytes whenever a chunk is
        # renamed or its content hash changes, so the same build measures
        # differently for no reason.
        size=$(gzip -nc "$f" | wc -c)
        total=$((total + size))
        count=$((count + 1))
      done < <(find "$measure_dir" -type f ! -name 'wrangler.json' ! -name '*.map' -print0)
    else
      # The static apps have no Worker bundle to measure — `astro build`
      # writes font binaries fetched from Google (hashed names,
      # `dist/_astro/fonts/`) and one HTML file per page into `dist`, and
      # neither belongs in this guard: font bytes move whenever Google's
      # metadata moves, with no repo change, and `dist` grows with ordinary
      # page content regardless of what the JS/CSS ships.
      # `dist/_astro/*.js` and `dist/_astro/*.css` are exactly the part that
      # regresses when a library wanders in, which is what this guard is
      # for — so this is an ALLOWLIST, not an exclusion, and deliberately
      # does not recurse into `dist/_astro/fonts/`.
      #
      # Known blind spot: `build.inlineStylesheets: "auto"` (Astro's default,
      # unset in all five static apps) writes some `<style>`/`<script>` output
      # inline into each page's HTML instead of into `dist/_astro`, and this
      # allowlist cannot see bytes that never reach that directory. Measured
      # on osn/landing: 5 inline style blocks + 4 inline script blocks in
      # `dist/index.html` alone, ~3116 bytes gzip-equivalent — real budget
      # this guard is blind to. Tracker #636 holds the two ways to
      # close it (parse the HTML too, or force `inlineStylesheets: "never"`);
      # this script deliberately does neither on its own.
      while IFS= read -r -d '' f; do
        size=$(gzip -nc "$f" | wc -c)
        total=$((total + size))
        count=$((count + 1))
      done < <(find "$measure_dir" -maxdepth 1 -type f \( -name '*.js' -o -name '*.css' \) -print0)
    fi

    if [ "$count" -eq 0 ]; then
      echo "::error::${label} ${measure_dir} holds no deployable files — the guard measured nothing, which is a broken build, not a pass."
      exit 1
    fi

    echo "${label} ${measure_dir} gzip total: ${total} bytes across ${count} files"

    # Threshold = the measured total plus headroom for ordinary dependency
    # growth (recorded per app in scripts/bundle-size-budgets.txt, alongside
    # the measured reading it was set from).
    #
    # The headroom is deliberately SMALLER than the mistake this guard exists
    # to catch. `motion` costs 21261 bytes gzip in cire/invites' MINIFIED SSR
    # build — measured, not assumed: that is the size of its own
    # already-minified client vendor chunk
    # (`dist/client/_astro/animate.*.js`), and rebuilding with
    # `stubMotionForSsr()` removed moves that app's server total by the same
    # ~21.4 KB. A threshold of "measured plus one whole library" can never
    # trip on one library, which is exactly backwards — cire/invites' own
    # history is the cautionary tale: its old threshold budgeted 47657 bytes,
    # motion's cost back when that build was UNMINIFIED, so a fresh library
    # of exactly that class would have landed under the line and shipped
    # silently.
    #
    # Re-baselining after an intentional change: edit ONLY
    # scripts/bundle-size-budgets.txt — build, read the new total, set the
    # threshold to that total plus headroom well under a library of motion's
    # class, and re-check the gap is still comfortably positive. This does
    # NOT catch a few hundred bytes of ordinary bump, and for the static apps
    # it is nowhere near Cloudflare Pages' limits — it watches the
    # trajectory, it is not a check against a hard cap.
    if [ "$total" -gt "$threshold" ]; then
      echo "::error::${label} ${measure_dir} gzip total ${total} bytes exceeds the ${threshold} byte guard (tracker #287, #619). Something is likely pulling a new dependency into the bundle that does not need to ship — check what is newly reachable from an import that runs in this build, the way motion was for cire/invites."
      exit 1
    fi
  )
}

# guard-bundle-size.sh <package-dir> — one app, looked up by its resolved
# label in the budgets file.
lookup_and_run() {
  local raw="$1" label line
  label="$(resolve_label "$raw")" || {
    echo "::error::guard-bundle-size.sh: package directory '${raw}' does not exist." >&2
    return 1
  }

  while IFS= read -r line || [ -n "$line" ]; do
    local stripped="${line%%#*}"
    [[ "$stripped" =~ ^[[:space:]]*$ ]] && continue
    parse_record "$line"
    [ "$REC_PKG" = "$label" ] || continue
    run_guard "$label" "$raw" "$REC_MODE" "$REC_THRESHOLD"
    return $?
  done < "$BUDGETS_FILE"

  echo "::error::guard-bundle-size.sh: no budget recorded for '${label}' in ${BUDGETS_FILE} — add a row before wiring this app's build/CI/deploy to the guard." >&2
  return 1
}

# guard-bundle-size.sh --all — every record in the budgets file, resolved
# against BUDGETS_ROOT (the repo root, by default) rather than the caller's
# own cwd, since a table row is a repo-relative path by definition. Runs every
# record even after one fails, so a CI run reports every app over budget in
# one pass instead of stopping at the first.
run_all() {
  local line any_fail=0 any_record=0 pkg_dir

  while IFS= read -r line || [ -n "$line" ]; do
    local stripped="${line%%#*}"
    [[ "$stripped" =~ ^[[:space:]]*$ ]] && continue
    parse_record "$line"
    [ -z "$REC_PKG" ] && continue
    any_record=1
    pkg_dir="$BUDGETS_ROOT/$REC_PKG"
    if [ ! -d "$pkg_dir" ]; then
      echo "::error::guard-bundle-size.sh: package directory '${pkg_dir}' does not exist." >&2
      any_fail=1
      continue
    fi
    if ! run_guard "$REC_PKG" "$pkg_dir" "$REC_MODE" "$REC_THRESHOLD"; then
      any_fail=1
    fi
  done < "$BUDGETS_FILE"

  if [ "$any_record" -eq 0 ]; then
    echo "::error::guard-bundle-size.sh: ${BUDGETS_FILE} has no records — nothing to guard, which is a broken config, not a pass." >&2
    return 1
  fi
  return "$any_fail"
}

if [ $# -ne 1 ]; then
  echo "::error::usage: guard-bundle-size.sh <package-dir> | guard-bundle-size.sh --all" >&2
  exit 1
fi

validate_budgets_file

if [ "$1" = "--all" ]; then
  run_all
else
  lookup_and_run "$1"
fi
