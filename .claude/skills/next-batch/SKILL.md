---
name: next-batch
description: Use when deciding what to work on next or what is already in flight — reading the OSN Platform project board's In Review, In Progress and Up Next columns, choosing a batch of issues for orchestrate, or checking that no other session holds an issue before anyone builds it.
---

# Pick the next batch

Read the board, triage every Up Next item, and hand `orchestrate` a batch it can run. You choose the work; you do not plan or build it. §Claim below is also the check `orchestrate` and `new-feat` run before anyone builds an issue.

## What this run must produce

A block at the end of the orchestrate blackboard, `/Users/ac/.work/osn.git/main/ORCHESTRATE.md`, then `orchestrate` invoked with the batch as its task list.

```markdown
## next-batch — 2026-10-08 (board: 72 items read)
In Review:   osn#1417 CI red, flaky recovery test → rerun · osn#1418 DIRTY on scripts/lint-warning-ceiling.txt
In Progress: osn#1291 live (task above) · osn-tracker#427 looks stale, no PR or worktree → Q2
Batch:       1. osn#1301 (cire/api/src/services/tiers.ts) · 2. osn-tracker#755 (.github/workflows/deploy.yml)
Queue:       osn#1395 after osn#1301 (same file) · osn#1389
Skipped:     osn#1381 blocked by an upstream release · osn#1385 epic → orchestrate Step 00 · …
Questions:   Q1. osn#1328 needs:decision — proposal: … · Q2. release osn-tracker#427 to Up Next?
```

Every Up Next item appears under Batch, Queue, Skipped or Questions. One that appears nowhere was not read.

Read the file before writing to it. If every task in it is merged or dropped, move it to `ORCHESTRATE-<date of its first entry>.md` and start a new one. If any task is still open, add the block at the end and change nothing above it.

## The API budget

GitHub's GraphQL limit, 5,000 points an hour, is shared by every agent on the account, CI polling included. `gh project`, `gh issue view`, `gh pr view`, `gh pr list` and `gh pr checks` spend it, and a drained pool fails them all. Read through REST (`gh api orgs/…`, `gh api repos/…`), and fetch the board once per triage. Do not trust `gh api rate_limit`: it has shown a full GraphQL pool while every GraphQL call was refused.

## Step 1 — Read the board once

```bash
gh api orgs/englishstreetventures/projectsV2/1/fields \
  --jq '.[] | select(.name=="Status") | {id, options: [.options[] | {id, name: .name.raw}]}'
gh api --paginate --slurp -X GET orgs/englishstreetventures/projectsV2/1/items -f per_page=100 \
  -f fields=<Status field id> -f q='status:"In Review","In Progress","Up Next"' > /tmp/board-raw.json
jq '[add[] | {item: .id, repo: (.content.repository_url | split("/") | last), n: .content.number,
  status: ([.fields[] | select(.name=="Status") | .value.name.raw][0]),
  labels: [.content.labels[].name], title: .content.title, body: .content.body}]' \
  /tmp/board-raw.json > /tmp/board.json
gh api 'repos/englishstreetventures/osn/pulls?state=open&per_page=100' \
  --jq '[.[] | {number, ref: .head.ref, title, body}]' > /tmp/open-prs.json
```

- The owner is `englishstreetventures`. `gh issue` and `gh pr` follow the old `englishstventures` redirect; the project calls do not.
- `--paginate` follows every page. The GraphQL way, `gh project item-list`, returns 30 items by default and truncates at `--limit` without a warning: it needs `--limit 2000` and `.items|length` equal to `.totalCount`.
- `/tmp/board.json` holds each item's REST id (`item`), status, labels, title and body, and `/tmp/open-prs.json` every open PR. Triage works from these two files; §Claim is the one deliberate second read.
- Standing owner rules at the top of `ORCHESTRATE.md` (scope, products to skip) still apply. Ask about any that looks out of date rather than dropping it.
- The board mixes `englishstreetventures/osn` with the private `englishstreetventures/osn-tracker`, and numbers repeat across the two. Write every item as `osn#N` or `osn-tracker#N`, and use the item's `repo` in every call.

## Step 2 — In Review: finish before starting

Open pull requests come first, and fixing them counts against agent capacity. Match each item to its PR in `/tmp/open-prs.json` by body, branch or title (a tracker fix's branch is `fix/tracker-<n>` or names its area), or through the issue's timeline (§Claim, step 1). Then:

```bash
gh api repos/englishstreetventures/osn/pulls/<pr> --jq '{state, merged, mergeable_state, sha: .head.sha}'
gh api repos/englishstreetventures/osn/commits/<sha>/check-runs \
  --jq '.check_runs[] | select(.conclusion=="failure") | .name'
```

Record CI red (the job and its decisive line), `dirty` or `behind` (sibling PRs collide on `scripts/lint-warning-ceiling.txt`), an owner question left in the comments, or no PR at all (the card is wrong: a question). `orchestrate` Step 5 does the fixing.

## Step 3 — In Progress: hands off

Another session holds each of these. Never dispatch onto one and never move one. Mark each live or stale:

- **Live**: an open PR refers to it, or a worktree (`git -C /Users/ac/.work/osn.git worktree list`) or an open task in `ORCHESTRATE.md` names it.
- **Stale**: the issue is closed, or its PR merged and the card did not move; or there is no PR, no worktree and no open task.

A stale card is a question: release it to Up Next? Only the owner releases another session's claim.

## Step 4 — Up Next: read every item

Read each body and its labels; the blockers and open choices are in the body, not the title. Read in slices of ten (`jq '[.[] | select(.status=="Up Next")][0:10]' /tmp/board.json`, then `[10:20]` …) so none gets skimmed. Send each item to the first row that fits:

| Item | Goes to |
|---|---|
| `needs:decision` label | Questions, with the proposal from the body. Never dispatched. |
| Blocked status, "Depends on #N" with N still open, or a condition in the body not yet met ("only if a measurement shows …") | Skipped, naming N or the condition. |
| `complexity:8`, the `epic` label, or a body that is a spec (open scope, several subsystems) | Skipped → `orchestrate` Step 00, designed with the owner. |
| Its premise is false on main: a named file, script or route moved or gone, or the work already landed | Moved: batch it, with the new path in its brief. Obsolete: a question proposing to close it, with the evidence (`git log -S`, the path as it is today). |
| Leaves a choice open with no recommendation: behaviour, copy, or which of two approaches | Questions, one per choice: the width, whether it can be dismissed, which option is highlighted, the default. Answered before dispatch, never left to the builder. Where the body recommends an option, take it and say so. |
| An open PR names it (`/tmp/open-prs.json`), or its parent is In Progress or In Review | Skipped as held. |
| Anything else | A batch candidate. |

An unrated item goes through `rate-complexity`, with the owner if they are here and its unattended path if not. Work may go ahead on an unconfirmed rating; never confirm a rating yourself.

## Step 5 — Form the batch

- **Capacity.** About three code-writing agents at once, one per pull request however many issues it closes, counting In Review fixes and tasks already running. Five or six at once have stopped every agent on usage limits. Start fewer when pull requests are already waiting on the owner's review, and write in the block how many are waiting and why you chose the number. The rest becomes the Queue, in order.
- **Files.** Name the files each item touches. Two items that edit the same file go in one PR or run one after the other, never in parallel.
- **One PR for several items** only when they are one unit of work: the same files, one read for the reviewer.
- **Tracker items** (`osn-tracker`) take `new-feat`'s tracker path for the branch name, and the PR body carries only a bare `Closes englishstreetventures/osn-tracker#<n>` line (`write-pr`).
- `pick-agent` chooses each agent.

## Step 6 — Write, ask, hand off

Write the block. Ask the owner the Questions, each with its proposal, those that block a batch item first. Then invoke `orchestrate` with the batch as its task list: the issues, their order and their files. `orchestrate` claims each one at its Step 2.

## Claim

The check and the write that stop two sessions building one issue. `orchestrate` runs it at Step 2, just before `git worktree add`. `new-feat` runs it at Step 0, unless its brief carries `CLAIMED: <repo>#<n>`. Nothing runs between the check and the write, an owner question least of all.

**1. Check.** The snapshot is stale by now, so read who holds what again, then the issue's links and blockers:

```bash
gh api --paginate --slurp -X GET orgs/englishstreetventures/projectsV2/1/items -f per_page=100 \
  -f fields=<Status field id> -f q='status:"In Progress","In Review"' > /tmp/held-raw.json
jq '[add[] | "\(.content.repository_url | split("/") | last)#\(.content.number)"]' /tmp/held-raw.json
gh api --paginate 'repos/englishstreetventures/<repo>/issues/<n>/timeline?per_page=100' \
  --jq '.[] | select(.event=="cross-referenced" and .source.issue.pull_request and .source.issue.state=="open") | .source.issue.html_url'
gh api repos/englishstreetventures/<repo>/issues/<n>/parent --jq .number    # HTTP 404 "No parent issue found": none
gh api 'repos/englishstreetventures/<repo>/issues/<n>/sub_issues?per_page=100' --jq '.[] | select(.state=="open") | .number'
gh api repos/englishstreetventures/<repo>/issues/<n>/dependencies/blocked_by --jq '.[] | select(.state=="open") | .number'
```

An open blocker sends the task back to the Queue. The issue is held when it, its parent or an open sub-issue is in the first list, or an open PR refers to it. A reference is not always a claim, since a PR also names the issues it opened, so read each PR before believing it. A tracker fix's PR often names nothing, which leaves the Status as the whole claim. Held: skip it and say why. Any other failed call (the parent's 404 aside) means the answer is unknown: do not claim and do not dispatch. No status at all means unclaimed.

**2. Write it**, with the item's REST id from `/tmp/board.json`:

```bash
gh api -X PATCH orgs/englishstreetventures/projectsV2/1/items/<item> \
  -F 'fields[][id]=<Status field id>' -f 'fields[][value]=<In Progress option id>'
```

An item outside the snapshot, such as a child of an epic, needs its id from GraphQL (one point):

```bash
gh api graphql -f query='{repository(owner:"englishstreetventures",name:"<repo>"){issue(number:<n>){projectItems(first:5){nodes{fullDatabaseId project{number}}}}}}'
```

Taking an epic claims every child it will build.

**3. Record it** as `claimed: <repo>#<n> item <item>` in the task's block in `ORCHESTRATE.md`. The board says an issue is held, not by whom; that line is how a run knows its own claims after a compaction.

**4. Move it on.** PR opened → In Review, with the same `PATCH`. Task dropped → back to Up Next, with the reason in `ORCHESTRATE.md`. Parked until a limit resets → it stays In Progress, and `next:` says why. Never set Done: merging closes the issue, and the board moves a closed issue's card.

The claim is the Status, not an assignee: every session runs as the same GitHub user, and `new-feat` and the owner already read the board by Status.

## Common mistakes

| Mistake | Instead |
|---|---|
| Counting only the new batch against capacity | Running tasks and In Review fixes count too; about three in all |
| Two items that edit one file run in parallel, "the second one rebases" | One PR, or one after the other |
| `gh issue edit --add-assignee @me` as the claim | The Status; an assignee cannot tell sessions apart |
| Moving another session's In Progress card | A question to the owner |
| An issue number without its repository | `osn#N` or `osn-tracker#N`; the numbers repeat |
| A rate-limit error read as "not claimed" | Unknown: wait, then check again |
