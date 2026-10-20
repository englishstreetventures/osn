---
title: Review Finding IDs
description: Tagging system for security, performance, and test review findings
tags: [convention, review]
related:
  - "[[contributing]]"
  - "[[stacked-prs]]"
last-reviewed: 2026-10-20
---

# Review Finding IDs

All review skills (`/review-security`, `/review-performance`, `/review-tests`) tag findings with short IDs, so you can refer to them precisely in discussion and in tracker issue titles. Where an ID may and may not appear is in [[#Where a finding ID may appear]].

## Prefix Table

| Prefix | Skill | Tier |
|--------|-------|------|
| `S-C` | review-security | Critical |
| `S-H` | review-security | High |
| `S-M` | review-security | Medium |
| `S-L` | review-security | Low |
| `P-C` | review-performance | Critical |
| `P-W` | review-performance | Warning |
| `P-I` | review-performance | Info |
| `T-M` | review-tests | Missing file |
| `T-U` | review-tests | Untested export |
| `T-E` | review-tests | Error path |
| `T-R` | review-tests | Route test |
| `T-S` | review-tests | Suggestion |
| `C-C` | review-security (compliance section) | Critical compliance — blocks deploy / triggers regulatory exposure |
| `C-H` | review-security (compliance section) | High compliance — fix before next release |
| `C-M` | review-security (compliance section) | Medium compliance — fix on this branch or a follow-up PR |
| `C-L` | review-security (compliance section) | Low compliance — fix on this branch or a follow-up PR |

## Numbering

Counters increment within each tier across the full report. For example, a security review might produce:

- `S-H1` -- first high-severity finding
- `S-H2` -- second high-severity finding
- `S-M1` -- first medium-severity finding
- `S-M2` -- second medium-severity finding
- `S-L1` -- first low-severity finding

## Finding Format

Each finding uses a four-field format:

| Field | Purpose |
|-------|---------|
| **Issue** | What is wrong or missing |
| **Why** | Why this matters (risk, impact) |
| **Solution** | Concrete fix or mitigation |
| **Rationale** | Why this solution is the right approach |

## Fix findings; do not file them

> [!important] A session fixes what its reviews find. Every finding, test gap,
> stale page or bug found on the way goes down the ladder below, and an issue
> left open for later is the last rung, reached only through a named exception.

An open issue is work handed to a future session that knows less than this one
does. A branch that closes one issue and leaves five behind has made the
backlog longer, so the measure of a session is what it **leaves open**, not
what it files. An issue the session files and its own pull request closes adds
nothing to that count; one filed and left open is a debt.

### The ladder

Take the first rung that fits:

1. **Fix it on this branch.** The default, at every severity. Anything in code
   the branch touches, in a package it already changes, or a fix a reviewer
   could read in one sitting belongs here.
2. **Fix it in a follow-up pull request, in this session.** When the fix would
   blur the branch — another package, an unrelated domain, a change that
   deserves its own review — cut a second branch (stacked on this one when it
   needs this one's code, from `main` otherwise, see [[stacked-prs]]), fix it
   there, and open that pull request before the session ends. Its issue, when
   it needs one, is closed by that pull request's merge.
3. **Leave an issue open**, only when one of these holds and the report names
   which:
   - **It needs the owner.** Two defensible designs, money, or a change to a
     public contract: write the proposal and add `needs:decision` (see
     [[#When the fix needs a decision from the owner]]).
   - **It needs what the session cannot have.** Production access, a secret,
     a third party, a deploy.
   - **It is a project of its own.** `rate-complexity` would rate it 5 or 8:
     several packages, or a shape nobody knows yet.

Not on that list, and so never a reason to file and move on: "out of scope for
this branch", "pre-existing", "low severity", "would make the diff bigger", or
the review running late. A session that runs out of budget says which rungs it
did not reach, to the person, rather than filing them silently.

Some findings are not issues at all. An `info` finding, a `T-S` suggestion, a
nit or an observation is fixed on this branch or recorded in the report, never
filed.

**More than two left open by one pull request means the ladder was skipped.**
Before filing a third, put the list to the owner; with no owner to ask, take
the remainder to rung 2.

### Critical and high

A `critical` or `high` finding gets only the first two rungs: fixed on the
branch that found it, or in a pull request opened immediately after and linked
before that branch merges. Neither exception in rung 3 applies; one that truly
needs the owner is put to them before the branch merges.

The reasoning is the same one that makes the tracker private. A filed-and-open
`critical` or `high` is a live, unpatched defect whose location is now written
down; the issue is an attack map with a timer on it. A finding fixed in the
same breath as it is found never becomes that.

**Downgrading severity to avoid the rule is the failure mode.** Severity comes
from the tier letter in the finding ID, which the review assigns before anyone
knows what fixing it would cost. Re-rating it afterwards to make it deferrable
is the same contamination as re-rating an issue's complexity once its token
cost is on screen.

## Filing a finding

Findings live in **`englishstreetventures/osn-tracker`**, a private repo. `englishstreetventures/osn` is public, and a finding names an unpatched route -- filing one there publishes an attack map. Route by *kind*, never by severity: an `S-`, `P-`, or `C-` ID goes to the tracker however minor it looks.

### The body has to stand alone

An issue is read once, months later, by someone with no branch checked out and no wiki open. It carries its own evidence or it carries nothing. The `write-issue` skill (`.claude/skills/write-issue/SKILL.md`) holds the writing rules for every issue body; this page holds what is particular to a finding.

- **Name the file and line** in **Issue**. "Missing rate limit" is not a location.
- **State the fix** in **Solution** — the function to call, the column to add, the header to set. Not "add a limit".
- **No pointer-only bodies.** "See `wiki/todo/api.md`", "tracked in the TODO", "migrated from <file>" is a bookmark, not an issue. The page it points at moves, gets rewritten, or is deleted — the migration of 2026-08-15 deleted every one of them.
- **Wiki links are context, never the content.** Where a page genuinely helps, name it by repo path (`wiki/shared/rate-limiting.md`) and still put the fact in the issue. A `[[wikilink]]` does not resolve on GitHub.
- **Spell out the acronyms and IDs** the body leans on the first time they appear. The ID in the title is a handle, not an explanation.

One issue per finding, with the ID leading the title and the four fields as the body:

```bash
gh issue create --repo englishstreetventures/osn-tracker \
  --title "S-M3 -- No rate limit on /foo endpoint" \
  --type Bug \
  --label "area:security" --label "severity:medium" --label "product:cire"
```

`--type` is the org-level issue type, which the Project groups on. `S-*` and `P-*` findings are `Bug`: something already built behaves wrongly. `C-*` compliance items are `Task`, and so is anything filed at `severity:info` -- it records an observation and asks for no fix.

Labels, exactly one of each:

| Label | Value |
|-------|-------|
| `area:` | `security` for `S-*`, `performance` for `P-*`, `compliance` for `C-*` |
| `severity:` | from the tier letter -- `C` -> `critical`, `H`/`W` -> `high`, `M` -> `medium`, `L` -> `low`, `I` -> `info` |
| `product:` | `osn-core`, `pulse`, `cire`, `zap`, `shared`, `landing` |

Rules:

- **Close a finding, never delete it** -- the history matters, and a closed issue keeps the body, the fix commit, and the discussion. Deleting an issue is out of bounds for every script and command in this repo.
- A finding fixed on a branch is closed by that branch's merge: its pull request carries a bare `Closes englishstreetventures/osn-tracker#<n>` line. A finding found and fixed on the same branch is filed first, in `/prep-pr` Step 7, so the merge has an issue to close and the tracker keeps the record. A finding dismissed as no defect is filed and closed as not planned, its reasoning in the body.
- A public pull request -- its title, body, comments and commits -- carries a tracker issue only as that bare reference: never the finding ID, the title, the file and line, or a word about the defect. The `write-pr` skill (`.claude/skills/write-pr/SKILL.md`) holds the rule and what to do when the reference itself is refused.
- Sorting is a filter now, not a file convention: `gh issue list --repo englishstreetventures/osn-tracker --label severity:high --state open`.
- File new findings from PR reviews immediately, in `/prep-pr` Step 7.
- Several findings from one piece of work go on **stacked PRs**, one fix per PR, base of each set to the one below it -- see [[stacked-prs]].

`T-*` test findings are not filed. They are coverage gaps, not defects -- `/prep-pr` Step 4 raises them and the branch writes the missing tests before it opens. A `T-S` suggestion the branch declines is a line in the report, not an issue.

## When the fix needs a decision from the owner

Some issues cannot be closed by anyone but the repo owner: the fix is a choice between two defensible designs, or it costs money, or it changes a public contract. An agent working the backlog must not guess at those, and must not stop on them either -- one open question is not a reason for the other hundred issues to sit still.

Label it and move on:

```bash
gh issue edit <n> --repo englishstreetventures/osn-tracker --add-label "needs:decision"
```

`needs:decision` exists on both repos. It is orthogonal to `product:`, `area:` and `severity:` -- it says the issue is parked on a person, not what kind of work it is.

Before the label goes on, the body has to carry exactly two things, in this order:

1. **What the issue actually is** -- the file and line, the current behaviour, and why it is wrong. The same standard as any other body: someone opens it months later with nothing checked out.
2. **A proposed solution, with the trade-off named** -- the option you would take, what it costs, and what the alternative buys instead. "Needs a decision" without a proposal hands the owner the whole problem back; the point of the label is that the thinking is done and only the choice is left.

A body that says no more than "blocked, needs input" is not an issue, it is an interruption. Write the proposal first, then apply the label, then pick up a different issue.

Filter for them when the owner sits down to clear the queue:

```bash
gh issue list --repo englishstreetventures/osn --label needs:decision --state open --limit 1000
gh issue list --repo englishstreetventures/osn-tracker --label needs:decision --state open --limit 1000
```

Remove the label once the decision is recorded in a comment; the issue then goes back to being ordinary work.

## Where a finding ID may appear

The ID of a real `S-`, `P-` or `C-` finding names a defect, so it appears only where the tracker's readers are (the IDs on this page are made-up examples): the tracker issue's title, the local `/prep-pr` report, and discussion with the owner. It never appears in the public repository -- not in a pull request's title, body, comments or commits, not in a code comment, not on a wiki page.

| Where | `S-`, `P-`, `C-` | `T-` |
|---|---|---|
| Tracker issue title and body | Yes | Not filed |
| Local `/prep-pr` report, talk with the owner | Yes | Yes |
| Public pull request, its comments and commits | No -- the bare `englishstreetventures/osn-tracker#<n>` reference only | Yes |
| Code comments, wiki pages | No | No |

`T-` IDs name coverage gaps, not defects, and nothing files them, so a public pull request may use them: "T-U3 -- this export has no test coverage".

Because the ID leads the tracker title, the ID is how you find the issue again:

```bash
gh issue list --repo englishstreetventures/osn-tracker --search "S-M34 in:title" --state all
```

## Related

- [[contributing]] -- PR workflow and conventions
- [[stacked-prs]] -- opening a PR on top of another PR
- `englishstreetventures/osn-tracker` -- the private repo holding every security, performance, and compliance finding
