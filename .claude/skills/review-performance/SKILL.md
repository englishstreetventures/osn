---
name: review-performance
description: Use when reviewing a branch diff for performance defects — redundant database round trips, N+1 queries, unbounded reads, per-request layer rebuilds, wasted client fetches, and build steps that ship a broken artefact — and reporting findings with P-C/W/I IDs in the four-field format.
---

Review the current branch diff for performance defects.

`$ARGUMENTS` may name the changed workspaces and the branch. Whether or not it does, start from the diff.

## Step 0 — Write the report skeleton before you review anything

Do this before the diff, before reading a line of source. The file is the
deliverable: a run that leaves a differently-shaped file has produced nothing,
however good the analysis inside it. Writing the shape now means the rest of the
run only fills it in. Leaving it until the end is how a section goes missing.

Copy this verbatim. The report file is `PERFORMANCE-REVIEW.md` unless the task
named another:

```bash
cat > PERFORMANCE-REVIEW.md <<'EOF'
## Performance findings

None

## Measurements

None

## Coverage

None

## Sections checked

None
EOF
```

Those four `##` headings are the whole permitted set, and that is their order.
Replace a `None` as you fill its section in; leave it where the section really
is empty. Never add a fifth `##`. The ones that get invented are `## Summary`,
`## Verified strengths`, `## Scope and method`, `## Verdict` and `## Bottom
line`, and none of them is allowed: a summary sentence goes at the top of
`## Performance findings`, a number you counted goes in `## Measurements`, and
an environment caveat goes at the end of `## Sections checked`.

**From here on this file is only ever edited, never rewritten.** Every later
change replaces a `None`, or inserts text under a heading that already exists.
Do not compose the report in your head and write it out whole at the end — a
single write to `PERFORMANCE-REVIEW.md` discards the shape this step just
established, and that is the one way this run fails outright however good the
analysis is. If you find yourself about to write the whole file, you have lost
the skeleton: read it back first and edit what is there.

**A finding is a bold label, not a heading.** ``P-W1`` goes on its own line as
bold text inside `## Performance findings`, exactly as **Finding format** shows below.
Promoting it to `## P-W1` adds a top-level section, and a run whose findings
each became a heading fails the shape check with four correct sections still
sitting in the file. The same goes for `## Summary`, `## Filing notes` and
anything else the analysis suggests along the way.

What each section holds is under **Report shape** at the end of this file.

## Step 1 — Route the diff

Resolve the base branch first. A stacked branch does not merge into `main`, and diffing against `main` reports the parent branch's files as this branch's:

```bash
BASE=$(git config --get branch.$(git branch --show-current).gh-merge-base || echo main)
git diff --name-only "$BASE"...HEAD
```

Keep that file list. Every file on it gets a verdict in the report, including the ones you clear.

Now grep the diff for the strings below. **A hit makes the named section mandatory**: you work every bullet in that section against **the whole changed file the hit landed in**, not against the matched line, and you record the verdict under `## Sections checked`. A section nothing matched is optional.

Routing widens attention; it never narrows it. **A grep hit is a reason to open a section, never a reason to stop reading.** Some patterns fire on ordinary code — `.get()` on a `Map`, `for (` on a loop over three constants. When every hit in a section is that kind, write one line under `## Sections checked` naming what matched and why the section does not apply, then move on. Never satisfy a bullet with code that is not in the diff.

```bash
git diff "$BASE"...HEAD | grep -nE '<pattern>'
```

| Grep the diff for | Sections that become mandatory |
|---|---|
| `await db.`, `.get()`, `.all()`, `.select(`, `drizzle`, two `await`s in a row in one function | Database round trips |
| `for (`, `.map(async`, `forEach`, `await` inside a loop body | Database round trips, Loops and batching (references) |
| `.where(`, `eq(`, `inArray(`, a new column read in a predicate | Database round trips, Indexes (references) |
| a route file, `.get(`, `.post(`, `derive(`, `resolve(`, middleware, a role or entitlement gate | Database round trips, Shared middleware — and if the diff mounts **two** gates on one route, the first bullet of Shared middleware is mandatory |
| `Effect.provide`, `runPromise`, `Layer.`, `ManagedRuntime` | Effect runtime (references) |
| `fetch(`, `createResource`, `createEffect`, `createMemo`, `onMount` | Client fetches (references), SolidJS reactivity (references) |
| `import * as`, a new dependency in a `package.json`, a route component | Bundle and loading (references) |
| `scroll`, `resize`, `oninput`, `onInput`, `ResizeObserver`, `scrollHeight`, `getBoundingClientRect` | Layout and event handlers (references) |
| `build`, `astro.config`, `wrangler.toml`, `turbo.json`, a `scripts/` file, a workflow under `.github/` | Build and deploy (references) |
| `.changeset/` | Changesets (references) |

## Step 2 — Work the mandatory sections

Read every changed source file in full, then take each mandatory section one bullet at a time. A bullet names a property the code is supposed to have: find the code that would carry that property, and check whether it does. A bullet you cannot tie to any line of the diff is cleared. A bullet whose code you found and whose property is missing is a finding — write it up before moving to the next bullet, or you will lose it.

**Check the shape once, as soon as the first finding is in the file.** Not at the
end — by then a clobbered skeleton has cost the whole run, and the same two
counts that catch it later catch it here for one command:

```bash
grep -c '^## \(Performance findings\|Measurements\|Coverage\|Sections checked\)$' PERFORMANCE-REVIEW.md
```

It must print `4`. If it prints less, the skeleton from Step 0 was overwritten
rather than edited: restore the 4 headings, put the finding back under the right
one, and edit from then on.

**Count before you write, and write the count down first.** A performance
finding is an argument about cost, so establish the cost before you argue.
Before drafting a finding, go to the code and count the thing that is actually
charged for — statements issued on the request, rows read, bytes added to a
bundle, times a component re-renders — with the number as it stands and the
number after your fix. Put that pair in `## Measurements` **in the same moment
you count it**, not at the end of the run: a `## Measurements` section filled in
afterwards from memory is a section of estimates, and it reads as one. The
finding's `Why` then quotes the count rather than restating that something is
slow. Where you genuinely cannot count — a bundle size with no build to run — say
what you estimated and from what, on its own line in the same section.

**A cost that is paid needlessly is a finding.** Do not wait for a benchmark to prove it. Rate it `P-I` if the path is cold or the saving is small; do not omit it.

**A saving in one place that adds cost in another is not a saving.** Every optimisation on shared code — middleware, a gate, a helper a dozen files import — is judged by what it does to the callers that did not ask for it. Check them.

**A comment is a claim, not a control.** A block explaining that a value is
cached, batched, indexed or hoisted is the author's intent; the statement count
is what the database charges for. Check the code does what the comment says, and
never report the comment itself as the defect — a `TODO` beside correct code is
not a performance finding.

---

## Database round trips

The dominant defect class in this repo. D1 is a network hop per statement, so the count of statements is the cost.

### Two `await`s in a row: the diagnosis, then the fix

Almost every finding in this section starts as a pair of sequential statements.
The pair is one defect with two possible fixes, and picking between them is a
two-question decision. Answer them in this order — the second question is
meaningless until the first is settled.

**The pair is not always in one function.** Two middlewares mounted on the same
route, a gate and the handler behind it, or a service call either side of an
`await` in a route body are all the same shape — the statements are sequenced by
the request, not by a line of code you can point at. Sequential gates are the
common case here and have their own bullet under **Shared middleware**; work
them with these two questions all the same.

**Question 1 — does the second statement have to wait?** It has to wait only if
the key it is issued on was *produced* by the first. Trace that key back to
where it was bound, in the code, not by eye:

- Bound before the first query ran — the function's own argument, a path
  parameter, a field of the request body — then **it does not have to wait**,
  however it is spelled at the call site. `getListing(id)` that awaits a row
  and then calls `fetchCategories(row.id)` is the classic disguise: `row.id`
  and `id` are the same value, the second query never needed the first, and the
  code only looks sequenced. This is a finding.
- Genuinely produced by the first — a foreign key the first row carried and
  nothing else knew — then the sequence is real and is not a finding on its own.
  Move to the unbounded-read and repeated-read bullets instead.

**Question 2 — can one statement answer both?** Only once the pair is
established as needlessly sequential:

- **It can, so fold.** The second query's rows are reachable from the first
  query's own `FROM`/`JOIN` — the same row, or a table keyed on it. The fix is
  an `EXISTS (…)` or a joined column on the earlier query's select, so the
  request drops a statement rather than overlapping two. `cire/api/src/services/directory.ts`
  already does this with its `inWedding` column; copy that idiom rather than
  inventing one. Prefer this whenever it is available: D1 charges per statement,
  so a fold removes cost where running in parallel only hides it. Not a cache,
  not a memo, not `Promise.all` — each of those still issues both statements.
- **It cannot, so run them together.** The two touch unrelated tables, or
  different stores, or the second's shape is not something a join to the first
  would serve. `Promise.all`, `Effect.all` (with `concurrency: "unbounded"`), or
  a `db.batch`. Statement count is unchanged and the latency of one hop is
  removed instead of two.

Say in `Rationale` which of the two you picked and why the other does not
apply. A finding that names the pair but leaves the fix as "parallelise or
combine these" has not made the decision the reader needed.

### The rest of the section

- **The same rows read twice in one request.** A collection scanned once to validate and again to derive a value.
- **Rows read whose value cannot change the outcome.** A cap check that fetches every row when the input is already under the floor; a ceiling derived from every row when only two of them can raise it.
- **A result the caller already holds, fetched again.** A create or claim handler returns the record it wrote, and the next screen fetches it by ID.

## The rest of the checklist

Eight more sections live in `references/checklists.md`: **Loops and batching**,
**Indexes**, **Unbounded reads**, **Effect runtime**, **Client fetches**,
**SolidJS reactivity**, **Bundle and loading**, **Layout and event handlers**,
**Build and deploy** and **Changesets**. They are there rather than here
because no scenario in this repository's eval suite exercises them, not because
they matter less — open the file whenever Step 1 routes to one of them, and work
it exactly as you would a section on this page.

Two are worth carrying in your head. **A build step that fails and still exits
`0` ships a broken artefact**, and the layers that swallow it are a provider
built with `throwOnError: false`, a retry that logs and continues, and a warning
where a throw belongs. And **an empty changeset is correct** when the branch
touches only the allowlisted paths in `scripts/changeset-required.sh`; do not
flag it.

## Shared middleware

- **Two gates mounted in sequence on the same route parameter.** A role gate resolves the caller against `:weddingId`; an entitlement, quota or feature gate mounts behind it and selects on that same `:weddingId`. **This is the two-`await` case from Database round trips, spread across two files, and it is the shape this section most often misses** — the pair does not look like a pair, because you never see both statements in one function. Work it with the same two questions. The key the second gate is issued on is the *route parameter*, bound before the first gate ran, so it never had to wait. And middleware order forbids running them together: the second gate mounts behind the first and cannot start earlier. **That leaves exactly one fix — the fold.** An optional key on the first gate, adding an `EXISTS (…)` column to the query it already issues, so a gated request drops a statement. A cache, a memo, a request-scoped store and `Effect.all` are each the wrong answer here and are worth naming as rejected in `Rationale`: every one of them still issues both statements, and the second gate cannot start early enough for concurrency to buy anything. Count who else mounts the first gate before you propose it — `grep -rn '<gateName>(' <workspace>/src/routes` — and make the key optional so they pay nothing.
- A fetch added unconditionally to a gate that a dozen routes mount, where most of them do not need it. That is a repo-wide regression dressed as an optimisation. The fix is an optional parameter: a route that does not ask for the extra data runs exactly the query it always ran.
- A middleware that resolves the same record every route behind it then resolves again. **Read this one narrowly**: it is about a *handler* repeating its own gate's work. A second gate duplicating the first is the bullet above, not this one.
- **This bullet also applies to a fix you propose.** Before writing a `Solution` that adds a column, a join or a fetch to shared code — a gate, a middleware, a helper a dozen files import — count the callers that do not need it (`grep -rn '<gateName>(' <workspace>/src`) and say in `Rationale` what they now pay. If the answer is anything but "nothing", the Solution is not finished: make the extra work an **optional parameter**, and state that a caller passing none runs exactly the query it ran before. A fix that taxes the callers that did not ask for it is a new finding, not a fix.

---

## Finding format

IDs are `P-C1`, `P-C2`, … Critical; `P-W1`, … Warning; `P-I1`, … Info. The counter increments within each tier across the whole report, so a finding can be referred to unambiguously.

Each finding uses exactly this structure:

```
**P-W1** — <short title>
**Issue:** What the problem is, with the file and line.
**Why:** The failure mode, the scale at which it bites, and what it costs — a count of round trips, a bundle size, a re-render count. Not "this is slow".
**Solution:** The concrete change.
**Rationale:** Why that change removes the cost without adding one elsewhere.
```

Tiers:

- **Critical (P-C)** — measurable degradation in production now: an unbounded read on a hot path, a per-request layer rebuild, a broken artefact that ships.
- **Warning (P-W)** — bites under load or as data grows: a redundant round trip, an N+1 on a list that is short today.
- **Info (P-I)** — a real but small waste, or a best-practice gap.

If a section is clear, say so. If the whole review is clear, write "No performance concerns found." — and still fill in `## Coverage` and `## Sections checked`.

## Report shape

The file already exists — Step 0 wrote it, with the four sections in order.
Keep that. This section says what goes in each one.

`## Performance findings` holds the findings, in the format above, most severe
first, with a summary sentence at the top if you want one.

`## Measurements` names anything you counted rather than guessed — statements per request before and after, rows read, bytes added to a bundle. A finding whose `Why` claims a cost that appears nowhere here is an estimate, and should say so.

`## Coverage` lists **every file** from the Step 1 diff, one line each, with a verdict — a finding ID, or `clear`, or `not source` (lockfiles, generated output, fixtures). A file you did not open is not clear; say you did not open it and why.

`## Sections checked` lists each section Step 1 made mandatory, and under it each bullet in that section, the code you looked at, and the verdict. This is the part that catches a skim: a bullet with no file and no line beside it was not checked.

### Check the file before you finish

The same two counts as Step 2's mid-run check, run once more on the finished
file:

```bash
grep -c '^## \(Performance findings\|Measurements\|Coverage\|Sections checked\)$' <report-file>
grep -c '^## ' <report-file>
```

Both must print `4`. Under 4 means a heading was renamed or demoted; over 4
means a section of your own crept in — a summary sentence belongs at the top of
`## Performance findings`, a number you counted in `## Measurements`, an
environment caveat at the end of `## Sections checked`.
