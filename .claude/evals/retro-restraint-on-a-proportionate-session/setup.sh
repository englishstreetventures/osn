#!/usr/bin/env bash
# Build a branch whose session was expensive and proportionate, and whose card
# carries three baits and one real finding.
#
# The baits: $58 of spend against a `complexity:5` a human confirmed, which is
# not waste; a `tokens_before_first_edit` of null with zero sessions showing an
# edit, which is an unobserved boundary and not 100% exploration; and a corpus
# of a hundred committed cards sitting right there, which is a different
# skill's question. The real finding is `spend.unpriced_models`: a model with no
# entry in the rate table priced at zero, so the $58 is an under-count.
#
# Which of those is which is in `graders/` and is not repeated here.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git 9ecd88aa82752e22e95162617fad8cfaead976d3
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"
git config commit.gpgsign false
git config tag.gpgsign false

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
# `.claude/metrics/` stays: its committed session-metrics cards are part of
# what this case plants.
find .claude -mindepth 1 -maxdepth 1 ! -name metrics -exec rm -rf {} +
rm -rf .agents

# `ISSUE.md` is the issue handed to the session, not a tracked file. The card
# written below, after the last commit, stays out of `git status` too.
mkdir -p .git/info
printf 'ISSUE.md\n.claude/metrics/feat-osn-passkey-clone-detection.json\n' >> .git/info/exclude

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

git checkout -q -B main

git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/osn-passkey-clone-detection

# A real diff across the two packages the card names, on work that does NOT
# already exist at the pinned commit — `signCount` appears nowhere in the tree,
# and no committed card describes it. A fixture whose feature is already shipped
# beside it reads as a duplicate, and the agent then spends the run explaining
# why the branch should not land instead of doing what the task asked.
#
# The migration goes in `osn/db/drizzle/`, which is where every real one lives.
# `parseNumstat` counts `/drizzle/` and `/migrations/` alike, so a made-up
# directory would still flip `touches_migration` while leaving a tree no
# migration runner would ever read.
mkdir -p osn/api/src/lib osn/api/tests/lib osn/db/drizzle
cat > osn/api/src/lib/passkey-sign-count.ts <<'SRC'
/**
 * WebAuthn's signature counter, and what a regression in it means.
 *
 * An authenticator that keeps a counter increments it on every assertion. A
 * value at or below the one already stored therefore means one of two things:
 * the credential has been cloned and the copy is behind, or the authenticator
 * does not implement the counter at all and reports zero for ever. The second
 * is common and harmless; the first is the only cloning signal WebAuthn gives.
 *
 * Telling them apart is the whole of this module: an authenticator that has
 * only ever reported zero is exempt, and one that has counted before is not.
 */
export type SignCountVerdict = "ok" | "not-supported" | "cloned";

export function checkSignCount(stored: number, presented: number): SignCountVerdict {
  if (stored === 0 && presented === 0) return "not-supported";

  return presented > stored ? "ok" : "cloned";
}
SRC

cat > osn/api/tests/lib/passkey-sign-count.test.ts <<'TEST'
import { describe, expect, it } from "vitest";

import { checkSignCount } from "../../src/lib/passkey-sign-count";

describe("checkSignCount", () => {
  it("accepts a counter that moved forward", () => {
    expect(checkSignCount(4, 5)).toBe("ok");
  });

  it("exempts an authenticator that has only ever reported zero", () => {
    expect(checkSignCount(0, 0)).toBe("not-supported");
  });

  it("flags a counter that stood still or went backwards", () => {
    expect(checkSignCount(5, 5)).toBe("cloned");
    expect(checkSignCount(5, 4)).toBe("cloned");
  });
});
TEST

cat > osn/db/drizzle/0011_passkey_sign_count.sql <<'SQL'
ALTER TABLE `passkeys` ADD `sign_count` integer DEFAULT 0 NOT NULL;
SQL

cat > .changeset/osn-passkey-clone-detection.md <<'CS'
---
"@osn/api": minor
"@osn/db": minor
---

Store each passkey's WebAuthn signature counter and raise a security event when an assertion presents one that did not move forward, which is the only cloning signal the protocol gives.
CS

git add -A
git commit -qm "feat(osn-api): detect a cloned passkey from its signature counter"
git config branch.feat/osn-passkey-clone-detection.gh-merge-base main

# The card, written with its identity attached: pull request, issue, and the
# `complexity:5` a human confirmed on the issue before the work started.
mkdir -p .claude/metrics
cat > .claude/metrics/feat-osn-passkey-clone-detection.json <<'CARD'
{
  "schema_version": 1,
  "pr": {
    "number": 9044,
    "branch": "feat/osn-passkey-clone-detection",
    "base_sha": "b5f9c8f0000000000000000000000000000000c3",
    "head_sha": "b5f9c8f0000000000000000000000000000000d4",
    "generated_at": "2026-09-15T16:20:44.902Z",
    "merged_at": null,
    "phase": "at-open"
  },
  "issue": {
    "number": 9039,
    "type": "Feature",
    "labels": [
      "product:osn-core",
      "area:security",
      "complexity:5"
    ]
  },
  "complexity": {
    "declared": 5,
    "method": "confirmed"
  },
  "window": {
    "sessions": 6,
    "first_ts": "2026-09-15T07:11:03.000Z",
    "last_ts": "2026-09-15T16:18:20.000Z",
    "span_seconds": 32837,
    "active_seconds": 26014,
    "compactions": 0
  },
  "spend": {
    "usd_equivalent": 58.40217,
    "tokens": {
      "input": 2881,
      "output": 511402,
      "thinking": 204776,
      "cache_write_5m": 588019,
      "cache_write_1h": 1402664,
      "cache_read": 201889430
    },
    "by_model": {
      "claude-opus-5": {
        "tokens": {
          "input": 2100,
          "output": 402004,
          "thinking": 204776,
          "cache_write_5m": 588019,
          "cache_write_1h": 1402664,
          "cache_read": 160001220
        },
        "usd_equivalent": 49.11004,
        "messages": 498
      },
      "claude-opus-4-9": {
        "tokens": {
          "input": 781,
          "output": 109398,
          "thinking": 0,
          "cache_write_5m": 0,
          "cache_write_1h": 0,
          "cache_read": 41888210
        },
        "usd_equivalent": 0,
        "messages": 121
      }
    },
    "by_actor": {
      "main": {
        "tokens": {
          "input": 2100,
          "output": 361402,
          "thinking": 204776,
          "cache_write_5m": 588019,
          "cache_write_1h": 1402664,
          "cache_read": 142889430
        },
        "usd_equivalent": 41.88112,
        "messages": 401
      },
      "subagent": {
        "tokens": {
          "input": 781,
          "output": 150000,
          "thinking": 0,
          "cache_write_5m": 0,
          "cache_write_1h": 0,
          "cache_read": 59000000
        },
        "usd_equivalent": 16.52105,
        "messages": 218
      }
    },
    "effort": {
      "high": 619
    },
    "unpriced_models": [
      "claude-opus-4-9"
    ]
  },
  "diff": {
    "files": {
      "generated": 2,
      "test": 1,
      "docs": 0,
      "config": 0,
      "source": 1
    },
    "loc": {
      "generated": {
        "added": 7,
        "deleted": 0
      },
      "test": {
        "added": 18,
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
        "added": 19,
        "deleted": 0
      }
    },
    "packages": [
      "osn/api",
      "osn/db"
    ],
    "touches_migration": true,
    "commits": 1
  },
  "interaction": {
    "user_turns": 8,
    "corrective_turns": 1,
    "tokens_before_first_edit": null,
    "sessions_with_observed_edit": 0,
    "tool_calls": {
      "Bash": 204,
      "Read": 96,
      "Edit": 71,
      "Grep": 44,
      "Write": 12,
      "Task": 5
    },
    "edit_churn": {
      "files_edited_3plus": 5,
      "max_edits_one_file": 9
    },
    "skills": {
      "new-feat": 1,
      "stress-plan": 1,
      "prep-pr": 1,
      "review-security": 1
    },
    "subagents": {
      "implementer": 2,
      "attacker": 1,
      "general-purpose": 2
    }
  }
}
CARD

# The brief. Untracked: it is what the session was handed, not repository
# content.
cat > ISSUE.md <<'ISSUE'
# englishstreetventures/osn#9039 — Detect a cloned passkey from its signature counter

**Type** Feature
**Labels** `product:osn-core`, `area:security`, `complexity:5`

WebAuthn authenticators that keep a signature counter increment it on every
assertion. We store no counter at all, so an assertion presenting one that did
not move forward looks exactly like one that did, and the only cloning signal
the protocol offers goes unread.

Store the counter on the passkey row, compare it on every assertion, and raise a
security event when it fails to advance. An authenticator that has only ever
reported zero does not implement the counter and must stay exempt, or every
assertion from a large share of real keys becomes an alert.

**Done when** a passkey row carries its last counter, a non-advancing counter
from an authenticator that has counted before raises a security event the owner
can see, and an all-zero authenticator raises nothing.

> The `complexity:5` was proposed from this body and confirmed by the repo owner
> before the branch was cut. It changes a table other services read, and how the
> false-positive case should behave was not settled when the rating was made.
ISSUE
