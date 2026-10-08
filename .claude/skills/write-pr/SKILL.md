---
name: write-pr
description: Use when writing or editing a pull-request title and body in this repository — at prep-pr Step 8, when a later commit or a review makes the body untrue, or for any pull request that closes public issues or private tracker findings. Covers the title, the five sections and what each holds, the Closes and Part of lines and what a public body may say about a tracker issue, owner and deploy actions, an honest test plan, the faults agent-written bodies fall into, and the command that opens or edits it.
---

# Write a pull request

A pull request has three readers. The owner reads it today to decide whether to merge, often without opening the diff. Someone reads it months from now, arriving from `git blame` with none of the session behind it. And GitHub reads its closing lines: a line it cannot parse leaves the issue open after the merge, and nobody is told. Write for all three.

This skill owns the **title and the body**. `prep-pr` owns the gates that feed them — base branch, changeset, builds, reviews, findings filed — and hands over at its Step 8. Two things this skill does not own:

- **An issue**, including a finding filed during the work: `write-issue`.
- **The session-metrics block.** `retro` appends its `<details>` block after the pull request opens. Leave no placeholder for it, and put nothing after it.

A worked body, before and after, is in `references/examples.md`.

## Step 1 — The skeleton, first

`prep-pr` writes this skeleton before its Step 0. Outside `prep-pr`, write it yourself before anything else — to `PR-BODY.md` at the root of the checkout unless the task named another file; it is gitignored:

```markdown
## Summary

None

## Workspaces affected

None

## Issues

None

## Decisions

None

## Test plan

None
```

Those five `##` headings are the whole permitted set, in that order. From then on the file is **edited, never rewritten**: replace a `None` as the work establishes what belongs there, and leave it where the answer really is nothing. A body composed in your head and written out whole at the end is how a section goes missing.

- Never add a sixth `##`. A change-specific heading belongs in the title; a gate that could not run gets a `## Test plan` row.
- A decision is a `###` inside `## Decisions`, never a `##`.
- Unlike an issue, where an empty section is left out, a section here with nothing to say keeps `None`: an absent one reads as forgotten.
- The only text outside the five sections is the owner actions above `## Summary` (Step 4).

## Step 2 — Gather the facts

Each line of the body comes from a command or a file, not from memory.

| Fact | Where it comes from |
|---|---|
| The base branch | `prep-pr` Step 0's `$BASE`: `main`, or the parent branch of a stacked one |
| What changed | `git log "$DIFF_BASE"..HEAD --oneline`, `git diff --stat "$DIFF_BASE"...HEAD` |
| The issues it fixes, wholly or in part | the issue `new-feat` took or opened (`NEW-FEAT.md`), and every tracker issue for a finding the branch fixed (`prep-pr` Step 7) |
| The issues raised against it | each `write-issue` call this session, and the findings its review filed |
| The gates | each command you ran, the commit it ran on (`git rev-parse --short HEAD` at the time), and what it printed |
| The owner's decisions | the brief, the issue, and any answer the owner gave during the work |
| What a person must do | a secret, a migration, a production approval, a merge order — anything the deploy does not do itself |

A fact you cannot source goes in as unknown, never as a guess.

## Step 3 — The title

The title becomes the squash commit's subject on `main`, so it is read in `git log` for as long as the repository lives.

- **Lead with the product or the shared area the change lands in**, as recent titles do: `Cire: welcome back guests who have already replied`, `Shared UI: remove the unused cn() helper and tailwind-merge`. Work on skills, agent definitions and evals leads with `Skills:`. Work with no such home is a plain sentence: `Make two flaky osn/api tests deterministic; correct two wiki pages`.
- **Say what changes for the person using it**, not the activity: `Cire: let a wedding below Gold download its budget, tasks and gifts`, never `Update export gating` or `Fix #1419`.
- At most 70 characters. No conventional-commit prefix (`docs:`, `fix(api):`), no issue number, no branch name.
- **A branch that only fixes a tracker finding names the area**, as its branch name does (`new-feat` Step 0): `Cire API: harden claim checks`. Never the defect, and never how the fix works. The title is public from the moment the pull request opens, which is before the fix is deployed, and it stays on `main` as the commit subject.

## Step 4 — Fill the sections

### Owner actions, above `## Summary`

When a person has to do something, it is the first thing the owner reads: the lines above `## Summary`, one bold lead-in per moment. When there is no action, nothing goes there.

```markdown
**Do not merge until** production `cire-api` has applied migrations 0062–0081: approve the pending "Deploy cire/api — production" job and let it finish.

**After merging** — run `cire-dev-db-rebuild.yml` by `workflow_dispatch` and check its ledger step passes.
```

Use `**Do not merge until**`, `**At deploy**` or `**After merging**`, and name the command, the workflow or the secret. A deploy step that appears only in the test plan or a closing paragraph is one the owner misses.

### Summary

Two or three sentences: what the branch changes, for whom, and why it was needed. Then bullets for what the prose cannot carry. Describe the change, not the session: "I explored", "after three attempts", "Phase 2 complete" and a list of every file touched belong in your report to whoever dispatched you. The commits carry the steps; the diff carries the files.

**For a tracker fix, say what the code now does and stop**, as the diff and the changeset already do: "Guest sessions now last 14 days." Never what was wrong with the old behaviour, how it could be abused, or which finding the change answers. Those stay in the tracker issue.

### Workspaces affected

Each workspace by its `package.json` `name`, then the changeset: which packages at which bump, or that none is needed because `scripts/changeset-required.sh` printed `skip`. Quote the script's verdict, not your reading of the allowlist.

### Issues

The closing lines come first, in plain text. GitHub ignores a closing keyword inside a table, a code span, a code block or an HTML comment.

```markdown
## Issues

Closes #9101
Closes englishstreetventures/osn-tracker#<n>

Part of #9001

**Raised against this branch**

- #9102 — Cire: show organisers when a resent invite was opened
- englishstreetventures/osn-tracker#<n>
```

1. **The branch closes every issue it fixes**: the issue `new-feat` took or opened, any other public issue the work finished, every tracker issue for a finding it fixed. Every branch traces to an issue, so a body with neither a `Closes` nor a `Part of` line has lost one: find it, or open it with `write-issue`. Only when you can do neither — no network, nothing to search — write one line under `## Issues` saying the branch closes no issue and why, and name in your report the issue you would open.
2. **A public issue is `Closes #N`**, one per line, nothing else on the line. GitHub's Development sidebar shows each title; a table beside the lines says the same thing twice.
3. **A tracker issue is `Closes englishstreetventures/osn-tracker#N`**, after the public lines, and nothing more. No finding ID, no title, no word about the defect — not here, not in the title or any other section, not in the branch name or a commit message. `englishstreetventures/osn` is public and the tracker is not. The line closes the issue on merge, because the owner can see both repositories; a reader who cannot sees a reference that goes nowhere.
4. **An issue the branch only partly fixes is `Part of #N`**, never `Closes`.
5. **A closing keyword closes wherever it sits.** `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves` or `resolved` directly before an issue reference closes that issue on merge, in prose as much as in the closing block: "this fixes #9001 in part" closes #9001. Reword it, or write `Part of`.
6. **Raised against this branch** lists every issue raised by its own review or split out of its work, whoever filed it and whenever: a follow-up, a deferral, a finding. A public one by number and title; a tracker one by its bare reference. An issue found while auditing another package goes in one line under **Out of scope**, not here.
7. **Never open a public issue to stand in for a tracker one**, whatever the body would otherwise lack. When the tracker lines are refused (Step 6) and no public issue closes, `## Issues` reads `Tracked privately.`

### Decisions

One `###` per decision, a plain-English heading, and four fields in this order:

```markdown
### Tracker issues close on a bare reference — decided by the owner

- **Issue** — what the problem was.
- **Why** — why it mattered: a risk, a correctness or a design concern.
- **Solution** — what was done.
- **Rationale** — why this is the right answer, and what was rejected.
```

- **A choice that was the owner's to make is a decision to overrule.** Where you took a default because the owner was not there to ask — an unconfirmed changeset summary, a scope cut, a split you did not make — end the heading `— owner's call`, and say in **Rationale** what you chose, the option you did not take, and what changes if the owner picks it.
- **A choice the owner already made is recorded as theirs**: `— decided by the owner`, saying where (the issue, the brief). A reviewer does not relitigate it, and a later reader knows it was not the agent's.
- **No security, performance or compliance finding appears here**, fixed, deferred or dismissed. Each one is a tracker issue (`prep-pr` Step 7). The body carries a fixed one as its `Closes` line and a deferred one under **Raised against this branch**, both bare; a dismissed one, closed as not planned, not at all. Test-coverage gaps (`T-`) are not tracker findings and may appear.
- Lint fixes, formatting and anything the diff already says do not belong.

The section ends with **Out of scope** as a bold lead-in, never a heading: one line per thing the work found and left alone that is not raised against this branch — usually an issue in a package it does not touch — as its issue reference and nothing else. `**Out of scope** — None.` when there is nothing.

### Test plan

A table, one row per gate, every row from a command you ran in this worktree:

```markdown
| Gate | Command | Commit | Result |
|---|---|---|---|
| Script tests | `bun run test:scripts` | `3f9c2a1` | 214 pass, 0 fail |
| Lint | `bun run lint` | `3f9c2a1` | 0 errors |
| Type check | `bun run check` | — | NOT RUN — docs-only diff; lefthook runs it on push |
```

- **Commit** is the short SHA the gate ran on. A later commit — a review fix, a rebase — leaves each row on an older SHA unproven for what it changed: run the gate again, or say which rows still stand and why.
- **Result** is what the command printed: a count, the failure, the error. Never a tick, "passes", "green" or a count you did not watch appear. An invented green row is the one fault in a body no reviewer can see.
- **`NOT RUN`, with its reason, is a correct row** — a gate you skipped, could not run, or are leaving to CI. CI has not run when the pull request opens, so its result is not yours to report.
- Below the table: what a reviewer must try by hand, and what stayed unverified, said plainly.

## Step 5 — Rules for every body

1. **Every sentence is true of the head commit.** Edit the body after any push that changes what it describes.
2. **No next steps without an issue.** "Follow-ups", "will land in a later PR", "note for whoever merges second" are an issue number or nothing (`AGENTS.md`: a deferral gets an issue).
3. **Point at the code** for public matters: file and line, the function, the route. Never for a tracker finding.
4. **Plain words**, as in `write-issue` Step 5: no slash shorthand, acronyms spelled out once, no planning labels the reader cannot look up ("wave 3", "GP-1").
5. **Wiki by repo path**, never a `[[wikilink]]`, which does not resolve on GitHub.
6. **Nothing personal**: no email address or account detail that is not already in the code.

## The faults, by name

Each of these shipped in the pull requests opened between #1367 and #1444.

| Fault | Looks like | Instead |
|---|---|---|
| Says it closes nothing | `This branch closes no issue.` above two closing lines appended after the metrics block | Every closing line in `## Issues`, and the section agreeing with them |
| No issue at all | A body with no `Closes` and no `Part of` on a branch that started from an issue | Step 4, Issues rule 1 |
| Said three times | A table, a comma-joined `Closes #1, closes #2` line and four single lines for the same four issues | One `Closes` line per issue |
| Tracker finding in public | A tracker reference beside its finding ID; a decision headed by a finding ID; prose saying how the fixed defect was reached | The bare reference; the rest in the tracker issue |
| Gate with no commit | A test plan that never says which commit it ran on | The `Commit` column |
| Gate left to CI | "`skill-eval.yml` runs it on this PR" as a result | `NOT RUN — left to CI` |
| No test plan | Four sections and no `## Test plan` | The skeleton, first |
| Buried owner action | Production migrations in a `## Follow-ups` section at the bottom; a post-merge workflow run in the middle of the Summary | Above `## Summary`, as a bold lead-in |
| Next steps with no issue | "Note for whoever lands second: rebase that paragraph and recount"; a `## Follow-ups` list | An issue number; a check nobody has made yet is an unverified line under the test plan |
| File-list summary | A Summary built from function and file names | What changes, for whom, and why |
| Personal detail | The owner's email address in a public body | Leave it out |

## Step 6 — Open it, or edit it

Check before sending:

- [ ] `grep -c '^## \(Summary\|Workspaces affected\|Issues\|Decisions\|Test plan\)$' PR-BODY.md` and `grep -c '^## ' PR-BODY.md` both print `5`.
- [ ] Owner actions, if any, above `## Summary`.
- [ ] One plain `Closes` line per fixed issue, in `## Issues`, tracker lines last and bare; `Part of` for a partial fix; no closing keyword in prose before an issue the branch does not close.
- [ ] No finding ID in the title, the branch name, a commit message or the body — these four print nothing:

  ```bash
  echo "<title>"                               | grep -nE '(^|[^A-Za-z0-9])[SPC]-[A-Z][0-9]+'
  git branch --show-current                    | grep -nE '(^|[^A-Za-z0-9])[SPC]-[A-Z][0-9]+'
  git log --format=%B "$DIFF_BASE"..HEAD       | grep -nE '(^|[^A-Za-z0-9])[SPC]-[A-Z][0-9]+'
  grep -nE '(^|[^A-Za-z0-9])[SPC]-[A-Z][0-9]+' PR-BODY.md
  ```

- [ ] Every test-plan row has a command, a commit and what it printed, or `NOT RUN` and why.

Push the branch first (`git push -u origin HEAD`, never `--no-verify`), then open the pull request through REST, from the body file:

```bash
gh api repos/englishstreetventures/osn/pulls \
  -f title="<title>" -f head="<branch>" -f base="<base>" \
  -F body=@PR-BODY.md \
  --jq '"\(.number) \(.html_url)"'
```

- **REST, not `gh pr create`**: `gh pr create` goes through GraphQL, whose hourly limit every agent on the account shares, and against the organisation's old name it fails with `GraphQL: Head sha can't be blank, Base sha can't be blank, …`.
- `base` is required and has no default: `main`, or the parent branch of a stacked pull request.
- `-F body=@<file>` reads the file and `-f` keeps the title a string. Never pass the body inline: the local shell, fish, has no heredocs, and an inline body mangles backticks and `$`.
- It opens ready for review. Add `-F draft=true` only when the task asks for a draft.

Edit it whenever the title or body stops being true:

```bash
gh api -X PATCH repos/englishstreetventures/osn/pulls/<n> -F body=@PR-BODY.md --jq .html_url
```

The API replaces the whole body. Once `retro` has appended its block the local file is behind: fetch the live body first (`gh api repos/englishstreetventures/osn/pulls/<n> --jq .body > PR-BODY.md`), edit that, and send it back.

### Check the closes registered

Straight after opening, before you report the number, ask GitHub which issues the merge will close. REST cannot say — an issue's timeline shows the same `cross-referenced` event for a closing line as for a plain mention. One GraphQL call can:

```bash
gh api graphql -F n=<number> -f query='query($n: Int!) { repository(owner: "englishstreetventures", name: "osn") { pullRequest(number: $n) { closingIssuesReferences(first: 25) { nodes { number repository { nameWithOwner } } } } } }' \
  --jq '.data.repository.pullRequest.closingIssuesReferences.nodes[] | "\(.repository.nameWithOwner)#\(.number)"'
```

Every `Closes` line must come back, in body order. If one is missing, it is not of the form `Closes #N` or `Closes englishstreetventures/osn-tracker#N`, or it sits in a table or a code span: fix the file, `PATCH` it, check again. If one comes back that should not, a closing keyword in prose put it there.

- **A tracker line can only come back to a token that can read the tracker.** In an environment whose token cannot, say so in your report instead of editing again.
- **A stacked pull request lists nothing**: GitHub reads closing keywords only on a pull request whose base is the default branch. Say so in your report; the check runs again once the parent merges and GitHub retargets this one to `main`, and an issue still open after the merge is closed by hand with a comment naming the pull request.
- **The session-metrics card takes its issue from the first line this check lists.** When it lists nothing, tell `retro` the branch's issue number, which it passes as `--issue`.

### When a tracker line is refused

The permission classifier can refuse a write that adds a `Closes englishstreetventures/osn-tracker#N` line to a public body, as "Excess Sensitive Detail". **Do not try again by another route** — another command, a split edit, a comment on the pull request, a commit message, a different file. A workaround makes the disclosure the refusal declined. Remove the refused lines and send the same body without them; that opens or updates the pull request, and it is not a retry. Then put the tracker numbers in your report to whoever dispatched you, and in the `prep-pr` report, saying the classifier refused them: the owner adds the lines, or closes those tracker issues by hand after the merge. The public body says nothing about the missing lines (Issues rule 7), and the check above will not list them.

## No network, no `gh`

Write the body file anyway; it is the deliverable. Record that the pull request was not opened, the base it should target, and that its closes were not checked. Never describe a pull request as opened, or its closes as registered, when the command did not run.
