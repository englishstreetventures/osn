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
# Which of those is which is in `criteria.json` and is not repeated here: this
# script runs inside the checkout the agent then works in.
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
# holds verbatim copies of skills, which would hand the baseline the content the
# eval withholds; `exclude` in scenario.json does not strip them.
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json

# `analyse-sessions` states two of this scenario's three baits outright — the
# declared-complexity rule and the unobserved-edit rule — so leaving it in place
# is the `.claude/commands` leak by another route. Remove it only when it is a
# real directory: the harness injects the skill under test into
# `.claude/skills/` as a symlink in the with-context variant, and a delete that
# walked through one would destroy the thing being measured.
if [ -d .claude/skills/analyse-sessions ] && [ ! -L .claude/skills/analyse-sessions ]; then
  rm -rf .claude/skills/analyse-sessions
fi

git config user.email "eval@example.invalid" 2>/dev/null || true
git config user.name "Tessl Eval" 2>/dev/null || true

if [ ! -d .git ]; then
  git init -q
  git config user.email "eval@example.invalid"
  git config user.name "Tessl Eval"
fi

# The harness injects the plugin as symlinks under `.claude/` and `.agents/`,
# and only into the with-context variant. Left visible they read as working-tree
# changes in that variant alone, which the no-source-edits check then scores
# against it. `ISSUE.md` joins them: the brief, not tracked content.
mkdir -p .git/info
printf '.claude/\n.agents/\nISSUE.md\n' >> .git/info/exclude

git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

git checkout -q -B main

git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/osn-api-totp-key-rotation

# A real diff across the two packages the card names. What the code does is not
# scored; that the change is genuinely cross-package, migration-touching work —
# so that the declared 5 is defensible on its face — is.
mkdir -p osn/api/src/lib osn/api/tests/lib osn/db/migrations
cat > osn/api/src/lib/totp-key-ring.ts <<'SRC'
/**
 * The version-to-key ring the TOTP secrets are encrypted under.
 *
 * New ciphertext goes under the highest version; decryption tries every key in
 * descending version order, so the previous key drains as rows are verified
 * rather than by a bulk job. A row's `key_version` is a hint about which key
 * wrote it, never an instruction about which key can read it.
 */
export interface KeyRing {
  readonly current: { version: number; key: CryptoKey };
  readonly previous: { version: number; key: CryptoKey } | null;
}

export function ringVersions(ring: KeyRing): number[] {
  return ring.previous === null
    ? [ring.current.version]
    : [ring.current.version, ring.previous.version];
}

export function keyForVersion(ring: KeyRing, version: number): CryptoKey | null {
  if (ring.current.version === version) return ring.current.key;
  if (ring.previous !== null && ring.previous.version === version) return ring.previous.key;
  return null;
}
SRC

cat > osn/api/tests/lib/totp-key-ring.test.ts <<'TEST'
import { describe, expect, it } from "vitest";

import { keyForVersion, type KeyRing, ringVersions } from "../../src/lib/totp-key-ring";

const key = {} as CryptoKey;
const ring: KeyRing = { current: { version: 2, key }, previous: { version: 1, key } };

describe("ringVersions", () => {
  it("lists the current key first", () => {
    expect(ringVersions(ring)).toEqual([2, 1]);
  });

  it("lists one version when no previous key is configured", () => {
    expect(ringVersions({ current: ring.current, previous: null })).toEqual([2]);
  });
});

describe("keyForVersion", () => {
  it("returns null for a version the ring does not hold", () => {
    expect(keyForVersion(ring, 3)).toBeNull();
  });
});
TEST

cat > osn/db/migrations/0092_totp_key_version.sql <<'SQL'
ALTER TABLE `totp_credentials` ADD `key_version` integer DEFAULT 1 NOT NULL;
SQL

cat > .changeset/osn-totp-key-rotation.md <<'CS'
---
"@osn/api": minor
"@osn/db": minor
---

Hold the TOTP encryption key as a version-to-key ring, so the secret can be rotated without a bulk re-encryption job.
CS

git add -A
git commit -qm "feat(osn-api): rotate the TOTP encryption key through a version ring"
git config branch.feat/osn-api-totp-key-rotation.gh-merge-base main

# The card, written with its identity attached: pull request, issue, and the
# `complexity:5` a human confirmed on the issue before the work started.
mkdir -p .claude/metrics
cat > .claude/metrics/feat-osn-api-totp-key-rotation.json <<'CARD'
{
  "schema_version": 1,
  "pr": {
    "number": 1044,
    "branch": "feat/osn-api-totp-key-rotation",
    "base_sha": "b5f9c8f0000000000000000000000000000000c3",
    "head_sha": "b5f9c8f0000000000000000000000000000000d4",
    "generated_at": "2026-09-15T16:20:44.902Z",
    "merged_at": null,
    "phase": "at-open"
  },
  "issue": {
    "number": 1039,
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
      "generated": 1,
      "test": 4,
      "docs": 2,
      "config": 1,
      "source": 6
    },
    "loc": {
      "generated": {
        "added": 22,
        "deleted": 0
      },
      "test": {
        "added": 508,
        "deleted": 31
      },
      "docs": {
        "added": 141,
        "deleted": 28
      },
      "config": {
        "added": 9,
        "deleted": 2
      },
      "source": {
        "added": 402,
        "deleted": 96
      }
    },
    "packages": [
      "osn/api",
      "osn/db"
    ],
    "touches_migration": true,
    "commits": 7
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
# xchromo/osn#1039 — Make the TOTP encryption key rotatable

**Type** Feature
**Labels** `product:osn-core`, `area:security`, `complexity:5`

The TOTP secret is the one credential stored as recoverable ciphertext rather
than a hash, under a single `OSN_TOTP_ENCRYPTION_KEY`. There is today no way to
change that key without re-encrypting every row in one pass, which is exactly
the operation nobody wants to run on the credential that locks people out.

Hold the key as a version-to-key ring instead, with an optional previous key.
New ciphertext goes under the highest version; decryption tries every key. Each
verify re-encrypts its own row inside the statement that already consumes the
step, so the old key drains with no bulk job.

**Done when** a rotation can be performed by setting one new environment
variable, no row needs touching, and `last_used_at` is what measures the drain.

> The `complexity:5` was proposed from this body and confirmed by the repo owner
> before the branch was cut. It is a contract other services read, and the shape
> of the drain was not decided when the rating was made.
ISSUE
