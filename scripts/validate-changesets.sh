#!/usr/bin/env bash
# Validate that every package name referenced in any .changeset/*.md frontmatter
# matches a real workspace `name` field. Self-contained (shell + jq only; no
# bun, no @changesets/cli, no network) so it runs identically in CI and locally.
#
# The bug class this guards against: a changeset that names a package which
# doesn't exist in the workspace tree (e.g. "pulse" instead of "@pulse/app")
# passes PR review and then crashes the post-merge Release workflow on `main`,
# blocking all subsequent versioning until someone hand-edits the offending file.
#
# It also guards a second instance of the same class: a "mixed" changeset that
# lists both an ignored package (one with no `version` field — e.g. the
# unversioned @cire/* apps) and a not-ignored, versioned package. Changesets
# forbids this and aborts `changeset version` with "Mixed changesets that
# contain both ignored and not ignored packages are not allowed", again only on
# `main` post-merge. Split such changesets in two (one per side) to fix.
#
# Invoked by .github/workflows/changeset-check.yml; runnable locally from
# anywhere in the repo.
set -euo pipefail

# Resolve to the repo root so the workspace globs below always hold. CHANGESET_ROOT
# overrides the root (used by validate-changesets.test.sh to point at fixtures);
# defaults to the repo root relative to this script.
cd "${CHANGESET_ROOT:-$(dirname "$0")/..}"

# Collect workspace names from every package.json under the five top-level
# domain directories. Skip node_modules.
mapfile -t names < <(
  find cire osn pulse zap shared -name package.json -not -path '*/node_modules/*' 2>/dev/null \
    | xargs -r jq -r '.name // empty' \
    | sort -u
)

# Packages with no `version` field are "ignored" by changesets — they get no
# version bump or changelog. A changeset may not mix these with versioned
# packages (see header). Collect the ignored set so we can flag such mixes.
mapfile -t ignored_names < <(
  find cire osn pulse zap shared -name package.json -not -path '*/node_modules/*' 2>/dev/null \
    | xargs -r jq -r 'select(.name != null and (has("version") | not)) | .name' \
    | sort -u
)

is_ignored() {
  local pkg="$1" n
  for n in "${ignored_names[@]}"; do
    [ "$n" = "$pkg" ] && return 0
  done
  return 1
}

if [ ${#names[@]} -eq 0 ]; then
  echo "❌ Refusing to validate against an empty workspace name set."
  exit 1
fi

echo "Known workspace names:"
printf '  %s\n' "${names[@]}"
echo

bad=0
for f in .changeset/*.md; do
  [ -f "$f" ] || continue
  base="${f##*/}"
  [ "$base" = "README.md" ] && continue

  in_fm=0
  fm_count=0
  saw_ignored=0
  saw_versioned=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = "---" ]; then
      fm_count=$((fm_count + 1))
      if [ $fm_count -eq 1 ]; then
        in_fm=1
        continue
      elif [ $fm_count -eq 2 ]; then
        break
      fi
    fi
    [ $in_fm -ne 1 ] && continue

    # Match `"<package>": (patch|minor|major)`
    if [[ "$line" =~ ^[[:space:]]*\"([^\"]+)\"[[:space:]]*:[[:space:]]*(patch|minor|major)[[:space:]]*$ ]]; then
      pkg="${BASH_REMATCH[1]}"
      found=0
      for n in "${names[@]}"; do
        if [ "$n" = "$pkg" ]; then
          found=1
          break
        fi
      done
      if [ $found -eq 0 ]; then
        echo "❌ $f: package '$pkg' is not a workspace name"
        bad=1
      elif is_ignored "$pkg"; then
        saw_ignored=1
      else
        saw_versioned=1
      fi
    fi
  done < "$f"

  # Mixed changeset: both an ignored (version-less) and a versioned package.
  # changesets refuses to version these — flag at PR time, not post-merge.
  if [ $saw_ignored -eq 1 ] && [ $saw_versioned -eq 1 ]; then
    echo "❌ $f: mixes ignored (version-less) and versioned packages"
    bad=1
  fi
done

if [ $bad -ne 0 ]; then
  echo
  echo "Open the offending .changeset/*.md files. For an unknown package,"
  echo "use the exact workspace 'name' from its package.json (e.g. '@osn/ui',"
  echo "'@pulse/app', not 'pulse'). For a mixed changeset, split it in two:"
  echo "one file for the ignored (version-less) packages and one for the"
  echo "versioned packages."
  exit 1
fi

echo "✅ All changeset package references are valid."
