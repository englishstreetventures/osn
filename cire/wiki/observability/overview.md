---
title: "Observability Overview"
tags: [observability, system]
related: [[contributing]], [[TODO]], [[index]]
last-reviewed: 2026-06-10
---

# Observability Overview

Cire uses platform-native observability via Cloudflare Workers logs and analytics. No external APM or log aggregation — Workers dashboard provides request traces, CPU time, and error rates out of the box.

## Three Golden Rules

1. **No `console.*` in backend** — use Effect structured logger. `console.log` bypasses structured output and is invisible to Cloudflare log filters.
2. **Never log PII** — email addresses, tokens, passwords, passphrase values are forbidden in log output. If you need to correlate, log a hashed or truncated identifier.
3. **Always log error paths** — every `catch` / `Effect.catchAll` must emit a log line before returning an error response. Silent failures are invisible in production.

## Log Levels

| Level   | Effect API          | When to use                                                                              |
| ------- | ------------------- | ---------------------------------------------------------------------------------------- |
| Debug   | `Effect.logDebug`   | Local dev only. Never in production code paths.                                          |
| Info    | `Effect.logInfo`    | Happy-path milestones: guest claimed invite, import applied, RSVP submitted.             |
| Warning | `Effect.logWarning` | Recoverable issues: rate limit approached, malformed input rejected, retry attempted.    |
| Error   | `Effect.logError`   | Unrecoverable failures: DB connection lost, crypto operation failed, invariant violated. |

## Effect.ts Structured Logging Example

```typescript
yield *
  Effect.logInfo("guest claimed invite").pipe(
    Effect.annotateLogs({ familyId, route: "POST /api/claim" }),
  );
```

This produces structured JSON in Workers logs, filterable by `familyId` or `route`.

## Redaction Deny-List

Maintain a deny-list of field names that must never appear in log output, even at debug level:

- `password`
- `passphrase`
- `token`
- `email`
- `sessionId`
- `passwordHash`

If a service handles these fields, strip or redact them before any `Effect.log*` call.

## Upgrade Path

The current setup (Workers logs + dashboard) is sufficient for a wedding-scale app (~100-500 families). If Cire is platformised (multi-tenant SaaS), consider:

- **OpenTelemetry (OTel)** export from Workers via `otel-cf-workers` package.
- **Axiom** or **Baselime** for log aggregation and alerting.
- **Sentry** for frontend error tracking in `cire/web`.
- Aligning with the OSN platform stack (OpenTelemetry → Grafana Cloud via `@shared/observability`) now that cire lives in the OSN monorepo.

These are post-MVP concerns. Do not add external observability dependencies until the platform decision is made — see [[TODO]] (Deferred Decisions).
