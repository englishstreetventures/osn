---
title: Logging
aliases: [logging rules, Effect.log, redaction]
tags: [observability, logging]
status: active
related:
  - "[[overview]]"
  - "[[tracing]]"
  - "[[metrics]]"
packages: ["@shared/observability"]
last-reviewed: 2026-04-12
---

# Logging

Use `Effect.logInfo` / `Effect.logWarn` / `Effect.logError` inside Effect pipelines. Trace context is attached automatically -- no manual `traceId` plumbing.

## Log level guide

| Level | When to use | Production? |
|-------|-------------|-------------|
| `Effect.logDebug` | Dev-only diagnostics (OTP codes, magic-link URLs, internal state dumps) | Never emitted -- minimum level is `Info` unless explicitly overridden |
| `Effect.logInfo` | Normal operations worth recording: service boot, significant state transitions, successful completions of multi-step flows | Yes -- the default minimum level in both dev and production |
| `Effect.logWarning` | Degraded but recoverable conditions: rate limit tripped, retryable upstream failure, deprecated code path hit | Yes |
| `Effect.logError` | Failures that need operator attention: unhandled exceptions, database errors, authentication verification failures | Yes |

## Structured context

**Put structured context in annotations, not message text.** Use `Effect.annotateLogs`, not template literal interpolation.

```typescript
// Good
Effect.logInfo("event created").pipe(
  Effect.annotateLogs({ eventId: e.id })
)

// Bad -- interpolated strings get redacted-or-missed
Effect.logInfo(`event created: ${e.id}`)
```

The JSON logger keeps annotations as structured fields; interpolated strings are subject to redaction and lose their structure.

## Error logging

**Every error path logs with `Effect.logError`, including the `_tag` and cause.** Let the tagged error *be* the structured context -- do not reformat. Every `Effect.tapError` should log at this level with the tagged error as structured context.

## Redaction

Redaction is non-negotiable, but the deny-list is kept minimal. The logger layer in `@shared/observability` applies a key-name scrubber to every log entry before serialization.

### Deny-list location

`shared/observability/src/logger/redact.ts`

### Currently covered keys

- `authorization`
- OAuth token fields: `accessToken` / `refreshToken` / `idToken` / `enrollmentToken` (+ snake_case variants)
- WebAuthn `assertion` body
- ARC `privateKey`
- User PII fields that exist in the schema: `email`, `handle`, `displayName`

### Deny-list maintenance rules

- Every entry must correspond to a real object key somewhere in the codebase -- do not pre-emptively guard hypothetical secrets.
- When you add a new field whose value is sensitive (a new auth method, a new schema column, a new request body), add the key in the same PR and update the lock-step assertion in `redact.test.ts`.
- When a field is deleted from the codebase, remove it from the deny-list in the same commit.
- Full criteria are documented in the file header of `redact.ts`.

### What is and is not OK to log

| Field | OK to log? | Why |
|-------|------------|-----|
| `userId` | Yes | Opaque ID, not PII |
| `handle` | No | User-chosen identifier, treated as PII |
| `email` | No | PII -- always redacted |

## Dev-mode OTP/magic-link logging

Dev-mode OTP/magic-link logging uses `Effect.logDebug` gated on `NODE_ENV !== "production"`. The OTP code, email, and magic link URL are interpolated into the message string (not annotations) so the redacting logger doesn't scrub them -- the whole point of the dev log is to expose those values to the developer. In production these branches never run because `config.sendEmail` is wired up.

## Route-level logger wiring

`createAuthRoutes` and `createGraphRoutes` accept an optional `loggerLayer: Layer.Layer<never>` parameter (default `Layer.empty`). The host application (`osn/app/src/index.ts`) passes its `observabilityLayer` from `initObservability()` so that `Effect.logDebug` / `Effect.logError` calls inside service pipelines actually fire through the configured logger + redactor.

Without this wiring, per-request Effect pipelines use Effect's default logger (which drops `Debug` and doesn't redact).

**When adding a new route factory that runs Effect pipelines**, follow the same pattern: accept `loggerLayer`, provide it inside the `run()` helper alongside `dbLayer`.
