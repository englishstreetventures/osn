---
title: Cire observability on workerd
tags: [observability, system, cire]
related:
  - "[[shared/observability/overview]]"
  - "[[cire]]"
  - "[[decisions/deferred-decisions]]"
last-reviewed: 2026-10-20
---
# Observability Overview

cire/api uses the OSN platform observability packages (`@shared/observability`), adapted to its Cloudflare Workers (workerd) runtime. The root OSN guide is authoritative: `[[shared/observability/overview]]` (root). This page records what cire does differently.

## What cire runs on workerd

cire/api is an Elysia app on workerd; cire uses Effect.ts only in the service + DB layer. The Node OpenTelemetry **SDK** (exporters, `PeriodicExportingMetricReader`, `NodeSdk`) does **not** bundle for workerd, so cire imports only the workerd-safe subpaths:

| Concern | What cire uses | Workerd-safe because |
| --- | --- | --- |
| **Logs** | `makeLoggerLayer` from `@shared/observability/logger` (`src/observability.ts` → `cireLoggerLayer`, provided via `runCire` / `runCireSync`) | pure `effect` code, zero OTel imports |
| **Traces** | `Effect.withSpan("cire.<domain>.<op>")` on service functions; `makeOtlpTracing` from `@shared/observability/tracing` | the optional exporter uses Effect and `fetch`, without the Node OpenTelemetry SDK |
| **Metrics** | `cire/api/src/metrics.ts` — typed counters/histograms via `createCounter`/`createHistogram` (`@shared/observability/metrics`) | factory imports only `@opentelemetry/api`; lazily resolves a no-op meter |

### Application export

`cire/api` exports application spans through a workerd-safe OTLP/HTTP exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. The Worker flushes after each request through `ctx.waitUntil`; without the endpoint, the exporter is inert. Application metrics still need a workerd export path; see `[[decisions/deferred-decisions]]`. Cloudflare's native tracing is separate: the local Wrangler config enables it without URL redaction, and dev enables it with query strings redacted on cire-api and cire-invites. The production `cire-invites` Worker traces both existing `/<slug>` guest links and new fixed-path links at `/cire/invite?slug=…` and `/cire/registry?slug=…`. Existing path slugs and outbound API URLs appear in traces; new fixed-path pages resolve invitations through a fixed API URL with the slug in the request body. The production API Worker keeps native traces off while path-bearing URLs are reviewed. Production query strings are redacted in Cloudflare logs and native traces. See [[shared/observability/tracing]].

## Three Rules

1. **No `console.*` in backend** — use the Effect structured logger run through `runCire` / `runCireSync` (which install the redacting `cireLoggerLayer`). `console.log` bypasses redaction + structured output.
2. **Never log PII** — guest names, dietary, claim codes, session tokens, OSN account ids are forbidden in log output. The shared deny-list catches accidental annotations (see below), but better not to annotate them at all. `weddingId` / `familyId` / OSN **profile** ids are loggable.
3. **Always log error paths** — every `catch` / `Effect.catchAll` / `tapError` on an unrecoverable failure must emit a log line.

## Log Levels

| Level   | Effect API          | When to use                                                                              |
| ------- | ------------------- | ---------------------------------------------------------------------------------------- |
| Debug   | `Effect.logDebug`   | Local dev only. Never in production code paths.                                          |
| Info    | `Effect.logInfo`    | Happy-path milestones: import applied, invite saved, dev-server banners.                  |
| Warning | `Effect.logWarning` | Recoverable issues: malformed palette, formula-injection rejected, best-effort cleanup.   |
| Error   | `Effect.logError`   | Unrecoverable failures: DB defect, R2 storage failure, S2S osn-api lookup failure.        |

## Redacting the logger

Every Effect run goes through `runCire(effect)` (or `runCireSync` for the framework error boundary + dev banners), which provides `cireLoggerLayer`. That layer replaces Effect's default logger with the shared **redacting** logger: it passes each message + annotation through the `@shared/observability/logger` deny-list before serialization (json in prod, pretty in dev). **Do not call `Effect.runPromise` / `Effect.runSync` directly** — that skips redaction.

### Redaction deny-list

The deny-list is the single shared list in `shared/observability/src/logger/redact.ts` — **not** a cire-local copy. It already lists every sensitive cire field: `cire_session`, `firstName`/`first_name`, `lastName`/`last_name`, `familyName`/`family_name`, `publicId`/`public_id` (the claim **code** — a credential), `dietary` and `dietaryPresets`/`dietary_presets` (both Art. 9 special-category — a preset key names a religious practice or a health condition as plainly as the sentence it replaces), and `osnAccountId`/`osn_account_id`. Add a new sensitive cire field there (camelCase + snake_case) **and** add its assertion in `redact.test.ts`, in the same commit.

## Naming conventions

- **Spans**: `cire.<domain>.<operation>` (camelCase op), e.g. `cire.claim.lookup`, `cire.import.apply`, `cire.accountLink.link`, `cire.invite.setImage`.
- **Metrics**: `{namespace}.{domain}.{subject}.{measurement}` with `namespace = cire`, snake_case, e.g. `cire.claim.attempts`, `cire.import.parse.rejected`, `cire.account_link.requests`. Every attribute value is a **bounded string-literal union** — no `weddingId` / `guestId` / `familyId` / `publicId` / `osnAccountId` in attributes (those go in spans/logs). Free-text inputs (parse-rejection reasons) are bucketed to a closed union via `bucketParseReason()`. All instruments live in `cire/api/src/metrics.ts`; emit only through the exported `metric*` / `measure*` helpers.

## Upgrade Path

The remaining step is wiring a workerd metric exporter so the counters ship:

- **Workers Analytics Engine** for metrics.

Either one activates the existing call-sites with no code change. See `[[decisions/deferred-decisions]]`.
