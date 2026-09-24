---
title: Agent tooling
description: How this repository configures coding agents — where sessions start, skills and their evals, third-party skills, subagent definitions, committed settings, and the vendored trees agents must not edit
tags: [convention, agents, tooling]
related:
  - "[[house-lint-rules]]"
  - "[[session-metrics]]"
  - "[[contributing]]"
  - "[[wiki-search]]"
last-reviewed: 2026-09-23
---

# Agent tooling

`AGENTS.md` at the repository root is the entry point every agent reads; `CLAUDE.md` only imports it, because Claude Code reads that name and no other. This page covers the machinery around it.

## Where sessions start

Locally the repository is the bare `~/.work/osn.git`, and every worktree — `main/` among them — is a subdirectory of it. The parent is not a worktree: it has no `AGENTS.md`, no `.claude/settings.json` and no skills, so a session started there gets no hooks and no instructions, and nothing says so. Moving afterwards does not help, because Claude Code reads project settings from the directory the session started in. Git there has no working tree, so `status`, `add`, `checkout` and `stash` exit 128 with `fatal: this operation must be run in a work tree`.

`bun run scripts/bootstrap-bare-root.ts` (part of `scripts/setup.sh`) writes a `SessionStart` hook into that directory saying so, and links its `.claude/skills` to `main`'s. It is idempotent and never overwrites a settings file it did not write.

## Settings

`.claude/settings.json` is committed, so its hooks travel to remote sessions that never read a local config — that is what makes a standing rule hold everywhere. Personal hooks and permissions go in `.claude/settings.local.json`, which is gitignored. A personal untracked `settings.json` blocks the pull that brings the tracked one down.

## Subagents

`.claude/agents/*.md` defines one agent per role — `implementer`, `mechanic`, `explorer`, `shepherd`, `attacker` — each with a `model` and an `effort`. Frontmatter is the only place per-task effort can be set, since a dispatch call carries a model but no effort. The `pick-agent` skill maps a task and its `complexity:` label to one. Two code-writing agents in one worktree corrupt each other's branches: give each its own worktree.

## Skills and their evals

A procedure an agent follows lives in `.claude/skills/<name>/SKILL.md` and nowhere else. Claude Code invokes a skill as `/<name>`, so a wrapper in `.claude/commands/` only splits the procedure across two files that drift.

Skills are measurable. `.claude/` is a Tessl plugin (`.tessl-plugin/plugin.json`), and each scenario under `.claude/evals/<scenario>/` runs an agent with and without the skill and scores the gap. A scenario pins a real commit and builds its branch in `setup.sh`; that commit ships whatever `.claude/` held then, so `setup.sh` deletes it — `exclude` in `scenario.json` does not. Every merged fix pull request is a free labelled scenario: pin its parent SHA, one checklist item per finding it fixed. Full guide: `.claude/evals/README.md`.

## Third-party skills

One skill is someone else's: `dgreenheck/webgpu-claude-skill`, the WebGPU and TSL guidance `@tools/lab` three.js work needs. It is installed at `.agents/skills/webgpu-threejs-tsl/`, with a `.claude/skills/webgpu-threejs-tsl` symlink and a content-hashing root `skills-lock.json`.

Install another the same way, never by copying the text in, so `npx skills update` can move the pin:

```bash
npx skills add <owner>/<repo> --agent claude-code universal
```

Name both agents: with only one target directory the CLI copies the files instead of symlinking them. **The same commit must add `.github/CODEOWNERS` rules and changeset-allowlist entries for `.agents/**` and `skills-lock.json`**, because that tree is someone else's instructions running with full agent permissions.

Nothing of ours writes into it. `oxlintrc.json` ignores both `.agents` and the symlink path (it follows the link and would report each file twice), both lefthook pre-commit commands exclude `.agents/**`, and the `skill-eval.yml` quality loop skips a symlinked skill. A fix made in someone else's file either blocks the next `npx skills update` or is thrown away by it.

## Vendored lint plugin

`tools/oxlint/anti-slop` is a verbatim upstream copy, unlike `tools/oxlint/house` ([[house-lint-rules]]). It is excluded from oxfmt and oxlint, with its MIT licence beside it. Its `SHA256SUMS` covers every tracked file, and CI checks both the checksums and the file set, so a re-vendor must regenerate it with the recipe in that directory's `README.md`. `.github/CODEOWNERS` puts it under a human owner, along with `scripts/`, `.github/`, `bunfig.toml` and the files that decide whether a guard runs at all (`package.json`, `oxlintrc.json`, `lefthook.yml`).
