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
last-reviewed: 2026-11-05
---

# Logging

Use `Effect.logInfo` / `Effect.logWarn` / `Effect.logError` inside Effect pipelines. No manual `traceId` plumbing: on a Worker, Workers Logs files each line under the invocation's trace, and on Bun the tracer logger adds each line to its span.

## Where a log line goes

`makeLoggerLayer` ([layer.ts](../../../shared/observability/src/logger/layer.ts)) picks one console logger per tier, and all three see the entry after redaction ([[#Redaction]]). Effect's console is the only sink; no service code calls `console.*`.

| Tier | Runtime | What reaches the console |
|---|---|---|
| `local` | any | Effect's pretty logger, coloured, multi-line |
| `dev`, `staging`, `production` | workerd (`navigator.userAgent` is `Cloudflare-Workers`) | The entry as an object, through the console method of its level: `console.debug`, `console.info`, `console.warn`, `console.error` (error and fatal), `console.trace` (trace) |
| `dev`, `staging`, `production` | anything else (Bun with `OSN_ENV` set) | The entry as one JSON line through `console.log` |

On a Worker that object is what Workers Logs indexes: it extracts and indexes the keys of a logged object, and keeps a logged string as one message that only a text match finds ([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), read 2026-11-05). A line's level in Workers Logs is the console method's. The entry's own fields are `message`, `level`, `timestamp`, `cause`, `annotations`, `spans` and `fiberId`, so an annotation is queried as `annotations.<key>`.

Each Worker's `[observability]` block decides what is kept: `enabled = true` writes logs, `head_sampling_rate` samples invocations (1 everywhere today), and `[observability.logs] invocation_logs = false` drops the per-invocation record, which every cire Worker sets because the record stores the request URL and cire paths carry the wedding slug. Workers Free keeps logs three days and Workers Paid seven, and both seven from 2026-12-01, within the limits in [[free-tier-limits#Monitoring]].

## Log level guide

| Level | When to use | Production? |
|-------|-------------|-------------|
| `Effect.logDebug` | Dev-only diagnostics (OTP codes, magic-link URLs, internal state dumps) | Never emitted in production (minimum level is `Info`). Emitted in dev by default (minimum level is `Debug`). |
| `Effect.logInfo` | Normal operations worth recording: service boot, significant state transitions, successful completions of multi-step flows | Yes -- the default minimum level in production. Dev defaults to `Debug`. |
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

Redaction is non-negotiable, but keep the deny-list minimal. The logger layer in `@shared/observability` applies a key-name scrubber to every log entry before serialisation.

### It runs on the output side, on the whole annotations record

`redact()` matches the deny-list against an **object's keys**. It is handed the
resolved annotations record in one piece, not one value at a time — hand it a
bare value and it sees a scalar with no key attached and passes it straight
through.

> [!warning] This was broken until the Effect v4 migration
> The v3 logger mapped over each annotation *value*
> (`HashMap.map(options.annotations, redact)`), so **no top-level annotation key
> was ever redacted**. `Effect.annotateLogs({ accessToken })` reached the sink in
> clear, on every tier, along with every other deny-listed key below. The page
> said otherwise; the code did not do it.
>
> Nothing caught it because the test named for catching it did not test it — it
> provided a raw capture logger with no redaction in the chain and asserted the
> annotation came through unredacted. `shared/observability/tests/layer.test.ts`
> now runs the real layer, reads what reaches stdout, and asserts a deny-listed
> key is `[REDACTED]` while an allow-listed one survives.

Effect v4 moved annotations off the logger's `Options` and onto the fiber, so
the logger's options carry no annotations to scrub. Redaction for the console
loggers therefore sits on the output side, wrapping `Logger.formatStructured` — whose output object already carries
the resolved `message` and `annotations`. Anything that rebuilds the logger must
keep that seam, and must keep the tracer logger in the `Logger.layer([…])`
array: that call replaces the **whole** active set, so omitting it drops
log-to-span correlation with no error. The tracer logger is wrapped in the same
input-side scrub as the pretty logger (`redactInput`), because it copies each
line's message and annotations onto the span as an event, which the Bun OTLP
path exports. A deployed Worker lists only the Workers Logs logger: a Workers
span carries no events ([[tracing#Effect spans in Workers traces]]), and Workers
Logs files each line under the invocation's trace itself.

### The JSON field is `level`, not `logLevel`

v4's structured output names the severity field `level`. Any Grafana query,
dashboard panel or alert rule still filtering on `logLevel` matches nothing. The
dashboards live in Grafana Cloud rather than this repo, so that migration is done
there by hand.

### Deny-list location

`shared/observability/src/logger/redact.ts`

### Currently covered keys

- `authorization`
- OAuth token fields: `accessToken` / `refreshToken` / `idToken` / `enrollmentToken` (+ snake_case variants)
- WebAuthn `assertion` body
- ARC `privateKey`
- Email transport credentials: `apiKey` (Resend) and `apiToken` (Cloudflare Email Service), so a logged transport config never carries its key
- User PII fields that exist in the schema: `email`, `handle`, `displayName`
- Billing: the provider's `secretKey` and `webhookSecret`, and the Stripe customer fields an invoice, a Checkout session or a customer object carries into the Worker — `customer_details`, `customer_address`, `customer_email`, `customer_name`, `customer_phone`, `customer_shipping`, `customer_tax_ids`, `address`, `tax_ids` ([[billing]]). Matching is exact-key, so `address` also scrubs any other object's `address`

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
| A wedding slug | No | It is the couple's names; log the slot or route kind instead |

### Failed-query errors carry no bound values

Redaction matches keys, so it cannot clean a value that is already inside an error's message — and many services log `reason: String(e)`. `drizzle-orm`'s `DrizzleQueryError` puts every bound parameter in its message, which on a failed write means guest names or answers. The repository patches it (`patches/drizzle-orm@1.0.0-rc.5.patch`, applied by `bun install`): the message is `Failed query: <sql>` only, and `params` stays on the error as a non-enumerable field, so no log line, `String(e)`, JSON form or span exception carries it. `cire/api/tests/db/query-error.test.ts` fails if the patch stops applying. A drizzle upgrade must carry the patch forward. See [[tracing]].

## Dev-mode OTP logging

Dev-mode step-up OTP logging uses `Effect.logDebug` gated on `OSN_ENV` being unset or `"dev"`. The guard excludes both staging and production. It gives defence in depth alongside the log-level minimum. The log interpolates the OTP code into the message string, not into annotations, so the redacting logger does not scrub it — the dev log exists to show the value to the developer. In production these branches never run because `config.sendEmail` is wired up.

## Route-level logger wiring

`createAuthRoutes` and `createGraphRoutes` accept an optional `loggerLayer: Layer.Layer<never>` parameter (default `Layer.empty`). Each host entry passes its own layer so that `Effect.logDebug` / `Effect.logError` calls inside service pipelines fire through the configured logger + redactor: the Bun entry (`osn/api/src/local.ts`) passes the `observabilityLayer` from `initObservability()`; the Workers entry (`osn/api/src/index.ts`) passes `osnLoggerLayer`, the redacting logger with the Workers trace mirror, because the OTel SDK does not run on workerd.

Without this wiring, per-request Effect pipelines use Effect's default logger (which drops `Debug` and doesn't redact).

**When you add a new route factory that runs Effect pipelines**, follow the same pattern: accept `loggerLayer`, provide it inside the `run()` helper alongside `dbLayer`.
