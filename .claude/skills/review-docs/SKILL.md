---
name: review-docs
description: Use when reviewing the documentation a branch changes — CLAUDE.md, READMEs and pages under wiki/ — or sweeping the whole wiki with --full. Cross-checks every claim a page makes against the code, finds wikilinks and heading anchors the branch broke, checks frontmatter and page shape, and reports D-C/H/M/L findings in the four-field format.
---

Review the documentation on the current branch — or the whole `wiki/` tree when `$ARGUMENTS` is `--full` — and report what is wrong, stale, unreachable or badly shaped.

Docs in scope: `CLAUDE.md` and `README.md` at the root, any `README.md` inside a workspace, and every `.md` under `wiki/`.

## Step 0 — Write the report skeleton before you read anything

The report is the deliverable. A run that leaves a differently-shaped file has produced nothing, however good the review inside it, and a report written at the end from memory loses a section. Copy this verbatim; the file is `DOCS-REVIEW.md` at the repo root unless the task named another:

```bash
cat > DOCS-REVIEW.md <<'EOF'
## Scope

None

## Findings

None

## Suggested next sweeps

None
EOF
```

Those three `##` headings are the whole permitted set, in that order. Replace a `None` as you fill its section; never add a fourth `##` — `## Summary`, `## Verdict` and `## Method` are the ones that get invented. Inside `## Findings`, one `###` per tier that has findings (`### Critical`, `### High`, `### Medium`, `### Low`); a finding ID is a bold label under it, never a heading.

**From here on the file is only ever edited, never rewritten.** Do not compose the report in your head and write it out whole at the end — a single write discards the shape this step established. If you find yourself about to write the whole file, read it back and edit what is there.

## When a step cannot run

**No step is a stop.** The Obsidian MCP (`mcp__obsidian-wiki__*`) and the `obsidian` CLI exist only on the maintainer's Mac with Obsidian open; in a remote, CI or sandboxed session they are absent. That is expected, not a fault — do not retry, and do not ask for Obsidian to be opened. Every check below has a shell form; use it.

Even when the MCP is there, **it indexes `main`, not this branch.** Any page in `git diff --name-only "$BASE"...HEAD -- 'wiki/**'` is one it shows the pre-branch version of. Use it for a `--full` sweep of `main`; use the shell for a branch diff.

This is a review. Do not edit a page unless the task says to, and then only a `D-L` whose fix is mechanical. A `D-M` or above is surfaced for a decision; rewriting a page while reviewing it is how this family of drift starts. When you do fix, use Edit in this worktree — the MCP write tools and `obsidian create`/`append` write to `main`'s tree.

## Step 1 — Resolve the scope

```bash
BASE=$(git config --get branch.$(git branch --show-current).gh-merge-base || echo main)
git diff --name-only "$BASE"...HEAD -- '*.md' 'wiki/**'
git diff --name-only "$BASE"...HEAD          # the code the docs have to agree with
```

A stacked branch merges into its parent, not `main`; the config keeps the parent's pages out of this diff. With `--full`, scope is every file under `wiki/` plus the root `CLAUDE.md` and `README.md`. If `$ARGUMENTS` names workspaces or paths, scope to the docs relevant to those.

Write `## Scope` now: the files in scope, and the files out of scope and why.

## Step 2 — Cross-check every claim against the code

Read each in-scope page in full. A page that is tidy but contradicts the code is the worst failure this review exists to catch, and it is invisible to a read that does not open the source. So extract the claims and check each one:

| Claim shape in the page | Check |
|---|---|
| A package name `@scope/name` | `git grep -l '"name": "@scope/name"' -- '**/package.json'` — no hit means a rename the page missed |
| A path in backticks | `test -e <path>`; a directory the page describes as scaffolded or empty, `ls` it |
| A route `/api/...`, `GET /x` | grep the owning `src/routes/` |
| A number with a unit — days, minutes, seconds, KB, a test count, a cap | find the constant in source and compare the number, not the sentence |
| An env var `UPPER_SNAKE` | `git grep UPPER_SNAKE -- '*.ts' '*.toml'` |
| A status word — placeholder, planned, not yet built, deprecated | `ls` the directory; a package with routes and a port is not a placeholder |
| A security-posture statement — hashed at rest, HttpOnly, single-use | open the code that would make it true |

A claim the code contradicts is **D-C** when a reader would act on it and break something — a runbook step, a code example, a security-posture claim — and **D-H** when it sends them looking in the wrong place: a package name, a path, a removed route described as current.

**Then check the pages the branch did not touch.** When the code diff changes a constant, a name, a path or a route, the old value usually lives on more than one page:

```bash
git diff "$BASE"...HEAD -U0 -- ':!*.md' | grep '^-' | grep -v '^---'   # what the code stopped saying
git grep -n '<old value>' -- 'wiki/**/*.md' CLAUDE.md README.md         # who still says it
```

A page in the diff that still carries the old value is a finding. A page outside the diff that carries it is stale as of this branch too — it is not this branch's file, so it goes under `## Suggested next sweeps`, named by path, not silently dropped. Do the same for a value the branch changed in a page: if the page now says 14 and the code still says 30, the page is wrong, not the code.

## Step 3 — Links and anchors

**Wikilinks.** On a branch diff, check the changed pages locally — the MCP's `find_broken_links` cannot see them:

```bash
comm -23 \
  <(git diff "$BASE"...HEAD --name-only -- 'wiki/**/*.md' \
      | xargs -r grep -oh '\[\[[^]|#]*' | sed 's/^\[\[//; s#.*/##' | sort -u) \
  <(find wiki -name '*.md' | xargs -n1 basename | sed 's/\.md$//' | sort -u)
```

Two shapes that come out of that pipe and are not findings: a TOML array header inside a code fence (`[[env.production.d1_databases]]`) has a wikilink's shape and is configuration, not a link; and a target ending in `\` is an alias inside a table cell — `[[oidc-provider\|OIDC]]` — where Obsidian requires the pipe escaped so the table does not split on it. Check that the name before the `\` resolves and move on; reporting `oidc-provider\` as a missing page is a false positive.

**Heading anchors.** `[[page#Heading]]` and a same-page `](#heading)` survive a rename of the page and break silently on a rename of the heading. For every page whose headings the branch renamed, added or removed:

```bash
git diff "$BASE"...HEAD -- wiki/ | grep -E '^[-+]#{1,6} '           # which headings moved
git grep -n '\[\[<page>#\|\](#' -- 'wiki/**/*.md' <page>              # who links into them
```

A link whose target heading no longer exists is a finding on the branch even when the linking page is outside the diff — the branch broke it.

**Other link shapes.** Wiki-to-wiki links are `[[wikilinks]]`, not relative markdown; a link to a file outside the vault (`[[CLAUDE]]` for the root `CLAUDE.md`) does not resolve in Obsidian and should be a relative markdown link; a link from a page to a source file is relative to the page and must resolve — `test -e` it from the page's directory.

## Step 4 — Frontmatter, shape, and the two rendering surfaces

Every page under `wiki/` except `wiki/README.md` has YAML frontmatter with `title` (matches the `#` heading), `tags`, `related` (≥ 2 wikilinks as `"[[page]]"` strings) and `last-reviewed` (`YYYY-MM-DD`, bumped on every touch). `packages`, where present, names real `package.json` names; `status` is one of `active`/`current`/`planned`/`in-progress`/`completed`/`deprecated` and matches reality. A `related` list written inline and one written as a YAML block are both valid — flagging either shape is noise.

Shape: a purpose opener a reader landing from a wikilink can orient on in two sentences; overview separated from deep detail; every page links to at least two others and is reachable from `wiki/index.md` and the `CLAUDE.md` navigation table. On a branch, check the branch's own `index.md` — a page created here reads as an orphan to any index of `main`.

Communication aids are recommended with the surface in mind. Tables, mermaid, footnotes and the five alert-compatible callouts (`note`/`tip`/`important`/`warning`/`caution`) render on GitHub and in Obsidian; every other callout type, `[[wikilinks]]`, embeds, block IDs and `==highlights==` render in Obsidian only; `.base` and `.canvas` files are raw YAML/JSON on GitHub and unreadable to a grep-only session. So a list of N comparable things wants a table, a multi-step flow wants a mermaid diagram, a warning buried in a paragraph wants a callout — and a `.base` or `.canvas` carrying content that exists nowhere else is **D-M**.

Bloat is a finding too: a runbook describing shipped work as upcoming, a `CLAUDE.md` row that restates a wiki page instead of summarising and linking it, a "Phase N" label with no decision behind it, a reference to a store, env var or column that no longer exists.

The full per-section checklist — currency, bloat, aids, structure, frontmatter, links, hygiene — is in `references/checklist.md`; on a `--full` sweep, work through it page by page.

## Step 5 — Docs-only security hygiene

`review-security` covers source. Here: pasted secrets (`eyJ…` JWTs, cloud or payment keys, PEM headers, long hex); example code teaching an insecure pattern (`Math.random()` for tokens, string-built SQL, disabled TLS, MD5/SHA-1); real `sub`, `kid` or user ids in a diagram where `<jwt>` belongs; and a security-posture claim the code does not honour — that last one is **D-C**.

## Finding format

IDs: `D-C1`, `D-C2`, … Critical; `D-H1`, … High; `D-M1`, … Medium; `D-L1`, … Low. The counter increments within each tier across the whole report.

```
**D-H1** — <short title>
**Issue:** What is wrong. Quote the offending line with its `file:line`.
**Why:** Who is misled, what it teaches, or which link or diagram rots next.
**Solution:** What should change — "replace X with Y", not "clarify this section".
**Rationale:** Why that fix holds and will not drift the same way in three months.
```

- **D-C** — the doc will mislead a reader into a broken action: a runbook naming tables, routes or tools that do not exist; a code example that cannot compile; a security claim the code contradicts.
- **D-H** — stale architecture described as current: package names, paths, removed patterns. Sends the reader to the wrong place.
- **D-M** — structure and communication: lists that should be tables, prose flows that should be diagrams, no purpose opener, `CLAUDE.md`/wiki duplication, a page absent from the map, load-bearing `.base`/`.canvas`.
- **D-L** — frontmatter polish, a stale `last-reviewed`, a broken link to a low-traffic page, wording drift. Batch into one commit.

## Report shape

`## Scope` — one paragraph: the files reviewed, the cross-checks run against the source, the files out of scope and why.

`## Findings` — grouped by tier under `###` headings, each finding in the four-field block. If nothing is wrong, write "No documentation concerns found." followed by the cross-checks that ran, so the reader sees the review was not a no-op.

`## Suggested next sweeps` — at most three, each a path and a sentence: the pages outside the diff that Step 2 found still carrying an old value, and anything a finding above unblocks. `None` if there is nothing.

### Check the file before you finish

```bash
grep -c '^## \(Scope\|Findings\|Suggested next sweeps\)$' DOCS-REVIEW.md
grep -c '^## ' DOCS-REVIEW.md
```

Both must print `3`. A first count under 3 means a section was renamed or demoted; a second count above 3 means you added a top-level section of your own, and it is not allowed.
