#!/usr/bin/env bash
# Decide whether a PR must carry a changeset, given its list of changed files on
# stdin (one path per line). Prints "required" or "skip" and exits 0 — unless
# stdin is a terminal, meaning nothing was piped, which exits 1 instead of
# guessing.
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
# scripts/tests/changeset-required.test.sh.
set -euo pipefail

# An interactive run with no redirect leaves stdin attached to a terminal, and
# reading it would just hang or return nothing — indistinguishable, in the
# empty case, from a real "skip" answer. Refuse it outright rather than let a
# misuse print the same word a genuine no-changeset PR gets. A pipe or a file
# redirect always fails `-t 0`, so every real caller — CI's
# `printf '%s\n' "$diff" | bash …` included — is unaffected.
if [ -t 0 ]; then
  echo "error: changeset-required.sh reads the changed-file list on stdin." >&2
  echo "       git diff --name-only origin/main...HEAD | bash scripts/changeset-required.sh" >&2
  exit 1
fi

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
    # The lock for third-party skills — see the `.agents/*` case below. It has
    # to live in THIS block because a path with no `/` never reaches the one
    # below.
    skills-lock.json) return 0 ;;
    *.md) return 0 ;; # top-level README.md, AGENTS.md, CLAUDE.md
    *) return 1 ;;    # any other root file (bun.lock, turbo.json, …)
  esac

  case "$f" in
    # Native clients and the OpenAPI spec: no package.json, no version.
    shared/swift/* | shared/openapi/* | pulse/ios/* | osn/ios/*) return 0 ;;
    # Repo plumbing and prose: never bundled into a package's build output.
    # `.claude/` is agent instructions — slash-commands, skills, settings; it is
    # read by the coding agent, never by a build.
    .github/* | .claude/* | scripts/* | wiki/* | docs/*) return 0 ;;
    # Third-party skills installed by `npx skills add`, pinned by the root
    # `skills-lock.json` above. Agent instructions, like `.claude/*`: read by
    # the coding agent, built into no package. Both entries are live again as
    # of the `webgpu-threejs-tsl` install — drop them together, with the
    # `.github/CODEOWNERS` rules for both paths, if the tree ever goes.
    .agents/*) return 0 ;;
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
