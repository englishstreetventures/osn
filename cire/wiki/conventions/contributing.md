---
title: "Contributing Conventions"
tags: [convention]
related: [[review-findings]], [[monorepo-structure]], [[overview]]
last-reviewed: 2026-06-10
---

# Contributing Conventions

Cire follows the **OSN monorepo conventions** since the merge (2026-06) — the root `CLAUDE.md` is authoritative. This page keeps the cire-specific notes.

## Branch Strategy

- **main** — always deployable.
- **feat/\*** — feature branches; **PRs required** to merge to main (osn convention — the old solo "merge directly" rule no longer applies).
- No release branches or tags.

## Commit Signing

- SSH signing with ed25519 key.
- All commits must be signed.

## Changesets

Every PR includes a changeset (`bun run changeset`) — CI fails without one (osn convention; supersedes the standalone-era "no changesets" rule). Package names must match the workspace `name` field exactly (e.g. `"@cire/api"`, not `"cire"`). Progress is tracked in [[TODO]].

## Hooks

- Root **lefthook** runs oxlint + oxfmt (auto-fix + re-stage) on staged files pre-commit, type check pre-push.
- Install after fresh clone: `bunx lefthook install` (repo root).

## Observability Rules

These rules apply to all backend code in `cire/api`. See [[overview]] for the full observability guide.

1. **No `console.*` in backend** — use Effect structured logger (`Effect.logInfo`, `Effect.logWarning`, `Effect.logError`).
2. **Structured logging** — always annotate logs with context: `Effect.annotateLogs({ familyId, route })`.
3. **Log levels**:
   - `logDebug` — local dev only, never in production paths.
   - `logInfo` — happy-path milestones (claim success, import applied).
   - `logWarning` — recoverable issues (rate limit approached, malformed input).
   - `logError` — unrecoverable failures (DB down, crypto failure).
4. **Never log PII** — email addresses, tokens, passwords, passphrase values are forbidden in log output.
5. **Redaction deny-list** — maintain a deny-list of field names that must never appear in logs: `password`, `passphrase`, `token`, `email`, `sessionId`.
6. **Always log error paths** — every `catch` / `Effect.catchAll` must log before returning an error response.

## Code Style

- TypeScript everywhere.
- `bunx oxlint .` for linting, `bunx oxfmt .` for formatting.
- Test files co-located: `*.test.ts` alongside the module.
