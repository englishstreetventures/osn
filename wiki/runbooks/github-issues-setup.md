---
title: GitHub Issues setup (repos, labels, Project)
tags: [runbooks, process, issues]
related:
  - "[[review-findings]]"
  - "[[index]]"
last-reviewed: 2026-08-31
---

# GitHub Issues setup

One-off setup for the move off `wiki/TODO.md`. Written down so it can be redone
— on a fork, after an org rename, or when a label set drifts.

Two repos and one Project:

| Thing | What it holds |
|---|---|
| `xchromo/osn` (public) | Feature work, bugs, ops, docs, schema |
| `xchromo/osn-tracker` (private) | Every security, performance and compliance finding |
| `OSN Platform` (org Project, **private**) | Both repos' issues in one board |

Findings are split off because `xchromo/osn` is public and an open finding is a
disclosure. See `[[review-findings]]` for what may be said in a public issue
about a finding that exists (the ID, nothing else).

## 1. Token scopes

```bash
gh auth status
```

`project` and `read:project` are not in the default `gh` scope set. Without
them every `gh project` command fails with
`your authentication token is missing required scopes`.

```bash
gh auth refresh -h github.com -s project -s read:project
gh project list --owner xchromo   # must not error
```

## 2. Private tracker repo

```bash
gh repo create xchromo/osn-tracker --private \
  --description "Private tracker for OSN security, performance and compliance findings"
```

The issue form for findings lives at `.github/tracker/ISSUE_TEMPLATE/` in this
repo and is copied across on first setup — it is kept here so it is reviewed
with everything else, but GitHub only reads a form from the repo it serves.

```bash
gh api repos/xchromo/osn-tracker/contents/.github/ISSUE_TEMPLATE/review-finding.yml \
  -X PUT -f message="chore: add the review-finding form" \
  -f content="$(base64 -i .github/tracker/ISSUE_TEMPLATE/review-finding.yml)"
```

## 3. Labels

```bash
./scripts/todo-to-issues/labels.sh
```

19 labels per repo: 6 `product:`, 6 `area:`, 5 `severity:`, `epic`, and
`needs:decision`. The script uses `--force`, so re-running it is how a colour
or description is changed. Every issue carries exactly one `product:` and at
most one `area:`; only a finding carries a `severity:`, taken from the tier
letter in its ID. The migration enforced that with a gate over its manifest;
now that issues are filed by hand, `/prep-pr` and `/new-feat` carry the rule.

`needs:decision` is the one label that says nothing about what an issue *is*.
It is a state: the next step needs a choice only the repo owner can make. It
combines with any product, area or severity, and it is the mechanism that keeps
one open question from stalling a backlog — see
`wiki/conventions/review-findings.md` for what the body must say before the
label goes on.

**There is no `area:feature`.** An issue with no `area:` is ordinary product
work, and its type already says `Feature` — a label repeating it would be a
second thing to keep in step for no gain. The label existed on the first run
and was deleted from both repos, which removed it from every issue carrying
it.

## 4. Issue types

Types are an org-level field, separate from labels: a label says which area an
item belongs to, a type says what kind of work it is, and a Project can group
and filter on it. `xchromo` uses the three GitHub creates by default.

```bash
gh api orgs/xchromo/issue-types --jq '.[] | "\(.id)  \(.name)"'
```

| Type | What gets it |
|---|---|
| `Bug` | An `S-*` or `P-*` finding — something behaves wrongly and wants fixing |
| `Feature` | New capability, and product work generally — everything carrying no `area:` label |
| `Task` | The rest: compliance items, ops, schema, docs, epics, and any finding at `severity:info`, which records an observation and asks for no fix |

`/prep-pr` and `/new-feat` follow that mapping when they file an issue.

Epics take `Task` because a custom `Epic` type would need the `admin:org`
scope, and `gh auth refresh` cannot be run by an agent. The `epic` label is
what distinguishes them; add the type later if the scope is ever granted.

Setting a type on an issue that already exists:

```bash
gh issue edit 450 --repo xchromo/osn --type Task
```

The migration set a type on every issue it created, so nothing is outstanding.
To find any that were filed since without one:

```bash
gh issue list --repo xchromo/osn --state all --limit 2000 \
  --json number,title,issueType --jq '.[] | select(.issueType == null) | "\(.number)  \(.title)"'
```

## 5. The Project

```bash
gh project create --owner xchromo --title "OSN Platform"
gh project list --owner xchromo   # note the number, $N below
```

> **Check the visibility before adding a single tracker issue.** A public
> Project lists the titles of every issue in it, including the private ones —
> the whole disclosure the tracker repo exists to prevent. Ours came out
> private, but `gh project create` has no `--visibility` flag to force it, so
> read it back rather than assume:
>
> ```bash
> gh project view $N --owner xchromo --format json --jq '.public'   # must be false
> ```
>
> If it says `true`, fix it first: `gh project edit $N --owner xchromo --visibility PRIVATE`.

A new Project already has a **Status** field, with options Todo / In Progress /
Done. Creating a second one called "Status" is allowed and unhelpful — the board
groups by the built-in one. Rewrite its options in place instead. Get the field
id, then run the mutation:

```bash
gh project field-list $N --owner xchromo --format json \
  --jq '.fields[] | select(.name == "Status") | .id'     # PVTSSF_…

gh api graphql -F field=PVTSSF_… -f query='
mutation($field: ID!) {
  updateProjectV2Field(input: { fieldId: $field, singleSelectOptions: [
    { name: "Backlog",     color: GRAY,   description: "Filed, not scheduled" }
    { name: "Up Next",     color: BLUE,   description: "Scheduled for the current push" }
    { name: "In Progress", color: YELLOW, description: "Someone is working on it" }
    { name: "In Review",   color: PURPLE, description: "PR open, awaiting review" }
    { name: "Blocked",     color: RED,    description: "Waiting on something outside the work" }
    { name: "Done",        color: GREEN,  description: "Merged or closed" }
  ]}) { projectV2Field { ... on ProjectV2SingleSelectField { name options { name } } } }
}'
```

`singleSelectOptions` replaces the whole list, so name every option you want to
keep. An option dropped here is cleared from every item that held it.

The other two fields don't exist yet, so they are ordinary creates:

```bash
gh project field-create $N --owner xchromo --name "Priority" \
  --data-type SINGLE_SELECT --single-select-options "P0,P1,P2,P3"
gh project field-create $N --owner xchromo --name "Effort" \
  --data-type SINGLE_SELECT --single-select-options "XS,S,M,L,XL"
```

## 6. Workflows (UI only — no API)

Project → the **⋯** menu, top right → **Workflows**. Each one is Edit, fill in,
then **Save and turn on workflow**.

1. **Auto-add to project** — filter `is:issue is:open`, one repo per workflow.
   **`xchromo` is on GitHub Free, and Free allows one auto-add workflow per
   project.** Two repos feed this board, so one of them gets it and the other
   is swept by hand. Put it on `xchromo/osn-tracker`: findings arrive in bursts
   at the end of a review and are the easy ones to forget, while a product
   issue is opened deliberately. Sweeping the other repo is one command —
   see the backfill below — and the choice is one edit to reverse.
2. **Item added to project** — set `Status` = `Backlog`. This one is off; turn
   it on whether or not auto-add is.

**Auto-add sub-issues to project** is already on, so a sub-issue opened under
an epic that is on the board joins it too.

Do this **before** the migration runs if you can. Auto-add is what makes the
migration cost zero Project API calls.

**It did not happen that way on the first run.** Creating the Project needs the
`project` scope, and `gh auth refresh` cannot be run by an agent — it is
interactive. Rather than stall the whole migration on one token grant, the
issues were created first and the Project comes second. Auto-add only fires on
issues opened *after* the workflow is enabled, so everything created before it
has to be backfilled:

```bash
bun run scripts/todo-to-issues/backfill-project.ts $N          # dry run, prints the plan
bun run scripts/todo-to-issues/backfill-project.ts $N --apply
```

It enumerates both repos with `gh issue list` — not `.migration/created.json`.
That file records only what the migration wrote, and issues filed by hand since
belong on the board just as much.

It skips anything already there, so a re-run costs nothing and the dry run is
the check that it is finished. Adding an item is an ordinary mutation rather
than content creation, so it throttles at 1.5s, not the 8s the issue writer uses.
It took three runs to clear the whole board — see §Rate limits worth knowing for
why, and expect the same of any later bulk add. The dry run now reports
`676 issues, 676 on the board, 0 to add`.

It stays useful after the migration: auto-add covers one repo, so run the dry
run over the other now and then and `--apply` when it finds anything.

## 7. Views (UI only)

New view: the **+** at the right of the view tabs. Its settings are the **View**
menu beside the search bar (layout, group, slice, fields), and its filter is the
search bar itself — there is no filter dropdown, you type the query.

| View | Layout | Settings | Filter to type |
|---|---|---|---|
| Board | Board | Group by **Status** | — |
| By product | Table | **Slice by** → **Labels** | — |
| By type | Table | Group by **Type** | — |
| Review findings | Table | **Slice by** → **Labels** | `repo:xchromo/osn-tracker is:open` |
| Up Next | Board | Group by **Status** | `status:"Up Next","In Progress"` |

Three things about that table are not obvious, and each one cost a search:

- **You cannot group by Labels.** GitHub excludes title, labels, reviewers and
  linked pull requests from grouping, and the option simply is not in the list.
  **Slice by** takes Labels — it puts a label list down the left and filters the
  table to whichever one you click, which is what grouping by product was for.
  Slice is per-view, so "By product" and "Review findings" can both use it.
- **A colon inside a label name has to be quoted**, because the filter already
  uses colons: `label:"product:cire"`, never `label:product:cire`. Comma between
  values is OR, a space between qualifiers is AND —
  `label:"area:security","area:performance"` is either of those two.
- **Type is the org issue type**, not a project field, and it filters as
  `type:"Bug"`. The board has no Product, Area or Severity field; those live on
  the issues as labels, which is why the views reach for Slice by.

`repo:` is what keeps "Review findings" honest — every issue in the tracker is a
finding, so naming the repo beats listing three `area:` labels and missing the
fourth.

## 8. Record the numbers

Fill these in once, here:

- Project number: `1` — <https://github.com/orgs/xchromo/projects/1> (private)
- Tracker repo: <https://github.com/xchromo/osn-tracker>

## What is left of the migration tool

`scripts/todo-to-issues/` now holds three things, and they are the three that
still run:

| File | Why it stays |
|---|---|
| `labels.sh` | Recreates the label set in both repos, any time (§3) |
| `backfill-project.ts` | Puts issues on the board until auto-add is enabled (§6) |
| `throttle.ts` | The rate-limit gap the backfill uses |

Everything else — the parser, the classifier, the link rewriter, the renderer,
the manifest gate, the issue writer and the `main.ts` that drove them — read the
checklists Phase 4 deleted. They could not be run again without them, so they
were removed rather than left looking usable. The commands they backed
(`migrate:plan`, `migrate:apply`, `migrate:verify`, `migrate:resync`) are gone
from `package.json` with them. The code is in git history, and the plan and
spec under `docs/superpowers/` describe it in full.

`.migration/created.json` stays, tracked: it maps each source checklist line to
the issue that replaced it, which is the only record of where an issue came
from.

## What the parser missed

The item pattern was `/^- \[( |x)\]\s+(.*)$/` — column 0, and either ` ` or
`x` in the box. A `- [~]` line (in-progress, used in the cire checklists) is
therefore not an item at all. It does not open one, so it never flushes, and
its indented children were folded into whichever item came before it. Three
issues had to be opened by hand afterwards and linked to their epics: #698 and
#699 (the nested `Registry` children in `cire/wiki/todo/platform.md`) under
epic #482, and #700 (the batch-import child in
`cire/wiki/todo/spreadsheet-import.md`) under epic #456. They are recorded in
`.migration/created.json` under their source lines like any other item.

Nothing else in the sources used `[~]`. If these files are ever re-parsed from
git history, widen the character class first.

## Rate limits worth knowing

The primary limit (5,000 REST requests/hour) is not the one that bites. The
secondary content-creation limit is: **80 creations per minute and 500 per
hour**, counted across issues, comments and sub-issue links together. The
migration writer self-throttles to 450/hour with an 8s gap. Exceeding it earns
a 403 with a `Retry-After`, and repeatedly ignoring that earns a longer block.

Putting issues on the board is a third limit again: `gh project item-add` is a
GraphQL call, and GraphQL has its own **5,000 points per hour**. Backfilling all
676 issues outspends one hour of it, so `backfill-project.ts` stops on the quota,
prints how far it got, and leaves the rest to the next run — nothing is lost,
because it reads the board each time and adds only what is missing. Two failures
are expected there and neither is a fault: `Content already exists in this
project` (the item list pages, so a long run races the board it read) is counted,
and the quota message ends the run cleanly. Watching CI with `gh pr checks
--watch` spends from the same GraphQL pool, so don't run one alongside a backfill.

Other ceilings, none of them close: 50,000 items per Project, 100 sub-issues
per parent, 8 levels of sub-issue nesting.
