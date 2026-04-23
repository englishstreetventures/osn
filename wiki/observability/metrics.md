---
title: Metrics
aliases: [metrics rules, counters, histograms, cardinality]
tags: [observability, metrics]
status: active
related:
  - "[[overview]]"
  - "[[logging]]"
  - "[[tracing]]"
  - "[[feature-checklist]]"
packages: ["@shared/observability", "@osn/api", "@pulse/api", "@shared/crypto"]
finding-ids: [S-C1, S-C2, S-C3]
last-reviewed: 2026-04-23
---

# Metrics

## Naming convention

Follow [OTel semantic conventions](https://opentelemetry.io/docs/specs/semconv/general/metrics/) where they exist (`http.server.*`, `db.client.*`, `process.runtime.*`). For OSN-specific metrics:

```
{namespace}.{domain}.{subject}.{measurement}
```

- **namespace**: `osn`, `pulse`, `zap`, `arc`, `db`, `http`, `process` -- identifies the owner
- **domain** + **subject**: lowercase, `snake_case` inside each segment, dots between
- No `_total` / `_count` suffix (OTel prometheus exporter adds `_total` for counters automatically)
- Unit lives in the metric's `unit` field, not the name
- UCUM-style units: `{attempt}`, `{event}`, `{token}`, `{operation}` for unit-less counts; `s` for seconds; `By` for bytes; `1` for dimensionless ratios

**Examples:** `osn.auth.register.attempts`, `osn.auth.login.duration`, `pulse.events.created`, `pulse.events.status_transitions`, `arc.token.issued`, `arc.token.verification`

## Default resource attributes

Applied to every metric by the SDK init, never set per-call:

| Attribute | Example |
|-----------|---------|
| `service.name` | `pulse-api` |
| `service.namespace` | `osn` (always) |
| `service.version` | from `package.json` |
| `service.instance.id` | `<hostname>-<pid>` |
| `deployment.environment` | `dev` / `staging` / `production` |

## Single-definition-site rule

Every metric is declared **exactly once**, in a `metrics.ts` file co-located with its domain:

| File | Scope |
|------|-------|
| `pulse/api/src/metrics.ts` | Pulse API domain metrics |
| `osn/api/src/metrics.ts` | OSN auth + graph metrics |
| `shared/crypto/src/arc-metrics.ts` | ARC token metrics |
| `shared/observability/src/metrics/http.ts` | Shared HTTP RED metrics (used by Elysia plugin) |

Each file exports:

1. An **`OSN_METRICS`** (or `PULSE_METRICS`, `ARC_METRICS`, etc.) const object of metric name strings -- the single source of truth, grep-able, refactor-safe.
2. **Typed counter/histogram instances** built via `createCounter<Attrs>(...)` from `@shared/observability/metrics/factory`. The `Attrs` generic pins the allowed attribute keys at declaration -- TypeScript rejects any caller passing an unknown key, so cardinality footguns become compile errors.
3. Optionally, small **wrapper functions** for common call sites (`metricLoginAttempt(method, result)`) so the call site reads as a verb, not a `.inc()`.

## Per-metric attribute rules

### Must be bounded

The `Attrs` type is a `Record<string, string>` where every value is a string-literal union (`"ok" | "error" | "rate_limited"`, not `string`).

### Must be documented at the declaration site

The TypeScript type *is* the contract.

### Never include user/request/session identifiers

No `userId`, no `requestId`, no `sessionId` -- even via `as`. Reviewers reject the diff; [[logging]] and [[tracing]] are the correct home for those.

### Max ~5 attributes per metric

More than that and you're probably modelling what should be two metrics.

### Free-text to bounded bucket

When an attribute value comes from user input or a runtime registry whose set can't be known at compile time (e.g. event category, ARC service ID), do NOT type it as `string`. Define a closed allow-list and a `bucketX()` / `safeX()` helper that collapses unknown values to `"other"` or `"unknown"` before emission. See `bucketCategory()` in `pulse/api/src/metrics.ts` and `safeIssuer()` in `shared/crypto/src/arc-metrics.ts` for the canonical pattern. This is the runtime analogue of the compile-time string-literal-union rule.

### Route attributes default to a fixed sentinel (S-C1)

HTTP-style route labels must never be set from a raw URL path. The shared Elysia plugin defaults `http.route` to `"unmatched"` and only overwrites it with Elysia's matched route template in `onAfterHandle`. Any request that short-circuits before then (404, body validation failure) records as `unmatched`, not as a raw attacker-controlled path.

## Canonical code examples

### Typed factory (`shared/observability/src/metrics/factory.ts`)

```typescript
import { metrics, type Attributes } from "@opentelemetry/api";

const meter = metrics.getMeter("osn");

export interface Counter<A extends Attributes> {
  add(value: number, attrs: A): void;
  inc(attrs: A): void;
}

export const createCounter = <A extends Attributes>(opts: {
  name: string;
  description: string;
  unit: string;
}): Counter<A> => {
  const c = meter.createCounter(opts.name, {
    description: opts.description,
    unit: opts.unit,
  });
  return {
    add: (value, attrs) => c.add(value, attrs),
    inc: (attrs) => c.add(1, attrs),
  };
};

// Standard latency buckets (seconds) -- use for all HTTP / DB / Effect-span histograms
export const LATENCY_BUCKETS_S = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;
```

### Shared attribute types (`shared/observability/src/metrics/attrs.ts`)

```typescript
export type Result = "ok" | "error" | "unauthorized" | "rate_limited" | "not_found";
export type AuthMethod = "passkey" | "recovery_code" | "refresh";
export type ArcVerifyResult =
  | "ok" | "expired" | "bad_signature" | "unknown_issuer"
  | "scope_denied" | "audience_mismatch";
```

### Domain metrics (`osn/api/src/metrics.ts`)

```typescript
import { createCounter, createHistogram, LATENCY_BUCKETS_S } from "@shared/observability/metrics";
import type { Result, AuthMethod } from "@shared/observability/metrics";

/** Single source of truth for OSN Core metric names. */
export const OSN_METRICS = {
  authRegisterAttempts: "osn.auth.register.attempts",
  authRegisterDuration: "osn.auth.register.duration",
  authLoginAttempts: "osn.auth.login.attempts",
  authLoginDuration: "osn.auth.login.duration",
  authTokenRefresh: "osn.auth.token.refresh",
  authHandleCheck: "osn.auth.handle.check",
  graphConnectionOps: "osn.graph.connection.operations",
  graphBlockOps: "osn.graph.block.operations",
  graphRateLimited: "osn.graph.rate_limited",
} as const;

type RegisterAttrs = { step: "begin" | "complete"; result: Result };
type LoginAttrs    = { method: AuthMethod; result: Result };

export const authRegisterAttempts = createCounter<RegisterAttrs>({
  name: OSN_METRICS.authRegisterAttempts,
  description: "Registration flow attempts by step and outcome",
  unit: "{attempt}",
});

export const authLoginAttempts = createCounter<LoginAttrs>({
  name: OSN_METRICS.authLoginAttempts,
  description: "Login attempts by auth method and outcome",
  unit: "{attempt}",
});

export const authLoginDuration = createHistogram<LoginAttrs>({
  name: OSN_METRICS.authLoginDuration,
  description: "Login flow duration by method",
  unit: "s",
  advice: { explicitBucketBoundaries: LATENCY_BUCKETS_S },
});
```

### Call site (`osn/api/src/services/auth.ts`)

```typescript
import { authLoginAttempts } from "../metrics";

export const login = (input: LoginInput) =>
  Effect.gen(function* () {
    // ... verification logic ...
    return session;
  }).pipe(
    Effect.withSpan("auth.login", { attributes: { "auth.method": input.method } }),
    Effect.tap(() =>
      Effect.sync(() => authLoginAttempts.inc({ method: input.method, result: "ok" })),
    ),
    Effect.tapError((e) =>
      Effect.sync(() =>
        authLoginAttempts.inc({
          method: input.method,
          result: e._tag === "RateLimited" ? "rate_limited" : "error",
        }),
      ),
    ),
  );
```

TypeScript rejects `authLoginAttempts.inc({ userId: "u_123" })` at compile time because `userId` is not in `LoginAttrs`. **Cardinality is enforced by the compiler, not by code review.**
