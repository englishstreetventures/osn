---
title: Agent tooling
description: How this repository configures coding agents — where sessions start, code search with LSP and git grep, skills and their evals, third-party skills, subagent definitions, committed settings, the guard hook, the mods in .claude/mods, and the vendored trees agents must not edit
tags: [convention, agents, tooling]
related:
  - "[[house-lint-rules]]"
  - "[[session-metrics]]"
  - "[[contributing]]"
  - "[[wiki-search]]"
last-reviewed: 2026-10-27
---

# Agent tooling

`AGENTS.md` at the repository root is the entry point every agent reads; `CLAUDE.md` only imports it, because Claude Code reads that name and no other. This page covers the machinery around it.

## Where sessions start

Locally the repository is the bare `~/.work/osn.git`, and every worktree — `main/` among them — is a subdirectory of it. The parent is not a worktree: it has no `AGENTS.md`, no `.claude/settings.json` and no skills, so a session started there gets no hooks and no instructions, and nothing says so. Moving afterwards does not help, because Claude Code reads project settings from the directory the session started in. Git there has no working tree, so `status`, `add`, `checkout` and `stash` exit 128 with `fatal: this operation must be run in a work tree`.

`bun run scripts/bootstrap-bare-root.ts` (part of `scripts/setup.sh`) writes a `SessionStart` hook into that directory saying so, and links its `.claude/skills` to `main`'s. It is idempotent and never overwrites a settings file it did not write.

Every worktree on the machine runs the same commands — `bun src/local.ts` servers, `wrangler dev`, `astro dev`, the `sleep` in `scripts/wait-pr.sh` — often from other sessions at the same time. So a session stops a process it started by the PID it recorded when it started it (`cmd & echo $! > <file>`, then `kill $(cat <file>)`), never with `pkill -f <pattern>`, which matches another worktree's process just as well.

## Settings

`.claude/settings.json` is committed, so its hooks travel to remote sessions that never read a local config — that is what makes a standing rule hold everywhere. Personal hooks and permissions go in `.claude/settings.local.json`, which is gitignored. A personal untracked `settings.json` blocks the pull that brings the tracked one down.

### The guard hook

A `PreToolUse` hook runs [`scripts/agent-guard.ts`](../../scripts/agent-guard.ts) before every `Bash`, `Write`, `Edit` and `Agent` call and every GitHub MCP write. It refuses a call that breaks a standing rule, and names the fix in its reason:

| Refused | Rule |
|---|---|
| `bun install` without `--frozen-lockfile` (or `-g`), `bun update`, `bun add --filter`, inside a tree with a `bun.lock` | Installs |
| A heredoc inside `$(…)` or backticks | Commands |
| `git commit` or `git push` on `main`, judged in the directory the command runs in (`cd`, `git -C`, a branch switch earlier in the line), and a push whose destination ref is `main` | Never commit to `main` |
| A tracker finding ID in a commit message, in `gh pr` or `gh issue` text (`create`, `edit`, `comment`, `review`, `merge`, and a `close` or `reopen` comment) or `gh api` fields (inline, `--body-file`, `-F body=@file`, `--input`), or in a GitHub MCP write, unless it targets `englishstreetventures/osn-tracker` | Issues |
| A Write or Edit of a test or spec file under a workspace's `src/`, in any worktree of this repository | Tests |
| An `Agent` call with no `subagent_type`, which starts `general-purpose` | Choose subagents by definition |

It catches slips; it is not enforcement, and `AGENTS.md` keeps every rule for agents that run no hooks. It reads only the call itself, never file contents already in the repository. Every failure lets the call through: unreadable input, an unreadable file, a `git` error, a directory it cannot resolve, a thrown check.

The hook command, inline in `settings.json`, runs **main's copy** of the script: `git cat-file blob refs/remotes/origin/main:scripts/agent-guard.ts` into a fresh `mktemp -d`, then `bun --no-env-file --no-install --config=<empty file>` from that directory, so no checkout `bunfig.toml`, `.env` or edited guard runs. The ref is spelled in full because a tag or a branch named `origin/main` would otherwise take precedence. It protects only while the session's own `.claude/settings.json` is main's: review another branch in its own worktree, never checked out where the session runs. Two consequences of reading `origin/main`: the guard is absent until a fetch has brought the script down, and a fix to it takes effect only after the next fetch.

`AGENT_GUARD_REF=<ref>` runs another ref's copy, which is how a branch tests a change to the guard in a fresh `claude -p` session. [`scripts/tests/agent-guard.test.ts`](../../scripts/tests/agent-guard.test.ts) covers the rules and [`agent-guard.cli.test.ts`](../../scripts/tests/agent-guard.cli.test.ts) runs the command as `settings.json` holds it. Both run in `bun run test:scripts`. A call costs a `mktemp`, one `git` call and a Bun start.

*Measured 2026-10-26 — median of 15 runs of the hook command on a `Bash` input, in a cloud container: 16 ms.*

### Mods

[`.claude/mods/`](../../.claude/mods) holds two Claude Code mods, plugins of function hooks that change what the interface shows:

| Mod | Shows |
|---|---|
| `branch-gates` | A **Branch gates** pane beside the chat. It shows the branch; the `Issue:` line of `NEW-FEAT.md` with that issue's `complexity:` label, and "(unconfirmed)" when that label is on it too; commits ahead and files changed against `refs/remotes/origin/main`, or "base unknown" when git cannot say; uncommitted files; and whether the diff needs a changeset. Under **Pull request**: the branch's PR from `gh pr view`, its state (open, merged or closed), its CI rollup (passing, failing or pending), its unresolved review threads and its review decision, or `gh`'s own error. Under **Checks**: the last `/gates` run, with its HEAD and time, marked stale after any later Bash, Edit, Write or NotebookEdit call, or a new HEAD or `git status`. Under **Gates**: each row of the `## Gates` section of `NEW-FEAT.md`. It also shows a band above the prompt when a changeset is required and missing, and a toast, "Guard: <reason>", when the guard hook above refuses a Bash, Write, Edit or Agent call. It draws no status line. |
| `prompt-row` | One row under the prompt, in this order. **Model:** the family (Fable, Opus, Haiku, Sonnet) as a coloured tag, with the effort level of the main thread's last model request, as `● Opus · high`; the level is left out until the session's first request, after one that named no level, and while the last request went to another family (a switch, `opusplan`'s other model, a fallback). **Context:** a ten-cell bar and the context window's fill, as `▰▰▰▱▱▱▱▱▱▱ 34%`, dim below 70%, a warning from 70% and an error from 85%; there is no bar before the window's first response, after `/clear` or after a compaction. **Mode:** Claude Code's own hint line with its permission-mode pill. **Session:** `session <id>`, the full ID that `claude --resume <id>` takes; it resumes only once its session has sent a prompt. In the terminal the ID is the hint line's dim tail, which Claude Code cuts at the row's edge before any pill; on desktop it comes before the hint line. The row redraws after each main-thread model request, a new context reading, a compaction, a model switch, a prompt and the end of a session (`/clear`, `/resume`). It also puts a dot in the model's colour before the working spinner, which in the terminal shows the effort as well. |

`branch-gates` works only in a repository whose `origin` is `englishstreetventures/osn` on github.com, as `https://github.com/…`, `git@github.com:…` or `ssh://git@github.com/…`. At session start it reads the repository's root (`git rev-parse --show-toplevel` in the session's directory) and that root's origin, keeps both for the session, and runs every later git, `gh` and `bash` call in that root, wherever the session's directory moves. Anywhere else it opens no pane, registers no command and makes no git call after those two, and a project's own `/gates` answers instead. Unprompted, it runs only git, `gh` and the copy of `scripts/changeset-required.sh` in the worktree the mods are loaded from, read from disk and run as `bash -c` with the file list on stdin; never a script from the session's checkout. It reads `NEW-FEAT.md` only when it is a regular file of at most 256 KB, and removes control characters from every text it draws from the checkout or from `gh`.

**`/gates`** runs CI's lint commands from the worktree root, one after another: `bash scripts/verify-vendored-anti-slop.sh && bun run lint`, `bun run fmt:check`, and `bash scripts/guard-lint-warnings.sh --base <sha>`, where `<sha>` is `git merge-base refs/remotes/origin/main HEAD` (the row reads "not run" when there is none). They are the **checkout's own scripts**, so `/gates` runs only when you type it at the prompt; started by a plugin, the SDK or a relayed message, it runs nothing and says why. It takes about 30 s, and each row reads "not run: no node_modules" in a worktree that has none.

*Measured 2026-10-26 — the three commands run in turn from the repository root in a cloud container: lint 7.0 s, `fmt:check` 0.5 s, the warning ceiling 18.6 s.*

**Loading them.** Claude Code loads a folder of plugins named in `CLAUDE_CODE_PLUGIN_DIRS`, read from the process environment or the `env` block of the user settings file, never from a project's settings. The user settings file is `$CLAUDE_CONFIG_DIR/settings.json`, which is `~/.claude/settings.json` only when `CLAUDE_CONFIG_DIR` is unset; a machine that runs Claude Code under several config directories needs the entry in each one's `settings.json`. Give the mods a detached worktree of their own, used for nothing else, at `refs/remotes/origin/main`:

```bash
git -C ~/.work/osn.git fetch origin "+refs/heads/main:refs/remotes/origin/main"
git -C ~/.work/osn.git worktree add --detach ~/.work/osn.git/claude-mods refs/remotes/origin/main
```

Then add its `.claude/mods` to `CLAUDE_CODE_PLUGIN_DIRS` in that settings file, in fish; run it once per config directory, with `CLAUDE_CONFIG_DIR` set to each. The `jq` program keeps any folders the variable already names, appends this one after a `:`, and adds nothing when it is already there:

```fish
set f (set -q CLAUDE_CONFIG_DIR; and echo $CLAUDE_CONFIG_DIR; or echo ~/.claude)/settings.json
set dir "$HOME/.work/osn.git/claude-mods/.claude/mods"
test -e $f; or echo '{}' > $f
jq --arg dir $dir '.env.CLAUDE_CODE_PLUGIN_DIRS |= (if . == null or . == "" then $dir elif (split(":") | index($dir)) != null then . else . + ":" + $dir end)' $f > $f.new; and mv $f.new $f
```

or by hand, as `"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/Users/<you>/.work/osn.git/claude-mods/.claude/mods" }`, after a `:` when the value already names other folders. New sessions load both mods, in every repository: `prompt-row` runs everywhere, and `branch-gates` turns itself off outside this one. To update them, move the worktree to main's latest commit:

```bash
git -C ~/.work/osn.git fetch origin "+refs/heads/main:refs/remotes/origin/main"
git -C ~/.work/osn.git/claude-mods checkout --detach refs/remotes/origin/main
```

> [!warning]
> Never point `CLAUDE_CODE_PLUGIN_DIRS` at a checkout where branches are switched. An interactive session watches the folder and reloads a mod's hooks when its files change, so `git checkout` of a branch you are reviewing would run that branch's `register.tsx` inside your session. The dedicated worktree changes only when you move it to main.

**Costs.** No mod calls the model; `/gates` leaves one line of output in the conversation. `branch-gates` refreshes at session start and after a Bash, Edit, Write or NotebookEdit call, at most once every 2 s, with one more refresh at the end of the window when calls keep coming. A refresh is four git reads run together, its `git status` run with `--no-optional-locks` so it never takes the index lock; one `bash` for the changeset script only when the changed files or the script change; and one `gh issue view` per issue per load, made after the pane has drawn. The pull request is read at session start, on `/gates`, and after a Bash `git push` or `gh` command, at most once a minute with one trailing read; each read is one `gh pr view` and one GraphQL call. `prompt-row` asks Claude Code for the model, the session ID and the context reading each time the prompt row redraws, a few times a turn; none of them runs a process or counts tokens. It also sits on every model request, main thread and subagent alike, as a `turn.step` hook that passes the response through untouched (`return yield* next(e)`); before a main-thread request goes out it records the model and effort level, inside a `catch`, so a failed write leaves the request as it was.

**Where they run.** A cloud session has only the checkout, and no checkout file sets the variable, so cloud sessions load neither mod. The tests sit in each mod's `tests/` folder and run with `claude plugin test .claude/mods/<mod>`, only locally: CI has no `claude` CLI. Verified on Claude Code 2.1.310, whose plugin API is early access and may change between releases.

## Subagents

`.claude/agents/*.md` defines one agent per role — `implementer`, `designer`, `mechanic`, `design-mechanic`, `reviewer`, `explorer`, `shepherd`, `attacker` — each with a `model` and an `effort`. `designer` and `design-mechanic` are the `implementer` and `mechanic` tiers for work that changes how a screen looks. Both load the `design-system` skill, which maps each frontend to the `DESIGN.md` or wiki page that governs its look, ranks that document above any design skill, and says which skill fits which task and which must never touch a surface with a design system. Skills and wiki pages name the agent and read its file, so a model change touches one line. That holds only while dispatches pass no `model` or `effort`: the Agent call takes both, and either overrides the definition. A `general-purpose` dispatch skips the definitions altogether and runs at its parent's settings, so review, plan-attack and whole-task work never go there, apart from the one plugin exception `pick-agent` names. The `pick-agent` skill maps a task and its `complexity:` label to one. Every agent lists its tools in `tools:`. The agents that change nothing — `explorer`, `reviewer`, `attacker` and `shepherd` — hold only what their instructions use. The four that write code share one list of built-in tools. Each agent that reaches the `design-system` skill also lists the Chrome browser tools (`mcp__claude-in-chrome__*`), which its step 4 uses; no other MCP server is listed. `scripts/check-agent-tools.ts`, which `bun run test:scripts` runs in CI, fails when a skill an agent can reach names an MCP tool that agent's line does not cover. Obsidian's server is exempt, because every skill that names it gives a shell fallback. An agent without the line inherits every tool the parent session has, and every call re-reads their schemas. Most of that weight is built-in tools the code-writing agents never call: the `Artifact` schema alone is 30,000 to 38,000 characters, about two thirds of an inheriting agent's tools array. MCP tools arrive as deferred names, under 1,000 tokens in all. An inheriting `implementer`'s first call carried a median of 42.5K tokens; the list is estimated to bring that to about 30K.

*Measured 2026-10-22 — first assistant call's input plus cache read plus cache write, and the tool schemas in the request each transcript records, over `implementer` subagent transcripts on one machine from the previous 3 days (n=10, all from one parent session). The 30K is an estimate from per-tool sizes; no dispatch with the list had run when it was written.*

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

`LSP` needs the worktree's `node_modules`: in a fresh worktree, run `bun install --frozen-lockfile` before trusting any answer. That also means an `LSP` call runs code from the branch: the server is the worktree's installed `typescript`, and a `tsconfig` can name a package under `contentMappers`, which `tsc --runExternalCode` runs and the language server may. On a branch nobody has read yet, read what it would run (`review-pr` Step 2) before any agent calls `LSP` there. Its streamed diagnostics stay untrusted either way (`.claude/skills/orchestrate/references/gotchas.md`).

The tool comes from the `ts-lsp@osn-local` plugin in `tools/claude-ts-lsp`, which starts the worktree's own `node_modules/.bin/tsc --lsp --stdio`, TypeScript 7's built-in language server. The `setup-osn` skill installs it at user scope. `.claude/settings.json` does not enable the plugin: a project-scope `enabledPlugins` entry turns a plugin on without installing it. Cloud sessions and CI agents have no `LSP` at all — cloud sessions ignore project plugins and never start plugin language servers — so there grep is the only tool. Every agent except `shepherd` lists `LSP` in its `tools:`.

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

`tools/oxlint/anti-slop` is a verbatim upstream copy, unlike `tools/oxlint/house` ([[house-lint-rules]]). It is excluded from bun fmt and oxlint, with its MIT licence beside it. Its `SHA256SUMS` covers every tracked file, and CI checks both the checksums and the file set, so a re-vendor must regenerate it with the recipe in that directory's `README.md`. `.github/CODEOWNERS` puts it under a human owner, along with `scripts/`, `.github/`, `bunfig.toml` and the files that decide whether a guard runs at all (`package.json`, `oxlintrc.json`, `lefthook.yml`).
