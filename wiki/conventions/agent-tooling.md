---
title: Agent tooling
description: How this repository configures coding agents — where sessions start, skills and their evals, third-party skills, subagent definitions, committed settings, and the vendored trees agents must not edit
tags: [convention, agents, tooling]
related:
  - "[[house-lint-rules]]"
  - "[[session-metrics]]"
  - "[[contributing]]"
  - "[[wiki-search]]"
last-reviewed: 2026-09-25
---

# Agent tooling

`AGENTS.md` at the repository root is the entry point every agent reads; `CLAUDE.md` only imports it, because Claude Code reads that name and no other. This page covers the machinery around it.

## Where sessions start

Locally the repository is the bare `~/.work/osn.git`, and every worktree — `main/` among them — is a subdirectory of it. The parent is not a worktree: it has no `AGENTS.md`, no `.claude/settings.json` and no skills, so a session started there gets no hooks and no instructions, and nothing says so. Moving afterwards does not help, because Claude Code reads project settings from the directory the session started in. Git there has no working tree, so `status`, `add`, `checkout` and `stash` exit 128 with `fatal: this operation must be run in a work tree`.

`bun run scripts/bootstrap-bare-root.ts` (part of `scripts/setup.sh`) writes a `SessionStart` hook into that directory saying so, and links its `.claude/skills` to `main`'s. It is idempotent and never overwrites a settings file it did not write.

## Settings

`.claude/settings.json` is committed, so its hooks travel to remote sessions that never read a local config — that is what makes a standing rule hold everywhere. Personal hooks and permissions go in `.claude/settings.local.json`, which is gitignored. A personal untracked `settings.json` blocks the pull that brings the tracked one down.

## Subagents

`.claude/agents/*.md` defines one agent per role — `implementer`, `mechanic`, `explorer`, `shepherd`, `attacker` — each with a `model` and an `effort`. Frontmatter is the only place either is stated: skills and wiki pages name the agent and read its file, so a model change touches one line. It is also the only place per-task effort can be set, since a dispatch call carries a model but no effort. The `pick-agent` skill maps a task and its `complexity:` label to one. Two code-writing agents in one worktree corrupt each other's branches: give each its own worktree.

## Skills and their evals

A procedure an agent follows lives in `.claude/skills/<name>/SKILL.md` and nowhere else. Claude Code invokes a skill as `/<name>`, so a wrapper in `.claude/commands/` only splits the procedure across two files that drift.

Skills are measurable. `.claude/` is a Tessl plugin (`.tessl-plugin/plugin.json`), and each scenario under `.claude/evals/<scenario>/` runs an agent with and without the skill and scores the gap. A scenario pins a real commit and builds its branch in `setup.sh`; that commit ships whatever `.claude/` held then, so `setup.sh` deletes it — `exclude` in `scenario.json` does not. Every merged fix pull request is a free labelled scenario: pin its parent SHA, one checklist item per finding it fixed. Full guide: `.claude/evals/README.md`.

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

Nothing of ours writes into it. `oxlintrc.json` ignores both `.agents` and the symlink path (it follows the link and would report each file twice), both lefthook pre-commit commands exclude `.agents/**`, and the `skill-eval.yml` quality loop skips a symlinked skill. A fix made in someone else's file fails `check-skills-lock`, and the next install throws it away: it goes upstream and comes back as a new pin.

## Vendored lint plugin

`tools/oxlint/anti-slop` is a verbatim upstream copy, unlike `tools/oxlint/house` ([[house-lint-rules]]). It is excluded from oxfmt and oxlint, with its MIT licence beside it. Its `SHA256SUMS` covers every tracked file, and CI checks both the checksums and the file set, so a re-vendor must regenerate it with the recipe in that directory's `README.md`. `.github/CODEOWNERS` puts it under a human owner, along with `scripts/`, `.github/`, `bunfig.toml` and the files that decide whether a guard runs at all (`package.json`, `oxlintrc.json`, `lefthook.yml`).
