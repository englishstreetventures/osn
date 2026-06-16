---
title: "Observability Overview"
tags: [observability, system]
related: [[contributing]], [[TODO]], [[index]]
last-reviewed: 2026-06-16
---

# Observability Overview

cire/api now adopts the OSN platform observability primitives (`@shared/observability`) — adapted to its Cloudflare Workers (workerd) runtime. The root OSN guide is authoritative: `[[wiki/observability/overview]]` (root). This page records the cire-specific deltas.

## What cire runs on workerd

cire/api is an Elysia app on workerd; Effect.ts is used only in the service + DB layer. The Node OpenTelemetry **SDK** (exporters, `PeriodicExportingMetricReader`, `NodeSdk`) does **not** bundle for workerd, so cire imports only the workerd-safe subpaths:

| Concern | What cire uses | Workerd-safe because |
| --- | --- | --- |
| **Logs** | `makeLoggerLayer` from `@shared/observability/logger` (`src/observability.ts` → `cireLoggerLayer`, provided via `runCire` / `runCireSync`) | pure `effect` code, zero OTel imports |
| **Traces** | `Effect.withSpan("cire.<domain>.<op>")` on every service fn; `instrumentedFetch` (`@shared/observability/fetch`) on the one S2S call | span annotations are free without a tracer; `instrumentedFetch` imports only `@opentelemetry/api` (no-op without a provider) |
| **Metrics** | `cire/api/src/metrics.ts` — typed counters/histograms via `createCounter`/`createHistogram` (`@shared/observability/metrics`) | factory imports only `@opentelemetry/api`; lazily resolves a no-op meter |

### Deferred: metric/trace EXPORT

There is no long-lived process on Workers to flush an OTLP exporter, so today the spans + `.inc()`/`.record()` calls are **no-ops** — defined, type-checked, and correct at the call-site, but not shipped anywhere until a workerd reader (otel-cf-workers / Workers Analytics Engine) is wired. Tracked in `[[deferred]]`. Until then, Cloudflare's own dashboard (request traces, CPU time, error rates) plus the structured logs below are the live signal.

## Three Golden Rules

1. **No `console.*` in backend** — use the Effect structured logger run through `runCire` / `runCireSync` (which install the redacting `cireLoggerLayer`). `console.log` bypasses redaction + structured output.
2. **Never log PII** — guest names, dietary, claim codes, session tokens, OSN account ids are forbidden in log output. The shared deny-list backstops accidental annotations (see below), but prefer not annotating them in the first place. `weddingId` / `familyId` / OSN **profile** ids are loggable.
3. **Always log error paths** — every `catch` / `Effect.catchAll` / `tapError` on an unrecoverable failure must emit a log line.

## Log Levels

| Level   | Effect API          | When to use                                                                              |
| ------- | ------------------- | ---------------------------------------------------------------------------------------- |
| Debug   | `Effect.logDebug`   | Local dev only. Never in production code paths.                                          |
| Info    | `Effect.logInfo`    | Happy-path milestones: import applied, invite saved, dev-server banners.                  |
| Warning | `Effect.logWarning` | Recoverable issues: malformed palette, formula-injection rejected, best-effort cleanup.   |
| Error   | `Effect.logError`   | Unrecoverable failures: DB defect, R2 storage failure, S2S osn-api lookup failure.        |

## Redacting the logger

Every Effect run goes through `runCire(effect)` (or `runCireSync` for the framework error boundary + dev banners), which provides `cireLoggerLayer`. That layer replaces Effect's default logger with the shared **redacting** logger: each message + annotation is passed through the `@shared/observability/logger` deny-list before serialization (json in prod, pretty in dev). **Do not call `Effect.runPromise` / `Effect.runSync` directly** — that skips redaction.

### Redaction deny-list

The deny-list is the single shared list in `shared/observability/src/logger/redact.ts` — **not** a cire-local copy. It already enumerates every sensitive cire field: `cire_session`, `firstName`/`first_name`, `lastName`/`last_name`, `familyName`/`family_name`, `publicId`/`public_id` (the claim **code** — a credential), `dietary` (Art. 9 special-category), and `osnAccountId`/`osn_account_id`. Adding a new sensitive cire field means adding it there (camelCase + snake_case) **and** its assertion in `redact.test.ts`, in the same commit.

## Naming conventions

- **Spans**: `cire.<domain>.<operation>` (camelCase op), e.g. `cire.claim.lookup`, `cire.import.apply`, `cire.accountLink.link`, `cire.invite.setImage`.
- **Metrics**: `{namespace}.{domain}.{subject}.{measurement}` with `namespace = cire`, snake_case, e.g. `cire.claim.attempts`, `cire.import.parse.rejected`, `cire.account_link.requests`. Every attribute value is a **bounded string-literal union** — no `weddingId` / `guestId` / `familyId` / `publicId` / `osnAccountId` in attributes (those go in spans/logs). Free-text inputs (parse-rejection reasons) are bucketed to a closed union via `bucketParseReason()`. All instruments live in `cire/api/src/metrics.ts`; emit only through the exported `metric*` / `measure*` helpers.

## Upgrade Path

The remaining step is wiring a workerd metric/trace exporter so the already-instrumented spans + counters actually ship:

- **OpenTelemetry export** from Workers via `otel-cf-workers`, or
- **Workers Analytics Engine** for metrics.

Either lights up the existing call-sites with no code churn. See `[[deferred]]`.
