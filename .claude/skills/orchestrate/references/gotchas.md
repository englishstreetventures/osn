# Gotchas — learned the hard way

Each row is a run that went wrong once. `SKILL.md` carries the five that cost the most; this is the whole list.

| Gotcha | Do this |
|---|---|
| Feature input dispatched straight into the autonomous loop → the subagent guesses scope | Run Step 00 first. `superpowers:brainstorming` has a hard gate — no worktree, plan or implementation until the user approves the spec — so do the design phase synchronously with the user and enter the loop only after spec and plan are approved |
| A large phase (many independent tasks) crammed into one `new-feat` subagent | Point the Step 3 subagent at the phase's plan file and have it run `superpowers:subagent-driven-development` instead — still one branch and one PR, and `prep-pr` runs once at the end |
| `gh pr ready <n>` does not propagate at once — a still-draft PR shows `mergeStateStatus: BLOCKED` with every check green | `gh pr ready`, then wait 5–10 s before reading `mergeStateStatus`; do not treat BLOCKED-on-draft as a CI failure |
| Pre-push lefthook runs `bun audit --audit-level=high` and refuses on a high or critical advisory in any installed package | That is the gate working. Fix it — an override in the root `package.json`, or the upstream bump once it clears `minimumReleaseAge` — and say so in the PR body. `--no-verify` skips the type check and the release-age check too |
| `scripts/validate-changesets.sh` uses `mapfile` (bash 4+); macOS ships bash 3.2 | Run it as `bash` from Homebrew or let CI (ubuntu) validate; either way, match the existing changeset format |
| Changesets: `@cire/*` packages are version-less (ignored); a changeset never mixes an ignored and a versioned package; a PR touching only allowlisted paths (`.github/`, `scripts/`, `wiki/`, `docs/`, `.claude/`, Swift trees, top-level prose) needs none | Name only the right packages; split a mixed one; `scripts/changeset-required.sh` is the allowlist |
| Wrangler named environments do NOT inherit top-level bindings (`[[d1_databases]]`, `[[r2_buckets]]`, `[[unsafe.bindings]]`, `[images]`) | Mirror every binding into `[env.production]` and `[env.dev]`; verify with `wrangler deploy --dry-run`, and remember a real first deploy catches module-eval crashes a dry run does not |
| The Bash tool's shell is fish, and bare `git` may not be on PATH | Wrap bash-isms in `bash -c '...'`; call `/usr/bin/git` |
| A fresh worktree has no `node_modules` | The subagent runs `bun install` at the worktree root before any test |
| LSP diagnostics in a worktree are often stale or wrong (no `node_modules` → bad type resolution) | Trust `bun test`, `tsc --noEmit` and `wrangler deploy --dry-run` over streamed diagnostics |
| Merging many PRs in sequence: the release workflow auto-versions on each merge, and sibling PRs touching the same file (`wrangler.toml`, an entry `index.ts`) conflict | Merge in dependency order; rebase and resolve additively as you go |
| A wiki edit made through the Obsidian MCP or the `obsidian` CLI lands in `main`'s working tree, not the task's branch — it never reaches the PR and it dirties `main` | Both are read-only by construction (the vault path is baked to `main/wiki/`). Search with them; edit with Edit/Write in the task's worktree. If `main` is already dirty, tell the user — never reset another worktree |
| The MCP shows the pre-branch version of a page the task just rewrote, so a later step "corrects" the branch back to stale content | `git diff --name-only origin/main...HEAD -- wiki/` before trusting an MCP result. Any page in that list: read the branch copy |
| Obsidian shut, or the task running remote or in CI → `mcp__obsidian-wiki__*` absent and `obsidian` not on PATH | Expected, not a fault. Drop to grep; do not retry or ask for Obsidian. `.base` and `.canvas` files are unreadable at that tier — one more reason they never carry load-bearing content |
| Astro 7 detects an agent environment and backgrounds `astro dev`; portless then deregisters the route and the URL 404s while a stray daemon holds the port | Run the devloop as `CLAUDECODE= bun run dev`; clear a stray with `bunx astro dev stop` |
