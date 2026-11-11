#!/usr/bin/env bash
# Simulate the merge queue for a stack before anyone queues it. Read by
# wiki/conventions/stacked-prs.md §A whole stack and orchestrate Step 5.
# Tested by scripts/tests/queue-sim.cli.test.ts.
#
#   bash scripts/queue-sim.sh <branch|pr-number>...   bottom to top
#   bash scripts/queue-sim.sh --stack <pr-number>     the registered stack holding it
#   --no-fetch                                        use the remote-tracking refs on disk
#
# GitHub's mergeable badge compares each pull request with its own base branch,
# which in a stack is its parent. The merge queue instead squashes each pull
# request's own diff onto `main`, in order. So every pull request in a stack
# can read clean while the queue refuses one. This applies each layer's own
# three-dot diff, in order, onto the current `origin/main`, in a scratch
# worktree, and prints one line per layer:
#
#   OK        <branch> (#<pr>)
#   CONFLICT  <branch> (#<pr>)     then each conflicting file, indented
#   SKIPPED   <branch> (#<pr>)     a layer below conflicts, so the queue would refuse it too
#
# A pull request number is diffed against its own base branch. A branch name is
# diffed against the argument before it, and the first against the trunk; so a
# child listed alone that still holds a squash-merged parent's original commits
# carries them, as the queue would see it once GitHub retargets it to `main`.
#
# Exit 0: every layer applies. Exit 1: a layer conflicts. Exit 2: a bad
# argument, a branch the remote does not have, or a gh lookup that failed.
#
# Read-only: it fetches the refs it reads into refs/remotes/<remote>/, and
# moves no other ref, writes no config and leaves no worktree. Its commits are
# made in a detached scratch worktree under $TMPDIR, removed on exit.
# QUEUE_SIM_REPO (default englishstreetventures/osn), QUEUE_SIM_REMOTE (origin)
# and QUEUE_SIM_TRUNK (main) change the defaults.
set -u

repo=${QUEUE_SIM_REPO:-englishstreetventures/osn}
remote=${QUEUE_SIM_REMOTE:-origin}
trunk=${QUEUE_SIM_TRUNK:-main}
owner=${repo%%/*}

usage() {
  echo "usage: queue-sim.sh [--no-fetch] <branch|pr-number>...   (bottom to top)" >&2
  echo "       queue-sim.sh [--no-fetch] --stack <pr-number>" >&2
  exit 2
}

die() {
  echo "queue-sim: $*" >&2
  exit 2
}

fetch=1
stack_pr=""
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-fetch) fetch="" ;;
    --stack)
      [ $# -ge 2 ] || usage
      stack_pr=$2
      shift
      ;;
    -*) usage ;;
    *) args+=("$1") ;;
  esac
  shift
done

if [ -n "$stack_pr" ]; then
  [ ${#args[@]} -eq 0 ] || usage
  case "$stack_pr" in '' | *[!0-9]*) usage ;; esac
else
  [ ${#args[@]} -gt 0 ] || usage
fi

valid_ref() {
  case "$1" in '' | -* | *..* | *[!A-Za-z0-9._/-]*) return 1 ;; esac
}

# Each layer: its branch, the ref its own diff is taken against, and its pull
# request number or "".
heads=()
bases=()
prs=()

# `<number>\t<head>\t<base>\t<stack number or empty>` for one pull request.
pull_line() {
  gh api "repos/$repo/pulls/$1" --jq '[.number, .head.ref, .base.ref, (.stack.number // "")] | @tsv' 2>/dev/null
}

if [ -n "$stack_pr" ]; then
  line=$(pull_line "$stack_pr") || die "gh could not read pull request #$stack_pr"
  IFS=$'\t' read -r number head base stack_number <<<"$line"
  [ -n "$stack_number" ] || die "#$stack_pr is not in a registered stack; list its pull requests instead"
  heads=("$head")
  bases=("$base")
  prs=("$number")
  # Down to the trunk, through each base branch's open pull request.
  while [ "${bases[0]}" != "$trunk" ]; do
    below=${bases[0]}
    line=$(gh api "repos/$repo/pulls?state=open&head=$owner:$below" \
      --jq '.[0] | [.number, .head.ref, .base.ref] | @tsv' 2>/dev/null) || line=""
    IFS=$'\t' read -r number head base <<<"$line"
    [ -n "${number:-}" ] && [ "$number" != null ] || die "no open pull request has $below as its head"
    heads=("$head" "${heads[@]}")
    bases=("$base" "${bases[@]}")
    prs=("$number" "${prs[@]}")
  done
  # Up, through the open pull request in the same stack based on each head.
  while :; do
    top=${heads[${#heads[@]} - 1]}
    line=$(gh api "repos/$repo/pulls?state=open&base=$top" \
      --jq "[.[] | select(.stack.number == $stack_number)] | .[0] // empty | [.number, .head.ref, .base.ref] | @tsv" \
      2>/dev/null) || die "gh could not list the pull requests based on $top"
    [ -n "$line" ] || break
    IFS=$'\t' read -r number head base <<<"$line"
    heads+=("$head")
    bases+=("$base")
    prs+=("$number")
  done
else
  previous=$trunk
  for arg in "${args[@]}"; do
    case "$arg" in
      *[!0-9]*)
        heads+=("$arg")
        bases+=("$previous")
        prs+=("")
        ;;
      *)
        line=$(pull_line "$arg") || die "gh could not read pull request #$arg"
        IFS=$'\t' read -r number head base _ <<<"$line"
        heads+=("$head")
        bases+=("$base")
        prs+=("$number")
        ;;
    esac
    previous=${heads[${#heads[@]} - 1]}
  done
fi

for ref in "$trunk" "${heads[@]}" "${bases[@]}"; do
  valid_ref "$ref" || die "not a plain branch name: $ref"
done

if [ -n "$fetch" ]; then
  refspecs=()
  for ref in "$trunk" "${heads[@]}" "${bases[@]}"; do
    refspecs+=("+refs/heads/$ref:refs/remotes/$remote/$ref")
  done
  # One fetch per ref, so a missing branch is named rather than failing them all.
  for spec in "${refspecs[@]}"; do
    git fetch --no-tags -q "$remote" "$spec" 2>/dev/null || true
  done
fi

for ref in "$trunk" "${heads[@]}" "${bases[@]}"; do
  git rev-parse --verify --quiet "refs/remotes/$remote/$ref^{commit}" >/dev/null \
    || die "$remote has no branch $ref"
done

scratch=$(mktemp -d "${TMPDIR:-/tmp}/queue-sim.XXXXXX") || die "cannot make a scratch directory"
tree="$scratch/tree"
# shellcheck disable=SC2329 # runs from the EXIT trap below
cleanup() {
  git worktree remove --force "$tree" >/dev/null 2>&1
  git worktree prune >/dev/null 2>&1
  rm -rf "${scratch:?}"
}
trap cleanup EXIT

nohooks=(-c core.hooksPath=/dev/null)
git "${nohooks[@]}" worktree add -q --detach "$tree" "refs/remotes/$remote/$trunk" >/dev/null 2>&1 \
  || die "cannot add a scratch worktree at $tree"

echo "queue-sim: onto $remote/$trunk $(git rev-parse --short "refs/remotes/$remote/$trunk")"

label() {
  if [ -n "$2" ]; then printf '%s (#%s)' "$1" "$2"; else printf '%s' "$1"; fi
}

status=0
for i in "${!heads[@]}"; do
  name=$(label "${heads[$i]}" "${prs[$i]}")
  if [ "$status" -ne 0 ]; then
    printf 'SKIPPED   %s\n' "$name"
    continue
  fi
  patch="$scratch/layer-$i.patch"
  git diff --binary "refs/remotes/$remote/${bases[$i]}...refs/remotes/$remote/${heads[$i]}" >"$patch"
  if [ ! -s "$patch" ]; then
    printf 'OK        %s (no changes)\n' "$name"
    continue
  fi
  if git -C "$tree" apply --3way --index "$patch" >"$scratch/apply.out" 2>&1; then
    git -C "$tree" "${nohooks[@]}" -c user.name=queue-sim -c user.email=queue-sim@localhost \
      -c commit.gpgsign=false commit -q --no-verify -m "queue-sim: $name" >/dev/null
    printf 'OK        %s\n' "$name"
  else
    printf 'CONFLICT  %s\n' "$name"
    files=$(git -C "$tree" diff --name-only --diff-filter=U)
    if [ -n "$files" ]; then
      printf '%s\n' "$files" | sed 's/^/  /'
    else
      grep -m 5 -E '^error' "$scratch/apply.out" | sed 's/^/  /'
    fi
    status=1
  fi
done

exit "$status"
