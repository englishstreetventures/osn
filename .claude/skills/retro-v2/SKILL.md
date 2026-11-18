---
name: retro-v2
description: Use when a branch has finished and the session-metrics card is all that is wanted — writes and commits the card, normally just before `prep-pr`'s first push, puts its block on the pull-request body, and stops. The card-only half of `retro`, for sessions running close to their token budget. Where there is room to think, run `retro` instead — this one deliberately produces no findings and changes nothing.
---

Write the session-metrics card for the branch named in `$ARGUMENTS`, or the
current branch if it is empty. Then stop.

## What this run must produce

One thing: **the card.** `.claude/metrics/<branch-slug>.json` — or
`<branch-slug>-<pr>.json` on a branch name an earlier pull request used —
carrying this branch's issue number and issue labels, and its pull request
number once one exists — committed, and its `<details>` block put on the
pull-request body.

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

`new-feat`, implement, `prep-pr` up to its push, then this, then `prep-pr`
pushes and opens the pull request (its Step 9). Under `orchestrate`, once per
task, the same way.

After `prep-pr`'s reviews and fixes, because a card written before they finish
measures building the change rather than shipping it. Before its push, because
a card committed once the pull request is open is a second push, and the pull
request runs CI twice.

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
SLUG=$(printf '%s' "$BRANCH" | tr -c 'a-zA-Z0-9._-' '-' | sed 's/^-*//;s/-*$//')
PR=$(gh pr view --json number --jq .number 2>/dev/null)   # empty until the pull request opens
BLOCK="${TMPDIR:-/tmp}/card-$SLUG.md"
BASE="origin/$(git config --get "branch.$BRANCH.gh-merge-base" || echo main)"   # the parent, on a stacked branch
```

**Before the pull request opens** — the usual case — `--resolve-issue` finds
nothing yet: `resolveIdentity` in `tools/pr-metrics/index.ts` returns as soon as
`gh pr list --head` lists no pull request. Name the issue and pass its labels —
only this repository's issue, since `card` takes any number it is given and a
tracker number on a card is a disclosure. The `grep` matches a bare `#N` and
nothing else, so a tracker reference leaves `FLAGS` empty:

```bash
ISSUE=$(grep -m1 -oE '^Issues?: #[0-9]+' NEW-FEAT.md | grep -oE '[0-9]+$')
FLAGS=()
[ -n "$ISSUE" ] && FLAGS=(--issue "$ISSUE" --issue-labels \
  "$(gh issue view "$ISSUE" --repo englishstreetventures/osn --json labels --jq '[.labels[].name] | join(",")')")
bun run --cwd tools/pr-metrics card -- "${FLAGS[@]}" --base "$BASE"
bun run --cwd tools/pr-metrics card -- "${FLAGS[@]}" --base "$BASE" --format markdown > "$BLOCK"
```

The card carries the issue and its rating, and `pr.number: null` until a later
run or `backfill` fills the number in; `retro` Step 1 says why that gap is safe,
and what a tracker-only branch, a branch closing several issues and a reused
branch name do instead.

**Once the pull request is open** — an adopted branch, or a card written again:

```bash
# 1. The committed card. `--resolve-issue` finds the pull request, names the
#    issue the branch was cut for and sums the `complexity:` ratings of every
#    issue in this repository the pull request closes, or, when it links none
#    here, of the tracker issues it closes.
bun run --cwd tools/pr-metrics card -- --resolve-issue --base "$BASE"

# 2. The `<details>` block for the pull-request body, on stdout, warnings excluded.
bun run --cwd tools/pr-metrics card -- --resolve-issue --base "$BASE" --format markdown > "$BLOCK"
```

Five rules about those runs:

- **Let `--resolve-issue` do the lookup; never hand-roll it in the shell.**
  `.closingIssuesReferences[0].number` drops the repository, so a follow-up
  `gh issue view <n> --repo englishstreetventures/osn` **succeeds** against a different
  repository's issue of the same number and writes a stranger's `complexity:`
  label in as this branch's denominator. `resolveIdentity` in
  `tools/pr-metrics/index.ts` compares the reference's own repository.
- **A card's labels come only from an issue in this repository.** Much work
  here closes a finding in the private `englishstreetventures/osn-tracker`, and
  that issue's `severity:`/`area:` labels must never reach a card committed to
  a public repository. For a pull request that links no issue here, the flag
  reads the tracker issues it closes and keeps only their `complexity:` pair,
  for the rating; the card names no issue. Beside an issue here, tracker issues
  are not read. A tracker issue the token cannot read records
  `complexity.method: "not-fetched"`, which is **not** `"none"` — a rating may
  well exist there, unread. `"lookup-failed"` is a call to this repository
  that did not land.
- **Check the issue the card names.** It is the issue in the branch's
  `NEW-FEAT.md` when the pull request links it, else the first `Closes` line of
  the body, else the first `Part of` line; with several closing references and
  none of those, it names none and warns. Read `issue.number` and
  `complexity.issues` off the card: when the issue is not the one the branch
  was cut for, run both commands again with `--issue <n>` added. `--issue`
  names the issue and nothing else; the rating stays the sum of what the pull
  request closes. It takes this repository's issue only — never a tracker
  number.
- **Pass explicit flags only where you know better than `gh` does.** `--pr`,
  `--issue-labels` and `--complexity` win over the lookup; `--issue-labels`
  turns the rating lookup off and declares that one issue's rating; pass this
  repository's issue's labels only, never a tracker issue's. Before the pull
  request opens they are the only source.
- **Commit the JSON with the branch.** `~/.claude/projects` is local,
  unversioned and dies with a remote container. The committed file is the
  record; an uncommitted one is nothing. Stage the one card, never the
  directory: `.claude/metrics/` holds every other branch's card too, and a
  `git add` of the whole of it sweeps in anything a concurrent session left
  there.

```bash
CARD=".claude/metrics/$SLUG.json"
[ -n "$PR" ] && [ -f ".claude/metrics/$SLUG-$PR.json" ] && CARD=".claude/metrics/$SLUG-$PR.json"
git add "$CARD"
git commit -m "chore: session-metrics card for $BRANCH"
```

## Step 2 — Put the block on the body

**Before the pull request opens**, stop after the commit: no push and no body
edit. The caller — `prep-pr` Step 9 — appends `$BLOCK` to its body file and
pushes, so the card goes out with the work.

**Once it is open**, a caller about to push the branch (`review-pr` Step 7) does
the same. Otherwise push, then append to the live body; that push starts
another CI run, which is why `prep-pr` runs this before its own push:

```bash
git push
gh pr view "$PR" --json body --jq .body > /tmp/body.md
cat "$BLOCK" >> /tmp/body.md
gh pr edit "$PR" --body-file /tmp/body.md
```

Read the body out and append to it — never compose a new one. The six sections
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
permits exactly six top-level headings, and appending a seventh fails a body that
is otherwise correct.

**When a step here cannot run**, record which and carry on — a missing card
never blocks anything. The exception is `card` exiting 1 because it cannot keep
this pull request's sessions apart from another's: a card on disk that names
another pull request, or an earlier pull request on this branch name whose merge
time is unknown or that closed without merging. If its message shows `gh` named
the wrong pull request, rerun with `--pr <n>`; if it asks for `--resolve-issue`,
rerun with it; otherwise stop — no block, no commit — and quote
it in the final message. No `gh`: write the card with whatever identity you know
and leave the block in a file, naming that file in the final message. No
network: commit the card locally; it pushes with the next push.

**The `SessionEnd` hook is a fallback, not a second writer.** It runs
`card -- --if-absent --resolve-issue`, so it writes a card for a branch that has
none and never touches one this skill committed.

A card with `pr.number: null` was written before its pull request opened: by
Step 1, which names the issue and its rating, or by the hook, which names
neither. Its spend and interaction numbers are as good as any other card's —
only the hook's card misses its identity, and Step 1 fills that in where it can
run.

---

## Finish

Report the card's path, the pull request it names (none yet, when it was
written before the push), the issue and `complexity.declared` it resolved, and
`spend.usd_equivalent`. Say plainly that the analysis half was not run and that
`retro` reads this card later from any session.

Do not offer a summary of what the session cost, and do not volunteer findings.
Someone who wants those runs `retro`.
