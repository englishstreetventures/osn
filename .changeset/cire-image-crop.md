---
"@cire/api": minor
"@cire/db": minor
"@cire/organiser": minor
"@cire/web": minor
---

Give the organiser **crop + zoom control** over the three customisable invite
images (hero backdrop, "Our Story" photo, and each per-event image), replacing
the fixed `object-cover` centre-crop. The organiser drags/resizes/zooms a crop
box over each uploaded image and the chosen region is exactly what guests see.

Data model: a normalised crop rectangle `{x,y,w,h}` in SOURCE FRACTIONS (0..1)
is JSON-encoded into three nullable TEXT columns (migration `0021_image_crop.sql`,
additive ADD COLUMNs): `wedding_invite_customisations.hero_image_crop` /
`story_image_crop` and `events.event_image_crop`. ONE rectangle captures both pan
and zoom (a zoom is just a smaller `{w,h}` box panned by `{x,y}`). NULL ⇒ the
current default centre `object-cover`, so every existing image renders exactly as
before until re-cropped. `schema.ts`, the `setup.ts` test DDL, and migration 0021
are mutually consistent (a fresh local D1 applies 0001..0021 cleanly).

Render path — **CSS, not server-side region crop** (the documented fallback):
the crop is applied on the guest site via the classic background-image fraction
technique (`background-size`/`background-position` computed from the rectangle),
which is WYSIWYG-identical to what Cropper.js showed the organiser, dims-free
(no source-dimension capture needed), and zero extra Cloudflare cost. The
organiser's editor LOCKS each slot's crop aspect ratio to the guest display box,
so the fraction render is exact regardless of source pixel dimensions. Server-side
region crop was deferred because it would have to compose with the existing
hero blur + fixed-variant pipeline and needs dimension capture for the pixel
mapping; the CSS path keeps the served image **bytes** unchanged, so the crop
rides in the always-fresh `no-store` invite/claim JSON and there is no
image-bytes cache to bust.

- `@cire/db`: migration `0021_image_crop.sql` + the three `*_image_crop` columns.
- `@cire/api`: `ImageCrop` + an `isValidCrop` bounds gate (each value 0..1, w/h
  > 0, x+w ≤ 1, y+h ≤ 1) + an `ImageCropBody` schema + a defensive `decodeCrop`
  read helper, all in `schemas/invite.ts`. New `inviteService.setCrop` /
  `eventImageService.setCrop` (the event variant re-checks event∈wedding
  ownership). New organiser routes `PUT
  /api/organiser/weddings/:weddingId/invite/image/:slot/crop` and `PUT
  .../events/:eventId/image/crop` — an out-of-range rectangle is a 400, never
  persisted (it's interpolated into a guest-facing inline style). A fresh image
  upload (or a remove) RESETS the slot's crop to full-frame. The crop is surfaced
  on `getForSlug`/`getForWeddingId` (hero/story), the claim `EventSummary`, and
  the organiser events list so the builder can re-open the saved crop.
- `@cire/web`: hero, "Our Story", and `EventCard` render the cropped region via
  the shared `image-crop.ts` helper (a background div), falling back to the
  existing responsive `<img srcset>` + `object-cover` when no crop is set — so the
  alternating/two-column/emptiness behaviour is unchanged.
- `@cire/organiser`: a "Crop" affordance on each image opens an `ImageCropModal`
  built on the battle-tested **Cropper.js** (`cropperjs`) with drag/resize/zoom,
  Save, and Reset-to-full; the saved crop re-opens as the initial box and the
  field thumbnail previews the cropped region WYSIWYG.

Ops note: additive and pre-launch — every existing image defaults to the full /
centre crop until an organiser re-crops it through the portal.
