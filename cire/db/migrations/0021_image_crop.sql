-- Per-image crop rectangle for the three customisable invite images: the hero
-- backdrop + the "Our Story" photo (on `wedding_invite_customisations`) and the
-- per-event image (on `events`). Each column stores a JSON-encoded normalised
-- rectangle `{"x":0,"y":0,"w":1,"h":1}` in SOURCE FRACTIONS (0..1): `x`/`y` are
-- the top-left of the visible region, `w`/`h` its size, all as a fraction of the
-- original image's width/height. One rectangle captures BOTH pan and zoom — a
-- crop with zoom is just a smaller `{w,h}` box panned by `{x,y}`.
--
-- NULL ⇒ the current default behaviour (centre `object-cover`), so every existing
-- image renders exactly as before until an organiser re-crops it. The rectangle
-- is validated server-side on write (each component in 0..1, w/h > 0,
-- x + w ≤ 1, y + h ≤ 1) before it is persisted — see
-- `cire/api/src/schemas/invite.ts`. The guest site applies the crop in CSS
-- (`object-fit: cover` + computed `object-position`/`scale`), so the stored
-- bytes are untouched and no source-dimension capture is needed; the crop rides
-- in the same no-store invite/claim JSON that already hands out the image URLs.
--
-- Pure forward-only ADD COLUMNs — every existing row defaults to NULL.
ALTER TABLE `wedding_invite_customisations` ADD `hero_image_crop` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `story_image_crop` text;--> statement-breakpoint
ALTER TABLE `events` ADD `event_image_crop` text;
