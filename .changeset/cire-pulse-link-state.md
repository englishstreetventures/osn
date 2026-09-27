---
"@cire/api": minor
"@cire/invites": patch
---

The Pulse account-link box draws from the claim payload, so it appears with
the welcome panel instead of a request later above the events.

- `@cire/api`: `POST /api/claim` and `GET /api/claim/session` carry
  `accountLink` — `{ enabled: false }`, or `{ enabled: true, signedIn,
  linkedGuestIds }`. Linking is offered when `cire.account-linking` is on for
  the household and an ARC resolver is configured, never to a host preview.
  The state is read beside the invite build, the flag wait is capped at
  250 ms, and any failure reports linking as off rather than failing the
  claim. `GET /api/account/link` is removed; the guest site was its only
  caller.
- `@cire/invites`: `PulseAccountLink` takes that state and makes no request
  to draw itself, and no longer mounts the OSN `AuthProvider`, whose session
  request held the box back. A missing or malformed `accountLink` hides the
  box and never the invite.
