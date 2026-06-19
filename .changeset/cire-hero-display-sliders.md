---
"@cire/api": minor
"@cire/db": minor
"@cire/organiser": minor
"@cire/web": minor
---

Replace the coarse hero display toggles (Blurred/Regular image + None/Solid
title backdrop, PR #188 / migration 0017) with fine-grained SLIDERS, and give
the organiser a full WYSIWYG live preview.

Three controls, each a bounded integer:

- **Hero image blur** (0–40, default 28) — the server-side Gaussian blur on the
  hero backdrop. 0 = the sharp full-bleed photo; 28 = the current soft look. The
  blur is now PER-WEDDING (it overrides the former fixed
  `VARIANT_BLUR["hero-bg"]` constant).
- **Title backdrop opacity** (0–100, default 0) — opacity of the dark legibility
  panel behind the hero title text. 0 = no panel (today's look).
- **Title backdrop blur** (0–20px, default 0) — a frosted-glass `backdrop-filter`
  behind the title.

- `@cire/db`: migration `0018_hero_display_sliders.sql` DROPs the two 0017 enum
  columns (`hero_image_style`, `hero_title_backdrop`) and ADDs three NOT-NULL
  integer columns (`hero_blur` default 28, `hero_title_backdrop_opacity` default
  0, `hero_title_backdrop_blur` default 0). Pre-launch data is all defaults, so
  the clean drop needs no value migration. `schema.ts`, the `setup.ts` test DDL
  mirror, and the migrated D1 shape are mutually consistent (this also closes the
  pre-existing 0017 lockstep gap).
- `@cire/api`: the theme PUT body validates the three ints, **clamping**
  out-of-range values into bounds (a stale client can't 400 the whole save) and
  rejecting non-integers with 400. `heroDisplay` on the public read is now
  `{ blur, titleBackdrop: { opacity, blur } }`. Saving bumps `updatedAt` — which
  the served hero image cache version derives from — so a blur change busts the
  cache. The serve route resolves the per-wedding `hero_blur` alongside the image
  key and applies it ONLY to the `hero-bg` variant of the `hero` slot; the blur
  is folded into the Cache API key too (defensively, on top of the `updatedAt`
  bump). The blur is always server-derived — NEVER a client query param — so the
  no-arbitrary-cache-minting invariant (S-M1) is preserved.
- `@cire/web`: the guest hero always requests the `hero-bg` variant (the server
  applies the stored blur, 0 ⇒ sharp), and renders a title legibility panel
  behind the title text driven by the two backdrop sliders — background opacity
  (via `color-mix`) + `backdrop-filter: blur()` (+ `-webkit-` twin). Opacity 0 ⇒
  no panel. The on-mount image-complete / re-arm logic is unchanged.
- `@cire/organiser`: the Blurred/Regular + None/Solid toggles are replaced by a
  reusable `SliderField` (label + range input + live value readout) for the three
  sliders, plus a **WYSIWYG `HeroPreview`** that composites the uploaded hero
  image (client-side CSS `filter: blur()` on a non-blurred `card` variant — no
  Cloudflare Images call per drag), the title backdrop panel, and the title text
  styled to evoke the real hero. With no image it falls back to the same dark
  gradient the real hero uses. The three values ride on the existing theme PUT.
