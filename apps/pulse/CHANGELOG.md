# @osn/pulse

## 0.3.0

### Minor Changes

- cf57969: Add an email-verified registration flow end-to-end with passkey enrolment, plus a security redesign that addresses the critical findings raised during review.

  **`@osn/core` — new endpoints + service work**

  - `POST /register/begin` — validates email + handle, normalises email to lowercase, generates an unbiased 6-digit OTP via rejection sampling, stores a pending registration in a bounded (10k cap), swept-on-insert in-memory map, and emails the OTP. Always returns `{ sent: true }` regardless of conflict to remove the user-enumeration oracle (S-M1/S-M26). Refuses to overwrite a non-expired pending entry to prevent griefing of in-progress registrations (S-M2/S-M23).
  - `POST /register/complete` — verifies the OTP using a constant-time comparison (S-M4/S-M25), enforces a 5-attempts-then-wipe brute-force cap (S-H1 partial), inserts the user using the DB unique constraint as the source of truth (no TOCTOU; the pending entry is only deleted after a successful insert — S-H4/S-H10), and returns access + refresh tokens **directly** alongside a single-use enrollment token. The registration code path no longer touches `/token` so it does not depend on the pre-existing PKCE bypass at `/token` (tracked separately as S-H4/S-H9).
  - New `issueEnrollmentToken` / `verifyEnrollmentToken` service helpers — short-lived (5 min) JWTs of `type: "passkey-enroll"`, single-use via an in-memory consumed-jti set with opportunistic sweep.
  - `POST /passkey/register/{begin,complete}` now accept an `Authorization: Bearer <token>` header where the token is either an enrollment token or a normal access token; the token's `sub` is compared against the body `userId` and a mismatch returns `401` (S-C1/S-H5 partial). The legacy unauth'd path is preserved with a deprecation warning so the hosted `/authorize` HTML page still works; removing it is tracked in the security backlog.
  - New `publicError()` route helper maps Effect-tagged errors to opaque public payloads (`invalid_request`, `internal_error`) and logs the underlying cause server-side (S-H5/S-M6/S-M4).
  - Dev-only `console.log` of OTP codes is now gated on `NODE_ENV !== "production"` (S-M3/S-M22).

  **`@osn/client` — RegistrationClient redesign**

  - `createRegistrationClient` exposes `checkHandle`, `beginRegistration`, `completeRegistration`, `passkeyRegisterBegin`, `passkeyRegisterComplete`. **`exchangeAuthCode` is gone** — `completeRegistration` now returns a parsed `Session` ready for `AuthProvider.adoptSession` plus an `enrollmentToken`. Both passkey calls accept the enrollment token and send it as `Authorization: Bearer <token>`.
  - New `OsnAuth.setSession` + Solid `AuthProvider.adoptSession` for installing a session obtained out-of-band by the registration flow.

  **`@osn/pulse` — Register component**

  - Multi-step UI: details (email + handle + display name with debounced live availability check) → 6-digit OTP → optional passkey enrolment → done.
  - `adoptSession` is called immediately after OTP verification, **before** any passkey work — the user is signed in regardless of whether they go on to set up a passkey, so a flaky WebAuthn ceremony or an unsupported environment can no longer leave them stranded.
  - WebAuthn feature-detection via `browserSupportsWebAuthn()`; the passkey step is skipped entirely (and the UI jumps straight to "done") on environments without WebAuthn — currently Tauri's iOS webview, until we ship the native plugin.
  - Imperative skip path replacing the previous `createEffect` (P-I10), inlined `detailsValid` accessor (P-I11), module-scope `RegistrationClient` (P-I12).
  - Wired into `EventList` as a "Create account" button next to "Sign in with OSN".

  **Test coverage** (277 tests total, +58 from the previous PR baseline)

  - Service-level: happy path, lowercase normalisation, no-row-before-verify, ValidationError on bad inputs, enumeration-resistant begin, refuse-to-overwrite pending entry, wrong OTP, no-pending error, single-use replay, brute-force attempt cap, TOCTOU loss against legacy `/register`, enrollment token issue/verify/consume, replay rejection, type-claim discrimination.
  - Route-level: complete shape assertions, enumeration-resistant 200 responses, complete-without-begin, replay attack, reserved handle availability, Authorization gating with valid enrollment token / valid access token / mismatched sub / invalid bearer / legacy unauth'd path, enrollment-token consumption on `/complete`.
  - Client unit tests: URL composition, body shapes, Authorization header propagation, RegistrationError on non-OK, trailing-slash issuerUrl normalisation.
  - Solid `AuthProvider.adoptSession` round-trip test (real provider, harness component, asserts both `useAuth().session()` reactivity and `localStorage` persistence).
  - Pulse Register component test: input sanitisation, debounced availability with stale-result guard, `detailsValid` gating during `checking`, OTP digit-only clamp, immediate `adoptSession` after OTP, happy passkey enrolment with enrollment token propagation, "Skip for now" → done, WebAuthn-unsupported jump-to-done, Cancel.

### Patch Changes

- Updated dependencies [cf57969]
  - @osn/core@0.4.0
  - @osn/client@0.1.0

## 0.2.11

### Patch Changes

- Updated dependencies [d8e3559]
  - @osn/api@0.4.3

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
