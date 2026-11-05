---
name: review-state
description: Use when reviewing a branch diff for implicit state-machine defects — a status, phase, flag or lifecycle timestamp written without the prior state in its WHERE, a state and its paired columns written apart, terminal or first-time values overwritten, a multi-statement transition that does not converge, an insert racing a unique index, a value set only the HTTP boundary enforces, a refusal in the wrong order — by listing every writer of each state across the repository, and reporting findings with G-C/H/M/L IDs in the four-field format.
---

Review the current branch diff for state-transition defects.

`$ARGUMENTS` may name the changed workspaces and the branch. Whether or not it does, start from the diff.

**This lens reads by state, not by file.** The defect it exists for lives between two writers of one column: the write in the diff is unguarded, and the write it overwrites is usually somewhere else, in a file the branch never touched. Reading the diff alone cannot find it. So the unit of work is each state the diff writes, and every writer of that state in the repository, in the diff or not.

## Step 0 — Write the report skeleton before you review anything

Do this before the diff, before reading a line of source. The file is the
deliverable: a run that leaves a differently-shaped file has produced nothing,
however good the analysis inside it. Writing the shape now means the rest of the
run only fills it in.

Copy this verbatim. The report file is `STATE-REVIEW.md` unless the task named
another:

```bash
cat > STATE-REVIEW.md <<'EOF'
## State findings

None

## For the tracker

None

## Writers

None

## Coverage

None

## Sections checked

None
EOF
```

Those five `##` headings are the whole permitted set, and that is their order.
Replace a `None` as you fill its section in; leave it where the section really
is empty. Never add a sixth `##`. The ones that get invented are `## Summary`,
`## States`, `## Verdict` and `## Scope and method`, and none of them is
allowed: a summary sentence goes at the top of `## State findings`, the states
you found head their tables in `## Writers`, and an environment caveat goes at
the end of `## Sections checked`.

**From here on this file is only ever edited, never rewritten.** Every later
change replaces a `None`, or inserts text under a heading that already exists.
A single write to `STATE-REVIEW.md` at the end discards the shape this step
established. If you find yourself about to write the whole file, read it back
first and edit what is there.

**A finding is a bold label, not a heading.** `G-H1` goes on its own line as
bold text inside `## State findings`, as **Finding format** shows below. A
state's writer table sits under `## Writers` behind a bold label too, never a
`###` that a later edit promotes.

**Record each finding the moment you have it**, and fill `## Writers`,
`## Coverage` and `## Sections checked` state by state as each one finishes. A
run that a usage limit stops keeps what the file holds, and a reviewer resumed
later starts from that file, not from memory.

## Step 1 — Find the states the diff writes

Resolve the base branch first. A stacked branch does not merge into `main`, and local `main` lags `origin/main` in the worktree layout:

```bash
BASE=$(git config --get branch.$(git branch --show-current).gh-merge-base || echo main)
DIFF_BASE=$BASE
git merge-base --is-ancestor "$BASE" "refs/remotes/origin/$BASE" 2>/dev/null && DIFF_BASE="refs/remotes/origin/$BASE"
git diff --name-only "$DIFF_BASE"...HEAD
```

Keep that file list. Every file on it gets a verdict in `## Coverage`.

Now grep the added **and removed** lines of the diff for anything that names a state. A removed line counts: a deleted guard is the commonest way a transition loses its protection.

```bash
git diff -U0 "$DIFF_BASE"...HEAD \
  | perl -ne 'if (/^diff --git a\/.* b\/(.*)$/) { $f = $1; $h = 0; next } if (/^@@/) { $h = 1; next } print "$f: $_" if $h && /^[+-]/' \
  | perl -ne 'print if /\b(status|state|phase|stage|lifecycle)\b|[a-z](Status|State|Phase|Stage)\b|_(status|state|phase|stage)\b|\b[a-z]\w*(At|_at|edBy|ed_by|Reason|_reason)\b|\b(is|has|was)[A-Z]\w*\??\s*:|mode:\s*["\x27]boolean|enum:\s*\[|Schema\.Literals?\(|"[\w-]+"\s*\|\s*"[\w-]+"|\bcheck\(\s*["\x27\x60]|CHECK\s*\(|CREATE\s+TRIGGER|onConflictDo|\.returning\(/'
```

The first `perl` prefixes each changed line with its file and drops the diff headers; the second keeps the lines that name a state. `perl` rather than `grep -E`, whose `\b` and `\w` differ between GNU and BSD.

`bun run scripts/review-scope.ts "$DIFF_BASE"` prints a verdict carrying `-state` (`full-state`, or `full-state-design` when the diff also changes how a screen looks) when the same kind of match lands in a file that writes the database; it is the trigger that sent this review, not a substitute for the grep.

A hit is a **state** when its value decides what a later request may do: some write refuses on it, some read branches on it, some sweep selects on it. That covers:

- a status, state, phase or stage column, and any string-literal union or `enum:` column used the same way;
- a nullable timestamp or actor used as a state: `completedAt`, `paidAt`, `revokedAt`, `hardDeleteAt`, `consumedAt`, `revokedBy` — non-null means "it happened";
- a boolean flag set: `revoked`, `selected`, `instanceOverride`, `isArchived`.

`createdAt`, `updatedAt` and their actors are not states, and a column only ever displayed is not either. For each state, write down in `## Writers`, as the bold label over its table: the table and column, **both names** (the TypeScript property and the SQL column, `cancelledAt` and `cancelled_at`), the value set and what enforces it (an `enum:` alone, a CHECK, a trigger, nothing), and its **paired columns** — the columns whose meaning depends on it, such as a cancel's time, reason and deletion schedule beside `status`, or a completion time beside `status = 'done'`.

A grep hit that names no state — a response's `set.status = 404`, a UI signal, a local `const isOwner` — gets one line under `## Sections checked` saying what matched and why it is not a state.

## Step 2 — List every writer of each state

For each state, search the whole repository by both names, whole word:

```bash
git grep -n -w '<typescriptName>'
git grep -n -w '<sql_name>'
```

Never `LSP` for this: it searches only the packages it has loaded, and the writer that matters is often in another one — a sweep, a webhook handler, an erasure flow, a migration backfill, a seed, a trigger. Then classify each hit:

- **writer** — sets the state or a paired column: a `.set(`, a `.values(`, raw `UPDATE` or `INSERT`, a trigger, a migration, a seed;
- **decider** — reads it to refuse, branch or select: an `if`, a WHERE, a sweep's predicate;
- **display** — reads it to show it. Display needs no row.

Every writer gets a row in that state's table under `## Writers`, in the diff or not; test code and seeds get one row per file, marked `fixture`. The shape, with placeholders:

```markdown
**`orders.status`** (`status`) — `open | closed | cancelled`, enforced by `enum:` only; paired: `closedAt`, `cancelledAt`, `cancelReason`

| Writer | From → to | Read it decides from, and who can commit in between | Prior state in WHERE | Paired columns in the same statement | Repeat write | Test that fails without the guard |
|---|---|---|---|---|---|---|
| `<file>:<line>` `closeOrder` | open → closed | read at `<file>:<line>` in the same request; `cancelOrder` (`<file>:<line>`) and the expiry sweep can commit in between | none: `WHERE id = ?` | `closedAt` yes; `cancelledAt` not cleared | refused in code only | none |
```

The **read** column is the one that finds the defect. For each writer, find where the row it decides from was read — the same request a few lines up, a list the caller passed in, a page the client loaded — and name every other writer from this table that can commit between that read and this write: another request, a background sweep, a webhook, a cron, a retry of the same request. A writer whose read and write nothing can come between needs no guard; say why on its row (the row was inserted by this request; every writer of it first takes the same claim).

## Step 3 — Work every transition through the checks

Take each writer row and each check below in turn. A check names a property the transition should have: find the code that would carry it and see whether it does. A check that holds gets its line in `## Sections checked`, with the file and line. A check that fails is a finding: write it up before the next check.

**Check the shape once, as soon as the first finding is in the file**:

```bash
grep -c '^## \(State findings\|For the tracker\|Writers\|Coverage\|Sections checked\)$' STATE-REVIEW.md
```

It must print `5`. Less means the skeleton was overwritten: restore the headings and edit from then on.

**A comment is a claim, not a control.** "Status is checked above", "the cancel cannot race this" or "single writer" is the author's intent; the WHERE clause is the control. And **do not report a name**: a `notTerminal` predicate defined in the file is not a guard on a write that never uses it. Follow it into the statement.

The Drizzle idioms that carry each property, with the files on `main` that use them, are in `wiki/shared/state-transitions.md`. The checks below are complete without it.

### 1. The prior state is in the WHERE

- A write that moves a row from state A to state B names A in its WHERE — the exact state it read (`eq(t.status, previous)`), or "not terminal" (`NOT IN ('cancelled', 'finished')`) — next to the row's id.
- **It checks what it matched**: `.returning()` or the changed-row count, and zero rows means the row moved after the read. The request is then refused as a fresh read would refuse it, or returns the stored row; it never reports the transition as done.
- The defect is a read that checks the state in code, then `UPDATE … WHERE id = ?`. Any writer in the table that commits between the two is overwritten. Name that writer in **Why**: the finding is the pair, and the reader of the diff cannot see the other half.
- A guard whose zero-row result is ignored is a finding of its own: a metric counts a transition that did not happen, or the caller gets back a status the database does not hold.

### 2. Paired columns move with the state, and only its owner moves it

- Every writer that sets the state sets or clears each paired column **in the same statement**, and no writer sets a paired column alone. Compare the paired columns' writer lists from Step 2 with the state's: a writer present in one and absent from the other is a finding, and the sibling that does move both is the proof the pair was meant to move together.
- The defect is a reachable row the domain forbids: `status = 'cancelled'` with no cancel time, a cancel time on a live row, a deletion schedule on a row someone restored.
- **A state another flow owns** — a cancel the erasure flow made, a `paid` a payment webhook set — is left only by that flow, or by a path that names the owner in its WHERE (`cancellationReason = 'organiser'`, `hardDeleteAt IS NULL`). A user path that can undo it is a finding.

### 3. Terminal and first-time values hold

- **Terminal** states — cancelled, finished, revoked, refunded, consumed — are left only by a path written to leave them. Every automatic writer (a transition computed on read, a sweep, a backfill) excludes them in its WHERE.
- **First-time** values — when something was first completed, paid, revoked or seen, a first-touch attribution — keep their first value on every later write: `COALESCE(col, now)`, or `CASE WHEN … THEN col ELSE now END` when the state decides. `completedAt: new Date()` on every `status: "done"` write is the defect: marking a done task done again moves its completion time.

### 4. A repeat write changes nothing

- A double click, a client retry, a redelivered webhook: the second write matches nothing (`ne(t.status, target)` in its WHERE) or writes the same values (`COALESCE`). A count, a metric or a notification fires for the first write only, keyed off what the write matched.

### 5. A transition of several statements is atomic or converges

- Two dependent writes — a series and its instances, a status and its ledger row, a claim and its release — go in one atomic `db.batch([...])` (through `commitBatch` where the code runs on both drivers; D1 has no interactive transactions, `wiki/shared/database-environments.md`), **or** each statement is guarded on the state it moves its rows out of, so a retry after a failure between them finishes the transition and a second run writes nothing. Say which in **Rationale**.
- The defect is a first statement that commits and a second that fails, after which the retry is refused because the first moved the state, or rewrites every row the first already moved.

### 6. An insert that races a unique index falls through

- Check-then-insert under a unique index: two first requests both read "no row" and both insert, and the second gets a constraint error that surfaces as a 500. The insert carries `onConflictDoNothing({ target: [...] })` and `.returning()`; an empty result continues as an update of the row the other request wrote, re-read first.
- A value decided from that read — "first", "new", "attributed to this source" — is decided in the write, with `CASE WHEN col IS NULL`, not from a read another request may already have overtaken.

### 7. The database holds the value set

- Drizzle's `enum:` is TypeScript only: the DDL it generates has no CHECK (`imports.status` is `enum: [...]` in `cire/db/src/schema.ts` and plain `status text NOT NULL` in `cire/db/migrations/0001_initial.sql:88`). A TypeBox or Effect Schema literal binds only the route or service that decodes with it; a migration, a seed, a sweep or raw SQL writes past it.
- A new table carries a `check()` in its schema. An existing table cannot gain a CHECK without a copy-and-swap rebuild, and D1 enforces foreign keys, so dropping the old table cascades into its children; the value set goes in a `BEFORE INSERT` and a `BEFORE UPDATE OF <column>` trigger pair that `RAISE(ABORT, …)`. A state column enforced only by `enum:` is a finding, usually `G-L`.

### 8. Refusals run in an order that discloses nothing

- The checks that decide whether the caller may see or act on the row at all — that it exists for them, membership, ownership, the guest list — run **before** any check on its state. A "this event is cancelled" refusal ahead of the guest-list check answers someone who is not on the list with the event's state.
- Whether that is a `G-` finding or one for the tracker turns on whether the caller could already read the state: a public event's cancellation is shown to everyone, so the order is only wrong (`G-M` or `G-L`); a private event's is not, so the refusal discloses it (`## For the tracker`, security).
- The same state refusal holds on every verb that writes the row: compare the handlers over one resource the way `review-security`'s sibling-verb step does, by listing what each checks before it writes.

### 9. A test fails without each guard

For every guard the checks above found, or asked for in a finding's **Solution**, there is a test whose arrangement reaches the state the guard handles — so taking the guard out turns it red. A happy-path test and a refusal of a row already in the wrong state before the call both pass without a WHERE guard; neither counts. The shapes that do:

- **The row changes underneath.** For a writer handed a copy, read the row, change it with a direct update, call the writer with the stale copy, and assert the stored row. For a writer that reads for itself, land the competing write between its read and its statement: `beforeStatement` (`cire/api/tests/test-helpers.ts:278`) runs a write just before the next statement matching a pattern, as `cire/api/tests/routes/vendor-directory.test.ts:474` does for a unique-index race; without it, run both through `Effect.all([a, b], { concurrency: "unbounded" })`, which on `bun:sqlite` yields at every `await`, so both read before either writes.
- **A repeat.** Seed the first-time column with an old value, repeat the write, assert the old value stayed. Repeating within one test with no seeding passes without the guard whenever both writes land in the same second of a column that stores seconds.
- **The value set.** Write an out-of-set value through the driver, past the service, and assert the database refuses it.

A reviewer not alone in the worktree builds and runs nothing (`prep-pr` Step 6): read the test, say whether its arrangement reaches the guarded state, and mark the verdict **reasoned, not run**. A guard that is present and correct but that no test can see fail is a `G-L` finding whose **Solution** names the test.

---

## Finding format

IDs are `G-C1`, `G-C2`, … Critical; `G-H1`, … High; `G-M1`, … Medium; `G-L1`, … Low. The counter increments within each tier across the whole report. Each finding uses exactly this structure:

```
**G-H1** — <short title>
**Issue:** What is wrong, with the file and line of the writer and the check it fails.
**Why:** The other writer it races or the state it breaks, named with its file and line, and what a user or a later flow then sees.
**Solution:** The concrete change: the WHERE predicate, the column moved into the statement, the COALESCE, the batch or the trigger, and the test that fails without it.
**Rationale:** Why that change closes it on both drivers without moving the defect to another writer.
```

Tiers:

- **G-C** — ordinary use reaches a state the domain forbids and loses or falsifies a record people or money depend on: a cancel undone, a paid or consented record reverted, a deletion that runs against a row someone restored, or never runs.
- **G-H** — a forbidden state is reachable under ordinary concurrency or a retry, or an ordinary concurrent request fails with a 500: a status and its paired columns that disagree, a terminal state left by a path that does not own it, a check-then-insert that throws on the index.
- **G-M** — the damage is a wrong value rather than a wrong state: a first-time value overwritten by a repeat write, an attribution decided from a stale read, a guard whose zero-row result is ignored, refusals in an order that reveals nothing private.
- **G-L** — hardening: the database does not enforce a value set the code already checks, or a correct guard no test can see fail.

**A guard that is absent is a finding**, however unlikely the race looks: the window between a read and a write is the threat model, not a reason the defect is not there. Rate it by what the overwritten state costs. If no state is written at all, say so at the top of `## State findings` — "No state written" — and still fill `## Coverage` and `## Sections checked`.

## Where findings go

A state finding is a correctness defect, so its `G-` ID is public: it may appear in a public pull request, its commits and its issue. It is fixed on the branch like any finding (`wiki/conventions/review-findings.md` §Fix findings; do not file them); one left open is filed in the public `englishstreetventures/osn`. This review files nothing itself — the session that dispatched it does — so say where each finding belongs, and no more.

**A state defect that is also a security, performance or compliance defect gets no `G-` ID.** Those belong to the private tracker, and a `G-` ID is public text, so the defect goes under `## For the tracker`, in the same four fields, headed by the lens it belongs to and the tier that lens's rubric gives, and no ID of its own:

```
**For security, S-H** — <short title>
**Issue:** …
**Why:** …
**Solution:** …
**Rationale:** …
```

The dispatching session gives it the next free ID in that lens's tier once every reviewer has returned. It is a security defect when the state is itself an authorisation — a revoked session, token, invite, key or consent that a stale write honours again; a block; a role — or when the order of refusals tells someone a row's state they may not see. It is a compliance defect when an erasure, retention or consent state can be undone or skipped, so a deletion never completes or a withdrawn consent is used. It is a performance defect when the guard's own predicate defeats the index a hot path depends on. Everything else is a `G-` finding.

## Report shape

The file already exists — Step 0 wrote it, with the five sections in order.

`## State findings` holds the `G-` findings, most severe first, with a summary sentence at the top if you want one.

`## For the tracker` holds the hand-offs above, or `None`.

`## Writers` holds one bold-labelled table per state from Step 1, with every writer Step 2 found, in the diff or not. A state with a writer whose read column is empty was not reviewed.

`## Coverage` lists **every file** from the Step 1 diff, one line each, with a verdict: a finding ID, `For the tracker`, `clear`, `no state written`, or `not source`. A file you did not open is not clear; say so and why.

`## Sections checked` lists each of the nine checks and, under it, each writer it applied to, the file and line you looked at, and the verdict.

### Check the file before you finish

End the file with one line that is not a heading: `**Review complete.** <n> findings: <tally by tier>; <m> for the tracker.` A file without it is a partial review, and a resumed run finishes it. Then:

```bash
grep -c '^## \(State findings\|For the tracker\|Writers\|Coverage\|Sections checked\)$' <report-file>
grep -c '^## ' <report-file>
```

Both must print `5`. Under 5 means a heading was renamed or demoted; over 5 means a section of your own crept in.
