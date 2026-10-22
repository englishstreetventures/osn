---
title: Agent tooling
description: How this repository configures coding agents — where sessions start, code search with LSP and git grep, skills and their evals, third-party skills, subagent definitions, committed settings, and the vendored trees agents must not edit
tags: [convention, agents, tooling]
related:
  - "[[house-lint-rules]]"
  - "[[session-metrics]]"
  - "[[contributing]]"
  - "[[wiki-search]]"
last-reviewed: 2026-10-22
---

# Agent tooling

`AGENTS.md` at the repository root is the entry point every agent reads; `CLAUDE.md` only imports it, because Claude Code reads that name and no other. This page covers the machinery around it.

## Where sessions start

Locally the repository is the bare `~/.work/osn.git`, and every worktree — `main/` among them — is a subdirectory of it. The parent is not a worktree: it has no `AGENTS.md`, no `.claude/settings.json` and no skills, so a session started there gets no hooks and no instructions, and nothing says so. Moving afterwards does not help, because Claude Code reads project settings from the directory the session started in. Git there has no working tree, so `status`, `add`, `checkout` and `stash` exit 128 with `fatal: this operation must be run in a work tree`.

`bun run scripts/bootstrap-bare-root.ts` (part of `scripts/setup.sh`) writes a `SessionStart` hook into that directory saying so, and links its `.claude/skills` to `main`'s. It is idempotent and never overwrites a settings file it did not write.

## Settings

`.claude/settings.json` is committed, so its hooks travel to remote sessions that never read a local config — that is what makes a standing rule hold everywhere. Personal hooks and permissions go in `.claude/settings.local.json`, which is gitignored. A personal untracked `settings.json` blocks the pull that brings the tracked one down.

## Subagents

`.claude/agents/*.md` defines one agent per role — `implementer`, `designer`, `mechanic`, `design-mechanic`, `reviewer`, `explorer`, `shepherd`, `attacker` — each with a `model` and an `effort`. `designer` and `design-mechanic` are the `implementer` and `mechanic` tiers for work that changes how a screen looks. Both load the `design-system` skill, which maps each frontend to the `DESIGN.md` or wiki page that governs its look, ranks that document above any design skill, and says which skill fits which task and which must never touch a surface with a design system. Skills and wiki pages name the agent and read its file, so a model change touches one line. That holds only while dispatches pass no `model` or `effort`: the Agent call takes both, and either overrides the definition. A `general-purpose` dispatch skips the definitions altogether and runs at its parent's settings, so review, plan-attack and whole-task work never go there, apart from the one plugin exception `pick-agent` names. The `pick-agent` skill maps a task and its `complexity:` label to one. Every agent lists its tools in `tools:`. The agents that change nothing — `explorer`, `reviewer`, `attacker` and `shepherd` — hold only what their instructions use. The four that write code share one list of built-in tools and no MCP tool. An agent without the line inherits every tool the parent session has, every MCP server's included, and each dispatch writes all of them into a fresh prompt cache: a subagent's first call carried a median of 42.7K tokens when it inherited, against 14.3K for `explorer` and 26K for `reviewer`.

*Measured 2026-10-22 — first assistant call's input plus cache read plus cache write, per subagent transcript under `~/.claude-esv-aniket/projects` from the previous 3 days; `implementer` n=10, `explorer` n=2, `reviewer` n=23.*

A task that needs an MCP tool adds it to that agent's `tools:` line, by its full `mcp__<server>__<tool>` name. Two code-writing agents in one worktree corrupt each other's branches: give each its own worktree. A session dispatches the definitions in the directory it started in, so to test a change to one on a branch, start a fresh session inside that branch's worktree (`claude -p "Dispatch the <agent> subagent …"`) rather than dispatching from a session started in `main/`.

## Code search

Agents search with two tools that fail in different ways. Claude Code's `LSP` tool asks the TypeScript language server, which knows what a name refers to. `git grep` reads text, so it finds every mention but cannot tell a call from a comment.

| Question | Tool |
|---|---|
| Where is this symbol defined? | `LSP` `goToDefinition` |
| What type is this? | `LSP` `hover`, instead of reading the file |
| Who calls this, inside one package? | `LSP` `incomingCalls`, which names each caller's function |
| What implements this interface? | `LSP` `goToImplementation` |
| What is in this file? | `LSP` `documentSymbol` |
| Who uses this anywhere? Across packages? | `git grep -lw <name>`, whatever `LSP` said |
| Where is this route, env var, config key, SQL or doc text? | `git grep -nw` |

The language server searches only the packages it has loaded, and gives no sign of what it skipped:

- Its first answer after start-up can be the declaration alone. `findReferences` on `forkBackground` returned 1 reference, then 25 in 9 files when asked again a minute later.
- A package nobody has opened is skipped. `findReferences` on `healthRoutes` in `@shared/observability` returned 5 files and missed `pulse/api/src/app.ts` and `zap/api/src/app.ts`, which `git grep -lw healthRoutes` found.

*Measured 2026-10-19 — `LSP` `findReferences` on [background.ts:110](../../osn/api/src/lib/background.ts) and [health.ts:35](../../shared/observability/src/elysia/health.ts), against `git grep -lw <name> -- '*.ts'` on the same commit.*

So a plausible `LSP` list can still be half the answer. Two rules follow:

1. **"Who uses X" across packages comes from `git grep -lw`.** Grep over-counts — `git grep -lw forkBackground -- '*.ts'` lists 13 files, 4 of them naming it only in comments or strings, and without the `*.ts` filter it adds changelogs and wiki pages — so it is the upper bound and a warm `LSP` answer the lower. Read the hits before reporting a count.
2. **Before renaming, deleting or changing the signature of an export, `git grep -w` its name across the whole repository.** `LSP` alone is never enough there.

`LSP` needs the worktree's `node_modules`: in a fresh worktree, run `bun install --frozen-lockfile` before trusting any answer. That also means an `LSP` call runs code from the branch: the server loads the worktree's installed `typescript` and any package a `tsconfig` names under `compilerOptions.plugins`. On a branch nobody has read yet, read what it would run (`review-pr` Step 2) before any agent calls `LSP` there. Its streamed diagnostics stay untrusted either way (`.claude/skills/orchestrate/references/gotchas.md`).

The tool comes from the `typescript-lsp@claude-plugins-official` plugin, which starts the `typescript-language-server` binary. The `setup-osn` skill installs both at user scope. `.claude/settings.json` does not enable the plugin: a project-scope `enabledPlugins` entry turns a plugin on without installing it. Cloud sessions and CI agents have no `LSP` at all — cloud sessions ignore project plugins and never start plugin language servers — so there grep is the only tool. Every agent except `shepherd` lists `LSP` in its `tools:`.

## Skills and their evals

A procedure an agent follows lives in `.claude/skills/<name>/SKILL.md` and nowhere else. Claude Code invokes a skill as `/<name>`, so a wrapper in `.claude/commands/` only splits the procedure across two files that drift.

Skills are measurable. `.claude/` is a Tessl plugin (`.tessl-plugin/plugin.json`), and each scenario under `.claude/evals/<scenario>/` runs an agent with and without the skill and scores the gap. A scenario pins a real commit and builds its branch in `setup.sh`; that commit ships whatever `.claude/` held then, so `setup.sh` deletes it — `exclude` in `scenario.json` does not. Every merged fix pull request is a free labelled scenario: pin its parent SHA, one checklist item per finding it fixed. Nothing in CI runs the evals or `tessl review run quality`; a person runs them by hand, from `scripts/skill-evals.ts` and the `tessl` CLI. Full guide: `.claude/evals/README.md`.

## Third-party skills

One skill is someone else's: `dgreenheck/webgpu-claude-skill`, the WebGPU and TSL guidance `@tools/lab` three.js work needs. It is installed at `.agents/skills/webgpu-threejs-tsl/`, with a `.claude/skills/webgpu-threejs-tsl` symlink and a root `skills-lock.json` that records, for each skill, the upstream commit it came from (`ref`) and a SHA-256 of the installed folder (`computedHash`).

Install another the same way, never by copying the text in:

```bash
DISABLE_TELEMETRY=1 npx --before=2026-09-22 skills@1.7.0 add '<owner>/<repo>#<commit-sha>' --agent claude-code universal
```

- **`#<commit-sha>`** is a full 40-character SHA, from `git ls-remote https://github.com/<owner>/<repo>.git`. The CLI writes it into the lock as `ref`. Without it the entry means whatever the default branch holds on the day someone next installs; a branch or tag moves the same way.
- **`skills@1.7.0`** pins the installer and **`--before`** pins what it pulls in: npm resolves every package in the install to the newest release published before that date, and refuses a CLI version published after it. `npx` resolves through npm, outside `bunfig.toml`'s `minimumReleaseAge`, so the date is what gives this install the same three-day soak — set it at least three days before the day you set it. Bump the version and the date together, on purpose.
- **`npx`, not `bunx --bun`**: the CLI is no dependency of ours, and it is built for Node (`engines.node >=22.20.0`).
- **`DISABLE_TELEMETRY=1`** stops the CLI reporting each install to its publisher.

Name both agents: with only one target directory the CLI copies the files instead of symlinking them. **The same commit must add `.github/CODEOWNERS` rules and changeset-allowlist entries for `.agents/**` and `skills-lock.json`**, because that tree is someone else's instructions running with full agent permissions.

To move a pin, read the upstream change first — `git diff <old-sha>..<new-sha> -- <skill folder>` in a clone of the source. Check that `git ls-remote` lists no branch or tag named like the new SHA, since the CLI tries a ref as a branch or tag before it tries it as a commit. Then re-run the recipe with the new SHA and `--skill <name>`. **Never run `npx skills update`.** With a commit pinned it re-installs the same commit, and it passes no `--agent` to the install it runs, so outside an agent session it writes a copy for every coding tool it finds in your home directory.

`scripts/check-skills-lock.ts` recomputes the CLI's folder hash and fails when a lock entry is not pinned to a full SHA, a folder no longer matches its hash, or a folder under `.agents/skills/` has no entry. The CLI never checks the hash after writing it; this runs on every pull request, through `bun run test:scripts`. It cannot tell whether the tree matches upstream at `ref` — that needs the network, and is what reading the diff is for.

Nothing of ours writes into it. `oxlintrc.json` ignores both `.agents` and the symlink path (it follows the link and would report each file twice), both lefthook pre-commit commands exclude `.agents/**`, and `scripts/skill-evals.ts` skips a symlinked skill. A fix made in someone else's file fails `check-skills-lock`, and the next install throws it away: it goes upstream and comes back as a new pin.

## Vendored lint plugin

`tools/oxlint/anti-slop` is a verbatim upstream copy, unlike `tools/oxlint/house` ([[house-lint-rules]]). It is excluded from oxfmt and oxlint, with its MIT licence beside it. Its `SHA256SUMS` covers every tracked file, and CI checks both the checksums and the file set, so a re-vendor must regenerate it with the recipe in that directory's `README.md`. `.github/CODEOWNERS` puts it under a human owner, along with `scripts/`, `.github/`, `bunfig.toml` and the files that decide whether a guard runs at all (`package.json`, `oxlintrc.json`, `lefthook.yml`).
