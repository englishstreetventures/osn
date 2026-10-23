---
name: write-pr
description: Use when writing or editing a pull-request title and body in this repository — at prep-pr Step 8, when a later commit or a review makes the body untrue, or for any pull request that closes public issues or private tracker findings. Covers the title, the six sections and what each holds — the change's impact first — the Closes and Part of lines and what a public body may say about a tracker issue, owner and deploy actions, an honest test plan, the faults agent-written bodies fall into, and the command that opens or edits it.
---

# Write a pull request

A pull request has three readers. The owner reads it today to decide whether to merge, often without opening the diff, so the body opens with why the change matters before it says what changed. Someone reads it months from now, arriving from `git blame` with none of the session behind it. And GitHub reads its closing lines: a line it cannot parse leaves the issue open after the merge, and nobody is told. Write for all three.

This skill owns the **title and the body**. `prep-pr` owns the gates that feed them — base branch, changeset, builds, reviews, findings filed — and hands over at its Step 8. Two things this skill does not own:

- **An issue**, including a finding filed during the work: `write-issue`.
- **The session-metrics block.** `retro` appends its `<details>` block after the pull request opens. Leave no placeholder for it, and put nothing after it.

A worked body, before and after, is in `references/examples.md`.

## Step 1 — The skeleton, first

`prep-pr` writes this skeleton before its Step 0. Outside `prep-pr`, write it yourself before anything else — to `PR-BODY.md` at the root of the checkout unless the task named another file; it is gitignored:

```markdown
## Impact

None

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

Those six `##` headings are the whole permitted set, in that order. From then on the file is **edited, never rewritten**: replace a `None` as the work establishes what belongs there, and leave it where the answer really is nothing. A body composed in your head and written out whole at the end is how a section goes missing.

- Never add a seventh `##`. A change-specific heading belongs in the title; a gate that could not run gets a `## Test plan` row.
- A decision is a `###` inside `## Decisions`, never a `##`. The deep dive, when there is one, is a `### Deep dive` at the end of `## Summary`.
- Unlike an issue, where an empty section is left out, a section here with nothing to say keeps `None`: an absent one reads as forgotten. `## Impact` is the exception: every change has one, so it is never `None` when the body is sent.
- Owner actions (Step 4) go at the end of `## Impact`, after its text and before `## Summary`.

## Step 2 — Gather the facts

Each line of the body comes from a command or a file, not from memory.

| Fact | Where it comes from |
|---|---|
| The base branch | `prep-pr` Step 0's `$BASE`: `main`, or the parent branch of a stacked one |
| The impact, in numbers | the public issue's **Why** — never a tracker issue's, whose text stays private — and a command that measures the change: a test count, a bundle size, a query count, a timing, a row count, how many users, weddings or files it reaches, counted from the repository, a test or the dev tier — never from a production database or anyone's real data. Before and after where the run already has both: a review report's measurements, `git show "$DIFF_BASE":<file>` for a count in a file, CI on the base. Never build or test the base just for this section |
| What changed | `git log "$DIFF_BASE"..HEAD --oneline`, `git diff --stat "$DIFF_BASE"...HEAD` |
| The issues it fixes, wholly or in part | the issue `new-feat` took or opened (`NEW-FEAT.md`), and every tracker issue for a finding the branch fixed (`prep-pr` Step 7) |
| The issues raised against it | each `write-issue` call this session, and the findings its review filed, **minus every issue the `Closes` lines above already carry** — raised against it means still open after the merge |
| The gates | each command you ran, the commit it ran on (`git rev-parse --short HEAD` at the time), and what it printed |
| The owner's decisions | the brief, the issue, and any answer the owner gave during the work |
| What a person must do | a secret, a migration, a production approval, a merge order — anything the deploy does not do itself |
| Draft or ready | `prep-pr` Step 9's list of what makes a pull request wait on the owner, read against the run's report, the brief and the issue it closes |

A fact you cannot source goes in as unknown, never as a guess.

## Step 3 — The title

The title becomes the squash commit's subject on `main`, so it is read in `git log` for as long as the repository lives.

- **Lead with the product or the shared area the change lands in**, as recent titles do: `Cire: welcome back guests who have already replied`, `Shared UI: remove the unused cn() helper and tailwind-merge`. Work on skills, agent definitions and evals leads with `Skills:`. Work with no such home is a plain sentence: `Make two flaky osn/api tests deterministic; correct two wiki pages`.
- **Say what changes for the person using it**, not the activity: `Cire: let a wedding below Gold download its budget, tasks and gifts`, never `Update export gating` or `Fix #1419`.
- At most 70 characters. No conventional-commit prefix (`docs:`, `fix(api):`), no issue number, no branch name.
- **A branch that only fixes a tracker finding names the area**, as its branch name does (`new-feat` Step 0): `Cire API: harden claim checks`. Never the defect, and never how the fix works. The title is public from the moment the pull request opens, which is before the fix is deployed, and it stays on `main` as the commit subject.

## Step 4 — Fill the sections

### Impact

The first thing anyone reads, and the reason the pull request exists. One to three sentences, in plain English, that answer: **who is better off after this merges, and by how much?**

- **Lead with the effect, not the change.** "Organisers can chase the 40 households that never replied without re-sending to the 160 who did" is an impact. "Adds a resend endpoint" is a summary, and belongs one section down.
- **Use a number whenever the change has one**, and write it out: `3 database round trips per page load, down from 11`, `bundle 212 kB → 148 kB`, `5 flaky tests made deterministic`, `every pull request CI runs`. Before and after where the run already has both — never build the base just to get the before. Each number comes from a command or a file, as Step 2 says, and the test plan or a decision shows where.
- **No number to give is fine; an invented one is not.** Say plainly what gets better and for whom: "A reviewer no longer has to open the diff to learn which issues the merge closes." Never "improves performance", "better developer experience" or "cleaner code" — name the person and the thing they can now do, or stop doing.
- **Tooling, skills and docs have readers too.** The effect is on the agents and people who use them: what they now get right that they got wrong, or how much less they spend.
- **A tracker fix states only the present effect, and it overrides every rule above.** "Guest sessions now last 14 days." No before value, no "down from", "no longer" or "previously", no "who was exposed" or who is better off for it, nothing about the old behaviour — the same rule as the Summary below. That one sentence is a complete Impact for a branch that only fixes tracker issues; it is not `None`. The same holds when the change is to a skill or a tool: say what it now does, never what it used to get wrong.

### Owner actions, at the end of Impact

When a person has to do something, the owner reads it straight after the impact: lines at the end of `## Impact`, before `## Summary`, one bold lead-in per moment. When there is no action, nothing goes there.

```markdown
**Do not merge until** production `cire-api` has applied migrations 0062–0081: dispatch a production release with `surfaces: cire_api`, approve it and let it finish.

**After merging** — dispatch **Deploy** with `expect_no_change: true` and check every stack job reports `Plan: no changes`.
```

Use `**Do not merge until**`, `**At deploy**` or `**After merging**`, and name the command, the workflow or the secret. A deploy step that appears only in the test plan or a closing paragraph is one the owner misses.

**A pull request that waits on the owner is a draft, and its `**Do not merge until**` line says what for**: the decision or the approval, naming the public issue or the `###` decision that holds it. The first example above is one, since only the owner can approve that release. `prep-pr` Step 9 lists what makes a pull request wait on the owner, and says only the owner marks it ready:

```markdown
**Do not merge until** the owner chooses whether a guest can change a reply after the RSVP deadline — the open decision below, also on #9101.
```

The line never names, points at or describes a tracker issue. A `critical` or `high` finding whose fix is the owner's choice gets no line at all: its pull request does not open until the owner has answered on the tracker issue.

### Summary

What changed, now that Impact has said why it matters: two or three sentences, then bullets for what the prose cannot carry. Do not repeat the impact. Describe the change, not the session: "I explored", "after three attempts", "Phase 2 complete" and a list of every file touched belong in your report to whoever dispatched you. The commits carry the steps; the diff carries the files.

**Deep dive, only when the change needs one.** A `### Deep dive` at the end of `## Summary` explains how it works — the mechanism, the data flow, a diagram, the trade-off a reviewer must understand to judge the diff. A rename, a bump or a copy change has none; leave the heading out rather than writing `None`. A tracker fix never has one: how the fix works points at what it fixed.

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

**Follow-up pull requests**

- #9104 — Cire API: invite lookup follow-up — englishstreetventures/osn-tracker#<m>
```

1. **The branch closes every issue it fixes**: the issue `new-feat` took or opened, any other public issue the work finished, every tracker issue for a finding it fixed. Every branch traces to an issue, so a body with neither a `Closes` nor a `Part of` line has lost one: find it, or open it with `write-issue`. Only when you can do neither — no network, nothing to search — write one line under `## Issues` saying the branch closes no issue and why, and name in your report the issue you would open.
2. **A public issue is `Closes #N`**, one per line, nothing else on the line. GitHub's Development sidebar shows each title; a table beside the lines says the same thing twice.
3. **A tracker issue is `Closes englishstreetventures/osn-tracker#N`**, after the public lines, and nothing more. No finding ID, no title, no word about the defect — not here, not in the title or any other section, not in the branch name or a commit message. `englishstreetventures/osn` is public and the tracker is not. The line closes the issue on merge, because the owner can see both repositories; a reader who cannot sees a reference that goes nowhere.
4. **An issue the branch only partly fixes is `Part of #N`**, never `Closes`.
5. **A closing keyword closes wherever it sits.** `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves` or `resolved` directly before an issue reference closes that issue on merge, in prose as much as in the closing block: "this fixes #9001 in part" closes #9001. Reword it, or write `Part of`.
6. **Each issue appears once in the body.** It is a `Closes` line, a `Part of` line, an entry under **Raised against this branch**, or a line under **Out of scope** — never two of them. A finding `prep-pr` Step 7 filed and the branch then fixed was raised and closed in the same branch: it is a `Closes` line and nothing else. Listing it under **Raised** as well tells the reader the work is still outstanding when the merge has finished it.
7. **Raised against this branch** lists every issue raised by its own review or split out of its work that **stays open after the merge**, whoever filed it and whenever: a deferral, a finding left open as out of scope, unrelated or larger work, a finding left unfixed in scope. A public one by number and title; a tracker one by its bare reference. An issue found while auditing another package goes in one line under **Out of scope**, not here. Most of what a review finds is fixed rather than raised (`prep-pr` Step 6), so this list is short; `None` is the usual answer. **Follow-up pull requests**, after it, lists the pull request this session opened to fix what the branch's review found outside it, by number and title, with the issues it will close on the same line; those issues appear nowhere else in the body. A follow-up that fixes a tracker finding has a title naming only the area (Step 3), so it says nothing more here. Leave the lead-in out when there are none.
8. **Never open a public issue to stand in for a tracker one**, whatever the body would otherwise lack. When the tracker lines are refused (Step 6) and no public issue closes, `## Issues` reads `Tracked privately.`

### Decisions

One `###` per decision, a plain-English heading, and four fields in this order:

```markdown
### Tracker issues close on a bare reference — decided by the owner

- **Issue** — what the problem was.
- **Why** — why it mattered: a risk, a correctness or a design concern.
- **Solution** — what was done.
- **Rationale** — why this is the right answer, and what was rejected.
```

- **A choice that was the owner's to make is a decision to overrule.** Where you took a default because the owner was not there to ask — an unconfirmed changeset summary, a scope cut, a split you did not make — end the heading `— owner's call`, and say in **Rationale** what you chose, the option you did not take, and what changes if the owner picks it. The branch is complete with the default, so it does not make the pull request a draft.
- **A choice still open, that this change waits on**, ends its heading `— open, for the owner`: **Solution** gives the options, **Rationale** the one you recommend and what each costs. The pull request is a draft until the owner answers (`prep-pr` Step 9), and its `**Do not merge until**` line names this heading.
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

Each of these has shipped in this repository's pull requests.

| Fault | Looks like | Instead |
|---|---|---|
| Says it closes nothing | `This branch closes no issue.` above two closing lines appended after the metrics block | Every closing line in `## Issues`, and the section agreeing with them |
| No issue at all | A body with no `Closes` and no `Part of` on a branch that started from an issue | Step 4, Issues rule 1 |
| Said three times | A table, a comma-joined `Closes #1, closes #2` line and four single lines for the same four issues | One `Closes` line per issue |
| Closed and raised | Four tracker issues as `Closes` lines and the same four again under **Raised against this branch**, so the merge looks as if it leaves work behind | A fixed issue is its `Closes` line only; **Raised** holds what stays open (Issues rule 6) |
| Tracker finding in public | A tracker reference beside its finding ID; a decision headed by a finding ID; prose saying how the fixed defect was reached | The bare reference; the rest in the tracker issue |
| Gate with no commit | A test plan that never says which commit it ran on | The `Commit` column |
| Gate left to CI | "`ci.yml` runs it on this PR" as a result | `NOT RUN — left to CI` |
| No test plan | Five sections and no `## Test plan` | The skeleton, first |
| Buried owner action | Production migrations in a `## Follow-ups` section at the bottom; a post-merge workflow run in the middle of the Summary | At the end of `## Impact`, as a bold lead-in |
| Change without why | "Adds a `resend` route and an `INVITE_RESEND_KEY` secret", and nothing on who needed it | `## Impact`: who is better off, and by how much |
| Next steps with no issue | "Note for whoever lands second: rebase that paragraph and recount"; a `## Follow-ups` list | An issue number; a check nobody has made yet is an unverified line under the test plan |
| File-list summary | A Summary built from function and file names | What changes, for whom, and why |
| Personal detail | The owner's email address in a public body | Leave it out |

## Step 6 — Open it, or edit it

Check before sending:

- [ ] `grep -c '^## \(Impact\|Summary\|Workspaces affected\|Issues\|Decisions\|Test plan\)$' PR-BODY.md` and `grep -c '^## ' PR-BODY.md` both print `6`.
- [ ] `## Impact` is not `None`, says who is better off, and carries a number wherever the change has one — unless the body closes a tracker issue, where it says only what the code now does. Then this prints nothing:

  ```bash
  grep -niE 'down from|no longer|previously|used to|→|->|was exposed' PR-BODY.md
  ```

- [ ] No count in the body comes from production data.
- [ ] Owner actions, if any, at the end of `## Impact`.
- [ ] If it waits on the owner (`prep-pr` Step 9), it opens as a draft and a `**Do not merge until**` line says what for. No such line names a tracker issue; this prints nothing:

  ```bash
  grep -niE 'do not merge until.*osn-tracker' PR-BODY.md
  ```

- [ ] One plain `Closes` line per fixed issue, in `## Issues`, tracker lines last and bare; `Part of` for a partial fix; no closing keyword in prose before an issue the branch does not close.
- [ ] No issue is listed twice — a `Closes` issue is not also under **Raised against this branch** or under **Out of scope** at the end of `## Decisions`. This prints nothing:

  ```bash
  awk '/^## Issues$/{f=1;next} /^\*\*Out of scope\*\*/{f=1} /^## /{f=0} f' PR-BODY.md \
    | grep -oE '([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#[0-9]+' \
    | sed 's#^englishstreetventures/osn\##\##' | sort | uniq -d
  ```
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

- **REST, not `gh pr create`**: `gh pr create` goes through GraphQL, whose hourly limit every agent on the account shares.
- `base` is required and has no default: `main`, or the parent branch of a stacked pull request.
- `-F body=@<file>` reads the file and `-f` keeps the title a string. Never pass the body inline: an inline body mangles backticks and `$` in the local shell.
- It opens ready for review unless it waits on the owner (`prep-pr` Step 9) or the task asks for a draft: then add `-F draft=true`. A draft still runs CI, and GitHub will not merge it. One already open becomes a draft with `gh pr ready --undo <n>`, since REST cannot convert one.

Edit it whenever the title or body stops being true. Before any push to its branch or any body edit, read its state:

```bash
gh api repos/englishstreetventures/osn/pulls/<n> --jq '{state, merged}'
```

On `merged: true` or `state: closed`, stop. Do not PATCH the body and do not push to the branch: a merged pull request's body is the record of what merged. Cut a new branch from `origin/main` and open a follow-up pull request for the change instead, with the open command above.

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

Every `Closes` line must come back; GitHub lists them by issue number, not in body order. If one is missing, it is not of the form `Closes #N` or `Closes englishstreetventures/osn-tracker#N`, or it sits in a table or a code span: fix the file, `PATCH` it, check again. If one comes back that should not, a closing keyword in prose put it there.

- **A tracker line can only come back to a token that can read the tracker.** In an environment whose token cannot, say so in your report instead of editing again.
- **A stacked pull request lists nothing**: GitHub reads closing keywords only on a pull request whose base is the default branch. Say so in your report; the check runs again once the parent merges and GitHub retargets this one to `main`, and an issue still open after the merge is closed by hand with a comment naming the pull request.
- **The session-metrics card does not take its issue from this list.** It names the issue in the branch's `NEW-FEAT.md` when the pull request links it, else the first `Closes` line of the body, and divides by the sum of the ratings of every issue in this repository the pull request closes (`wiki/conventions/session-metrics.md` §Which issue a card names, and what it divides by). So put the branch's own issue on the first `Closes` line. When the card still names the wrong one, tell `retro` the branch's issue number, which it passes as `--issue` — this repository's issue only, never a tracker number.

### When a tracker line is refused

The permission classifier can refuse a write that adds a `Closes englishstreetventures/osn-tracker#N` line to a public body, as "Excess Sensitive Detail". **Do not try again by another route** — another command, a split edit, a comment on the pull request, a commit message, a different file. A workaround makes the disclosure the refusal declined. Remove the refused lines and send the same body without them; that opens or updates the pull request, and it is not a retry. Then put the tracker numbers in your report to whoever dispatched you, and in the `prep-pr` report, saying the classifier refused them: the owner adds the lines, or closes those tracker issues by hand after the merge. The public body says nothing about the missing lines (Issues rule 8), and the check above will not list them.

## No network, no `gh`

Write the body file anyway; it is the deliverable. Record that the pull request was not opened, the base it should target, and that its closes were not checked. Never describe a pull request as opened, or its closes as registered, when the command did not run.
