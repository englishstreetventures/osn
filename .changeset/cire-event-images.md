---
"@cire/api": minor
"@cire/db": minor
"@cire/organiser": minor
"@cire/web": minor
---

Add **one optional image per event**, render it in an alternating two-column
guest layout, and let the organiser upload/replace it per event.

Data model: a single nullable `events.event_image_key` column (migration
`0019_event_image.sql`, an additive ADD COLUMN) stores the R2 object **key** (not
a URL), mirroring `wedding_invite_customisations.hero_image_key`. NULL ⇒ the
event renders text-only at every breakpoint. Events have no `updated_at`, so the
served image's cache version is derived SERVER-SIDE from the key (a deterministic
FNV-1a digest): a re-upload mints a fresh uuid-suffixed key ⇒ a fresh version ⇒
the new image is never served stale, and the client `?v=` is never trusted for
cache keying (S-M1). `schema.ts`, the `setup.ts` test DDL, and migration 0019 are
mutually consistent (a fresh local D1 applies 0001..0019 cleanly).

- `@cire/db`: migration `0019_event_image.sql` + the `eventImageKey` column on
  `events`.
- `@cire/api`: a new `eventImageService` (set/remove/`imageKeyForEvent`,
  `versionFromKey`, `eventImagePath`) reusing the shared R2 + Cloudflare Images
  pipeline. New public serve route `GET /api/invite/:slug/event/:eventId/image`
  (same bounded `IMAGE_VARIANTS` + Accept negotiation + Cache-API short-circuit
  as the wedding-slot serve route, factored into a shared `serveTransformedImage`
  helper) and organiser routes `POST`/`DELETE
  /api/organiser/weddings/:weddingId/events/:eventId/image` (osnAuth +
  weddingMember, per-IP rate limit, 5 MB cap, magic-byte JPEG/PNG/WebP sniff,
  event∈wedding ownership check). `POST /api/claim`'s `EventSummary` and the
  organiser `GET .../events` response now carry `imageUrl` (the first-party path
  with the key-derived `?v=`, or null).
- `@cire/web`: `EventCard` takes an `orientation` (`norm`/`alt`) and the event's
  image. On desktop (md+) with an image it's two columns — `norm` = text-left /
  image-right, `alt` = image-left / text-right (CSS `order`, DOM order stays
  text-first for accessibility), vertically centred. On mobile it's a single
  column with the image stacked BELOW the text (image IS shown for events). With
  no image it collapses to a single text-only column at every breakpoint (no
  empty half). `InvitePage` alternates the orientation by event index. The two
  buttons keep their order (Respond, then View Event).
- `@cire/organiser`: `EventTable` gains a per-event image field (file input +
  preview thumbnail + Remove), reusing the InviteBuilder image-upload look +
  toast pattern. One image per event — uploading replaces the current one; event
  details stay read-only (sourced from the spreadsheet import).

Ops note: this is additive and pre-launch — every existing event row defaults to
NULL, so live events have no images until one is uploaded through the organiser
portal.
