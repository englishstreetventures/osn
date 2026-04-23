Analyse the current branch diff (or the full `wiki/` tree if `$ARGUMENTS` is `--full`) for documentation concerns. If `$ARGUMENTS` contains a list of changed workspaces or file paths, scope the review to docs relevant to those; if not provided, derive scope from `git diff --name-only main...HEAD -- '*.md' 'wiki/**'`.

Docs reviewed by this skill:

- `CLAUDE.md` at the repo root
- `README.md` at the repo root
- Any `README.md` inside a workspace (e.g. `zap/README.md`)
- Every `.md` under `wiki/`

Read each in-scope file in full. Where a doc makes a factual claim about the code (package name, file path, route exists, column name, env var), cross-check against the actual source — grep for the symbol, `cat` the `package.json`, or list the referenced directory. A doc that is *internally tidy* but contradicts the code is the most dangerous failure mode and must be flagged at the highest tier.

---

## 1. Currency — does the doc still match the code? (OWASP-of-docs)

- **Package / module renames** — refs to packages that no longer exist or have moved (e.g. `@osn/core`, `@osn/crypto` when those are now `@osn/api`, `@shared/crypto`). Cross-check against `package.json` `name` fields and workspace directories.
- **File-path drift** — linked or described paths that no longer resolve (e.g. `osn/core/src/...`, `osn/app/src/...`). Cross-check by listing the directory or `stat`-ing the file.
- **Removed routes / endpoints / stores** — endpoints listed as current that were deleted (e.g. `/login/otp/*`, `/login/magic/*`, hosted `/authorize` + PKCE, `pkceStore`, `otpStore`). Cross-check by grepping `src/routes/` and `src/services/`.
- **Status claims** — "placeholder", "not yet built", "planned" when the directory is scaffolded, or vice versa (e.g. calling `@zap/api` "a placeholder" when it has routes and a port).
- **Primary-vs-secondary factor conflation** — docs that list OTP / magic-link / PKCE as primary login when the project's invariant is passkey-primary.
- **Architecture statements** — "`@osn/core` is a library that never calls `listen()`" when the package has been consolidated into a binary. Cross-check against the actual `package.json` `scripts` and `src/index.ts`.
- **Counts / version numbers** — "209 tests" when the real number is different; "5-min TTL" when the constant changed.

## 2. Bloat — legacy content that should be trimmed

- **Runbooks describing completed work as future work** — e.g. an "S2S migration" runbook that describes the transition as upcoming when `graphBridge.ts` already does HTTP+ARC. Either mark the runbook as historical or delete it.
- **Duplicated detail between `CLAUDE.md` and a wiki page** — the CLAUDE.md Key Patterns row should be a one-line summary + a `[[wiki/...]]` link, not a paragraph that restates the wiki page. If both hold the same detail, one of them will drift.
- **"Phase N" language without a decision** — deferred decisions or phase labels that have been live for months without a resolution. Suggest moving them to `wiki/TODO.md` Deferred Decisions or removing them.
- **Defunct config / env / store references** — references to env vars, Redis namespaces, DB columns, or in-memory stores that no longer exist.
- **Forward-looking "will migrate to" text** for migrations that already shipped.

## 3. Communication aids — tables, diagrams, cheat-sheets

- **List-shaped content that is actually tabular** — route inventories, token types, endpoint rate limits, schema columns, package mapping, phase status. Convert to a Markdown table; tables render in Obsidian, GitHub, and most editor previews.
- **Multi-step flows explained in prose** where a Mermaid `sequenceDiagram` or `flowchart` would be clearer:
  - Token issuance / verification / rotation
  - Registration flows
  - Runbook diagnosis trees
  - S2S call sequences
- **ASCII-art diagrams** — replace with Mermaid unless the ASCII adds something Mermaid cannot (rare). Mermaid renders in Obsidian and in GitHub's Markdown viewer.
- **Missing at-a-glance tables** — if a page describes N of something (routes, packages, columns, limits, finding IDs) and readers will compare or reference them, a table belongs at the top.

## 4. Structure — page shape and navigability

- **No purpose opener** — page jumps into implementation detail without a "What is this for / why does it exist" paragraph at the top. Readers landing from a wikilink need a 2-sentence orient.
- **Overview and deep detail interleaved** — split into "Overview" / "Current surface" / "Details" sections or, for big pages, into sibling pages.
- **Every wiki page links to ≥2 other wiki pages** (per the repo's own `wiki/README.md` convention). Flag pages that don't.
- **Wiki pages reachable from the map** — every `wiki/**/*.md` should be linked from `wiki/index.md` AND from the `CLAUDE.md` "Wiki Navigation" table. Flag orphans.
- **Related-field signals navigability** — `related` in YAML frontmatter should list the wiki pages a reader is most likely to jump to next. Empty or stale `related` blocks are a structure smell.

## 5. Frontmatter — YAML metadata

Every wiki page (`wiki/**/*.md` except `wiki/TODO.md` and `wiki/README.md`) must have YAML frontmatter between `---` fences with:

- `title` — human-readable page title (matches the top-level `#` heading)
- `tags` — array of topic tags; used for Obsidian filtering
- `related` — array of `"[[page-name]]"` strings pointing to ≥2 sibling wiki pages
- `last-reviewed` — ISO date (`YYYY-MM-DD`); update whenever the page is touched

Also check:

- `packages` on pages scoped to workspace(s) — package names match real `package.json` `name` fields (no `@osn/core`, no `@osn/crypto`)
- `status` where used — one of `active` / `current` / `planned` / `in-progress` / `completed` / `deprecated`, and matches reality
- `related` entries are wikilinks (`"[[foo]]"`), not bare strings (`"foo"`) or relative paths
- `last-reviewed` is not suspiciously old (>3 months) for a page whose code has changed recently

## 6. Wikilinks + cross-references

- **Broken wikilinks** — `[[foo]]` whose basename doesn't match any file under `wiki/`. Derive the list by running `ls wiki/*.md wiki/*/*.md | xargs -I {} basename {} .md`.
- **Out-of-vault wikilinks** — the Obsidian vault root is `wiki/`. Links to files outside it (e.g. `[[CLAUDE]]` pointing to repo-root `CLAUDE.md`) don't resolve in graph view. Replace with relative markdown links: `` [`../CLAUDE.md`](../CLAUDE.md) ``.
- **Relative markdown links between wiki pages** — the convention is `[[wikilinks]]`, not `[foo](../foo.md)`. Flag mixed usage.
- **Source-file links** — links from a wiki page to source code should be relative and correct (e.g. `[osn/api/src/routes/auth.ts](../../osn/api/src/routes/auth.ts)` from `wiki/systems/`). Broken source-file links are worse than no link.

## 7. Docs-specific security hygiene

Already light-duty because `review-security` covers source; here we check for things that land *only* in docs:

- **Pasted secrets** — real JWTs (`eyJ…` prefix), AWS / Stripe / GitHub / Slack / Google keys, PEM headers, long hex strings.
- **Example code teaching insecure patterns** — `Math.random()` for token generation, raw-SQL construction, disabled TLS flags, MD5/SHA1/DES, `.env` values committed as examples.
- **Mermaid / code snippets embedding real identifiers** — check for real `sub`, `kid`, or user-IDs rather than placeholders like `<jwt>`, `<kid>`.
- **Security-posture claims that contradict the code** — if the docs say "refresh tokens are hashed at rest" but the schema stores them raw, that's a high-tier finding.

---

---

## Finding format

Number each finding with a short ID: `D-C1`, `D-C2`, … for Critical; `D-H1`, `D-H2`, … for High; `D-M1`, … for Medium; `D-L1`, … for Low. Increment the counter within each tier across the full report.

Each finding must use this exact structure:

```
**D-H1** — <short title>
**Issue:** What the problem is, stated concisely. Quote the offending line and give the file:line reference.
**Why:** Why this matters — who is misled, what pattern it teaches, or which link/diagram will rot next.
**Solution:** What should change. Prefer a concrete diff ("replace X with Y") over a vague direction ("clarify this section").
**Rationale:** Why this solution fixes it and won't create the same drift in three months.
```

Tier definitions:

- **Critical (D-C)** — the doc is actively wrong in a way that will mislead a reader into broken actions. Examples: a runbook whose diagnostic steps reference tables / routes / tools that don't exist; a code example that won't compile; a security-posture claim that contradicts the implementation.
- **High (D-H)** — stale architectural content: package names, file paths, or removed patterns described as current. The doc isn't wrong enough to break the reader's hand, but it will send them looking in the wrong place.
- **Medium (D-M)** — structural / communication gaps: bullet lists that should be tables, prose flows that should be diagrams, missing purpose openers, duplicated detail between `CLAUDE.md` and the wiki, pages absent from the navigation map.
- **Low (D-L)** — frontmatter polish, stale `last-reviewed` dates, broken wikilinks to low-traffic pages, minor wording drift. Worth batching into a single commit.

---

## Output shape

1. **Scope** — one paragraph: which files were reviewed, which cross-checks were run against source code, which files were out of scope and why.
2. **Findings** — grouped by tier (C / H / M / L), each using the four-field block above.
3. **Suggested next sweeps** — at most three; prune items now unblocked by the findings above (e.g. "after D-H3 lands, the ARC source-file paths in `arc-tokens.md` need a follow-up rebase").

If nothing is worth flagging, state that explicitly: "No documentation concerns found." followed by the list of cross-checks that *were* run (so the reader sees the review wasn't a no-op).

---

## When to apply fixes inline

This skill is a **review** skill: by default it produces findings only, not edits. Apply fixes inline only when:

- The user explicitly asks, OR
- The finding is low-tier (D-L) and the fix is mechanical — add missing `last-reviewed`, fix a typo, replace a broken wikilink with the right one.

Anything D-M or above — surface the finding, get a decision, then fix. Rewriting a page while reviewing it is how this family of drift started in the first place.
