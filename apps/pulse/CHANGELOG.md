# @osn/pulse

## 0.2.10

### Patch Changes

- Updated dependencies [3a0196b]
  - @osn/core@0.3.2

## 0.2.9

### Patch Changes

- @osn/core@0.3.1
- @osn/api@0.4.2

## 0.2.8

### Patch Changes

- Updated dependencies [623ad9f]
  - @osn/core@0.3.0

## 0.2.7

### Patch Changes

- 9caa8c7: Add user handle system

  Each OSN user now has a unique `@handle` (immutable, required at registration) alongside a mutable `displayName`. Key changes:

  - **`@osn/db`**: New `handle` column (`NOT NULL UNIQUE`) on the `users` table with migration `0002_add_user_handle.sql`
  - **`@osn/core`**: Registration is now an explicit step (`POST /register { email, handle, displayName? }`); OTP, magic link, and passkey login all accept an `identifier` that can be either an email or a handle; JWT access tokens now include `handle` and `displayName` claims; new `GET /handle/:handle` endpoint for availability checks; `verifyAccessToken` returns `handle` and `displayName`
  - **`@osn/api`**: `createdByName` on events now uses `displayName` → `@handle` → email local-part (in that priority order)
  - **`@osn/pulse`**: `getDisplayNameFromToken` updated to prefer `displayName` then `@handle`; new `getHandleFromToken` utility

- Updated dependencies [9caa8c7]
  - @osn/core@0.2.0
  - @osn/api@0.4.1

## 0.2.6

### Patch Changes

- Updated dependencies [05a9022]
  - @osn/api@0.4.0
  - @osn/core@0.1.1

## 0.2.5

### Patch Changes

- 89b104c: Add latitude/longitude columns to the events schema, store geocoordinates from Photon autocomplete in the create form, and display an "Open in Maps" link on each EventCard using coordinates when available or text-based search as a fallback.
- Updated dependencies [89b104c]
  - @osn/api@0.3.0

## 0.2.4

### Patch Changes

- @osn/api@0.2.3

## 0.2.3

### Patch Changes

- b8a40bc: Add toast notifications for event create, delete, and error states using solid-toast

## 0.2.2

### Patch Changes

- a9329a6: Refactor App.tsx into focused modules: lib/types.ts, lib/auth.ts, components/CallbackHandler.tsx, components/CreateEventForm.tsx, components/EventCard.tsx, components/EventList.tsx

## 0.2.1

### Patch Changes

- 75f801b: Implement OSN Core auth system.

  - `@osn/core`: new auth implementation — passkey (WebAuthn via @simplewebauthn/server), OTP, and magic-link sign-in flows; PKCE authorization endpoint; JWT-based token issuance and refresh; OIDC discovery; Elysia route factory; sign-in HTML page with three-tab UI; 25 service tests + route integration tests
  - `@osn/osn`: new Bun/Elysia auth server entrypoint at port 4000; imports `@osn/core` routes; dev JWT secret fallback
  - `@osn/db`: schema updated with `users` and `passkeys` tables; migration generated
  - `@osn/client`: `getSession()` now checks `expiresAt` and clears expired sessions; `handleCallback` exposed from `AuthProvider` context
  - `@osn/pulse`: `CallbackHandler` handles OAuth redirect on page load; fix events resource to load without waiting for auth; fix location autocomplete re-triggering search after selection
  - `@osn/api`: HTTP-level route tests for category filter and invalid startTime/endTime

- Updated dependencies [75f801b]
  - @osn/core@0.1.0
  - @osn/client@0.0.3
  - @osn/api@0.2.2

## 0.2.0

### Minor Changes

- 7d3f9dd: Add events CRUD UI to Pulse: create-event form with validation, location autocomplete via Photon (Komoot), delete support, Eden typed API client replacing raw fetch, shadcn design tokens, and fix for newly created events not appearing in the list due to datetime truncation.

### Patch Changes

- Updated dependencies [7d3f9dd]
  - @osn/api@0.2.1

## 0.1.1

### Patch Changes

- 880e762: Add @osn/client package with OAuth 2.0 + PKCE auth core, SolidJS and React adapters. Wire AuthProvider into Pulse.
- Updated dependencies [880e762]
- Updated dependencies [880e762]
  - @osn/client@0.0.2
  - @osn/api@0.2.0

## 0.1.0

### Minor Changes

- 51abbcc: Add events CRUD UI to Pulse: create-event form with validation, location autocomplete via Photon (Komoot), delete support, Eden typed API client replacing raw fetch, shadcn design tokens, and fix for newly created events not appearing in the list due to datetime truncation.

### Patch Changes

- Updated dependencies [51abbcc]
  - @osn/api@0.1.1

## 0.0.2

### Patch Changes

- ade0a12: Remnant @solidjs/start bugs
