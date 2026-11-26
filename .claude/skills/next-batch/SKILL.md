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
In Review:   osn#1417 CI red, flaky recovery test → rerun · osn#1418 DIRTY on cire/api/src/routes/organiser-rsvp.ts
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
  -f fields=<Status field id>,449016881,449016914 \
  -f q='status:"In Review","In Progress","Up Next"' > /tmp/board-raw.json
jq '[add[] | {item: .id, repo: (.content.repository_url | split("/") | last), n: .content.number,
  status: ([.fields[] | select(.name=="Status") | .value.name.raw][0]),
  heldBy: ([.fields[] | select(.name=="Held by") | .value.raw][0]),
  lastTouched: ([.fields[] | select(.name=="Last touched") | .value][0] // "" | .[0:10]),
  labels: [.content.labels[].name], title: .content.title, body: .content.body}]' \
  /tmp/board-raw.json > /tmp/board.json
gh api 'repos/englishstreetventures/osn/pulls?state=open&per_page=100' \
  --jq '[.[] | {number, ref: .head.ref, title, draft, body}]' > /tmp/open-prs.json
```

- The owner is `englishstreetventures`.
- `--paginate` follows every page. The GraphQL way, `gh project item-list`, returns 30 items by default and truncates at `--limit` without a warning: it needs `--limit 2000` and `.items|length` equal to `.totalCount`.
- `449016881` and `449016914` are the **Held by** and **Last touched** fields (§Claim step 2).
- `/tmp/board.json` holds each item's REST id (`item`), status, holder, last-touched date, labels, title and body, and `/tmp/open-prs.json` every open PR. Triage works from these two files; §Claim is the one deliberate second read.
- Standing owner rules at the top of `ORCHESTRATE.md` (scope, products to skip) still apply. Ask about any that looks out of date rather than dropping it.
- The board mixes `englishstreetventures/osn` with the private `englishstreetventures/osn-tracker`, and numbers repeat across the two. Write every item as `osn#N` or `osn-tracker#N`, and use the item's `repo` in every call.

## Step 2 — In Review: finish before starting

Open pull requests come first, and fixing them counts against agent capacity. Match each item to its PR in `/tmp/open-prs.json` by body, branch or title (a tracker fix's branch is `fix/tracker-<n>` or names its area), or through the issue's timeline (§Claim, step 1). Then:

```bash
gh api repos/englishstreetventures/osn/pulls/<pr> --jq '{state, merged, mergeable_state, sha: .head.sha}'
gh api "repos/englishstreetventures/osn/commits/<sha>/check-runs?per_page=100" \
  --jq '.check_runs[] | select(.conclusion=="failure") | .name'
gh api "repos/englishstreetventures/osn/actions/runs?head_sha=<sha>&event=pull_request" \
  --jq '[.workflow_runs[] | select(.path == ".github/workflows/ci.yml")] | length'
```

Record CI red (the job and its decisive line), CI never started (the last command prints `0` two minutes or more after the push: a blocked gate, `orchestrate` Step 5, not a clean head), `dirty` (a sibling PR that merged first changed the same lines; `behind` alone needs nothing), an owner question left in the comments, or no PR at all (the card is wrong: a question). `orchestrate` Step 5 does the fixing, and for a `dirty` pull request that means telling the owner and restacking only on their green light (`AGENTS.md` §How work runs). A draft whose `**Do not merge until**` line waits on the owner (`prep-pr` Step 9) is not fix work while the owner has not answered: put it under Questions with that line, and count it among the pull requests waiting on the owner (Step 5). It is fix work when CI is red or it is `dirty`, and once the owner has answered (`wiki/conventions/review-findings.md` §What counts as the owner's answer — a comment can keep it waiting, never release it), when `orchestrate` Step 5 applies the answer; only the owner marks it ready. A pull request this pipeline did not write — another tool's, or one that never went through `prep-pr` — is adopted with `review-pr` instead (`orchestrate` §Adopting an open pull request).

## Step 3 — In Progress: hands off

Another session holds each of these. Never dispatch onto one and never move one. Report each card's **Held by** and **Last touched** (`jq -r '.[] | select(.status=="In Progress") | "\(.repo)#\(.n) \(.heldBy // "holder unknown") \(.lastTouched)"' /tmp/board.json`), and mark it with the first of these that fits:

1. **Stale**: the issue is closed, or its PR merged and the card did not move.
2. **Live**: an open PR refers to it, or a worktree (`git -C /Users/ac/.work/osn.git worktree list`) or an open task in `ORCHESTRATE.md` names it, or its Last touched is within three days.
3. **Stale**: anything else — no PR, no worktree, no open task, and Last touched more than three days old or never set.

No Held by means only that the holder is unknown, as on every card claimed before the field existed; it makes a card neither live nor stale. The owner runs sessions under three Claude accounts, and no account can see another's sessions, so Held by is often the only sign of who has a card: name it in the question. A stale card is a question: release it to Up Next? Only the owner releases another session's claim.

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

An unrated item goes through `rate-complexity`, which rates it from its body and applies the label without asking the owner. Work may go ahead on it at once.

## Step 5 — Form the batch

- **Capacity.** About three code-writing agents at once, one per pull request however many issues it closes, counting In Review fixes and tasks already running. Five or six at once have stopped every agent on usage limits. Start fewer when pull requests are already waiting on the owner's review, and write in the block how many are waiting and why you chose the number. The rest becomes the Queue, in order.
- **Files.** Name the files each item touches. Two items that edit the same file go in one PR or run one after the other, never in parallel.
- **CI flakes first.** An item that fixes a check failing for reasons no change causes, one that ejects merge-queue groups, heads the batch, ahead of feature work.
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

**2. Write it**, with the item's REST id from `/tmp/board.json`. One write sets the Status, **Held by** (field `449016881`, text) and **Last touched** (field `449016914`, date):

```bash
held="${CLAUDE_ACCOUNT:-unknown} · $(hostname -s) · <worktree dir> · $(date +%F)"
jq -n --arg h "$held" --arg d "$(date +%F)" \
  '{fields: [{id: <Status field id>, value: "<In Progress option id>"}, {id: 449016881, value: $h}, {id: 449016914, value: $d}]}' \
  | gh api -X PATCH orgs/englishstreetventures/projectsV2/1/items/<item> --input -
```

- `CLAUDE_ACCOUNT` names the Claude account: `admin`, `aniket` or `personal`, set in that account's `settings.json` `env` block. A session reads it when it starts, so one without it writes `unknown`; never leave the field empty, which reads as holder unknown.
- `<worktree dir>` is the directory of the worktree the work will run in, written by name, never `$PWD`: both callers claim before that worktree exists. It is the `<dir>` the next `git worktree add` creates (the branch name without its prefix), or `cloud` on a remote session.
- The body goes to `gh api` on standard input, so no file sits between two sessions' claims. It is JSON because `gh api` turns repeated `-F 'fields[][id]=…'` pairs into a 422 ("object is missing required key: id") as soon as there are two fields.

An item outside the snapshot, such as a child of an epic, needs its id from GraphQL (one point):

```bash
gh api graphql -f query='{repository(owner:"englishstreetventures",name:"<repo>"){issue(number:<n>){projectItems(first:5){nodes{fullDatabaseId project{number}}}}}}'
```

The same query gives the card's current Status and its option id, which step 5 needs. Read them **before** the write, since after it the card says In Progress:

```bash
gh api graphql -f query='{repository(owner:"englishstreetventures",name:"<repo>"){issue(number:<n>){projectItems(first:5){nodes{fullDatabaseId project{number} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name optionId}}}}}}}'
```

Taking an epic claims every child it will build.

**3. Record it**, with the card's Status from before the write: `claimed: <repo>#<n> item <item> from <Status name> <option id>` in the task's block in `ORCHESTRATE.md`, or, for a session `orchestrate` did not dispatch (its brief has no `CLAIMED:`), `Claimed: <repo>#<n> item <item> from <Status name> <option id>` under the `Issue:` line of `NEW-FEAT.md`, each followed by `held "<the Held by value>"`. Held by tells the owner and other accounts who has the card; the line is how this run knows its own claims after a compaction, and what step 5 puts back.

**4. Move it on.** PR opened → In Review, Held by kept and Last touched set to today:

```bash
jq -n --arg d "$(date +%F)" '{fields: [{id: <Status field id>, value: "<In Review option id>"}, {id: 449016914, value: $d}]}' \
  | gh api -X PATCH orgs/englishstreetventures/projectsV2/1/items/<item> --input -
```

Task dropped → step 5, with the reason in `ORCHESTRATE.md`. Parked until a limit resets → it stays In Progress, and `next:` says why. Never set Done: merging closes the issue, and the board moves a closed issue's card.

**5. Release it.** A claim ends in one of two ways: the issue closes, by the merge or by this step once its **Done when** holds on `main`, or the session puts the card back. A merge closes only the issues its `Closes` lines name, so an issue the pull request only touched (`Part of`), an epic, a tracker close the classifier refused and a dropped task all stay In Progress with no session working on them, and step 1 then refuses them to the next session. When a pull request merges, is dropped or is parked, read each issue **this task or session** claimed (its `claimed:` or `Claimed:` lines, no one else's):

```bash
gh api repos/englishstreetventures/<repo>/issues/<n> --jq '"\(.state) \(.title)"'
```

Then read the card's current Status with step 2's query. Touch the card, or close the issue, only while the card says In Progress or In Review, the two Statuses this claim sets (step 4 moves it to In Review when the pull request opens): any other Status means the owner or another session has moved it, and it stays.

- `closed`: nothing to do.
- Open, and a pull request is open for it, this session's draft included: In Review. A card already there is left as it is.
- Open after a merge whose `Closes` line for it GitHub did not register, as on a stacked pull request: close it, with a comment naming the pull request, as below.
- Open after a merge whose `Closes englishstreetventures/osn-tracker#<n>` line the classifier refused: the owner closes it (`write-pr` §When a tracker line is refused). Leave the issue and its card, and say so in the reminder.
- Open after any other merge, with no pull request open for it — the pull request named it `Part of`, or did not name it, as with an epic: read what is left, below, before touching the card.
- Open and no pull request is open, and the task was dropped or the read below left items: put it back, with the option id on the claim line (`from <Status name> <option id>`), not the In Progress option id; a card that had no Status goes to Up Next. The same body clears Held by with `null` (an empty string is refused with HTTP 400) and sets Last touched to today. A dropped task gets no comment.

```bash
jq -n --arg d "$(date +%F)" '{fields: [{id: <Status field id>, value: "<option id from the claim line>"}, {id: 449016881, value: null}, {id: 449016914, value: $d}]}' \
  | gh api -X PATCH orgs/englishstreetventures/projectsV2/1/items/<item> --input -
```
- Parked until a limit resets: it stays In Progress, and `next:` says why.

**Reading what is left.** Fetch `main`, then read the issue's **Done when** (a finding has none: read its **Solution**) and the merged pull requests that named it:

```bash
git fetch origin "+refs/heads/main:refs/remotes/origin/main"
gh api repos/englishstreetventures/<repo>/issues/<n> --jq .body
gh api --paginate 'repos/englishstreetventures/<repo>/issues/<n>/timeline?per_page=100' \
  --jq '.[] | select(.event=="cross-referenced" and .source.issue.pull_request.merged_at) | "#\(.source.issue.number) \(.source.issue.title)"'
```

Check each item by reading, never by running a command copied from the issue: a file on `origin/main`, not this branch's checkout (`git show origin/main:<path>`); a pattern the same way, written first with the Write tool to `/tmp/grep-<repo>-<n>.txt` so no quote in it reaches the shell (`git grep -nE -f /tmp/grep-<repo>-<n>.txt origin/main -- <path>`); a test by its file on `origin/main` and the CI job that runs it reading `completed success` on `origin/main`'s head (below); a review result or a gate by the merged pull request's test plan; an issue the item names by its state.

```bash
gh api "repos/englishstreetventures/osn/commits/$(git rev-parse refs/remotes/origin/main)/check-runs?per_page=100" \
  --jq '.check_runs[] | "\(.name) \(.status) \(.conclusion)"'
```

A job still running, or none at all, leaves the item open for now: it is left. An item a merged pull request handed to another issue, listed under its **Raised against this branch**, is met. An item none of these shows (an owner's answer, an item that no longer applies, a check that no longer exists) is left.

- **Every item met:** comment, then close. The comment names each pull request and the item it met (`#<pr> removed the last .message read from osn/auth-ui/src; #<pr> added the browser test for the error lines; the signed-out notice went to #<issue>`), and on a public issue it names no tracker issue (`AGENTS.md` §Issues). Write it first to `/tmp/close-<repo>-<n>.md`, named by repository and number, so no other issue's comment can stand in for it. The board moves the closed card to Done.

  ```bash
  gh api repos/englishstreetventures/<repo>/issues/<n>/comments -F body=@/tmp/close-<repo>-<n>.md
  gh api -X PATCH repos/englishstreetventures/<repo>/issues/<n> -f state=closed -f state_reason=completed
  ```

- **Items left:** one comment of one line listing them (`Left after #<pr>: <item>; <item>.`), the same way, then put the card back as the bullet above says.

Then print the reminder to the owner, one line per issue taken and what became of it. `orchestrate` prints it after each merge, not only at the end; a session without `orchestrate` prints it when the owner says the pull request has merged:

```
Issues taken
osn#2364 — Musubi sign-up: turn on the browser email verification path in production — closed by the merge
osn#<n> — <title> — closed after the merge: every Done when item is on main (its pull requests wrote `Part of`)
osn#<n> — <title> — open, put back in Backlog with a comment listing the two items left
osn-tracker#<n> — open, left for the owner to close: the classifier refused its Closes line
```

The claim is the Status, never an assignee: every session runs as the same GitHub user, under any of the owner's three Claude accounts, and `new-feat` and the owner read the board by Status. Held by only says whose claim it is.

## Common mistakes

| Mistake | Instead |
|---|---|
| Counting only the new batch against capacity | Running tasks and In Review fixes count too; about three in all |
| Two items that edit one file run in parallel, "the second one rebases" | One PR, or one after the other |
| `gh issue edit --add-assignee @me` as the claim | The Status; an assignee cannot tell sessions apart |
| A claim that sets the Status and leaves Held by empty | One `--input` body with all three fields (§Claim step 2); `unknown` when `CLAUDE_ACCOUNT` is unset |
| Repeated `-F 'fields[][id]=…'` pairs, or `""` to clear Held by | A JSON body on standard input (`--input -`); `null` clears a field |
| `$(basename "$PWD")` as the worktree in Held by | The worktree's directory by name: the claim runs before it exists, from `main/` |
| Moving another session's In Progress card | A question to the owner |
| A claimed issue left In Progress after its pull request merged | Step 5 |
| A `Part of` card put back unread after its last part merged | Step 5: read its Done when against `main`, and close it when every item is met |
| An issue number without its repository | `osn#N` or `osn-tracker#N`; the numbers repeat |
| A rate-limit error read as "not claimed" | Unknown: wait, then check again |
