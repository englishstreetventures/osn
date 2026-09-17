#!/usr/bin/env bash
# Build a branch whose only session-metrics card is the SessionEnd fallback's.
#
# The fallback runs `card -- --if-absent` with no `--pr`, `--issue` or
# `--issue-labels`, so the card it leaves carries a null pull request, a null
# issue and a null `complexity.declared`. The issue itself says
# `complexity:1`, and the session cost $47 and hit a compaction — so the
# comparison the whole metric exists for is available, but only to a run that
# notices the card is not the identity-bearing one and reads the rating off
# the issue instead.
#
# Which finding routes where is in `criteria.json` and is not repeated here:
# this script runs inside the checkout the agent then works in.
set -euo pipefail

# Refuse to run anywhere but a checkout of this repository. Everything below is
# a relative `rm -rf`, and `.claude/projects` is where Claude Code keeps its
# session transcripts — a card never written is gone for good. The harness does
# `cd` to `installPath` before running this, but that is an assumption about
# someone else's runner, and an assumption guarded by nothing is how a delete
# lands in a home directory.
[ -f CLAUDE.md ] && [ -d .claude/skills ] && [ -d tools/pr-metrics ] || {
  echo "setup.sh: not in an osn checkout — refusing to delete anything" >&2
  exit 1
}

# The fixture ships the repository's own agent instructions. `.claude/commands`
# holds verbatim copies of skills, which would hand the baseline the content
# the eval withholds; `exclude` in scenario.json does not strip them.
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json

# `analyse-sessions` carries the same card-reading traps this scenario scores —
# the declared-complexity rule and the unobserved-edit rule both appear in it
# verbatim — so leaving it in place is the `.claude/commands` leak by another
# route. Remove it only when it is a real directory: the harness injects the
# skill under test into `.claude/skills/` as a symlink in the with-context
# variant, and a delete that walked through one would destroy the very thing
# being measured.
if [ -d .claude/skills/analyse-sessions ] && [ ! -L .claude/skills/analyse-sessions ]; then
  rm -rf .claude/skills/analyse-sessions
fi

git config user.email "eval@example.invalid" 2>/dev/null || true
git config user.name "Tessl Eval" 2>/dev/null || true

# A commit fixture may install the tree without its `.git`. Normalise, and fold
# any install-time drift into history BEFORE branching so it lands on the base
# and never appears in the branch under review.
if [ ! -d .git ]; then
  git init -q
  git config user.email "eval@example.invalid"
  git config user.name "Tessl Eval"
fi

# The harness injects the plugin as symlinks under `.claude/` and `.agents/`,
# and only into the with-context variant. Left visible they read as working-tree
# changes in that variant alone, which the no-source-edits check then scores
# against it. `ISSUE.md` joins them: it is the issue handed to the session, not
# a tracked file.
mkdir -p .git/info
printf '.claude/\n.agents/\nISSUE.md\n' >> .git/info/exclude

git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

git checkout -q -B main

# `git fetch origin "$BASE"` appears in the skills this branch's session would
# have run. Without a remote it fails every run, costing turns.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/cire-host-registry-filters

# A real diff in one package, matching the card's `diff.packages`. What the code
# does is not scored; that it exists, and that it is small, is.
mkdir -p cire/host/src/lib cire/host/tests/lib
cat > cire/host/src/lib/registry-filters.ts <<'SRC'
export type RegistryFilter = "all" | "claimed" | "unclaimed";

const FILTERS: Record<RegistryFilter, (claimedBy: string | null) => boolean> = {
  all: () => true,
  claimed: (claimedBy) => claimedBy !== null,
  unclaimed: (claimedBy) => claimedBy === null,
};

export function isRegistryFilter(value: string): value is RegistryFilter {
  return Object.hasOwn(FILTERS, value);
}

export function applyRegistryFilter<T extends { claimedBy: string | null }>(
  items: readonly T[],
  filter: RegistryFilter,
): T[] {
  return items.filter((item) => FILTERS[filter](item.claimedBy));
}
SRC

cat > cire/host/tests/lib/registry-filters.test.ts <<'TEST'
import { describe, expect, it } from "vitest";

import { applyRegistryFilter, isRegistryFilter } from "../../src/lib/registry-filters";

const items = [
  { id: "a", claimedBy: null },
  { id: "b", claimedBy: "guest-1" },
];

describe("applyRegistryFilter", () => {
  it("returns everything for `all`", () => {
    expect(applyRegistryFilter(items, "all")).toHaveLength(2);
  });

  it("splits claimed from unclaimed", () => {
    expect(applyRegistryFilter(items, "claimed").map((i) => i.id)).toEqual(["b"]);
    expect(applyRegistryFilter(items, "unclaimed").map((i) => i.id)).toEqual(["a"]);
  });
});

describe("isRegistryFilter", () => {
  it("rejects an inherited Object.prototype member", () => {
    expect(isRegistryFilter("constructor")).toBe(false);
  });
});
TEST

cat > .changeset/cire-host-registry-filters.md <<'CS'
---
"@cire/host": patch
---

Add claimed / unclaimed filters to the organiser registry list.
CS

git add -A
git commit -qm "feat(cire-host): filter the registry list by claim state"
git config branch.feat/cire-host-registry-filters.gh-merge-base main

# The card on disk. Written unattended by the `SessionEnd` hook as the last
# session closed, so it carries the diff and the spend and none of the
# identity: null pull request, null issue, null declared complexity.
mkdir -p .claude/metrics
cat > .claude/metrics/feat-cire-host-registry-filters.json <<'CARD'
{
  "schema_version": 1,
  "pr": {
    "number": null,
    "branch": "feat/cire-host-registry-filters",
    "base_sha": "b5f9c8f0000000000000000000000000000000a1",
    "head_sha": "b5f9c8f0000000000000000000000000000000b2",
    "generated_at": "2026-09-14T18:41:02.114Z",
    "merged_at": null,
    "phase": "at-open"
  },
  "issue": {
    "number": null,
    "type": null,
    "labels": []
  },
  "complexity": {
    "declared": null,
    "method": "none"
  },
  "window": {
    "sessions": 4,
    "first_ts": "2026-09-14T09:02:11.000Z",
    "last_ts": "2026-09-14T18:38:55.000Z",
    "span_seconds": 34604,
    "active_seconds": 19870,
    "compactions": 1
  },
  "spend": {
    "usd_equivalent": 47.31882,
    "tokens": {
      "input": 1204,
      "output": 402118,
      "thinking": 151990,
      "cache_write_5m": 402991,
      "cache_write_1h": 1118447,
      "cache_read": 168224903
    },
    "by_model": {
      "claude-opus-5": {
        "tokens": {
          "input": 1204,
          "output": 402118,
          "thinking": 151990,
          "cache_write_5m": 402991,
          "cache_write_1h": 1118447,
          "cache_read": 168224903
        },
        "usd_equivalent": 47.31882,
        "messages": 612
      }
    },
    "by_actor": {
      "main": {
        "tokens": {
          "input": 1204,
          "output": 402118,
          "thinking": 151990,
          "cache_write_5m": 402991,
          "cache_write_1h": 1118447,
          "cache_read": 168224903
        },
        "usd_equivalent": 47.31882,
        "messages": 612
      },
      "subagent": {
        "tokens": {
          "input": 0,
          "output": 0,
          "thinking": 0,
          "cache_write_5m": 0,
          "cache_write_1h": 0,
          "cache_read": 0
        },
        "usd_equivalent": 0,
        "messages": 0
      }
    },
    "effort": {
      "high": 612
    },
    "unpriced_models": []
  },
  "diff": {
    "files": {
      "generated": 1,
      "test": 1,
      "docs": 0,
      "config": 0,
      "source": 1
    },
    "loc": {
      "generated": {
        "added": 5,
        "deleted": 0
      },
      "test": {
        "added": 25,
        "deleted": 0
      },
      "docs": {
        "added": 0,
        "deleted": 0
      },
      "config": {
        "added": 0,
        "deleted": 0
      },
      "source": {
        "added": 18,
        "deleted": 0
      }
    },
    "packages": [
      "cire/host"
    ],
    "touches_migration": false,
    "commits": 1
  },
  "interaction": {
    "user_turns": 9,
    "corrective_turns": 6,
    "tokens_before_first_edit": 4118502,
    "sessions_with_observed_edit": 2,
    "tool_calls": {
      "Bash": 188,
      "Read": 141,
      "Grep": 96,
      "Edit": 44,
      "Glob": 31,
      "Write": 6
    },
    "edit_churn": {
      "files_edited_3plus": 3,
      "max_edits_one_file": 12
    },
    "skills": {},
    "subagents": {}
  }
}
CARD

# The issue the work was taken from. Untracked: it is the brief handed to the
# session, not repository content — and it is where the rating actually lives.
cat > ISSUE.md <<'ISSUE'
# xchromo/osn#1041 — Filter the organiser registry list by claim state

**Type** Feature
**Labels** `product:cire`, `complexity:1`

The registry page lists every gift. Organisers have asked to see just the
claimed ones, or just the unclaimed ones, without scrolling the whole list.

Add a three-way filter — all / claimed / unclaimed — to the list that
`cire/host` already renders. The data is on the row; nothing new is fetched.

**Done when** the list can be narrowed to claimed or unclaimed gifts and the
choice survives a page navigation.

---

## What the session looked like, in the owner's words

> Took far longer than I expected for what it was. I asked three times for the
> filter to keep working when the page re-navigates, and twice more about where
> the component was supposed to live — I could not point at a page that said
> it, and neither could the agent.
ISSUE
