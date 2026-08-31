---
title: Review Finding IDs
description: Tagging system for security, performance, and test review findings
tags: [convention, review]
related:
  - "[[contributing]]"
  - "[[stacked-prs]]"
last-reviewed: 2026-08-31
---

# Review Finding IDs

All review skills (`/review-security`, `/review-performance`, `/review-tests`) tag findings with short IDs, so you can refer to them precisely in discussions, PR comments, and issue titles.

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
| `C-M` | review-security (compliance section) | Medium compliance — schedule into next sprint |
| `C-L` | review-security (compliance section) | Low compliance — opportunistic fix or hardening |

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

## Filing a finding

Findings live in **`xchromo/osn-tracker`**, a private repo. `xchromo/osn` is public, and a finding names an unpatched route -- filing one there publishes an attack map. Route by *kind*, never by severity: an `S-`, `P-`, or `C-` ID goes to the tracker however minor it looks.

### The body has to stand alone

An issue is read once, months later, by someone with no branch checked out and no wiki open. It carries its own evidence or it carries nothing.

- **Name the file and line** in **Issue**. "Missing rate limit" is not a location.
- **State the fix** in **Solution** — the function to call, the column to add, the header to set. Not "add a limit".
- **No pointer-only bodies.** "See `wiki/todo/api.md`", "tracked in the TODO", "migrated from <file>" is a bookmark, not an issue. The page it points at moves, gets rewritten, or is deleted — the migration of 2026-08-15 deleted every one of them.
- **Wiki links are context, never the content.** Where a page genuinely helps, name it by repo path (`wiki/systems/rate-limiting.md`) and still put the fact in the issue. A `[[wikilink]]` does not resolve on GitHub.
- **Spell out the acronyms and IDs** the body leans on the first time they appear. The ID in the title is a handle, not an explanation.

One issue per finding, with the ID leading the title and the four fields as the body:

```bash
gh issue create --repo xchromo/osn-tracker \
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
- A finding fixed on the branch that found it gets no issue of its own: put `Closes xchromo/osn-tracker#<n>` in the PR body, or if no issue existed, open one and close it with a comment naming the PR.
- Reference tracker issues from a public PR by number and finding ID only -- never the title, the file:line, or the body.
- Sorting is a filter now, not a file convention: `gh issue list --repo xchromo/osn-tracker --label severity:high --state open`.
- File new findings from PR reviews immediately, in `/prep-pr` Step 7.
- Several findings from one piece of work go on **stacked PRs**, one fix per PR, base of each set to the one below it -- see [[stacked-prs]].

`T-*` test findings are not filed. They are coverage gaps, not defects -- `/prep-pr` Step 4 raises them and they get closed in the branch or waved through.

## When the fix needs a decision from the owner

Some issues cannot be closed by anyone but the repo owner: the fix is a choice between two defensible designs, or it costs money, or it changes a public contract. An agent working the backlog must not guess at those, and must not stop on them either -- one open question is not a reason for the other hundred issues to sit still.

Label it and move on:

```bash
gh issue edit <n> --repo xchromo/osn-tracker --add-label "needs:decision"
```

`needs:decision` exists on both repos. It is orthogonal to `product:`, `area:` and `severity:` -- it says the issue is parked on a person, not what kind of work it is.

Before the label goes on, the body has to carry exactly two things, in this order:

1. **What the issue actually is** -- the file and line, the current behaviour, and why it is wrong. The same standard as any other body: someone opens it months later with nothing checked out.
2. **A proposed solution, with the trade-off named** -- the option you would take, what it costs, and what the alternative buys instead. "Needs a decision" without a proposal hands the owner the whole problem back; the point of the label is that the thinking is done and only the choice is left.

A body that says no more than "blocked, needs input" is not an issue, it is an interruption. Write the proposal first, then apply the label, then pick up a different issue.

Filter for them when the owner sits down to clear the queue:

```bash
gh issue list --repo xchromo/osn --label needs:decision --state open --limit 1000
gh issue list --repo xchromo/osn-tracker --label needs:decision --state open --limit 1000
```

Remove the label once the decision is recorded in a comment; the issue then goes back to being ordinary work.

## Usage in PR Comments

Finding IDs make PR discussions precise:

- "Fix S-H1 before merging"
- "P-C2 still open -- needs the batch query"
- "S-M34 is a known limitation, tracked in osn-tracker#412"
- "T-U3 -- this export has no test coverage"

Because the ID leads the title, the ID is also how you find the issue again:

```bash
gh issue list --repo xchromo/osn-tracker --search "S-M34 in:title" --state all
```

## Related

- [[contributing]] -- PR workflow and conventions
- [[stacked-prs]] -- opening a PR on top of another PR
- `xchromo/osn-tracker` -- the private repo holding every security, performance, and compliance finding
