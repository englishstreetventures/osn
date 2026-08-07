---
"@cire/host": minor
"@cire/invites": minor
---

The cire invite's closing image is now a **full-bleed band**, spanning the guest
page edge to edge, instead of the 200px centred square it shipped as.

The slot was sized for a monogram or a signature; a photograph is what couples
reach for, and at 200px the sign-off read like a stray avatar rather than the
invite's closing image. It now spans the viewport, with the note (when there is
one) reading below it on the section surface.

- `@cire/invites`: `InviteClosing.tsx` renders the image at `w-full` with square
  corners, and **the crop decides the height** — the box takes the crop's true
  pixel aspect and renders the framed region exactly (`cropBackgroundStyle`, the
  technique it already used), so an organiser who crops a 3∶1 panorama publishes
  a 3∶1 panorama and one who crops a 4∶3 scene publishes a 4∶3 scene.

  This is deliberately not the hero backdrop's treatment, which pins a
  viewport-shaped box and demotes the crop to a focal point: the hero's box is
  dictated by the screen it fills, while this band has no shape of its own to
  defend, so the crop editor can be honest. With no crop saved the image keeps
  its natural proportions (`h-auto`) — nothing was chosen, so nothing is cut.

  `85dvh` is the single bound, for the one bad case (a 4∶5 portrait at 1440px
  wide would otherwise want 1800px of band and bury the note) — and on the
  cropped path it bounds the box's **width**, not its height: `width: 100%` plus
  `max-width: 85dvh × aspect`. A `max-height` clip would show a top-anchored
  crop's top strip only, since the background layer sits at the crop's own
  offset and can't tell the box got shorter. So an extreme portrait crop stops
  being edge-to-edge (a centred column at the widest size that fits a screen)
  rather than being cut; wide crops are untouched — a 2∶1 band is still
  1440×720 on a laptop, 390×195 on a phone.

  Two properties keep the band from moving the page under the guest, neither of
  which a 200px square needed: `aspect-ratio: auto 16/9` on the `<img>` (the
  fallback form — a box is reserved before a lazy, `content-visibility`-deferred
  image decodes, and the source's own ratio still wins afterwards, so the note
  and the site footer no longer jump down by up to a screen height), and a
  `contain-intrinsic-size` computed from the band's real geometry
  (`auto calc(100vw / aspect + 24rem)`) instead of a flat guess.

  Variants followed the box: `thumb`/`card` at `sizes="200px"` became
  `card`/`hero` at `sizes="100vw"`, and the crop layer's tightness-based variant
  pick collapsed to plain `hero` (1600w — a background can't carry a `srcset`,
  and at viewport width the 320w thumb was far too soft). Still `loading="lazy"`
  and `decoding="async"`: the section sits below every event card.

  One layout knock-on: the section's horizontal padding moved off the
  `<section>` onto the note's own block, since the band has to reach past it.
- `@cire/host`: the builder's section preview (`SectionSample`, the markup
  behind both the inline per-section card and the composed `PreviewPane`) now
  renders the band **edge to edge and crop-aware** — same exact-region render,
  same crop-driven aspect as the invite — so "what will my closing image look
  like" has a truthful answer before saving. `imageCrop` is threaded through
  `PreviewPaneProps["closing"]` and the inline preview to reach it.
  `CROP_ASPECT.footer` went 1∶1 → 16∶9, so the crop editor opens on the shape
  most couples want here rather than a square, and the Closing Section
  description says the image spans the page edge to edge like the hero.
- Both `cropAspectRatio` mirrors now clamp the crop's pixel aspect to
  `[0.05, 20]`. `natW`/`natH` are validated only as positive and finite, so an
  extreme pair yields a ratio that stringifies to exponential notation — which
  CSS rejects outright, dropping the `aspect-ratio` declaration and rendering
  the band as a zero-height box for every guest of that wedding.

No API, schema or wire change — same `footer_image_key` / `footer_image_crop`
storage, same claim gate, same endpoints. Existing closing images keep the
region their crop already framed; only the size it publishes at changes.
