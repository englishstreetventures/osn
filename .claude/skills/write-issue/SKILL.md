---
name: write-issue
description: Use when writing a GitHub issue in this repository — planned work, a bug, an epic and its children, a follow-up a review or retro turned up, or a needs:decision proposal. Covers which repository it goes to, the title, type and labels, a body someone can act on months later with nothing checked out, the faults agent-written issues fall into, and the command that files it. Invoked by new-feat, prep-pr, retro and stress-plan whenever they open an issue.
---

# Write an issue

An issue is read once, months from now, by someone with no branch checked out, no wiki open and none of the conversation that produced it. Write for that reader.

This skill covers **issue bodies only**. A pull-request title and body follow the `write-pr` skill, which wants the opposite on one point: there, a section with nothing to say says `None` rather than being left out.

Two things this skill does not own, and links to instead:

- **A review finding** (`S-`, `P-`, `C-`): its four fields (Issue / Why / Solution / Rationale), its labels and its severity are in `wiki/conventions/review-findings.md` §Filing a finding. A worked example is `.claude/skills/prep-pr/references/issue-filing-example.md`. The writing rules below still apply to what goes in each field.
- **The label and type scheme**: `wiki/conventions/github-issues-setup.md` §3 and §4.

## Step 1 — Where it goes, and whether it exists

| The issue is | Repository |
|---|---|
| A security, performance or compliance finding, however minor | `englishstreetventures/osn-tracker` (private) |
| Everything else | `englishstreetventures/osn` (public) |

Route by kind, never by severity. A finding names an unpatched route, so filing it in the public repository publishes it, and a public issue never links to a tracker issue either.

Search the repository the table chose, open and closed both. A finding is searched in the tracker by its ID as well:

```bash
gh issue list --repo <repository from the table> --state all --limit 20 --search "<two or three words from the title>"
```

An open issue that already covers the work gets a comment with the new evidence, not a twin. A closed one that the work reopens is named in the new body by number.

## Step 2 — The title

The title states the outcome, specific enough to tell the issue apart from its neighbours in a list.

- Product work: `<Product> <surface>: <outcome>` — `Cire RSVP: collect meal choices and export catering counts`.
- A bug: what breaks, where — `Flaky osn/api test: recovery-session rotation late in the window`.
- A finding: its ID first — `S-M1 — No rate limit on POST /events/:id/rsvp`. In the public repository a finding never appears at all.
- Not an activity ("Improve RSVP", "Look into tests"), and no internal draft ID (`GP-1`, `EP-Q`) the reader cannot look up.

## Step 3 — Type and labels

Read `wiki/conventions/github-issues-setup.md` §3–4 for the scheme. The decisions people get wrong:

- **`--type`**: `Feature` for new capability, `Bug` for something built that behaves wrongly, `Task` for the rest — chores, docs, ops, schema, epics. Every issue gets one; an issue with no type drops out of the Project's grouping.
- **Exactly one `product:` label.** List the live set rather than trusting a copy: `gh label list --repo englishstreetventures/osn --search product:`.
- **`area:`** only for a finding (`security`, `performance`, `compliance`) or for `ops`, `schema` or `docs` work. A change to a skill, an agent definition or CI is `area:ops`. Product work takes no `area:`.
- **An epic** is `--type Task` plus the `epic` label.
- **`needs:decision`** only once the body carries a proposal; see Step 4.
- **`complexity:`** comes from `rate-complexity` in Step 6, never by hand.

## Step 4 — The body

### Planned work, and most issues

Bold lead-ins, in this order. Leave out a lead-in you have nothing real to put under.

```markdown
**What** — the change in two or three sentences, naming the surface it lands on and the files or routes it starts from.

**Why** — what goes wrong today and who it happens to. Evidence beats assertion: a count, a quoted error, a run link, a support message.

**Done when** — what a reviewer can check: a command and its expected output, a behaviour on a named screen, a grep that returns nothing.

**Notes** — constraints, what is already decided and why, what is out of scope, related issues by number. Wiki pages by repo path, with the fact restated.
```

### A bug

Same lead-ins, plus **Evidence** after **What**: the command you ran, the error quoted exactly in a code span, the CI run or PR where it showed up, how often. Add **Fix** when the cause is known, naming the function to change. `references/examples.md` has one.

### An epic and its children

The epic's **What** and **Why** describe the whole outcome; its **Done when** names the children by number. Each child is a full issue that stands alone: someone may open it without ever seeing the parent, so it restates the constraint it depends on rather than saying "see the epic". Put a rule that every child shares in the epic once, not pasted into each child. Link children as sub-issues of the epic.

### A finding

The four fields in `wiki/conventions/review-findings.md`, filed in the tracker only. A public issue body never names a finding, not even by number or ID. A public pull request carries a tracker issue only as a bare reference — `Closes englishstreetventures/osn-tracker#<n>` — and never its ID, title or detail (`write-pr`).

### A `needs:decision` proposal

Before the label goes on, the body carries what the issue actually is and a proposed answer with its trade-off: the option you would take, what it costs, what the other option buys. `wiki/conventions/review-findings.md` §When the fix needs a decision from the owner is the full rule. "Blocked, needs input" is not a body.

Issues filed through the GitHub web forms render their fields as `###` headings. Those are fine, and you need not rewrite them; issues an agent files use the bold lead-ins so the backlog reads one way.

## Step 5 — Rules for every body

1. **Every paragraph belongs to this issue.** If a paragraph would fit a sibling issue unchanged, it does not belong in either. Shared constraints go in the epic or the wiki page, once.
2. **No empty sections.** A heading followed by "None", "N/A" or "No new dependency" tells the reader nothing; leave it out.
3. **Point at the code.** File and line (`cire/api/src/routes/rsvp.ts:42`), the function, the command. "The RSVP flow" is not a location.
4. **Why names a person and a consequence.** "Caterers need meal counts" is a want. "Organisers read meal choices out of free-text dietary notes and count them by hand before sending the caterer a number" is a problem someone can check is solved.
5. **Done when can fail.** If no reviewer could look at the result and say "not done", rewrite it. "Implemented", "works" and "handled gracefully" can never fail.
6. **Check the premise.** A sentence about how the code behaves today is checked today, at the line you cite. An issue inherits nothing it has not verified.
7. **Plain words.** No slash shorthand: "an owner or editor", not "owner/editor"; "paid or refunded", not "paid/refunded". Spell out an acronym the first time. No planning words the reader cannot look up ("wave 3", "GP-1").
8. **Wiki by repo path, fact restated.** `wiki/shared/rate-limiting.md`, never a `[[wikilink]]`, which does not resolve on GitHub. A body that only points elsewhere ("see the TODO") is a bookmark, not an issue.
9. **Outside evidence earns its place.** A competitor page or vendor doc goes in only when it changes what gets built, with one line on what it shows.
10. **Name a tracker issue only from a private place.** A public issue body states the constraint and leaves the finding unnamed. A pull request may carry a bare reference, and nothing more, as `write-pr` says.

## The faults, by name

Each of these has shipped in this repository's backlog.

| Fault | Looks like | Instead |
|---|---|---|
| Stock paragraph | The same "For database changes, keep migrations…" paragraph in thirty bodies | Say it once in the epic or the wiki; in the child, only what differs |
| Empty section | `## Dependencies` → "No new subsystem dependency." | Leave the section out |
| Planning noise | "Planned wave: 3. This is backlog order, not a delivery estimate." | Order belongs on the Project board, not in the body |
| A want, not a problem | **Why** — "Couples need usable counts." | Who does what by hand today, and what it costs them |
| Slash shorthand | "owner/editor authors a fund with title/image/description" | Write the words out |
| Hedged citation | A competitor link followed by a paragraph saying it proves nothing | Drop it, or say in one line what it changes |
| Done when that cannot fail | "Errors are handled gracefully." | The status code, the message, the test name |
| Pointer-only body | "See `wiki/todo/api.md`." | Put the fact in the issue |
| Missing type | Filed with labels but no `--type` | Step 3 |

## Step 6 — File it

Write the body to a scratch file outside the repository with the Write tool, then pass the file. The local shell is fish, which has no heredocs and no `<(…)`, and AGENTS.md forbids a heredoc inside `$(…)` in any shell.

```bash
gh issue create --repo englishstreetventures/osn \
  --title "<title>" \
  --type Feature \
  --label "product:<one>" \
  --body-file <path to the body file>
```

A finding takes the tracker instead, its ID leading the title and its `area:` and `severity:` labels from `wiki/conventions/review-findings.md`:

```bash
gh issue create --repo englishstreetventures/osn-tracker \
  --title "S-M1 — <title>" \
  --type Bug \
  --label "area:security" --label "severity:medium" --label "product:<one>" \
  --body-file <path to the body file>
```

Before running it, check:

- [ ] Right repository for the kind of issue (Step 1), and no open duplicate.
- [ ] Title states the outcome; a finding's ID leads the title; no finding text in a public title.
- [ ] One `--type`, one `product:`, `area:` only where Step 3 says.
- [ ] Every path and line in the body exists today; every quoted error is exact.
- [ ] **Done when** could fail.
- [ ] No paragraph that would fit a sibling issue unchanged; no empty section; no slash shorthand.

After it is filed:

1. **Rate it.** Invoke `rate-complexity` with the new number, now, before anyone starts the work. Rate once: when `new-feat` calls this skill, this is the rating, and `new-feat` does not rate again.
2. **Put it on the Project.** The tracker adds its own issues to the board; a public issue needs adding:

   ```bash
   gh project item-add 1 --owner englishstreetventures --url <issue url> --format json --jq .id
   ```

   Either way the item arrives with no status and shows in no column until one is set. Set `Backlog` with the item id (the one `item-add` printed, or from `gh project item-list 1 --owner englishstreetventures` for a tracker issue):

   ```bash
   gh project field-list 1 --owner englishstreetventures --format json \
     --jq '.fields[] | select(.name=="Status") | {id, options}'
   gh project item-edit --project-id <project id> --id <item id> \
     --field-id <Status field id> --single-select-option-id <Backlog option id>
   ```

   `gh project view 1 --owner englishstreetventures --format json --jq .id` prints the project id. `new-feat` moves the issue to `In Progress` when work starts.
3. **Link children** to their epic as sub-issues.
4. **Report** the number and URL to whoever asked.

## No network, no `gh`

Write the issue you would have filed into the report: repository, title, type, labels and body, marked **not filed**. Skip the duplicate search and say you skipped it. Never describe an issue as filed, labelled or rated when the command did not run.
