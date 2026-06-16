---
"@cire/api": minor
"@cire/db": minor
"@cire/organiser": minor
"@cire/web": minor
---

Add a basic invite builder to the cire organiser dashboard. Organisers can
swap a couple of images and rewrite the hero / "Our Story" copy on top of the
existing animated invite; the event + guest source of truth still comes from
the CSV import and is untouched.

- `@cire/db`: new `wedding_invite_customisations` table (1:1 per wedding, PK =
  `wedding_id`, cascade FK). Nullable text slots (`hero_title`,
  `hero_subtitle`, `story_eyebrow`, `story_heading`, `story_body`) and R2
  image keys (`hero_image_key`, `story_image_key`); a null column means "use
  the built-in default". Migration `0009_invite_customisations.sql`.
- `@cire/api`: new `inviteService` (Effect) + sibling route instances. Public
  reads — `GET /api/invite/:slug` (text + image URLs for the guest site) and
  `GET /api/invite/:slug/image/:slot` (image bytes from R2) — are kept off the
  `osnAuth` gate. Organiser writes under
  `/api/organiser/weddings/:weddingId/invite` (`GET`, `PUT /text`,
  `POST /image/:slot`, `DELETE /image/:slot`) sit behind `osnAuth` +
  `weddingOwner` (403, never 401, on ownership mismatch). Images live in a new
  `cire-assets` R2 bucket via a binary `AssetsR2Service` (the CSV-import R2
  service is text-only); uploads are size-capped (5MB) and magic-byte sniffed
  (JPEG/PNG/WebP), not trusted by declared Content-Type. The fixed slot set
  (`hero`, `story`) is a closed union driving the route param, R2 key
  namespace, and bounded observability attributes. Service ops are wrapped in
  `cire.invite.*` spans with `Effect.log*` on every path.
- `@cire/organiser`: new "Invite" dashboard tab + `InviteBuilder` panel for
  editing copy and uploading/removing slot images via `authFetch`.
- `@cire/web`: the static `Hero.astro` / `OurStory.astro` are replaced by a
  client-hydrated `InviteHeader` island that fetches the public invite endpoint
  and applies overrides on top of the original copy (uncustomised weddings
  render exactly as before). New `PUBLIC_WEDDING_SLUG` env var selects which
  wedding's customisation the guest site renders.

Note: the `cire-assets` R2 bucket (+ `cire-assets-preview`) must be created
before first deploy (`bunx wrangler r2 bucket create cire-assets`).
