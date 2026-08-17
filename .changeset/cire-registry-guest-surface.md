---
"@cire/api": patch
---

Guest-facing registry surface. A published registry is now readable from the
invite site, and a household can reserve, mark purchased and release a gift
against its claim-code cookie.

`GET /api/invite/:slug/registry` returns the couple's copy and the item list;
`GET .../registry/image/:name` serves a gift photo through the same transform
pipeline as the rest of the invite; `GET .../registry/mine` returns the calling
household's own claims, plus the shipping address once it has earned it;
`POST`/`DELETE .../items/:itemId/claim` delegate to the existing
`registryService.claim` / `releaseClaim`, so the guest-side business logic has
one home.

Three things worth knowing:

- **Every failure on the public routes is one 404 with one body.** Unknown
  slug, wedding without the `registry` entitlement, and registry not yet
  published are three different facts, and a guest URL is public, so all three
  answer identically. Organisers still get a 402 on their own routes; guests
  must not be able to tell a drafted list from a wedding that does not exist.
- **The slug decides the wedding, never the cookie.** Every write resolves the
  wedding from the URL and hands that id to the service, so a session minted
  for one wedding does nothing on another.
- **The shipping address is earned.** It ships only to a household holding a
  live claim, only when the couple has set one, and only once
  `shippingVisibleFrom` has passed.

Also adds the registry section copy (`registryEyebrow` / `registryHeading` /
`registryBody` / `registryTone`, columns that existed but were never read) to
the public invite payload, alongside the other section copy.

Everything here stays behind the `registry` entitlement, which no wedding
holds.
