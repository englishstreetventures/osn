---
name: retro-v2
description: Use when a branch has finished and the session-metrics card is all that is wanted — writes, commits and renders the card, and stops. The card-only half of `retro`, for sessions running close to their token budget. Where there is room to think, run `retro` instead — this one deliberately produces no findings and changes nothing.
---

Write the session-metrics card for the branch named in `$ARGUMENTS`, or the
current branch if it is empty. Then stop.

## What this run must produce

One thing: **the card.** `.claude/metrics/<branch-slug>.json`, carrying this
branch's pull request number, issue number and issue labels — committed, pushed,
and rendered onto the pull-request body as a `<details>` block.

Nothing else. No `RETRO.md`, no findings, no changes to the skills, `AGENTS.md`,
the wiki, the tests or the brief.

## When to run this instead of `retro`

`retro` is the full procedure: the card, then reading what the session cost
against the complexity declared before it started, then turning that into
concrete changes. **That reading is the point of the exercise**, and this skill
throws it away.

Run this one when the session has no room left to do it properly — a long run
close to its context or token budget, where the choice is between a card and
nothing. Run `retro` in every other case.

A card written here is complete and permanent: it holds the same measurements a
full run would have written, and `retro` can read it later from any session. The
analysis is what is deferred, not the record.

## Where this sits

`new-feat`, implement, `prep-pr`, then this. Under `orchestrate`, once per task,
after that task's pull request is open and before the shepherd watches it.

After `prep-pr` and not inside it, because `prep-pr` dispatches three review
agents: a card written before they finish measures building the change rather
than shipping it.

## Before Step 1 — what can actually run

Three answers, once, exactly as `prep-pr` establishes them:

```bash
git ls-remote --exit-code origin HEAD >/dev/null 2>&1 && echo "network: yes" || echo "network: no"
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && echo "gh: yes" || echo "gh: no"
ls ~/.claude/projects >/dev/null 2>&1 && echo "transcripts: yes" || echo "transcripts: no"
```

If `prep-pr` ran in this same session it already has these three answers. Read
them out of its report rather than probing again.

**`transcripts: no` governs what the collector can write.** It reads
`~/.claude/projects`; with that directory absent, the card it writes now carries
the diff and zero spend — true, but able to answer nothing about cost. Write it
anyway, and say in the final message that the spend figure is not a measurement.
Never present a zero-spend card as a cheap session.

**A card already in `.claude/metrics/` is a record, not collector output to be
distrusted.** Its spend was measured when the transcripts still existed and
stays true after they are gone — that is the entire reason the file is committed
rather than recomputed.

---

## Step 1 — Write the card

```bash
BRANCH=$(git branch --show-current)
PR=$(gh pr view --json number --jq .number)
```

Then the two runs, which do different jobs:

```bash
# 1. The committed card. `--resolve-issue` finds the pull request, its first
#    linked issue and that issue's `complexity:` label for itself.
bun run --cwd tools/pr-metrics card -- --resolve-issue

# 2. The `<details>` block for the pull-request body, on stdout, warnings excluded.
bun run --cwd tools/pr-metrics card -- --resolve-issue --format markdown > /tmp/card.md
```

Four rules about that pair:

- **Let `--resolve-issue` do the lookup; never hand-roll it in the shell.**
  `.closingIssuesReferences[0].number` drops the repository, so a follow-up
  `gh issue view <n> --repo xchromo/osn` **succeeds** against a different
  repository's issue of the same number and writes a stranger's `complexity:`
  label in as this branch's denominator. `resolveIdentity` in
  `tools/pr-metrics/index.ts` compares the reference's own repository.
- **Labels are read only from an issue in this repository.** Most work here
  closes a finding in the private `xchromo/osn-tracker`, and that issue's
  `severity:`/`area:` labels must never reach a card committed to a public
  repository. The flag withholds them and records
  `complexity.method: "not-fetched"`, which is **not** `"none"` — a rating may
  well exist there and nobody looked. `"lookup-failed"` is its third answer,
  for a call that did not land.
- **Pass explicit flags only where you know better than `gh` does.** `--pr`,
  `--issue`, `--issue-labels` and `--complexity` all win over the lookup, and
  passing one turns the rest of it off. The usual reason is a branch whose pull
  request is not open yet.
- **Commit the JSON with the branch.** `~/.claude/projects` is local,
  unversioned and dies with a remote container. The committed file is the
  record; an uncommitted one is nothing. Stage the one card, never the
  directory: `.claude/metrics/` holds every other branch's card too, and a
  `git add` of the whole of it sweeps in anything a concurrent session left
  there.

```bash
git add ".claude/metrics/$(echo "$BRANCH" | tr -c 'a-zA-Z0-9._-' '-').json"
git commit -m "chore: session-metrics card for $BRANCH"
git push
```

## Step 2 — Render it onto the pull request

```bash
gh pr view "$PR" --json body --jq .body > /tmp/body.md
cat /tmp/card.md >> /tmp/body.md
gh pr edit "$PR" --body-file /tmp/body.md
```

Read the body out and append to it — never compose a new one. The five sections
`prep-pr` wrote are the pull request's contract, and an edit that rebuilds the
body from memory loses them.

**Check the card is not already on the body** before appending — a re-run would
otherwise stack a second block. Match the summary line, not the tag: a body that
describes what this step does mentions `<details>` in its own prose, and a bare
`grep -c '<details>'` then reports a block that is not there.

```bash
gh pr view "$PR" --json body --jq .body | grep -c '^<details><summary>Session metrics'
```

The block is a `<details>`, never a `##` section: `prep-pr`'s body shape check
permits exactly five top-level headings, and appending a sixth fails a body that
is otherwise correct.

**When a step here cannot run**, record which and carry on — a missing card
never blocks anything. No `gh`: write the card with whatever identity you know
and leave the block in a file, naming that file in the final message. No
network: commit the card locally; it pushes with the next push.

**The `SessionEnd` hook is a fallback, not a second writer.** It runs
`card -- --if-absent --resolve-issue`, so it writes a card for a branch that has
none and never touches one this skill committed.

A card with `pr.number: null` is one the hook wrote before a pull request
existed. Its spend and interaction numbers are as good as any other card's —
only its identity is missing, and Step 1 fills that in where it can run.

---

## Finish

Report the card's path, the pull request it names, the issue and
`complexity.declared` it resolved, and `spend.usd_equivalent`. Say plainly that
the analysis half was not run and that `retro` reads this card later from any
session.

Do not offer a summary of what the session cost, and do not volunteer findings.
Someone who wants those runs `retro`.
