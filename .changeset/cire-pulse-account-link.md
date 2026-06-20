---
"@cire/web": patch
---

Add the guest "Link my Pulse account" affordance to the invite site.

After a guest claims their invite, an optional, additive panel
(`PulseAccountLink.tsx`, mounted post-claim inside `InvitePage.tsx`) lets them
link their OSN/Pulse account to their household seat. It probes
`GET /api/account/link` first — a 503 (linking disabled on the deployment) hides
the feature entirely. Signed-out guests get an OSN passkey sign-in (reusing
`@osn/ui`'s `SignIn`/`Register`, the same ceremony as the organiser portal — so
`@osn/client` + `@osn/ui` are now `cire/web` deps); signed-in guests pick which
household member they are and `POST /api/account/link` with `{ guestId }` via
`useAuth().authFetch` (attaches the OSN bearer and silent-refreshes on 401),
with the `cire_session` cookie riding along. A 409 already-linked is shown as
linked (not an error); per-member linked/unlinked indicators come from the GET,
and an unlink control issues `DELETE /api/account/link/:guestId`. Every failure
path degrades quietly so linking can never break the core invite. The guest-site
CSP `connect-src` now allowlists the OSN issuer origin.
