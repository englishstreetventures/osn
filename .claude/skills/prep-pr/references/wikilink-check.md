# Checking wikilinks resolve on a branch

Reference for `prep-pr` Step 7.

**Then check the links resolve.** A new page whose `related` points at nothing, a `[[wikilink]]` with a typo, or a link into a page this branch moved is invisible until someone clicks it. `mcp__obsidian-wiki__find_broken_links` is the right idea but the wrong tree — it indexes `main`, so it cannot see this branch's pages at all. Check locally, from the repository root:

```bash
bun scripts/check-wikilinks.ts
```

It reads every page in the vault, not only the ones this branch changed, because the usual break is a page renamed or deleted here while the links into it sit in pages the branch never touched. It resolves each target the way Obsidian does, with the vault root at `wiki/`: by page name, with any folder part matching the page's real folder. So `[[component-library]]` and `[[shared/component-library]]` pass, while `[[wiki/shared/component-library]]` (written from the repository root, so it names `wiki/wiki/…`) and `[[osn/component-library]]` (wrong folder) fail. A page `.gitignore` excludes does not count as a page.

Each line it prints is `path:line: [[target]]` for a link that resolves to nothing — fix it or drop it. It exits 0 when every link resolves and 1 when one does not; 2 means it could not run (not at the repository root). It does not read fenced code blocks or inline code spans, so a TOML array header in a fence is never reported, and a wikilink written inside backticks is never checked. A table cell's escaped alias pipe (`[[page\|alias]]`) resolves like any alias.

On a checkout older than `scripts/check-wikilinks.ts`, or with no `bun`, record the link check as not run rather than as passed. Run `find_orphaned_notes` over the MCP **after** the PR merges, when `main` has caught up, for the pages nothing links to.
