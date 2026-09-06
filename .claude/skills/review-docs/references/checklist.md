# The full docs-review checklist

The `SKILL.md` gives the retrieval procedure — which claims to extract from a page and how to check each. This is the per-section list behind it, for a `--full` sweep or for a page the procedure did not settle. Each bullet names the tier it usually lands at.

## 1. Currency — does the doc still match the code?

- **Package / module renames** — refs to packages that no longer exist or have moved (`@osn/core`, `@osn/crypto`, `@osn/app`, `@cire/web`, `@cire/organiser`, `@pulse/app` are all former names). Cross-check against `package.json` `name` fields and workspace directories. D-H.
- **File-path drift** — paths that no longer resolve (`osn/core/src/...`, `osn/app/src/...`, `cire/web/...`). `stat` the file or `ls` the directory. D-H.
- **Removed routes, endpoints, stores** — endpoints listed as current that were deleted (`/login/otp/*`, `/login/magic/*` as primary login; `pkceStore`, `otpStore`). Grep `src/routes/` and `src/services/`. D-H; D-C inside a runbook step.
- **Status claims** — "placeholder", "not yet built", "planned" for a directory that is scaffolded, or the reverse. D-H.
- **Primary-vs-secondary factor conflation** — OTP / magic-link / PKCE described as a primary login when the invariant is passkey-primary. D-C.
- **Architecture statements** — "a library that never calls `listen()`" for a package that is now a binary. Check `package.json` `scripts` and `src/index.ts`. D-H.
- **Counts and constants** — "209 tests", "5-min TTL", "30-day cookie" when the number in source differs. D-H; D-C when a runbook acts on it.

## 2. Bloat — legacy content to trim

- **Runbooks describing shipped work as future work** — mark historical or delete. D-M.
- **Duplicated detail between `CLAUDE.md` and a wiki page** — the `CLAUDE.md` row is a one-line summary plus a `[[wiki/...]]` link; if both hold the detail, one drifts. D-M.
- **"Phase N" language without a decision** — deferred decisions live for months with no resolution; suggest `wiki/deferred-decisions.md` or removal. D-M.
- **Defunct config / env / store references** — env vars, Redis namespaces, columns, in-memory stores that no longer exist. D-H.
- **Forward-looking "will migrate to"** for migrations that shipped. D-M.

## 3. Communication aids — tables, diagrams, callouts

- **List-shaped content that is tabular** — route inventories, token types, rate limits, schema columns, package maps, phase status. A Markdown table renders everywhere. D-M.
- **Multi-step flows in prose** — token issuance / verification / rotation, registration, runbook diagnosis trees, S2S call sequences: a mermaid `sequenceDiagram` or `flowchart`. D-M.
- **ASCII-art diagrams** — replace with mermaid unless the ASCII adds something mermaid cannot. D-M.
- **Missing at-a-glance table** — a page describing N of something readers compare wants the table at the top. D-M.
- **A warning buried in a paragraph** — a footgun, a "never do X", a prerequisite that bites: `> [!warning]`, `> [!important]`, `> [!tip]`. Long asides most readers skip: a collapsed `> [!note]-`. D-M.
- **Surface check before recommending** — tables, mermaid, footnotes and the five alert-compatible callouts render on GitHub and in Obsidian; other callout types, `[[wikilinks]]`, embeds, block IDs and `==highlight==` are Obsidian-only; `.base` and `.canvas` are raw YAML/JSON on GitHub. The `obsidian:obsidian-markdown` skill is the syntax authority when it is available.
- **`.base` / `.canvas` as additions, never replacements** — a record set that outgrew its table can have an `obsidian:obsidian-bases` view *beside* it; a tangled graph can have an `obsidian:json-canvas` *beside* the mermaid. One carrying content that exists nowhere else is D-M: a GitHub reader sees JSON and a grep-only session reads neither.

## 4. Structure — page shape and navigability

- **No purpose opener** — the page starts in implementation detail; a reader from a wikilink needs two orienting sentences. D-M.
- **Overview and deep detail interleaved** — split into Overview / Current surface / Details, or into sibling pages. D-M.
- **Fewer than two outgoing wikilinks** — `wiki/README.md`'s convention. D-L.
- **Not reachable from the map** — every `wiki/**/*.md` is linked from `wiki/index.md` and from the `CLAUDE.md` Wiki Navigation table. On a `--full` sweep `mcp__obsidian-wiki__find_orphaned_notes` finds these; on a branch, check the branch's own `index.md` by hand — a page created on the branch reads as an orphan to any index of `main`. D-M.
- **`related` that does not signal navigation** — empty or stale `related` blocks. D-L.

## 5. Frontmatter

Obsidian calls these properties and types them; a `related` list inline (`related: ["[[a]]", "[[b]]"]`) and one as a YAML block are both valid, and calling either a finding is noise.

Every `wiki/**/*.md` except `wiki/README.md`:

- `title` — matches the top-level `#` heading
- `tags` — array
- `related` — array of `"[[page]]"` strings, ≥ 2 sibling pages, wikilinks not bare names or paths
- `last-reviewed` — `YYYY-MM-DD`; > 3 months old on a page whose code changed recently is D-L
- `packages` where present — real `package.json` names
- `status` where used — `active` / `current` / `planned` / `in-progress` / `completed` / `deprecated`, and true

## 6. Wikilinks and cross-references

- **Broken wikilinks** — on a `--full` sweep, `mcp__obsidian-wiki__find_broken_links` uses Obsidian's own resolver and handles `[[page#Heading]]`, `[[page#^id]]`, `[[page|alias]]` and path-style targets. On a branch it is blind — use the `comm -23` recipe in `SKILL.md`. D-L for a low-traffic page, D-M for a page in the navigation table.
- **Not findings** — a TOML array header in a code fence (`[[env.<name>.d1_databases]]`); a target ending in `\`, which is the escaped pipe of an alias inside a table cell (`[[page\|alias]]` — Obsidian needs it so the table does not split on the pipe). Check the name before the `\` resolves and move on.
- **Heading or block anchors that moved** — `[[page#Heading]]` breaks silently on a heading rename. For any page the branch reorganised, find what links in (`get_backlinks`, or `git grep '\[\[<page>#'`). D-M.
- **Out-of-vault wikilinks** — the vault root is `wiki/`; `[[CLAUDE]]` for the repo-root `CLAUDE.md` does not resolve in graph view. Use `` [`../CLAUDE.md`](../CLAUDE.md) ``. D-L.
- **Relative markdown links between wiki pages** — the convention is `[[wikilinks]]`. D-L.
- **Source-file links** — relative and correct from the page's directory (`[osn/api/src/routes/auth.ts](../../osn/api/src/routes/auth.ts)` from `wiki/systems/`). A broken one is worse than none. D-M.

## 7. Docs-specific security hygiene

`review-security` covers source; this is what lands only in docs.

- **Pasted secrets** — real JWTs (`eyJ…`), AWS / Stripe / GitHub / Slack / Google keys, PEM headers, long hex strings. D-C.
- **Example code teaching an insecure pattern** — `Math.random()` for tokens, string-built SQL, disabled TLS flags, MD5 / SHA-1 / DES, real `.env` values as examples. D-H.
- **Real identifiers in snippets or diagrams** — a real `sub`, `kid` or user id where `<jwt>`, `<kid>` belongs. D-M.
- **Security-posture claims the code contradicts** — "refresh tokens are hashed at rest" over a schema that stores them raw. D-C.
