---
title: Schema Layers
aliases:
  - schema separation
  - TypeBox vs Effect Schema
  - validation layers
tags:
  - architecture
  - validation
  - elysia
  - effect
status: current
related:
  - "[[backend-patterns]]"
  - "[[testing-patterns]]"
packages:
  - "@pulse/api"
  - "@osn/core"
last-reviewed: 2026-04-12
---

# Schema Layers

OSN uses two schema tools at two distinct layers. They must never be mixed -- each has a specific job and a specific location in the request lifecycle.

## The Two Layers

### Elysia TypeBox (`t` from `elysia`) -- HTTP boundary only

- Validates raw request types (query params, route bodies, path params)
- Drives Eden client type inference -- must stay in routes
- Strings stay strings (no transforms); keep it structural
- Example: `t.String({ format: "date-time" })` validates the wire format

### Effect Schema (`Schema` from `effect`) -- service/domain layer only

- Validates AND transforms (e.g. ISO string to `Date`, enum narrowing)
- Returns `Effect<A, ParseError>` -- integrates naturally with Effect pipelines
- Used via `Schema.decodeUnknown(MySchema)(data)` inside service functions
- Example: `Schema.DateFromString` decodes `"2030-06-01T..."` to a `Date` object

## Data Flow Diagram

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

## Why Two Layers?

The separation exists for practical reasons:

1. **Eden type inference requires TypeBox at the route level.** Moving validation into the service layer would break the Eden treaty client's ability to infer request/response types. TypeBox schemas in route definitions are the contract between client and server.

2. **Effect Schema integrates with Effect pipelines.** Decoding returns an `Effect`, which can be composed with other Effect operations, mapped to domain errors, and traced via `Effect.withSpan`. TypeBox has no Effect integration.

3. **Transforms belong in the service layer.** The route layer deals in wire types (strings, numbers). The service layer deals in domain types (`Date`, `NonEmptyString`, `Literal` unions). The transform boundary is explicit and testable.

## Examples

### Route layer (TypeBox)

```typescript
// In routes/events.ts
.post("/", async ({ body, set }) => {
  const result = await Effect.runPromise(
    createEvent(body).pipe(Effect.provide(dbLayer))
  );
  set.status = 201;
  return { event: result };
}, {
  body: t.Object({
    title: t.String(),
    startTime: t.String({ format: "date-time" }),  // string validation only
  }),
});
```

### Service layer (Effect Schema)

```typescript
// In services/events.ts
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
  startTime: DateFromISOString,  // string → Date (validated)
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

## Rules

- **Never use Effect Schema in route definitions.** TypeBox is the HTTP boundary schema.
- **Never use TypeBox in service functions.** Effect Schema is the domain boundary schema.
- **Never transform in the route layer.** Strings stay strings at the HTTP boundary.
- **Always map `ParseError` to a domain error.** Callers should catch `ValidationError`, not `ParseError`.

## Source Files

- [CLAUDE.md](../CLAUDE.md) -- "Schema Layers" section
- [pulse/api/src/routes/events.ts](../pulse/api/src/routes/events.ts) -- TypeBox usage
- [pulse/api/src/services/events.ts](../pulse/api/src/services/events.ts) -- Effect Schema usage
