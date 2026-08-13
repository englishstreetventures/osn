#!/usr/bin/env bash
# Creates a Cloudflare Pages project if it does not exist, and fails on anything
# else.
#
# The deploy workflow used `wrangler pages project create … || true` at five
# sites. That is the right intent — the step must be idempotent — but `|| true`
# swallows every failure, not just "it already exists": an expired or
# wrong-scoped CLOUDFLARE_API_TOKEN, a rate limit, an account-id typo. The job
# then reports a green "Ensure the project exists" step and moves on, and the
# real reason has to be rediscovered from the deploy step's less specific error.
#
# So: swallow the already-exists case by name, print everything, exit non-zero on
# the rest.
#
# Usage: scripts/ensure-pages-project.sh <project-name> [production-branch]
set -euo pipefail

project="${1:?ensure-pages-project.sh: project name required}"
branch="${2:-main}"

if out="$(bunx wrangler pages project create "$project" --production-branch "$branch" 2>&1)"; then
  printf '%s\n' "$out"
  echo "Created Pages project $project."
  exit 0
fi

printf '%s\n' "$out"

# Wrangler reports the benign case as "A project with this name already exists"
# (API code 8000007). Anything else is a real failure and must stop the job.
if printf '%s\n' "$out" | grep -qiE 'already exists|8000007'; then
  echo "Pages project $project already exists — nothing to do."
  exit 0
fi

echo "ensure-pages-project.sh: creating $project failed for a reason other than 'already exists'. Refusing to continue." >&2
exit 1
