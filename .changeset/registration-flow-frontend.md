---
"@osn/core": minor
"@osn/client": minor
"@osn/pulse": minor
---

Add an email-verified registration flow end-to-end with passkey enrolment, plus a security redesign that addresses the critical findings raised during review.

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
