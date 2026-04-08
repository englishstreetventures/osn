# CLAUDE.md

AI coding assistant reference. For full spec see README.md. For progress/decisions see TODO.md.

## Quick Context

OSN: Modular social platform. Users own identity + social graph. Apps opt-in/out independently.

Phase 1 apps: OSN Core (auth), Pulse (events), Messaging (TBD name), Landing (marketing).

## File Responsibilities

- `README.md` → Project spec, vision, features, tech stack, contributing (human-readable)
- `CLAUDE.md` → Code patterns, commands, current state, conventions (AI reference)
- `TODO.md` → Progress tracking, deferred decisions, task checklists

## TODO.md Structure + Maintenance

`TODO.md` is organised into these top-level sections — add new items to the right place:

| Section | What goes here |
|---------|---------------|
| **Up Next** | ≤8 highest-priority items across all areas. Keep it short — if everything is a priority, nothing is. Prune when items are done or promoted to a feature section. |
| **App sections** (Pulse, OSN Core, Messaging, Landing) | Feature work specific to that app. Check items off when done; don't delete them. |
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

The monorepo is organised by **domain**. Three top-level directories, three
workspace-name prefixes, one prefix per directory — no mixing:

| Dir | Prefix | What lives here |
|-----|--------|-----------------|
| `osn/`    | `@osn/*`    | OSN identity stack (auth, graph, SDK, crypto, landing) |
| `pulse/`  | `@pulse/*`  | Pulse events stack (app, events API, DB) |
| `shared/` | `@shared/*` | Cross-cutting utilities consumable by either stack |

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
- Messaging backend is shared service (direct/indirect modes)
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
