---
"@cire/api": patch
---

Wire the `cireweddings.com` custom domain into the cire production config,
replacing the `example.com` / `pages.dev` placeholders.

- `cire/api/wrangler.toml` `[env.production]`:
  - `WEB_ORIGIN = "https://cireweddings.com,https://app.cireweddings.com"` (guest
    apex + organiser portal; each entry is `https://…` so the edge Origin guard
    admits both).
  - `OSN_JWKS_URL = "https://id.cireweddings.com/.well-known/jwks.json"` and
    `OSN_ISSUER_URL = "https://id.cireweddings.com"` (must equal osn-api's own
    `OSN_ISSUER_URL`); `OSN_AUDIENCE` stays `osn-access`.
  - custom-domain route `[[env.production.routes]]` (`pattern =
    "api.cireweddings.com"`, `custom_domain = true`) serving cire-api on
    `api.cireweddings.com`.
- Build-time `PUBLIC_*` for the static Astro Pages sites are set in the production
  build env (`.github/workflows/deploy.yml`), with localhost dev fallbacks kept in
  source: cire/web → `PUBLIC_API_URL=https://api.cireweddings.com`,
  `PUBLIC_SITE_URL=https://cireweddings.com`; cire/organiser →
  `PUBLIC_CIRE_API_URL=https://api.cireweddings.com`,
  `PUBLIC_OSN_ISSUER_URL=https://id.cireweddings.com`,
  `PUBLIC_CIRE_WEB_URL=https://cireweddings.com`. Adds a `deploy-cire-organiser`
  Pages job (the portal previously had no deploy job) and updates the
  `.env.example` files.

Config + CI only; no app logic changed. dev/staging keep their current config.
Validated with `wrangler deploy --env production --dry-run` and prod builds of both
sites (URLs confirmed baked into `dist`).
