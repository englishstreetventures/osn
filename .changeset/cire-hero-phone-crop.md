---
"@cire/api": patch
"@cire/web": patch
"@cire/organiser": patch
"@cire/db": patch
---

Hero phone crop — per-device framing for the full-bleed hero backdrop.

With the subjects framed to one side of the hero photo, the mobile auto-crop
(centre `object-cover` on a tall viewport) cut them out entirely. The hero now
carries two crop rectangles: the existing desktop crop governs the guest packs'
`md:` breakpoint and up, and a new hero-only `hero_image_crop_mobile` column
(migration `0046`, same JSON shape) governs narrower viewports — falling back
to the desktop rectangle when unset, so every existing invite renders
unchanged. The crop route gains an optional `screen: "desktop" | "mobile"`
body field (`mobile` outside the hero slot is a 400); uploading or removing the
hero image resets both rectangles. Both guest design packs render one focal
cover layer per breakpoint, and the organiser's hero image field gains a
"Phone crop" button opening the crop editor on a tall 9:16 default aspect,
plus a phone-shaped WYSIWYG thumbnail.
