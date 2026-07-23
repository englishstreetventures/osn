---
title: Backend Code Patterns
aliases:
  - code patterns
  - route patterns
  - service patterns
tags:
  - architecture
  - patterns
  - elysia
  - effect
status: current
related:
  - "[[schema-layers]]"
  - "[[testing-patterns]]"
  - "[[observability/overview]]"
  - "[[database-environments]]"
packages:
  - "@pulse/api"
  - "@osn/api"
  - "@zap/api"
last-reviewed: 2026-07-23
---

# Backend Code Patterns

OSN's backend uses a layered architecture. **Routes** handle HTTP concerns: validation, status codes, serialisation. **Services** hold business logic as Effect pipelines. **Schemas** validate and transform data at each boundary. See [[schema-layers]] for the full schema separation strategy.

## Route Layer -- Elysia TypeBox for HTTP shapes

Routes use Elysia's built-in TypeBox (`t`) for request/response validation. This validates raw HTTP types and drives Eden client type inference.

```typescript
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
```

Key points:
- Routes accept an optional `dbLayer` parameter for dependency injection (default is `DbLive`)
- TypeBox stays structural -- strings stay strings (no transforms)
- Handlers set `set.status` explicitly for non-200 responses
- Routes run Effect pipelines via `Effect.runPromise` at the boundary

### Build the layer graph ONCE — never re-provide expensive layers per request

`Effect.provide(layer)` **rebuilds** the layer every time the effect runs. Layer memoisation is per-build, so calling `Effect.runPromise(eff.pipe(Effect.provide(someLayer)))` inside a request handler reconstructs `someLayer`'s entire resource graph on every request. For the observability layer this is severe: `makeObservabilityLayer` wraps `NodeSdk.layer` (a `BatchSpanProcessor`, OTLP trace + metric exporters, and a `PeriodicExportingMetricReader`), so each request **starts and tears down the whole OpenTelemetry SDK** — and the teardown blocks on an exporter flush (≈3s locally when no collector is listening). `DbLive` similarly opens a fresh, never-closed `bun:sqlite` connection per request.

In `@osn/api` this surfaced as multi-second stalls on the debounced username-availability check. The fix: build the graph once into a long-lived `ManagedRuntime` at boot and run every request against it.

```typescript
// index.ts — build once
const appRuntime = ManagedRuntime.make(Layer.merge(dbAndEmailLayer, observabilityLayer));

// route factory — reuse per request (see osn/api/src/lib/route-runtime.ts → makeAppRunner)
const { run } = makeAppRunner(appRuntime, Layer.merge(dbLayer, loggerLayer));
//   run(eff)  ⇒  appRuntime.runPromise(eff)   — no per-request layer rebuild

// handler
const result = await run(createEvent(body));
```

Route factories keep accepting `dbLayer` / `loggerLayer` for tests (where `makeAppRunner` wraps the test layer in a one-time `ManagedRuntime`); production threads the single shared `appRuntime` through every factory so there is exactly one OTel SDK + one DB connection process-wide. Cheap, stateless effects that need no services (e.g. JWT verification) can still use a bare `Effect.runPromise` — the rule is: do not re-provide `DbLive` or the observability layer inside a hot request path.

As of 2026-07-03, `pulse/api` and `zap/api` route factories comply too: each factory builds `const runtime = ManagedRuntime.make(dbLayer)` once at construction time and handlers call `runtime.runPromise(eff)` — the per-request `Effect.provide(dbLayer)` pattern was removed monorepo-wide. (They build one runtime per route group rather than threading a single shared `AppRuntime` like `osn/api`; consolidating to one runtime per process is a follow-up if those services grow an observability layer.)

## Service Layer -- Effect Schema for domain validation + transforms

Services use Effect Schema to validate AND transform data into domain types. This is where strings become `Date` objects, enums are narrowed, and invariants are enforced.

```typescript
// Schema.DateFromString allows Invalid Date — use a validated transform instead
const ValidDateString = Schema.String.pipe(
  Schema.filter((s) => !isNaN(new Date(s).getTime()))
);

const DateFromISOString = Schema.transform(ValidDateString, Schema.DateFromSelf, {
  strict: true,
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
});

const InsertEventSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  startTime: DateFromISOString,                 // string → Date (validated)
  status: Schema.optional(
    Schema.Literal("upcoming", "ongoing", "finished", "cancelled")
  ),
});

export const createEvent = (data: unknown) =>
  Effect.gen(function* () {
    const validated = yield* Schema.decodeUnknown(InsertEventSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );
    // validated.startTime is now a Date
  });
```

Key points:
- `Schema.decodeUnknown` returns `Effect<A, ParseError>` -- integrates naturally with Effect pipelines
- Services map errors to domain-specific tagged errors (`ValidationError`, `EventNotFound`, etc.)
- Services use `Effect.gen` + generator syntax for sequential Effect composition
- Wrap every service function in `Effect.withSpan("<domain>.<operation>")` for tracing

### Large services: split into a module directory

When a service outgrows a single file, split it into a directory of domain modules composed by an `index.ts` factory — the canonical example is `osn/api/src/services/auth/`:

- `index.ts` — `createAuthService(config)` builds a shared context once, wires the domain module factories in dependency order, and returns the flat method surface. It also re-exports every previously-public name, so consumers keep importing from `services/auth` unchanged.
- `context.ts` — `createAuthContext(config)`: config defaults resolved once + injected stores + cross-cutting helpers (e.g. `hashIp`). Every module factory takes this as its first argument.
- One file per domain (`tokens.ts`, `passkeys.ts`, `recovery.ts`, `step-up.ts`, …). A module that needs another module's methods takes it as a factory parameter (`createTokensModule(ctx, profiles)`) and destructures what it uses — the layering stays acyclic and explicit.
- Stateless building blocks live beside them: `errors.ts`, `types.ts` (public DTOs), `helpers.ts` (pure functions), `constants.ts` (tunables + rationale), `stores.ts` (store contracts + in-memory defaults), `config.ts`.

Two rules: module factories return only the methods other code calls (internals stay closed over); the composition root lists the public surface explicitly rather than spreading modules, so the service's API is pinned in one place.

The same shape applies at the route layer — `osn/api/src/routes/auth/` splits a large route factory into one Elysia group per domain (`registration.ts`, `step-up.ts`, `sessions.ts`, …), each a `createXxxRoutes(ctx)` factory over a shared `AuthRouteContext` (`context.ts`: service instance, app runner, rate-limit / Turnstile gates, IP + cookie plumbing). `index.ts` builds the context once and mounts the groups with `.use(...)`, keeping the original `createAuthRoutes` signature and re-exports intact.

## Route Factory Pattern

Every backend uses route factories that accept dependency layers, so tests can swap in `createTestLayer()` without touching production wiring:

```typescript
// osn/api/src/routes/auth/index.ts — factory definition
export const createAuthRoutes = (config: AuthConfig, dbLayer?: Layer) => { ... }
export const createGraphRoutes = (dbLayer?: Layer) => { ... }

// osn/api/src/app.ts — pure createApp factory (no process.env reads)
export const createApp = (deps: AppDeps) =>
  new Elysia()
    .use(createAuthRoutes(deps.authConfig))
    .use(createGraphRoutes(deps.loggerLayer));

// osn/api/src/local.ts — env-driven Bun entry
const deps = buildAppDeps();          // loads JWT keys, pepper, Redis stores, builds the shared appRuntime ONCE
startBunServer(createApp(deps));      // app.listen + ephemeral-key warning + ARC rotation + erasure sweeper
```

Auth routes require an `AuthConfig` parameter (no global default). Graph routes accept an optional `loggerLayer` so the host application can provide its observability layer for Effect pipeline logging.

**App factory / entry split (osn-api, PR #131).** osn-api now uses the same
factory/entry split as **Zap** and **Pulse**: `src/app.ts` exports a pure
`createApp(deps)` that composes the routes and never reads `process.env`, while
`src/local.ts` owns all env-driven wiring (`buildAppDeps()` loads the JWT key
pair, validates the session-IP pepper, initialises Redis-backed stores + rate
limiters, selects the email transport, and builds the Effect layer graph once
into the shared `appRuntime`; `startBunServer()` keeps `app.listen`, the
ephemeral-key warning, outbound ARC key rotation, and the account-erasure
sweeper). This was Phase 1 (P1) of the Cloudflare Workers migration; the later
phases have since shipped too — osn-api runs a Workers `fetch` entry
(`src/index.ts` + `main` in `wrangler.toml`) on `id.cireweddings.com` against
Upstash-REST Redis. Zap/Pulse ship the same `createApp` + `local.ts` + Workers
`index.ts` shape per [[database-environments]].

The two entries differ in what they wire: `local.ts` starts the OTel SDK through
`initObservability()`, while `index.ts` builds the redacting logger layer alone
and sets `includeObservabilityPlugin: false` (the per-request plugin calls
`process.hrtime.bigint()`, absent on workerd). See [[logging]].

## Error Handling Pattern

Services use tagged errors (`Data.TaggedError` from Effect) so callers can match on `_tag`:

```typescript
// Definition
class EventNotFound extends Data.TaggedError("EventNotFound")<{ eventId: string }> {}
class ValidationError extends Data.TaggedError("ValidationError")<{ cause: unknown }> {}

// In service
export const getEvent = (id: string) =>
  Effect.gen(function* () {
    const event = yield* findEventById(id);
    if (!event) yield* Effect.fail(new EventNotFound({ eventId: id }));
    return event;
  }).pipe(Effect.withSpan("events.get"));

// In route
const result = await Effect.runPromise(
  getEvent(params.id).pipe(
    Effect.catchTag("EventNotFound", () => {
      set.status = 404;
      return Effect.succeed({ error: "not_found" });
    }),
    Effect.provide(dbLayer),
  )
);
```

## Metric Instrumentation Pattern

Every service function should emit metrics via typed counters/histograms. See [[observability/metrics]] for the full metrics system.

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

## Source Files

- [CLAUDE.md](../../CLAUDE.md) — "Backend Code Patterns" section
- [pulse/api/src/routes/events.ts](../../pulse/api/src/routes/events.ts) — canonical route example
- [pulse/api/src/services/events.ts](../../pulse/api/src/services/events.ts) — canonical service example
- [osn/api/src/routes/auth/index.ts](../../osn/api/src/routes/auth/index.ts) — auth route factory (route-group composition root)
- [osn/api/src/services/auth/index.ts](../../osn/api/src/services/auth/index.ts) — module-directory service composition root
