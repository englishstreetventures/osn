---
title: Searching the wiki
description: The three ways to search this vault — the Obsidian MCP, the obsidian CLI, and grep — which exist where, and the one guard that stops a branch reading stale
tags: [convention, wiki, obsidian, search]
related:
  - "[[index]]"
  - "[[contributing]]"
last-reviewed: 2026-09-07
---

# Searching the wiki

`CLAUDE.md` carries the short version: three tiers, and grep is the one that
works everywhere. This page is the long version — what each tier can do, where
it exists, and the traps in the two that talk to a running Obsidian.

**Read this page with grep if you are anywhere but the local machine.** The
first two tiers below reach a local Obsidian over `127.0.0.1` and are simply
absent in a remote or CI session, which is exactly the session most likely to
need a search protocol. That is why the grep tier stays written out in
`CLAUDE.md` itself rather than only here.

Three ways, in order. Try each; drop to the next when it isn't there.

**1. Obsidian MCP (`mcp__obsidian-wiki__*`) — preferred, local sessions only.** The MCP Connector plugin (`mcp-tools-istefox`) serving the `wiki` vault. Reachable when the `mcp__obsidian-wiki__*` tools are listed and a call returns; an error ending `is Obsidian open with the vault loaded?` means it isn't — drop to step 2.

Where it exists:

| Where you're running | Obsidian MCP? |
|---|---|
| Claude Code on Aniket's Mac, Obsidian open with the `wiki` vault | Yes — registered at user scope |
| Claude Code on that Mac, Obsidian shut | No — the server can't resolve a port |
| Claude Desktop | Only if the `.mcpb` is installed there as well; the Claude Code registration doesn't carry over |
| Remote or cloud session, cloud agent, CI, another machine | **Never.** It reaches a local Obsidian over `127.0.0.1`. Skip to step 3 — the `obsidian` CLI is local-only too. |

Don't hunt for it, retry it, or ask for it to be started when the tools aren't listed. Absent means absent: go to grep.

| To... | Call |
|---|---|
| Search by meaning, not wording | `search_vault_smart` (semantic index over the vault) |
| Search for an exact string | `search_vault_simple` (substring + surrounding context) |
| Read one page / up to 20 pages | `get_vault_file`, `get_vault_files` |
| Read one heading, field, or the outline only | `get_vault_file_partial`, `get_note_outline` |
| Follow the graph | `get_backlinks`, `get_outgoing_links` |
| Find pages by tag | `get_files_by_tag`, `list_tags` |
| Orient in an unfamiliar area | `get_vault_overview`, `list_vault_files` |

Some tools start inactive — `tool_catalog` lists them, `activate_tools` promotes several in one call.

**It always shows you `main`, not your branch.** The vault path is baked into the connector as the `main` worktree's `wiki/`. Obsidian stays open on that one vault; nobody re-points it per branch. Two consequences:

- **Read only.** The write tools (`create_vault_file`, `patch_vault_file`, `search_and_replace`, …) would edit `main`'s working tree, not your branch. Retrieve over MCP; edit wiki pages in your own worktree with Edit/Write.
- **Your branch's own wiki edits are invisible to it.** Before trusting a page the branch might have changed, run the guard — one command, not a re-read of the wiki:

  ```bash
  git diff --name-only origin/main...HEAD -- wiki/   # pages this branch changed
  ```

  Empty output (the usual case) → MCP results are authoritative, use them. Any page you need in that list → read the branch copy with Read; MCP has the pre-branch version.

Keep the vault fresh, since a stale `main` worktree means stale answers. Obsidian re-indexes on file change, and a fast-forward of a clean worktree is safe:

```bash
git -C ~/.work/osn.git/main pull --ff-only
```

If it refuses, leave it alone — never force or reset another worktree. Grep your own `wiki/` instead.

That's the whole protocol: freshen, one guard command, then lean on semantic search instead of grepping and reading whole pages.

**2. Obsidian CLI** — same limits: local machine, app running. Invoke the **`obsidian:obsidian-cli` skill** for the command surface; it wraps `obsidian help`, which is authoritative and stays current. Quick reference:

```bash
which obsidian 2>/dev/null || echo "not installed"
obsidian search vault=wiki query="arc tokens"          # full-text search
obsidian search:context vault=wiki query="arc tokens"  # search with line context
obsidian tag vault=wiki name=systems verbose           # list files tagged #systems
obsidian read vault=wiki path=systems/arc-tokens.md    # read a page
obsidian backlinks vault=wiki file=arc-tokens          # find pages linking to it
obsidian files vault=wiki folder=systems               # list files in a folder
```

Two repo-specific rules the skill can't know:

- **Paths are vault-root-relative, and the vault root is `wiki/`.** `path=systems/arc-tokens.md`, not `path=wiki/systems/...` — the latter errors with `File not found`. `file=` takes a wikilink target (`file=arc-tokens`) instead.
- **Read only, same as the MCP and for the same reason.** The CLI acts on the vault, and the vault is `main`'s `wiki/`. `create`, `append`, and `property:set` would write to `main`'s working tree, not your branch. There are three vaults registered (`wiki`, `echo_chamber`, `vault_india_22`) — always pass `vault=wiki` rather than trusting the default.

**3. grep** — works everywhere, including remote and CI. Reads your worktree's own `wiki/`:

```bash
grep -r "arc token" wiki/ --include="*.md" -l          # find matching pages
grep -r "arc token" wiki/ --include="*.md" -n          # with line numbers
```

## Related

- [[index]] — the full page-by-page map this search protocol is for
- [[contributing]] — the PR workflow the wiki edits ride in on
