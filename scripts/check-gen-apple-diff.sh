#!/usr/bin/env bash
# Guard: fail if the committed iOS Xcode project has uncommitted changes.
#
# The bug class this guards against: `tauri ios init` regenerates
# `pulse/app/src-tauri/gen/apple/` from scratch. That directory is committed and
# hand-edited — the deployment target, the entitlements, the extra SDK
# dependencies and the Swift sources of the native bridges all live in it — so a
# regen silently throws that work away and leaves a diff that reads like noise.
# Xcode does the same on a smaller scale: it rewrites `project.pbxproj` whenever
# someone adds a file through the IDE instead of through `project.yml`.
#
# Nothing under `gen/apple/` is generated on an ordinary build. Tauri's one
# genuinely generated directory is `pulse/app/src-tauri/gen/schemas`, which sits
# outside `gen/apple/` and is already gitignored, so this check needs no
# exclusions. `gen/apple/.gitignore` covers the build outputs (`build/`,
# `Externals/`, `xcuserdata/`) and `git status` honours it.
#
# Self-contained (git only; no bun, no network) so it runs identically in CI and
# locally. Run it after any local iOS build or Xcode session.
#
# Usage: bash scripts/check-gen-apple-diff.sh
set -euo pipefail

# Resolve to the repo root so the path below holds regardless of CWD. The test
# harness runs this from inside a fixture repo and overrides GEN_APPLE_DIR.
cd "$(git rev-parse --show-toplevel)"
GEN_APPLE_DIR="${GEN_APPLE_DIR:-pulse/app/src-tauri/gen/apple}"

if [[ ! -d "$GEN_APPLE_DIR" ]]; then
  echo "❌ check-gen-apple-diff: $GEN_APPLE_DIR not found" >&2
  exit 1
fi

# Modified-tracked and untracked both count: a regen rewrites the files that are
# there and adds ones that are not.
dirty="$(git status --porcelain -- "$GEN_APPLE_DIR")"

if [[ -n "$dirty" ]]; then
  echo "❌ check-gen-apple-diff: uncommitted changes under $GEN_APPLE_DIR" >&2
  echo "" >&2
  echo "$dirty" >&2
  echo "" >&2
  echo "   That project is committed and hand-edited. If this came from" >&2
  echo "   \`tauri ios init\` — never run it on this repo — throw the regen away:" >&2
  echo "     git checkout -- $GEN_APPLE_DIR" >&2
  echo "     git clean -fd $GEN_APPLE_DIR" >&2
  echo "" >&2
  echo "   If you meant to edit the project, commit the change deliberately and" >&2
  echo "   say in the message what it does." >&2
  exit 1
fi

echo "✅ check-gen-apple-diff: $GEN_APPLE_DIR is clean."
