---
"@cire/api": minor
"@cire/invites": minor
---

Open a returning guest's invite without asking for their code again, and take the
network latency out of the moment a code is entered.

- `@cire/api`: new `GET /api/claim/session` — a restore read gated by
  `sessionAuth()` that returns the same payload `POST /api/claim` returns, keyed
  on the `familyId` derived from the `cire_session` cookie. It accepts no claim
  code and the caller cannot name a family, so it is not a second credential
  surface. A required `?slug=` binds the restore to the wedding being rendered
  (the guest site serves every wedding from one origin, so an unscoped restore
  could paint one wedding's events into another's page — and an RSVP sent from
  that state would write to the wrong wedding's events). The response is
  `Cache-Control: no-store` + `Vary: Origin, Cookie`, since the body is selected
  entirely by the cookie and carries special-category dietary text. It re-checks
  `families.deactivated_at` as defence in depth and clears a stale cookie on
  that 401 — but never on a wrong-wedding 401, where the session is still good. Both entry points now build through a shared
  `buildClaimResponse`, so the events list and the claim-gated closing section
  cannot drift between claim and restore. Mounted as a sibling Elysia instance
  with its own 60/min limiter (`claimSessionLimiter`) rather than sharing the
  claim endpoint's 5/min brute-force budget, which a page-load-frequency read
  would otherwise exhaust. A matching native `CLAIM_SESSION_RATE_LIMITER`
  ratelimit binding is declared at top level and under `[env.production]` and
  wired in the Worker entry, so that cap is a real global edge limiter rather
  than a per-isolate in-memory fallback.
- `@cire/invites`: both design packs restore an existing household session on mount,
  so a guest who has already opened their invite lands straight on their events.
  The restored events section skips the unlock choreography (there is no unlock
  to perform on a return visit) and never starts at `opacity-0`. Adds a
  `preconnect` to the cire-api origin — the guest site and the API are separate
  origins, so the browser otherwise paid DNS+TCP+TLS in the middle of the claim
  request — and prefetches the unlock/modal animation chunks at idle, which were
  previously fetched after the interaction that needs them. Both prefetches are
  hints: every call site keeps its own import and its existing fallback. The
  restore is gated on a non-credential `cire_claimed` marker written by a
  successful claim, so a first-time visitor never spends a request on a
  guaranteed 401, and the island hydrates with a `rootMargin` so the restore
  starts while the full-viewport hero is still on screen rather than once the
  guest has already scrolled to the code form.
