---
title: Review Finding IDs
description: Tagging system for security, performance, and test review findings
tags: [convention, review]
related:
  - "[[contributing]]"
  - "[[stacked-prs]]"
last-reviewed: 2026-10-22
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
| `C-C` | review-security (compliance section) | Critical compliance — blocks deploy; fix on this branch or a follow-up PR opened before it merges |
| `C-H` | review-security (compliance section) | High compliance — fix on this branch or a follow-up PR opened before it merges |
| `C-M` | review-security (compliance section) | Medium compliance — fix on this branch or a follow-up PR |
| `C-L` | review-security (compliance section) | Low compliance — fix on this branch or a follow-up PR |

## Numbering

Counters increment within each tier across the full report. For example, a security review might produce two high-severity findings, two medium and one low, each numbered from 1 within its tier.

## Finding Format

Each finding uses a four-field format:

| Field | Purpose |
|-------|---------|
| **Issue** | What is wrong or missing |
| **Why** | Why this matters (risk, impact) |
| **Solution** | Concrete fix or mitigation |
| **Rationale** | Why this solution is the right approach |

## Fix findings; do not file them

> [!important] A session fixes what its reviews find. Everything within the
> feature's scope is fixed on the branch; an issue is left open only for work
> out of the feature's scope, something unrelated found mid-task, or a larger
> piece of work.

An open issue is work handed to a future session that knows less than this one
does. A branch that closes one issue and leaves five behind has made the
backlog longer, so the measure of a session is what it **leaves open**, not
what it files. An issue the session files and its own pull request closes adds
nothing to that count; one filed and left open is a debt.

### In scope is fixed; three things may stay open

**Within the feature's scope, everything is fixed on this branch, at every
severity.** The scope is the files the branch changes, their tests and their
docs, and every finding in those files, whether the branch introduced it or
found it there.

An issue is left open only for something in one of these three, and the report
names which:

1. **Out of scope for the feature.** Real work that belongs to a different
   feature or surface than the one this branch delivers.
2. **Unrelated, and found mid-task.** Something that looks irrelevant to the
   task and only came to light while doing it: a finding in a file the branch
   does not change, even in the same package, a flaky test elsewhere, a stale
   page about another system.
3. **A larger piece of work.** A project of its own — `rate-complexity` would
   rate it 5 or 8 — or one that needs what the session cannot supply: the
   owner's choice between designs, money or a public contract (write the
   proposal and add `needs:decision`, see
   [[#When the fix needs a decision from the owner]]), or production access, a
   secret, a third party or a deploy.

Never reasons to leave something in scope open: "low severity", "pre-existing",
"would make the diff bigger", "a later pull request can tidy it", or the review
running late. A session that runs out of budget, or whose fix failed, says
what it did not reach, to the person, and still files each unfixed `S-`, `P-`
or `C-` finding in the tracker so it keeps an owner — as unfinished work, not
as one of the three.

Some findings ask for no work. An `info` finding is filed in the tracker for
its record and closed at once, so it never counts as open. A `T-S` suggestion, a
nit or an observation is fixed on this branch or recorded in the report, never
filed.

### One follow-up pull request, not one per fix

What is small in the first two goes on **one** follow-up pull request rather
than into issues: every such fix as its own commit on a single second branch
(stacked on this one when it needs this one's code, from `main` otherwise, see
[[stacked-prs]]), opened after this branch's pull request and before the
session ends. Its issues are closed by its merge. Its own reviews do not spawn a
third pull request: what they find out of its scope becomes an issue.

The session that found the work does not cut that branch itself. A session
that cuts two branches leaves its spend on neither metrics card, so it
dispatches a subagent whose prompt opens `TASK-BRANCH: <follow-up branch>`,
which cuts the branch, fixes, and runs `prep-pr`. When any fix is for an `S-`,
`P-` or `C-` finding, the branch name, commit messages and title name the area
or the tracker number, never the defect — `new-feat` Step 0's rule, applied
before the first commit, because the public repository's branch list
publishes the name before the fix lands.

### More than two left open

Count the issues a pull request leaves open that no open pull request will
close. **More than two means something in scope was filed.** Before filing a
third, put the list to the owner; with no owner to ask, fix the in-scope ones
and keep only what fits the three. A reviewer of the work — the orchestrator,
or the owner — checks the count against the tally in the `prep-pr` report and
names any issue that fits none of the three.

### Critical and high

A `critical` or `high` finding is never left open, whichever of the three it
falls in: it is fixed on the branch that found it, or in a pull request opened
immediately after and linked before that branch merges. One that truly needs
the owner — a design choice, a secret, production access — **blocks the merge**
until the fix lands or the owner accepts the risk in writing on its tracker
issue; adding `needs:decision` does not release it. A run with no owner to ask
fixes every `critical` and `high` itself, and one that cannot names each as
blocking and does not call the branch ready.

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
gh issue create --repo <private-tracker> \
  --title "<finding-id> -- No rate limit on /foo endpoint" \
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
- A finding fixed on a branch is closed by that branch's merge: its pull request carries a bare `Closes` line that names the tracker issue. A finding found and fixed on the same branch is filed first, in `/prep-pr` Step 7, so the merge has an issue to close and the tracker keeps the record. A finding dismissed as no defect is filed and closed as not planned, its reasoning in the body.
- A public pull request -- its title, body, comments and commits -- carries a tracker issue only as that bare reference: never the finding ID, the title, the file and line, or a word about the defect. The `write-pr` skill (`.claude/skills/write-pr/SKILL.md`) holds the rule and what to do when the reference itself is refused.
- Sorting is a filter now, not a file convention: `gh issue list --repo <private-tracker> --label severity:high --state open`.
- File new findings from PR reviews immediately, in `/prep-pr` Step 7.
- Findings one branch cannot fix in its own files go on **one** follow-up pull request, one commit per fix -- see [[#One follow-up pull request, not one per fix]] and [[stacked-prs]].

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
gh issue list --repo <private-tracker> --label needs:decision --state open --limit 1000
```

Remove the label once the decision is recorded in a comment; the issue then goes back to being ordinary work.

## Where a finding ID may appear

The ID of a real `S-`, `P-` or `C-` finding names a defect, so it appears only where the tracker's readers are (the IDs on this page are made-up examples): the tracker issue's title, the local `/prep-pr` report, and discussion with the owner. It never appears in the public repository -- not in a pull request's title, body, comments or commits, not in a code comment, not on a wiki page.

| Where | `S-`, `P-`, `C-` | `T-` |
|---|---|---|
| Tracker issue title and body | Yes | Not filed |
| Local `/prep-pr` report, talk with the owner | Yes | Yes |
| Public pull request, its comments and commits | No -- the bare reference to the tracker issue only | Yes |
| Code comments, wiki pages | No | No |

`T-` IDs name coverage gaps, not defects, and nothing files them, so a public pull request may use them: "T-U3 -- this export has no test coverage".

Because the ID leads the tracker title, the ID is how you find the issue again:

```bash
gh issue list --repo <private-tracker> --search "<finding-id> in:title" --state all
```

## Related

- [[contributing]] -- PR workflow and conventions
- [[stacked-prs]] -- opening a PR on top of another PR
- `englishstreetventures/osn-tracker` -- the private repo holding every security, performance, and compliance finding
