---
---

Guest site renders the wedding FROM THE INVITE LINK — SSR + clean path URLs, no
build-time slug (all `@cire/*` — version-less):

- **`@cire/web` — static → SSR** — switched `output: "static"` → `output: "server"`
  (the `@astrojs/cloudflare` adapter), deployed as a **Cloudflare Worker with
  Static Assets** (committed `wrangler.jsonc` carries the worker name +
  `cireweddings.com` custom-domain route). No `PUBLIC_WEDDING_SLUG`.
- **`@cire/web` — path-routed invite** — new `[slug].astro` server-renders
  `/<wedding-slug>` from a per-request `GET /api/invite/<slug>` fetch (real 404 +
  `NotFoundDocument` on unknown slug; transient API error renders defaults). The
  bare domain `/` (`index.astro`) resolves the primary wedding and 302-redirects
  to `/<slug>` (neutral state when none). `?code=<host code>` deep-link preserved
  on `/<slug>?code=…` and across the redirect; legal pages stay static
  (`prerender = true`). Hero/islands + runtime revalidation unchanged (shared
  `InviteDocument.astro`).
- **`@cire/api`** — new **public** `GET /api/primary-wedding` → `{ slug }` (sole
  wedding, or most-recently-created when several; 404 when none) drives the bare
  domain. `POST /api/organiser/weddings/:weddingId/preview-code` now returns
  `{ publicId, slug }`.
- **`@cire/organiser`** — the Preview-invite button and the copy-invite message
  now link to the wedding **path** (`${CIRE_WEB_URL}/<slug>`), so each opens the
  correct wedding regardless of which the bare domain resolves to.
- **CI** — `deploy.yml` deploys cire/web via `wrangler deploy` (SSR Worker) instead
  of `wrangler pages deploy`.
