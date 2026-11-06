---
"@pulse/web": minor
"@pulse/api": patch
"@shared/rp-auth": minor
"@shared/dev-urls": patch
---

Pulse web renders its pages on the server, signed in. It mounts pulse-api under
`/api` on its own origin (`/api/auth/*` unchanged, `/api/<rest>` as `/<rest>`),
so the `pulse_web_session` cookie is host-only on the web origin and the server
rendering a page receives it and passes it on to pulse-api, sending nothing else.
`/calendar` arrives with the user's events in the first HTML; no cookie, an
unknown, expired or revoked one renders it signed out. Page HTML is
`Cache-Control: private, no-store` and `Vary: Cookie`. The mount refuses
pulse-api's `/internal/*`, `/health`, `/ready` and `/openapi*`, and any path
that could name another host. The browser never calls pulse-api's own origin.

- `@pulse/web`: `PULSE_API_INTERNAL_URL` (server-only) replaces `VITE_API_URL`.
  Every date and time is written by the server in the item's own zone (its
  venue's or series', else UTC) with the zone named, in the request's
  `Accept-Language` locale, and rewritten in the reader's own zone and locale
  once the page mounts (`<LocalTime>`), so a reader without JavaScript gets
  real dates and hydration keeps the server's text.
- `@pulse/api`: `PULSE_API_ORIGIN` is documented, and set in `wrangler.toml`,
  as the web origin that mounts it; no behaviour change.
- `@shared/rp-auth`: `RpAuthConfig.fetch` takes any `fetch`-compatible
  function (`RpFetch`) and is the transport every call goes through, so a
  rendering server can forward the page request's cookie; `apiBase` is read
  per call. Existing callers are unaffected.
- `@shared/dev-urls`: under portless, pulse-api's `PULSE_API_ORIGIN` is the web
  origin, and `@pulse/web` gets `PULSE_API_INTERNAL_URL` instead of
  `VITE_API_URL`.
