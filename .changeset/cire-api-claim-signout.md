---
"@cire/api": patch
---

Add `POST /api/claim/signout` — the guest counterpart to the organiser's
`/api/auth/signout`. Revokes the `cire_session` the caller presents and clears
the cookie.

Until now there was no way for a guest to end a household session:
`sessionService.revoke` had no guest-facing caller, so a 30-day credential that
auto-exercises on every page load could only be ended by expiry or an organiser
action. Mounted as its own sibling instance and deliberately without
`sessionAuth`, so it is idempotent: the case that most needs to succeed is a
stale cookie still sitting in a browser, and a 401 there would leave it in
place. Always answers 204 and always clears the cookie; the revoke is
best-effort. Closes the guest half of security backlog S-M2.
