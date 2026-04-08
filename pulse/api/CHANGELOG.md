# @osn/api

## 0.4.3

### Patch Changes

- d8e3559: Reject event creation when `startTime` is not strictly in the future. The events service now returns a `ValidationError` (HTTP 422) if the supplied `startTime` is at or before the current moment, preventing past-dated events from being created.

## 0.4.2

### Patch Changes

- Updated dependencies [45248b2]
  - @pulse/db@0.5.0

## 0.4.1

### Patch Changes

- 9caa8c7: Add user handle system

  Each OSN user now has a unique `@handle` (immutable, required at registration) alongside a mutable `displayName`. Key changes:

  - **`@osn/db`**: New `handle` column (`NOT NULL UNIQUE`) on the `users` table with migration `0002_add_user_handle.sql`
  - **`@osn/core`**: Registration is now an explicit step (`POST /register { email, handle, displayName? }`); OTP, magic link, and passkey login all accept an `identifier` that can be either an email or a handle; JWT access tokens now include `handle` and `displayName` claims; new `GET /handle/:handle` endpoint for availability checks; `verifyAccessToken` returns `handle` and `displayName`
  - **`@osn/api`**: `createdByName` on events now uses `displayName` → `@handle` → email local-part (in that priority order)
  - **`@osn/pulse`**: `getDisplayNameFromToken` updated to prefer `displayName` then `@handle`; new `getHandleFromToken` utility

## 0.4.0

### Minor Changes

- 05a9022: Add event ownership enforcement: `createdByUserId NOT NULL` on events, auth required for POST/PATCH/DELETE, ownership check (403) on mutating operations, `createdByName` derived server-side from JWT email claim, index on `created_by_user_id`, `updateEvent` eliminates extra DB round-trip.

### Patch Changes

- Updated dependencies [05a9022]
  - @pulse/db@0.4.0

## 0.3.0

### Minor Changes

- 89b104c: Add latitude/longitude columns to the events schema, store geocoordinates from Photon autocomplete in the create form, and display an "Open in Maps" link on each EventCard using coordinates when available or text-based search as a fallback.

### Patch Changes

- Updated dependencies [89b104c]
  - @pulse/db@0.3.0

## 0.2.3

### Patch Changes

- Updated dependencies [caafe67]
  - @pulse/db@0.2.1

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

- Updated dependencies [880e762]
- Updated dependencies [880e762]
  - @pulse/db@0.2.0

## 0.1.1

### Patch Changes

- 51abbcc: Add events CRUD UI to Pulse: create-event form with validation, location autocomplete via Photon (Komoot), delete support, Eden typed API client replacing raw fetch, shadcn design tokens, and fix for newly created events not appearing in the list due to datetime truncation.
- Updated dependencies [51abbcc]
  - @osn/db@0.1.1

## 0.1.0

### Minor Changes

- efcf464: Apply auto transition for event lifecycle
- 96c406d: Added testing framework

### Patch Changes

- Updated dependencies [96c406d]
  - @osn/db@0.1.0
