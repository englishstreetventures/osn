---
"@shared/rp-auth": patch
---

Add `resumeSession` — carry an already-signed-in visitor past the sign-in page.

A sign-in page that has buttons on it cannot redirect on mount, but it should
not ask someone for a session they already hold either. `resumeSession` asks
`GET {basePath}/session` behind the rendered page and, if the answer is yes,
navigates to `home` with `location.replace`, leaving no history entry for
`Back` to bounce through. A signed-out visitor waits for nothing: the buttons
render first, and an unreachable API reads as signed out.

It deliberately only sees the relying party's own cookie. A session at the
issuer is unreachable from a background request — that cookie is
`SameSite=Lax`, so it rides top-level navigations only, and a hidden-iframe
`prompt=none` probe would report "signed out" in every browser regardless of
third-party-cookie policy. Asking properly needs a full-page redirect, which is
the behaviour this replaces.

It also refuses to ping-pong. An app that bounces its own 401s back to the
sign-in page could trade redirects with this one if the two disagreed — a
session expiring between the calls. `resumeSession` stamps `rp-auth.resumed-at`
in `sessionStorage` and skips the next resume within five seconds, so a loop
stops after a single lap while a deliberate return visit still gets carried
through. Signing out clears the stamp. Both the storage and the navigation are
injectable.
