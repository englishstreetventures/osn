---
"@cire/invites": patch
---

Docs-only: root `CLAUDE.md` now reaches for the Obsidian MCP first when looking
something up in the wiki. The vault is served by the `mcp-tools-istefox` MCP
Connector plugin, registered as the `obsidian-wiki` server, so a session can
search by meaning (`search_vault_smart`), read many pages in one call
(`get_vault_files`), and walk the graph (`get_backlinks`) instead of grepping
markdown. Documents the three-rung ladder (MCP → `obsidian` CLI → grep), where
each rung exists — the first two need a local Obsidian over `127.0.0.1`, so
remote sessions, cloud agents and CI go straight to grep. The vault path is
baked to the `main` worktree's `wiki/`, so it answers from `main` whatever
branch the session is on: the MCP is read-only (its write tools would edit
`main`), a `git diff --name-only origin/main...HEAD -- wiki/` guard catches the
pages where the branch and `main` disagree, and a `--ff-only` pull of the `main`
worktree keeps the index fresh. Also folds in the
Cloudflare Workers debugging notes (tail the failing service first, JSON/JWK
secret handling, redeploy to cycle isolates, first-deploy module-eval crashes,
named-env routes). No code change.
