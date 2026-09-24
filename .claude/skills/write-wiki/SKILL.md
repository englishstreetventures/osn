---
name: write-wiki
description: Use before creating, editing or restructuring any page under wiki/ — the Obsidian vault for the whole monorepo. Covers where edits must be made, the syntax skill to load, what renders on GitHub as well as in Obsidian, required frontmatter, linking a new page into the map, and how to write a measured number.
---

Every page under `wiki/` is read in two places: Obsidian, and GitHub. Follow each step before you finish the edit.

## 1. Edit in your own worktree

Write pages with Edit or Write in the current worktree. Never use the Obsidian MCP write tools (`create_vault_file`, `patch_vault_file`, `search_and_replace`, …) or `obsidian create` / `append` / `property:set`: both target the `main` worktree's `wiki/`, not your branch.

## 2. Put the page in the right folder

The folders mirror the monorepo. Choose by who the page is about, not what kind of page it is:

| Folder | Holds |
|---|---|
| `osn/`, `musubi/`, `pulse/`, `cire/`, `zap/` | Everything about that product: its overview (`<product>/<product>.md`, or `osn-core.md`, `social.md`), systems, architecture, runbooks, and `<product>-development.md` for its build rules |
| `shared/` | What applies to more than one product: backend and frontend patterns, shared packages, platform systems (D1, rate limiting, email), deploys and free-tier limits. `shared/observability/` holds logging, tracing and metrics |
| `conventions/` | How we work: tests, comments, commands, pull requests, issues, agent tooling |
| `decisions/` | One record per choice made between named alternatives, plus `deferred-decisions.md` |
| `compliance/` | The legal programme, across products |

Product folders stay flat; the page's tags say whether it is a system or a runbook. Filenames stay unique across the whole vault, so a product page that could collide takes the product prefix (`cire-auth`, `pulse-onboarding`). A page that starts in one product and later applies to two moves to `shared/`.

Moving a page keeps its `[[wikilinks]]` working, because they resolve by filename, but it breaks every repo path that cites it — code comments, skills, `AGENTS.md` and issue bodies. Find them with `grep -rn "wiki/<old-folder>/<name>" .` and rewrite them in the same pull request.

## 3. Load the syntax skill

Invoke `obsidian:obsidian-markdown` before writing. It is the syntax authority for this vault — wikilinks (`[[Note#Heading]]`, `[[Note#^block-id]]`, `[[Note|alias]]`), embeds, callouts, properties, nested tags, `%%comments%%`, `==highlights==`, and mermaid nodes that link to notes. Half of it is not CommonMark, so do not guess.

## 4. Write for both surfaces

| Feature | Obsidian | GitHub |
|---|---|---|
| Tables, mermaid, footnotes | Yes | Yes |
| Callouts `note`, `tip`, `important`, `warning`, `caution` | Yes | Yes (GitHub alerts, same syntax) |
| Other callout types, `[[wikilinks]]`, embeds, block IDs, `==highlight==` | Yes | No — literal text |
| `.base` and `.canvas` files | Yes | No — raw YAML/JSON |

Use tables and mermaid for anything a GitHub reader needs. A `.base` or `.canvas` adds to a page's prose and never replaces it: remote and CI sessions only have grep.

## 5. Frontmatter and links

- Every page has YAML frontmatter with `title`, `tags`, `related` and `last-reviewed`. Set `last-reviewed` to today on every page you touch.
- Frontmatter describes the page, never a task: no finding IDs or per-PR keys.
- Link between pages with `[[wikilinks]]`, never relative markdown links. Link to a source file with a relative markdown link from the page's directory. Cire pages carry a `cire-` prefix where a bare name would collide.
- A page links to at least two others.
- **A new page** gets a line in `wiki/index.md`, in the right section. Product-specific build rules go in `wiki/<product>/<product>-development.md`, never a nested `AGENTS.md` or `CLAUDE.md`; a fact true of more than one product belongs in `frontend-patterns`, `backend-patterns` or `testing-patterns`.
- **A changed pattern** updates its page in the same pull request.

## 6. State the present

A page says what is true now. No "used to", "was moved", "the first attempt" — `git log` holds history. A reason that stops a mistake stays.

## 7. Numbers

Two kinds, written differently.

- **A documented ceiling** is a provider's published limit. Leave it in prose and name the pricing page.
- **A measured figure** is ours, and nobody can check it without running something. Put the command and date on the line under it, as visible italic text — an HTML comment renders on neither surface:

  ```markdown
  A full dev rebuild costs **8,007 D1 rows written**.

  *Measured 2026-09-10 — `bunx wrangler d1 insights cire-db-dev --time-period=7d --sort-by=writes`*
  ```

  Where no single command produces it, name the method (*Measured 2026-08-31 — latency probe from a Sydney client, n=25*). Where the method or date is unknown, write `*Unverified — …*`, say what you do know, and leave the figure alone. Never invent a command.

`last-reviewed` means someone read the page, not that its numbers are true; the measured marker is what a reader re-runs.
