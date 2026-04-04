# @osn/db

## 0.2.3

### Patch Changes

- 05a9022: Add event ownership enforcement: `createdByUserId NOT NULL` on events, auth required for POST/PATCH/DELETE, ownership check (403) on mutating operations, `createdByName` derived server-side from JWT email claim, index on `created_by_user_id`, `updateEvent` eliminates extra DB round-trip.

## 0.2.2

### Patch Changes

- 75f801b: Implement OSN Core auth system.

  - `@osn/core`: new auth implementation — passkey (WebAuthn via @simplewebauthn/server), OTP, and magic-link sign-in flows; PKCE authorization endpoint; JWT-based token issuance and refresh; OIDC discovery; Elysia route factory; sign-in HTML page with three-tab UI; 25 service tests + route integration tests
  - `@osn/osn`: new Bun/Elysia auth server entrypoint at port 4000; imports `@osn/core` routes; dev JWT secret fallback
  - `@osn/db`: schema updated with `users` and `passkeys` tables; migration generated
  - `@osn/client`: `getSession()` now checks `expiresAt` and clears expired sessions; `handleCallback` exposed from `AuthProvider` context
  - `@osn/pulse`: `CallbackHandler` handles OAuth redirect on page load; fix events resource to load without waiting for auth; fix location autocomplete re-triggering search after selection
  - `@osn/api`: HTTP-level route tests for category filter and invalid startTime/endTime

## 0.2.1

### Patch Changes

- 7d3f9dd: Add events CRUD UI to Pulse: create-event form with validation, location autocomplete via Photon (Komoot), delete support, Eden typed API client replacing raw fetch, shadcn design tokens, and fix for newly created events not appearing in the list due to datetime truncation.

## 0.2.0

### Minor Changes

- 880e762: Split `packages/db` into `packages/osn-db` (`@osn/db`) and `packages/pulse-db` (`@pulse/db`). Each app now owns its database layer: OSN Core owns user/session/passkey schema, Pulse owns events schema. Replace Valibot with Effect Schema in the events service — `effect/Schema` is used for service-layer domain validation and transforms (e.g. ISO string → Date), while Elysia TypeBox remains at the HTTP boundary for route validation and Eden type inference.

### Patch Changes

- 880e762: Add `@utils/db` package (`packages/utils-db`) with shared database utilities — `createDrizzleClient` and `makeDbLive` — eliminating boilerplate duplication between `@osn/db` and `@pulse/db`. Both db packages now delegate client creation and Layer setup to `@utils/db`. Also removes the unused singleton `client.ts` export from both db packages.
- Updated dependencies [880e762]
  - @utils/db@0.2.0
