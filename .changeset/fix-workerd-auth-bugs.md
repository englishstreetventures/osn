---
"@osn/api": patch
---

Fix two auth-path bugs that only surfaced on the deployed Cloudflare Worker
(workerd).

- **Bug A — `/graph/internal/register-service` + `/service-keys/:keyId` 500
  ("crypto.timingSafeEqual is not a function").** The `INTERNAL_SERVICE_SECRET`
  bearer check compared the header with the GLOBAL `crypto` (Web Crypto), which
  has no `timingSafeEqual` on workerd, so the compare threw and the request
  500'd — blocking the cire→osn ARC key registration (the "add hosts by handle"
  feature). The compare now uses a new workerd-safe `timingSafeEqualString`
  helper (`osn/api/src/lib/timing-safe.ts`) backed by `node:crypto`
  (`nodejs_compat`), keeping the constant-time property and the length-mismatch
  guard. `osn/api/src/services/auth.ts` now reuses the same shared helper
  instead of its private copy.

- **Bug B — organiser "Security → add a passkey" returned 401 "unauthorized".**
  `/passkey/register/{begin,complete}` resolved the enrol principal by requiring
  the client to echo a `body.profileId` exactly equal to the access token's
  `sub`. When the client's notion of the active profile drifted from the token's
  `sub` (e.g. after a silent token refresh re-issues the access token for the
  account's default profile), this produced a spurious 401. The principal is now
  resolved from the access token's OWN verified `sub` (the same pattern
  `/step-up/passkey/*` already uses), so enrolment always binds to the caller's
  own account; the client-supplied `profileId` is no longer a trust input and a
  foreign `profileId` can never redirect enrolment onto another account.

- **Bug C — organiser login looped back to login once Turnstile was enabled.**
  `/login/passkey/begin` is hit by TWO frontend paths: the interactive
  identifier-bound form (renders the Turnstile widget, carries a token) and the
  silent conditional-UI / passkey-autofill ceremony (NO identifier, NO token, by
  design). With Turnstile configured the gate fail-closed on EVERY caller, so the
  autofill path — the common way passkey users sign in — got `turnstile_failed`
  and bounced back to login. The gate now fires only when a non-empty
  `identifier` is present (the interactive form); the no-identifier conditional-UI
  ceremony is exempt — it discloses nothing account-specific, still requires a
  valid passkey assertion to complete, and stays per-IP rate-limited.
