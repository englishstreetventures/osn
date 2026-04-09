# CLAUDE.md

AI coding assistant reference. For full spec see README.md. For progress/decisions see TODO.md.

## Quick Context

OSN: Modular social platform. Users own identity + social graph. Apps opt-in/out independently.

Phase 1 apps: OSN Core (auth), Pulse (events), Zap (messaging), Landing (marketing).

## File Responsibilities

- `README.md` → Project spec, vision, features, tech stack, contributing (human-readable)
- `CLAUDE.md` → Code patterns, commands, current state, conventions (AI reference)
- `TODO.md` → Progress tracking, deferred decisions, task checklists

## TODO.md Structure + Maintenance

`TODO.md` is organised into these top-level sections — add new items to the right place:

| Section | What goes here |
|---------|---------------|
| **Up Next** | ≤8 highest-priority items across all areas. Keep it short — if everything is a priority, nothing is. Prune when items are done or promoted to a feature section. |
| **App sections** (Pulse, OSN Core, Zap, Landing) | Feature work specific to that app. Check items off when done; don't delete them. |
| **Platform** (API, DB, Client, UI, Infra) | Shared package work and infrastructure. Same check-off rule. |
| **Security Backlog** | All security findings, sorted H → M → L. Add new findings from PR reviews here. Mark done with `[x]` + short note. Never delete — the history matters. |
| **Performance Backlog** | All perf findings. Same rules as Security. |
| **Deferred Decisions** | Questions we're not answering yet. Add a row; remove it when the decision is made. |
| **Future** | Phase 2/3 items. Vague is fine here — detail gets added when the phase starts. |

**When to update TODO.md:**
- After a PR merges → check off completed items; add any new findings; update Up Next
- When a security/performance review surfaces findings → add to the relevant backlog section
- When a new deferred decision comes up → add a row to the table
- Keep Up Next pruned to the real next things — it should be actionable at a glance

## Current State

The monorepo is organised by **domain**. Four top-level directories, four
workspace-name prefixes, one prefix per directory — no mixing:

| Dir | Prefix | What lives here |
|-----|--------|-----------------|
| `osn/`    | `@osn/*`    | OSN identity stack (auth, graph, SDK, crypto, landing) |
| `pulse/`  | `@pulse/*`  | Pulse events stack (app, events API, DB) |
| `zap/`    | `@zap/*`    | Zap messaging stack (app, messaging API, DB) — placeholder, see TODO.md |
| `shared/` | `@shared/*` | Cross-cutting utilities consumable by any stack |

```
osn/
  app/                 # ✓ @osn/app — Bun/Elysia auth server (port 4000); thin wrapper over @osn/core
  landing/             # ✓ @osn/landing — Astro + Solid (marketing site)
  core/                # ✓ @osn/core — auth services + routes (passkey, OTP, magic link, PKCE, JWT, /login/*) + social graph service + routes + hosted /authorize HTML
  client/              # ✓ @osn/client — SDK: createRegistrationClient, createLoginClient, OsnAuthService; @osn/client/solid AuthProvider + useAuth
  crypto/              # ✓ @osn/crypto — ARC tokens (S2S auth); Signal protocol pending
  db/                  # ✓ @osn/db — Drizzle + SQLite (users, passkeys, social graph, service accounts)
  ui/                  # ✓ @osn/ui — shared SolidJS components: <Register>, <SignIn>, <MagicLinkHandler> under @osn/ui/auth/*
pulse/
  app/                 # ✓ @pulse/app — Tauri + SolidJS (iOS target ready). Consumes @osn/client, @osn/ui, @pulse/api
    src/               # SolidJS frontend
    src-tauri/         # Rust + Tauri native layer
  api/                 # ✓ @pulse/api — Elysia + Eden events server (port 3001). Consumed by @pulse/app via @pulse/api/client
  db/                  # ✓ @pulse/db — Drizzle + SQLite (events, RSVPs)
zap/                   # ⏳ placeholder — see zap/README.md and the Zap section of TODO.md
  app/                 # planned: @zap/app — Tauri + SolidJS messaging client
  api/                 # planned: @zap/api — Elysia + Eden messaging server
  db/                  # planned: @zap/db — Drizzle schema (chats, messages, group state)
shared/
  db-utils/            # ✓ @shared/db-utils — createDrizzleClient, makeDbLive (consumed by @osn/db and @pulse/db)
  typescript-config/   # ✓ @shared/typescript-config — base.json, node.json, solid.json
```

### @osn/core vs @pulse/api — the distinction, for the record

`@osn/core` is a **library** — it never calls `listen()`. It exports
Elysia route factories (`createAuthRoutes`, `createGraphRoutes`) + Effect
services. `@osn/app` is the binary that imports it and actually listens on
port 4000.

`@pulse/api`, by contrast, **is** the binary — it runs its own Elysia
process on port 3001 and exposes `@pulse/api/client` (an Eden treaty
wrapper) for the Pulse frontend to consume. It imports `@pulse/db` and
has nothing to do with OSN identity.

### Sign-in + Register are now shared

Both `<Register />` and `<SignIn />` live in `@osn/ui/auth/*`, receive an
injected client prop, and talk to first-party `/login/*` + `/register/*`
endpoints that return `{ session, user }` directly (no PKCE). The hosted
`/authorize` HTML + PKCE flow stays put in `@osn/core` for third-party
OAuth clients but is no longer used by first-party apps like Pulse.

## Tech (one-liner)

Bun, TypeScript, Elysia, Effect.ts (trial), Drizzle, SQLite→Supabase, Eden+REST, WebSockets, Signal Protocol, SolidJS, Astro, Tauri, Turborepo, oxlint, oxfmt, Vitest + @effect/vitest

## ARC Tokens (S2S Auth)

ARC is OSN's service-to-service authentication token — an ASAP-style self-issued JWT for backend-to-backend calls (e.g. Pulse API querying OSN Core's social graph).

**Key properties:**
- ES256 (ECDSA P-256) — compact, fast, no shared secret
- Self-issued: each service signs its own token with its private key
- Short-lived (5 min TTL); cached in-memory, re-issued 30s before expiry
- Scope-gated: `scope` claim limits what the token can do (e.g. `graph:read`)
- Audience-scoped: `aud` claim names the target service (e.g. `"osn-core"`)
- Public key discovery: first-party services registered in `service_accounts` DB table (`service_id`, `public_key_jwk`, `allowed_scopes`); third-party apps use JWKS URL derived from `iss`

**Lives in:** `osn/crypto` (`@osn/crypto`). Import from `@osn/crypto/arc`.

**Exports:**
```typescript
generateArcKeyPair()                                      // → CryptoKeyPair (ES256)
exportKeyToJwk(key)                                       // → JSON string (for DB storage)
importKeyFromJwk(jwk)                                     // → CryptoKey
createArcToken(privateKey, { iss, aud, scope }, ttl?)     // → signed JWT string
verifyArcToken(token, publicKey, expectedAud, scope?)     // → ArcTokenPayload or throws
resolvePublicKey(issuer, tokenScopes?)                    // → Effect<CryptoKey, ArcTokenError, Db>
getOrCreateArcToken(privateKey, { iss, aud, scope }, ttl?) // → cached JWT (re-issues 30s before expiry)
clearTokenCache() / clearPublicKeyCache()                 // → for testing / key rotation
```

### When to use ARC tokens

| Scenario | Use ARC? | Why |
|----------|----------|-----|
| Pulse API → OSN Core graph (current) | No | Direct package import (`createGraphService()`); zero overhead |
| Pulse API → OSN Core graph (multi-process) | **Yes** | HTTP call to `/graph/internal/*` must prove caller identity |
| Third-party app → any OSN endpoint | **Yes** | Caller has no shared secret; presents its public key via JWKS |
| User-facing API call | No | Use user JWT (Bearer token); ARC is machine-to-machine only |
| Background job → OSN Core | **Yes** | Job acts as a service, not a user |

### Calling service (token issuer) — typical pattern

```typescript
import { getOrCreateArcToken, importKeyFromJwk } from "@osn/crypto/arc";

// Boot-time: load private key from env/secret store
const privateKey = await importKeyFromJwk(process.env.ARC_PRIVATE_KEY_JWK!);

// Per-request: get a cached or fresh token
const token = await getOrCreateArcToken(privateKey, {
  iss: "pulse-api",      // this service's service_id
  aud: "osn-core",       // target service
  scope: "graph:read",   // minimal required scope
});

// Attach to outgoing HTTP request
fetch("http://localhost:4000/graph/internal/connections", {
  headers: { Authorization: `ARC ${token}` },
});
```

### Receiving service (token verifier) — typical pattern

```typescript
import { verifyArcToken } from "@osn/crypto/arc";
import { resolvePublicKey } from "@osn/crypto/arc";
import { Effect } from "effect";

// In an Elysia route guard or middleware:
const arcMiddleware = (requiredScope: string) => async (ctx) => {
  const auth = ctx.headers.authorization;
  if (!auth?.startsWith("ARC ")) return ctx.set.status = 401;

  const token = auth.slice(4);
  // resolvePublicKey looks up the issuer in service_accounts table + validates allowed_scopes
  const publicKey = await Effect.runPromise(
    resolvePublicKey(/* iss from token */, [requiredScope]).pipe(Effect.provide(DbLive))
  );
  const claims = await verifyArcToken(token, publicKey, "osn-core", requiredScope);
  // claims.iss, claims.aud, claims.scope are now verified
};
```

### Service registration

Each first-party service must have a row in `service_accounts`:
```sql
INSERT INTO service_accounts (service_id, public_key_jwk, allowed_scopes)
VALUES ('pulse-api', '<exported-public-key-jwk>', 'graph:read');
```
Generate a key pair once at service setup with `generateArcKeyPair()`, store the **private key** in an env/secret store, and insert the **public key** (via `exportKeyToJwk`) into the DB.

**Current S2S strategy:** Pulse API imports `createGraphService()` from `@osn/core` directly (zero network overhead). ARC tokens guard HTTP-based S2S (`/graph/internal/*`) — needed when scaling to multi-process, and immediately for any third-party app. See the "S2S scaling" deferred decision in TODO.md.

## Observability (Logging / Metrics / Tracing)

OSN uses **OpenTelemetry end-to-end**, shipped to **Grafana Cloud** (free tier: 10k active series, 50 GB/mo logs, 50 GB/mo traces, 14-day rolling retention). Frontend observability via **Grafana Faro** (same OTLP endpoint, no Sentry). All plumbing lives in `@shared/observability` — no other package should import `@opentelemetry/*` directly.

**Package layout:**
```
shared/observability/
  src/
    config.ts              # env → typed config
    logger/                # Effect Logger.json + redaction (no pino)
    tracing/               # @effect/opentelemetry NodeSdk layer
    metrics/
      factory.ts           # typed createCounter / createHistogram / createUpDownCounter
      attrs.ts             # shared attribute string-literal unions (Result, AuthMethod, …)
    elysia/plugin.ts       # request ID, spans, access log, RED metrics, /health, /ready
    fetch/instrument.ts    # outbound fetch wrapper: injects W3C traceparent + ARC token preserved
```

### The three golden rules

1. **Never call `console.*` in backend code.** Use `Effect.logInfo` / `Effect.logWarn` / `Effect.logError`. The logger is automatically replaced with `Logger.jsonLogger` in prod and `Logger.prettyLogger()` in dev via `ObservabilityLive`.
2. **Never construct OTel meters/tracers directly.** Use the typed helpers from `@shared/observability/metrics`. Raw `metrics.getMeter(...)` calls are banned (lint rule enforces this).
3. **Never put unbounded values in metric attributes.** No `userId`, no `requestId`, no `eventId`, no email, no handle. Those belong in traces (spans) or logs (annotations), never metrics.

### Logging rules

- **Use `Effect.logInfo/Warn/Error` inside Effect pipelines.** Trace context is attached automatically — no manual `traceId` plumbing.
- **Put structured context in annotations, not message text.** `Effect.logInfo("event created").pipe(Effect.annotateLogs({ eventId: e.id }))`, not `Effect.logInfo(`event created: ${e.id}`)`. The JSON logger keeps annotations as structured fields; interpolated strings get redacted-or-missed.
- **Every error path logs with `Effect.logError`, including the `_tag` and cause.** Let the tagged error *be* the structured context — do not reformat.
- **Redaction is non-negotiable.** The logger layer applies a deny-list scrubber before serialization: `email`, `password`, `otp`, `otpCode`, `token`, `accessToken`, `refreshToken`, `authorization`, `cookie`, `set-cookie`, `passkey`, `credential`, `privateKey`, `ciphertext`, `plaintext`, `messageBody`, `signalEnvelope`, `ratchetKey`, `identityKey`, `prekey`, `senderKey`. Add to the list; never remove.
- **`userId` is OK to log; `handle` and `email` are not.** Use the ID.
- **Dev-mode OTP/magic-link logging** (which exists today at `console.log` sites flagged in S-L8) is replaced by a dedicated `Effect.logDebug` path gated on `NODE_ENV !== "production"`.

### Tracing rules

- **Wrap every service-level function in `Effect.withSpan("<domain>.<operation>")`.** Examples: `events.create`, `auth.register.complete`, `graph.connection.accept`, `arc.token.verify`.
- **Span names are hierarchical and snake_case.** Dots separate layers; underscores separate words. Match the metric naming convention so dashboards can correlate on shared prefixes.
- **Do not create spans at route level** — the Elysia plugin already creates a span per request with `http.*` attributes. Creating a second span inside the handler is redundant; add service spans inside the Effect pipeline instead.
- **Propagate trace context across services via the shared `fetch` wrapper.** Any outbound HTTP from our code goes through `instrumentedFetch` from `@shared/observability/fetch` — it injects `traceparent` + (if configured) the ARC token header. Never raw `fetch()` for service-to-service calls.
- **Inbound `traceparent` is only trusted from ARC-authenticated callers.** The Elysia plugin extracts upstream trace context when — and only when — the request presents `Authorization: ARC ...`. Anonymous/public requests start fresh root spans to prevent external attackers from forcing sampling decisions or injecting chosen trace IDs into our internal traces (S-H13).
- **Elysia hook limitation (known).** Elysia's `onRequest → handler → onAfterResponse` hooks run as separate invocations, not inside a single enclosing callback. OTel's `context.with(ctx, fn)` scope only lives for the duration of `fn`, so there is no way to make a single OTel `Context` active across the hook → handler boundary via hooks alone. Consequences: `trace.getActiveSpan()` inside a synchronous handler does NOT see the server span, and Effect service spans created via `Effect.withSpan` become root spans rather than children of the HTTP request. Distributed tracing across services still works (inbound/outbound `traceparent` propagation is unaffected). For handlers that explicitly want child spans, use `getRequestContext(request)` + `context.with(...)` as an escape hatch.
- **WebSocket spans are out of scope for the initial rollout** — flagged to add per-message spans when `@zap/api` lands.

### Metrics rules

**Naming convention** — follow [OTel semantic conventions](https://opentelemetry.io/docs/specs/semconv/general/metrics/) where they exist (`http.server.*`, `db.client.*`, `process.runtime.*`). For OSN-specific metrics:

```
{namespace}.{domain}.{subject}.{measurement}
```

- `namespace`: `osn`, `pulse`, `zap`, `arc`, `db`, `http`, `process` — identifies the owner
- `domain` + `subject`: lowercase, `snake_case` inside each segment, dots between
- No `_total` / `_count` suffix (OTel prometheus exporter adds `_total` for counters automatically)
- Unit lives in the metric's `unit` field, not the name
- `{attempt}`, `{event}`, `{token}`, `{operation}` for UCUM-style unit-less counts; `s` for seconds; `By` for bytes; `1` for dimensionless ratios

Examples: `osn.auth.register.attempts`, `osn.auth.login.duration`, `pulse.events.created`, `pulse.events.status_transitions`, `arc.token.issued`, `arc.token.verification`.

**Default resource attributes** — applied to every metric by the SDK init, never set per-call:
- `service.name` (e.g. `pulse-api`)
- `service.namespace` (always `osn`)
- `service.version` (from `package.json`)
- `service.instance.id` (`<hostname>-<pid>`)
- `deployment.environment` (`dev` | `staging` | `production`)

**Single-definition-site rule:** every metric is declared exactly once, in a `metrics.ts` file co-located with its domain:
- `pulse/api/src/metrics.ts` — Pulse API domain metrics
- `osn/core/src/metrics.ts` — OSN Core auth + graph metrics
- `osn/crypto/src/arc-metrics.ts` — ARC token metrics
- `shared/observability/src/metrics/http.ts` — shared HTTP RED metrics (used by the Elysia plugin)

Each file exports:
1. An **`OSN_METRICS`** (or `PULSE_METRICS`, `ARC_METRICS`, etc.) const object of metric name strings — the single source of truth, grep-able, refactor-safe.
2. **Typed counter/histogram instances** built via `createCounter<Attrs>(...)` from `@shared/observability/metrics/factory`. The `Attrs` generic pins the allowed attribute keys at declaration — TypeScript rejects any caller passing an unknown key, so cardinality footguns become compile errors.
3. Optionally, small **wrapper functions** for common call sites (`metricLoginAttempt(method, result)`) so the call site reads as a verb, not a `.inc()`.

**Per-metric attributes** — strict rules:
- **Must be bounded.** The `Attrs` type is a `Record<string, string>` where every value is a string-literal union (`"ok" | "error" | "rate_limited"`, not `string`).
- **Must be documented at the declaration site** via the TypeScript type. The type *is* the contract.
- **Never include user-identifying, request-identifying, or session-identifying values** — even via `as`. Reviewers reject the diff; logs and traces are the correct home for those.
- **Max ~5 attributes per metric.** More than that and you're probably modelling what should be two metrics.
- **Free-text → bounded bucket.** When an attribute value comes from user input or a runtime registry whose set can't be known at compile time (e.g. event category, ARC service ID), do NOT type it as `string`. Define a closed allow-list and a `bucketX()` / `safeX()` helper that collapses unknown values to `"other"` or `"unknown"` before emission. See `bucketCategory()` in `pulse/api/src/metrics.ts` and `safeIssuer()` in `osn/crypto/src/arc-metrics.ts` for the canonical pattern. This is the runtime analogue of the compile-time string-literal-union rule.
- **Route attributes default to a fixed sentinel.** HTTP-style route labels must never be set from a raw URL path. The shared Elysia plugin defaults `http.route` to `"unmatched"` and only overwrites it with Elysia's matched route template in `onAfterHandle`. Any request that short-circuits before then (404, body validation failure) records as `unmatched`, not as a raw attacker-controlled path (S-C1).

### Canonical code example

```typescript
// shared/observability/src/metrics/factory.ts — typed factory
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

// Standard latency buckets (seconds) — use for all HTTP / DB / Effect-span histograms
export const LATENCY_BUCKETS_S = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;
```

```typescript
// shared/observability/src/metrics/attrs.ts — shared string-literal unions
export type Result = "ok" | "error" | "unauthorized" | "rate_limited" | "not_found";
export type AuthMethod = "passkey" | "otp" | "magic_link" | "refresh";
export type ArcVerifyResult =
  | "ok" | "expired" | "bad_signature" | "unknown_issuer"
  | "scope_denied" | "audience_mismatch";
```

```typescript
// osn/core/src/metrics.ts — domain metrics for OSN Core
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

```typescript
// osn/core/src/services/auth.ts — call site
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

### Checklist when adding a new feature / service / route

Every feature PR should answer these questions:

- [ ] **Logs** — are all error paths covered by `Effect.logError` with the tagged error? Any `console.*` calls? Any secret fields that need adding to the redaction deny-list?
- [ ] **Traces** — is every service function wrapped in `Effect.withSpan("<domain>.<operation>")`? Are the span names consistent with existing ones? Any outbound HTTP going through `instrumentedFetch`?
- [ ] **Metrics** — does this feature need new counters/histograms? If yes, added to the correct `metrics.ts` file with typed `Attrs`? Names follow `{namespace}.{domain}.{subject}.{measurement}`? Cardinality bounded?
- [ ] **Dashboards / alerts** — if this is a critical path (auth, payments, S2S, messaging), is there a follow-up task to add a dashboard row or alert rule? (Out of scope for most feature PRs but worth noting.)

### What stays out of scope (for now)

- Alerting rules and dashboards (separate post-instrumentation work)
- Self-hosted collector (use Grafana Cloud OTLP endpoint directly)
- Continuous profiling (pyroscope)
- WebSocket per-message spans (deferred to Zap M1)
- Log-based metrics (straight counters/histograms only)

## Review Finding IDs

All review skills (`/review-security`, `/review-performance`, `/review-tests`) tag findings with short IDs so they can be referenced precisely (e.g. "fix S-H1 before merging", "P-C2 still open").

| Prefix | Skill | Tiers |
|--------|-------|-------|
| `S-C`, `S-H`, `S-M`, `S-L` | review-security | Critical / High / Medium / Low |
| `P-C`, `P-W`, `P-I` | review-performance | Critical / Warning / Info |
| `T-M`, `T-U`, `T-E`, `T-R`, `T-S` | review-tests | Missing file / Untested export / Error path / Route test / Suggestion |

Counters increment within each tier across the full report (`S-H1`, `S-H2`, …). Each finding uses a four-field format: **Issue** / **Why** / **Solution** / **Rationale**.

When adding findings to the TODO.md Security or Performance backlogs, use the finding ID as the item label:
```
- [ ] S-M3 — No rate limit on /foo endpoint
- [x] P-W1 — N+1 in listEvents (fixed: inArray batch fetch)
```

## Conventions

- Tauri apps created via CLI (`bunx create-tauri-app`), not manually
- Effect.ts: trial with OSN/Pulse first, then decide (see TODO.md)
- Messaging backend (`@zap/api`) is a shared service: Zap consumes it directly; Pulse uses it indirectly for event chats. Users don't need a Zap install to participate in event group chats.
- E2E encryption everywhere
- All personalization data user-accessible + resettable
- Priority: iOS > Web > Android (Android deferred)
- Pre-commit: lefthook runs oxlint + oxfmt on staged files
- Pre-push: lefthook runs type check
- oxlint configured via `oxlintrc.json` (React plugin disabled for SolidJS)
- Use `bunx --bun` flag for all tooling (bypasses Node.js)
- PRs required to merge to main (no direct pushes)
- Always work on a feature branch — never commit directly to main
- Every PR must include a changeset (`bun run changeset`) — CI will fail without one
- **Changeset packages must use the workspace `name` field exactly** (e.g. `"@pulse/app"`, not `"pulse"`). The Changeset Check workflow runs `bunx changeset status` to catch typos before merge — without it, a bad reference fails the Release workflow on main and blocks all subsequent versioning.
- Versioning is automatic: changesets are consumed and committed by CI on merge to main

## Testing Patterns

Test files live in `tests/` at the package root, mirroring the `src/` structure:

```
pulse/api/
  tests/
    helpers/db.ts                  # createTestLayer() — shared test utility
    services/events.test.ts        # Effect service tests
    routes/events.test.ts          # HTTP integration tests
osn/core/
  tests/
    helpers/db.ts                  # createTestLayer() for osn/db (users + passkeys)
    services/auth.test.ts          # Effect service tests
    routes/auth.test.ts            # HTTP integration tests
pulse/db/
  tests/
    schema.test.ts                 # Schema smoke tests
osn/ui/
  tests/
    auth/Register.test.tsx         # Shared Register component (Solid + happy-dom)
    auth/SignIn.test.tsx           # Shared SignIn component
    auth/MagicLinkHandler.test.tsx # Magic-link deep-link helper
```

```typescript
// Service tests: it.effect from @effect/vitest, isolated DB per test
import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { createTestLayer } from "../helpers/db";

it.effect("creates event with evt_ prefix", () =>
  Effect.gen(function* () {
    const event = yield* createEvent({ title: "Test", startTime: "2030-06-01T10:00:00.000Z" });
    expect(event.id).toMatch(/^evt_/);
  }).pipe(Effect.provide(createTestLayer()))
);

// Error assertions: use Effect.flip to promote errors to success channel
it.effect("fails with EventNotFound", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(getEvent("nonexistent"));
    expect(error._tag).toBe("EventNotFound");
  }).pipe(Effect.provide(createTestLayer()))
);

// Route tests: plain vitest, fresh app per test via beforeEach
import { describe, it, expect, beforeEach } from "vitest";
import { createEventsRoutes } from "../../src/routes/events";

describe("events routes", () => {
  let app: ReturnType<typeof createEventsRoutes>;
  beforeEach(() => { app = createEventsRoutes(createTestLayer()); });

  it("GET /events → 200", async () => {
    const res = await app.handle(new Request("http://localhost/events"));
    expect(res.status).toBe(200);
  });
});
```

**Rules:**
- All tests use in-memory SQLite — no file DB, no migrations needed
- Service tests: `it.effect` + `Effect.provide(createTestLayer())` per test (full isolation)
- Route tests: `createEventsRoutes(createTestLayer())` in `beforeEach` (full isolation)
- Routes accept an optional `dbLayer` param for injection; default is `DbLive`
- `osn/core` auth routes use `createAuthRoutes(authConfig, dbLayer?)` — config is required (no global default)
- Use `bunx --bun vitest` (not plain `vitest`) — required for `bun:sqlite` module access
- Use future dates (e.g. `2030-06-01T10:00:00.000Z`) for test events; default `listEvents` filters past events out

## Schema Layers

Two schema tools, two distinct layers — never mix them:

**Elysia TypeBox (`t` from `elysia`)** — HTTP boundary only:
- Validates raw request types (query params, route bodies, path params)
- Drives Eden client type inference — must stay in routes
- Strings stay strings (no transforms); keep it structural
- Example: `t.String({ format: "date-time" })` validates the wire format

**Effect Schema (`Schema` from `effect`)** — service/domain layer only:
- Validates AND transforms (e.g. ISO string → `Date`, enum narrowing)
- Returns `Effect<A, ParseError>` — integrates naturally with Effect pipelines
- Used via `Schema.decodeUnknown(MySchema)(data)` inside service functions
- Example: `Schema.DateFromString` decodes `"2030-06-01T..."` → `Date`

```
HTTP request
  ↓
[Elysia TypeBox]  validates raw HTTP types, powers Eden types
  ↓
service called with typed-but-still-primitive body (strings, not Dates)
  ↓
[Effect Schema]   transforms + validates into domain types
  ↓
database operation
```

## Backend Code Patterns

```typescript
// Route layer — Elysia TypeBox for HTTP shapes
export const createEventsRoutes = (dbLayer = DbLive) =>
  new Elysia({ prefix: "/events" })
    .post("/", async ({ body, set }) => {
      const result = await Effect.runPromise(
        createEvent(body).pipe(Effect.provide(dbLayer))
      );
      set.status = 201;
      return { event: result };
    }, {
      body: t.Object({
        title: t.String(),
        startTime: t.String({ format: "date-time" }), // string at HTTP layer
      }),
    });

// Service layer — Effect Schema for domain validation + transforms
// Schema.DateFromString allows Invalid Date — use a validated transform instead
const ValidDateString = Schema.String.pipe(Schema.filter((s) => !isNaN(new Date(s).getTime())));
const DateFromISOString = Schema.transform(ValidDateString, Schema.DateFromSelf, {
  strict: true,
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
});

const InsertEventSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  startTime: DateFromISOString,                 // string → Date (validated)
  status: Schema.optional(Schema.Literal("upcoming", "ongoing", "finished", "cancelled")),
});

export const createEvent = (data: unknown) =>
  Effect.gen(function* () {
    const validated = yield* Schema.decodeUnknown(InsertEventSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );
    // validated.startTime is now a Date
  });
```

## Cross-package S2S patterns (`pulse/api` → `@osn/core`)

When a Pulse service needs identity or graph data (RSVP visibility,
user displays, close-friends lookups), **every call must go through
`pulse/api/src/services/graphBridge.ts`**. That file is the single
import surface for `@osn/core` + `@osn/db` inside Pulse, so:

- The eventual S2S migration from direct package import to ARC-token
  HTTP is a single-file change.
- A reviewer can `grep '@osn/core' pulse/api/src` and see every
  cross-boundary call in one place.
- The bridge maps OSN errors onto a single `GraphBridgeError` tagged
  error so callers catch one tag instead of a union of errors they
  don't own.

Exports:

```typescript
getConnectionIds(userId)                      // accepted connections set
getCloseFriendIds(userId)                     // outbound close-friends set
getCloseFriendsOf(viewerId, attendeeIds[])    // attendees who marked viewer as CF
getUserDisplays(userIds[])                    // batched user metadata join
OsnDbLayer                                     // Effect Layer for routes
```

Graph membership sets are bounded by `MAX_EVENT_GUESTS` (see limits
below) — the bridge is not paginated and never returns partial sets
for the visibility filter.

## Shared visibility gate (`loadVisibleEvent`)

`pulse/api/src/services/eventAccess.ts` exports `canViewEvent(event,
viewerId)` and `loadVisibleEvent(eventId, viewerId)` — the single
source of truth for "can this viewer see this event?".

Every direct-fetch route (`GET /events/:id`, `/ics`, `/comms`,
`/rsvps[/counts/latest]`) MUST use this gate or private events
become bypassable by direct ID. Discovery (`listEvents`) uses the
equivalent SQL predicate — keep them in sync.

Rules:
- **Public events**: visible to everyone (incl. unauthenticated)
- **Private events**: visible to the organiser OR any user with an
  RSVP row (going / interested / not_going / invited)
- Non-authorised viewers get `null` → route returns **404** (not 403
  — 403 would disclose existence)

When adding a new event-scoped route, always load the event via
`loadVisibleEvent` instead of `getEvent`.

## Platform limits (`pulse/api/src/lib/limits.ts`)

Platform-wide caps live in a single `limits.ts` file per workspace.
Schemas, route bodies, and documentation reference the named
constant — never inline the number.

Current limits:

| Constant          | Value | Bites |
|-------------------|-------|-------|
| `MAX_EVENT_GUESTS` | 1000 | Bulk-invite batch size; graph membership sets in `graphBridge.ts` |

Beyond 1000 guests, events belong to a future verified-organisation
tier (Pulse phase 2 — dashboards, SLA, bulk import/export, paid
ticketing). Do not bump this number without a team discussion.

## Shared UI tokens (`pulse/app/src/lib/ui.ts`)

Visual treatments that appear in more than one component live in
`lib/ui.ts` as exported constants. Changing a colour or ring style
should be a **single-file edit**.

Current tokens:

```typescript
CLOSE_FRIEND_RING_CLASS  // green outline on attendees who are close friends
avatarClasses(base, isCloseFriend)  // helper that appends the ring class
```

The `RsvpAvatar` component reads the constant, and both `RsvpSection`
and `RsvpModal` use `RsvpAvatar` — so the entire event-detail page's
close-friend affordance updates from one file.

Rule: when you find yourself copy-pasting the same Tailwind class
list across two components, lift it into `lib/ui.ts`. The
`RsvpAvatar` test asserts the constant flows to the DOM so you can
verify the linkage stays intact.

## Commands

```bash
# Development
bun run dev              # Start all dev servers (turbo)
bun run build            # Build all packages (turbo)
bun run check            # Type-check all packages (turbo)

# Testing
bun run test                          # run all tests (turbo, skips packages without test script)
bun run --cwd pulse/api test:run          # run Pulse events API tests once
bun run --cwd osn/core test:run           # run OSN core auth tests once
bun run --cwd osn/client test:run         # run OSN client SDK tests once
bun run --cwd osn/ui test:run             # run shared auth component tests once
bun run --cwd pulse/db test:run           # run Pulse DB schema tests once
bun run --cwd pulse/api test              # watch mode

# Code quality
bun run lint             # oxlint
bun run fmt              # oxfmt format
bun run fmt:check        # oxfmt check (CI)

# Database (run from the relevant package directory)
bun run db:migrate       # Generate migrations
bun run db:push          # Push schema
bun run db:studio        # Drizzle Studio
# e.g. bun run --cwd pulse/db db:studio

# Versioning
bun run changeset        # Create changeset (required for every PR)
# Note: bun run version runs automatically on merge to main — do not run manually

# Maintenance
bun run clean            # git clean -fdX
bun run reset            # clean + reinstall

# Tauri (from app directory)
bunx tauri init          # Initialize app
bunx tauri dev           # Dev server
bunx tauri build         # Build app
```

## Workspace Installs

```bash
# Use --cwd (not --filter)
bun add solid-js --cwd osn/landing
bun add drizzle-orm --cwd pulse/db
```
