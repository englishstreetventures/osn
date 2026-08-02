---
"@cire/web": patch
"@cire/api": patch
"@cire/db": patch
---

Point the guest site's bare domain (`/`) at the marketing site instead of at a
wedding, and delete the "primary wedding" concept behind it.

`/` used to resolve the **most-recently-created** wedding via a public
`GET /api/primary-wedding` and redirect to `/<slug>`. That was a single-tenant
assumption held over from the bespoke era: with more than one wedding live, the
root served one arbitrary couple's invite to every visitor, and any anonymous
caller could learn whose invite was newest.

The endpoint wasn't re-pointed at a better "primary" — there is no correct single
wedding to resolve, so the concept is gone:

- `pages/index.astro` now 302s to `PUBLIC_MARKETING_URL` (default and production
  value `https://cireweddings.com`, wired in `deploy.yml`), resolved through
  `resolveMarketingUrl`, which falls back to the apex for an empty, whitespace,
  relative or non-`http(s)` value — a plain `??` would let a present-but-empty
  env var through as `""`, and an empty `Location` resolves against the request
  URL, turning `/` into a redirect loop. It makes no API call, so the route has
  no failure mode and no neutral/error state left to render.
  Query strings are dropped — the only one that ever rode `/` was a `?code=`
  host-preview deep link, meaningless to the marketing site and not something to
  forward off-origin. 302 rather than 301, since where the root points is a
  product decision and a permanent redirect would stick in browser caches.
- Deleted `routes/primary-wedding.ts` (and its tests),
  `weddingsService.primaryWeddingSlug()`, and the guest-side
  `fetchPrimaryWedding()` helper.
- `weddings_created_at_idx` (migration 0053, added purely to serve that query) is
  kept — dropping it costs a migration and buys nothing at this table size — but
  is now flagged in the schema as a removal candidate.

Guests are unaffected: they have always arrived on their own `/<slug>` invite
link, which is unchanged.
