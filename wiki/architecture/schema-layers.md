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
  - "[[d1-limits]]"
  - "[[backend-patterns]]"
  - "[[testing-patterns]]"
packages:
  - "@pulse/api"
  - "@osn/api"
  - "@osn/client"
last-reviewed: 2026-09-06
---

# Schema Layers

OSN uses two schema tools at two distinct layers. Never mix them -- each has a specific job and a specific place in the request lifecycle.

## The Two Layers

### Elysia TypeBox (`t` from `elysia`) -- HTTP boundary only

- Validates raw request types (query params, route bodies, path params)
- Drives Eden client type inference -- must stay in routes
- Strings stay strings (no transforms); keep it structural
- Example: `t.String({ format: "date-time" })` validates the wire format

### Effect Schema (`Schema` from `effect`) -- service/domain layer only

- Validates AND transforms (e.g. ISO string to `Date`, enum narrowing)
- Returns `Effect<A, ParseError>` -- integrates naturally with Effect pipelines
- Runs via `Schema.decodeUnknown(MySchema)(data)` inside service functions
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
const InsertEventSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  // Rejects a string that parses to an Invalid Date. Effect v3's did not, which
  // is why three services here used to carry a hand-rolled validate-then-
  // transform pair in its place.
  startTime: Schema.DateFromString,  // string → Date (validated)
  status: Schema.optional(
    Schema.Literals(["upcoming", "ongoing", "finished", "cancelled"])
  ),
});

export const createEvent = (data: unknown) =>
  Effect.gen(function* () {
    const validated = yield* Schema.decodeUnknownEffect(InsertEventSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );
    // validated.startTime is now a Date
  });
```

## The Effect Schema surface, as of v4

The whole repo moved to Effect 4 on 2026-09-06. These are the forms to write;
the v3 spellings are gone and will not type-check.

| Purpose | Write this |
| --- | --- |
| Decode unknown input | `Schema.decodeUnknownEffect(S)(input)` (`Result` variant: `decodeUnknownResult`, `Exit`: `decodeUnknownExit`, sync: `decodeUnknownSync`) |
| Catch a decode failure | `Effect.catchTag("SchemaError", …)` — the tag is `SchemaError`, not v3's `ParseError`; the type is `Schema.SchemaError` |
| Bound a string or collection | `S.check(Schema.isMinLength(a), Schema.isMaxLength(b))` — `isMinLength`/`isMaxLength` cover strings *and* arrays |
| Bound a number | `S.check(Schema.isBetween({ minimum, maximum }))`, `isInt()`, `isGreaterThan…` |
| Match a pattern | `S.check(Schema.isPattern(/…/))` |
| An arbitrary predicate | `S.check(Schema.makeFilter(pred))` |
| Several literals | `Schema.Literals(["a", "b"])` — `Schema.Literal` takes exactly one |
| A union | `Schema.Union([A, B])` — one array, not variadic |
| A key with a decoding default | `S.pipe(Schema.withDecodingDefaultType(Effect.succeed(v)))` |
| Trim, then bound | `Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(n))` — the checks see the trimmed value |
| A transform | `S.pipe(Schema.decodeTo(target, SchemaTransformation.transform({ decode, encode })))` |
| Parse a JSON string | `Schema.fromJsonString(S)`, or `Schema.UnknownFromJsonString` with no inner schema |

Four things about that table are worth knowing before you rely on them:

- **A filter carries its own message.** `Schema.makeFilter` treats `undefined`
  or `true` as success and **a returned string as the failure message** — which
  is how a v3 `Schema.filter(pred, { message: () => "…" })` migrates. On a
  check's optional annotations, `message` is a plain string, not a thunk.
- **`.check(a, b, …)` short-circuits** on the first failure, so ordering is a
  guarantee you can rely on. `cire/api`'s `TimeZone` depends on it: its length
  cap runs before the ICU time-zone lookup precisely so an oversized blob never
  reaches the lookup.
- **`Schema.Union` and `Schema.Literal` fail quietly if you pass the v3 shape.**
  Extra members are dropped rather than rejected at the call, and the mistake
  surfaces later as `{}` where a real type was expected, or as a union that has
  simply stopped rejecting one of its cases.
- **Decode error messages changed and no longer echo the input.** v4 renders a
  reason line plus an `at ["path"]` line, where v3 wrote
  `Expected number, actual "not_a_number"`. A test asserting on the old text
  passes vacuously if it only checks that *something* threw — pin the reason
  and the path.

## Rules

- **Never use Effect Schema in route definitions.** TypeBox is the HTTP boundary schema.
- **Never use TypeBox in service functions.** Effect Schema is the domain boundary schema.
- **Never transform in the route layer.** Strings stay strings at the HTTP boundary.
- **Always map `SchemaError` to a domain error.** Callers should catch `ValidationError`, not `SchemaError`.
- **Client SDK packages use Effect Schema.** `@osn/client` is not an Elysia route layer, so it has no TypeBox. Any runtime validation of external data (e.g. token responses from OAuth endpoints) uses Effect Schema, consistent with the service-layer pattern. Use `Schema.decodeUnknownSync` when the call site is synchronous or non-Effect.
- **No third-party validation libraries.** Do not introduce Valibot, zod, or similar libraries. TypeBox handles validation at the HTTP boundary; Effect Schema handles it everywhere else.

## Source Files

- [CLAUDE.md](../../CLAUDE.md) — "Schema Layers" section
- [pulse/api/src/routes/events.ts](../../pulse/api/src/routes/events.ts) — TypeBox usage
- [pulse/api/src/services/events.ts](../../pulse/api/src/services/events.ts) — Effect Schema usage
- [osn/client/src/tokens.ts](../../osn/client/src/tokens.ts) — Effect Schema in client SDK (decodeUnknownSync)
