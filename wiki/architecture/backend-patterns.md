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
packages:
  - "@pulse/api"
  - "@osn/core"
  - "@osn/app"
last-reviewed: 2026-04-12
---

# Backend Code Patterns

OSN's backend follows a layered architecture: **routes** handle HTTP concerns (validation, status codes, serialization), **services** contain business logic as Effect pipelines, and **schemas** validate + transform data at each boundary. See [[schema-layers]] for the full schema separation strategy.

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
- `set.status` is used explicitly for non-200 responses
- Effect pipelines are run via `Effect.runPromise` at the route boundary

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
- Errors are mapped to domain-specific tagged errors (`ValidationError`, `EventNotFound`, etc.)
- Services use `Effect.gen` + generator syntax for sequential Effect composition
- Every service function should be wrapped in `Effect.withSpan("<domain>.<operation>")` for tracing

## Route Factory Pattern

Both `@osn/core` and `@pulse/api` use route factories that accept dependency layers:

```typescript
// osn/core exports factories (library pattern)
export const createAuthRoutes = (config: AuthConfig, dbLayer?: Layer) => { ... }
export const createGraphRoutes = (dbLayer?: Layer) => { ... }

// osn/app composes them into a running server (binary pattern)
const app = new Elysia()
  .use(createAuthRoutes(authConfig))
  .use(createGraphRoutes())
  .listen(4000);
```

Auth routes require an `AuthConfig` parameter (no global default). Graph routes accept an optional `loggerLayer` so the host application can provide its observability layer for Effect pipeline logging.

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

- [CLAUDE.md](../CLAUDE.md) -- "Backend Code Patterns" section
- [pulse/api/src/routes/events.ts](../pulse/api/src/routes/events.ts) -- canonical route example
- [pulse/api/src/services/events.ts](../pulse/api/src/services/events.ts) -- canonical service example
- [osn/core/src/routes/auth.ts](../osn/core/src/routes/auth.ts) -- auth route factory
