#!/usr/bin/env bash
# Decide whether a PR must carry a changeset, given its list of changed files on
# stdin (one path per line). Prints "required" or "skip"; always exits 0.
#
# Why this exists: some PRs touch nothing that any versioned package ships —
# Swift/Xcode scaffolding, CI workflows, wiki pages. Forcing a changeset there
# means naming an unrelated package and writing a false changelog entry.
#
# The test is an ALLOWLIST, deliberately. Skip only when every changed path is
# known not to version anything; anything else requires a changeset. The
# opposite shape (skip unless some known-versioned path was touched) leaks:
# `bun.lock`, root `tsconfig.json`, `turbo.json` and `bunfig.toml` all change
# what deployed packages build from while living outside every workspace
# directory, so a denylist waves a `bun update` through with no changelog.
#
# Invoked by .github/workflows/changeset-check.yml. Tests in
# scripts/changeset-required.test.sh.
set -euo pipefail

# True when this one path ships inside no versioned package.
is_allowed() {
  local f="$1"

  # A `*` glob matches across `/`, so `scripts/*` would also match
  # `scripts/../osn/api/routes.ts` — a path that names a file the allowlist
  # does not cover. `git diff --name-only` cannot emit such a path (git rejects
  # `..` components, and a symlink is reported under its resolved path), so this
  # is unreachable from the one caller. Guard anyway: the point of a gate is not
  # having to re-derive who feeds it.
  case "$f" in
    /* | ../* | */../* | */.. | ./* | */./* | */.) return 1 ;;
  esac

  case "$f" in
    */*) ;; # has a directory component — checked below
    .gitignore) return 0 ;;
    *.md) return 0 ;; # top-level README.md, CLAUDE.md
    *) return 1 ;;    # any other root file (bun.lock, turbo.json, …)
  esac

  case "$f" in
    # Native clients and the OpenAPI spec: no package.json, no version.
    shared/swift/* | shared/openapi/* | pulse/ios/* | osn/ios/*) return 0 ;;
    # Repo plumbing and prose: never bundled into a package's build output.
    # `.claude/` is agent instructions — slash-commands, skills, settings; it is
    # read by the coding agent, never by a build.
    .github/* | .claude/* | scripts/* | wiki/* | docs/*) return 0 ;;
    # RETIRED PATHS — both were prose that shipped in no package, and both
    # were removed on 2026-08-21: `cire/wiki/` folded into `wiki/`, and
    # `cire/CLAUDE.md` became `wiki/apps/cire-development.md` when the repo
    # settled on exactly one CLAUDE.md at the root. Neither path exists now,
    # so these two cases can only ever match that PR's own deletions.
    # DROP BOTH once it has merged.
    cire/wiki/* | cire/CLAUDE.md) return 0 ;;
  esac

  return 1
}

verdict=skip
while IFS= read -r f || [ -n "$f" ]; do
  [ -n "$f" ] || continue
  if ! is_allowed "$f"; then
    verdict=required
    break
  fi
done

echo "$verdict"
