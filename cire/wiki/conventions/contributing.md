---
title: "Contributing Conventions"
tags: [convention]
related: [[review-findings]], [[monorepo-structure]], [[overview]]
last-reviewed: 2026-05-05
---

# Contributing Conventions

Solo project conventions for Cire. No external contributors expected, but these rules keep the codebase consistent for AI agents and future collaborators.

## Branch Strategy

- **main** — always deployable.
- **feat/\*** — feature branches; merge directly (solo, no PR review required).
- No release branches or tags — deploy from main.

## Commit Signing

- SSH signing with ed25519 key.
- All commits must be signed.

## No Changesets

Solo project — no versioning scheme or changelog automation. Progress is tracked in [[TODO]].

## Hooks

- **lefthook** runs lint + format + tests before every push.
- Install after fresh clone: `bunx lefthook install`.

## Observability Rules

These rules apply to all backend code in `apps/api`. See [[overview]] for the full observability guide.

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
