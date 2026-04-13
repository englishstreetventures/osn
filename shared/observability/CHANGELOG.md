# @shared/observability

## 0.2.6

### Patch Changes

- f5c1780: feat: add multi-account schema foundation (accounts table, userId → profileId rename)

  Introduces the `accounts` table as the authentication principal (login entity) and renames
  `userId` to `profileId` across all packages to establish the many-profiles-per-account model.

  Key changes:

  - New `accounts` table with `id`, `email`, `maxProfiles`
  - `users` table gains `accountId` (FK → accounts) and `isDefault` fields
  - `passkeys` re-parented from users to accounts (`accountId` FK)
  - All `userId` columns/fields renamed to `profileId` across schemas, services, routes, and tests
  - Seed data expanded: 21 accounts, 23 profiles (including 3 multi-account profiles), 2 orgs
  - Registration flow creates account + first profile atomically

## 0.2.5

### Patch Changes

- e2ef57b: Add organisation support with membership and role management

## 0.2.4

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).

## 0.2.3

### Patch Changes

- e8b4f93: Add close friends to the OSN graph properly

  - Add `isCloseFriendOf` and `getCloseFriendsOfBatch` helpers to the graph service
  - Add `GET /graph/close-friends/:handle` status check endpoint
  - Instrument close friend operations with metrics (`osn.graph.close_friend.operations`) and tracing spans
  - Fix `removeConnection` to clean up close-friend entries in both directions (consistency bug)
  - Transaction-wrap `removeConnection` and `blockUser` multi-step mutations
  - Add `close_friends_friend_idx` index on `friend_id` for reverse lookups
  - Clamp `getCloseFriendsOfBatch` input to 1000 items (SQLite variable limit)
  - Sanitize error objects in graph operation log annotations
  - Migrate Pulse graph bridge from raw SQL to service-level `getCloseFriendsOfBatch`
  - Add `GraphCloseFriendAction` attribute type to shared observability

## 0.2.2

### Patch Changes

- f87d7d2: Auth security hardening: per-IP rate limiting on all auth endpoints (S-H1), redirect URI allowlist validation (S-H3), mandatory PKCE at /token (S-H4), legacy unauth'd passkey path removed (S-H5), login OTP attempt limit + unbiased generation + timing-safe comparison (S-M7/M24/M25), dev-log NODE_ENV gating (S-M22), console.\* replaced with Effect.logError. Oxlint no-new warning fixed in @pulse/api. AuthRateLimitedEndpoint type added to @shared/observability.

## 0.2.1

### Patch Changes

- 1cc3aa5: Migrate dev-mode `console.log` of registration OTP, login OTP, and magic-link
  URL in `osn/core/src/services/auth.ts` to `Effect.logDebug` (S-H21). The values
  stay interpolated into the message string so the redacting logger doesn't scrub
  them — the whole point of these dev branches is to expose the code/URL to the
  developer.

  `createAuthRoutes` and `createGraphRoutes` now accept an optional third
  `loggerLayer: Layer.Layer<never>` parameter (defaulting to `Layer.empty`) which
  is provided to the per-request Effect runtime alongside `dbLayer`. Without this
  wiring `Effect.logDebug` calls inside auth services would be silently dropped
  by Effect's default `Info` minimum log level, breaking local dev UX after the
  migration. `osn/app/src/index.ts` now threads its `observabilityLayer` through
  to both route factories (S-L1). The parameter is optional and backwards
  compatible for any downstream caller.

  Trim the redaction deny-list in `@shared/observability` to only the keys that
  correspond to real object properties in the codebase today: `authorization`,
  the OAuth token fields (`accessToken`/`refreshToken`/`idToken`/`enrollmentToken`

  - snake_case), the WebAuthn `assertion` body, ARC `privateKey`, and the user
    PII fields `email` / `handle` / `displayName`. Removes ~30 speculative entries
    (Signal/E2E keys, password fields, address/SSN/etc.) that were never reached.
    `enrollmentToken` is added because it is a real bearer credential returned by
    `/register/complete` and sent back as `Authorization: Bearer <token>` for
    passkey enrollment (S-M1). Adds a documented criteria block at the top of
    `redact.ts` explaining when to add or remove keys, a lock-step assertion in
    `redact.test.ts` pinning the exact set, a positive assertion for the enrollment
    token, and a behavioural regression anchor (T-S1) that proves previously-
    scrubbed keys now pass through unchanged. Dev-log branch coverage is locked
    with three new `it.effect` tests using a `Logger.replace` capture sink (T-U1).

## 0.2.0

### Minor Changes

- cab97ca: Scaffold `@shared/observability` — OSN's single source of truth for logs,
  metrics, and tracing.

  **New package `@shared/observability`** exports:

  - `initObservability(overrides)` — one-shot bootstrap that loads config
    from env vars (`OSN_SERVICE_NAME`, `OSN_ENV`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
    …) and returns a combined Effect Layer wiring up the logger, OTel tracer,
    and metric exporter.
  - **Logger** — Effect `Logger.jsonLogger` in prod, `Logger.prettyLogger()` in
    dev, both wrapped with a deny-list redaction pass that scrubs ~30 known
    secret-bearing keys (`password`, `email`, `token`, `ciphertext`, `ratchetKey`,
    …) from log annotations and errors before serialization. Add new keys to
    `src/logger/redact.ts`; never remove.
  - **Metrics factory** — typed `createCounter<Attrs>`, `createHistogram<Attrs>`,
    `createUpDownCounter<Attrs>`. The `<Attrs>` generic pins allowed attribute
    keys at declaration so TypeScript rejects unbounded values (userId,
    requestId, …) at compile time. Standard latency buckets
    (`LATENCY_BUCKETS_SECONDS`) and byte buckets (`BYTE_BUCKETS`) exported
    for consistency.
  - **HTTP RED metrics** — `http.server.requests`, `http.server.request.duration`,
    `http.server.active_requests` following OTel semantic conventions. Emitted
    automatically by the Elysia plugin; handlers never call these directly.
  - **Tracing layer** — `@effect/opentelemetry` NodeSdk with OTLP trace +
    metric exporters, parent-based trace-id-ratio sampler (1.0 in dev, 0.1
    in prod by default, overridable via `OSN_TRACE_SAMPLE_RATIO`).
  - **W3C propagation helpers** — `injectTraceContext(headers)` and
    `extractTraceContext(headers)` so outbound fetches participate in the
    same trace.
  - **`instrumentedFetch`** — drop-in replacement for `globalThis.fetch` that
    creates a client span, injects `traceparent`, and records status/errors.
    Use for all S2S HTTP calls.
  - **Elysia plugin** `observabilityPlugin({ serviceName })` — wires up per-
    request spans, request ID propagation (`x-request-id`), OTel HTTP semconv
    attributes, and RED metric emission via `onRequest` / `onAfterHandle` /
    `onError` / `onAfterResponse` hooks.
  - **Health routes** — `/health` (liveness; always 200 if the process is up)
    and `/ready` (readiness; takes an optional `probe` function that runs a
    trivial dep check like `SELECT 1`).

  **Metrics conventions** (see `CLAUDE.md` "Observability" section for the
  full rules):

  - Naming: `{namespace}.{domain}.{subject}.{measurement}` (e.g.
    `pulse.events.created`, `osn.auth.login.attempts`, `arc.token.issued`).
  - Every metric declared exactly once in a co-located `metrics.ts` file
    (`pulse/api/src/metrics.ts`, `osn/crypto/src/arc-metrics.ts`, …) via
    typed helpers — raw OTel meter calls are banned.
  - Default resource attributes (`service.name`, `service.namespace`,
    `service.version`, `service.instance.id`, `deployment.environment`) are
    applied automatically by the SDK init; never set per-metric.
  - Per-metric attribute values must be bounded string-literal unions
    (`"ok" | "error" | "rate_limited"`), never `string`.

  **Wired into `@pulse/api`**:

  - Elysia plugin and health routes active in `src/index.ts`.
  - `src/metrics.ts` defines Pulse domain metrics (`pulse.events.created`,
    `pulse.events.updated`, `pulse.events.deleted`, `pulse.events.listed`,
    `pulse.events.create.duration`, `pulse.events.status_transitions`,
    `pulse.events.validation.failures`) via typed counters.
  - `src/services/events.ts` is instrumented: every service function is
    wrapped in `Effect.withSpan("events.<op>")`, and domain counters fire
    on success/error paths.

  **Wired into `@osn/crypto`**:

  - New `src/arc-metrics.ts` with typed ARC counters (`arc.token.issued`,
    `arc.token.verification`, `arc.token.cache.hits`/`misses`,
    `arc.token.public_key.cache.hits`/`misses`).
  - `createArcToken`, `verifyArcToken`, `getOrCreateArcToken`, and
    `resolvePublicKey` now emit metrics on the happy path and classify
    verification failures into the bounded `ArcVerifyResult` union
    (`ok | expired | bad_signature | unknown_issuer | scope_denied |
audience_mismatch | malformed`).

  **Out of scope for this PR** (deliberately): wiring into `@osn/app` and
  `@osn/core` (tracked as follow-ups), WebSocket instrumentation, dashboards
  and alert rules, migration of stray `console.*` calls in auth routes
  (tracked separately as S-L8).

  30 new tests across redaction, config parsing, trace propagation, health
  routes, and the metrics factory. Full monorepo test suite passes (390+
  tests).
