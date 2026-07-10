---
"@cire/api": minor
"@cire/db": minor
"@cire/web": minor
"@cire/organiser": minor
---

Three follow-ups to the invite-customisation work:

- **Neutral built-in defaults** — the guest invite's fallback copy no longer
  belongs to one couple: the hero's "V & R" monogram fallback is now a neutral
  "You're Invited" title, and the bespoke story text is a neutral greeting.
  The builder placeholders mirror the new defaults. (A deployed wedding that
  relied on the old defaults must save its own copy via the builder.)
- **Image cache version decoupled from copy/theme saves (WT-P-I1)** —
  migration `0029` adds `wedding_invite_customisations.images_updated_at`
  (backfilled from `updated_at`), bumped only by image upload/remove/crop and
  a hero-blur change. The guest image URLs' `?v=` and the server-side
  transform cache key now derive from it, so copy/colour saves leave the
  per-call-billed Cloudflare Images transform cache warm.
- **Live WCAG contrast advisory (WT-C-L1)** — the builder warns (never
  blocks) when a section's accent-on-background pair drops below the 4.5:1 AA
  text minimum, computed live from the pickers via a new
  hex/rgb/hsl/oklch-aware `lib/contrast.ts`; the built-in defaults sit at
  7.5:1 so an un-themed invite never warns.
