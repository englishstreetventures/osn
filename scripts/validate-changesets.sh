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
      fi
    fi
  done < "$f"
done

if [ $bad -ne 0 ]; then
  echo
  echo "Open the offending .changeset/*.md files and use the exact"
  echo "workspace 'name' from its package.json (e.g. '@osn/ui',"
  echo "'@pulse/app', not 'pulse')."
  exit 1
fi

echo "✅ All changeset package references are valid."
