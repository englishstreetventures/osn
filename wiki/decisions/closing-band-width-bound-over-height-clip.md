---
title: "The closing band follows the crop, and its height bound bounds the width"
tags:
  - decision
  - cire
  - frontend
related:
  - "[[cire]]"
  - "[[cire-invite-builder]]"
  - "[[browser-tests]]"
  - "[[decisions/README]]"
last-reviewed: 2026-09-18
---

# The closing band follows the crop, and its height bound bounds the width

The invite's closing image (`cire/invites/src/components/InviteClosing.tsx`) is a
**band spanning the viewport edge to edge**, and its **height follows the crop
the organiser framed**. It was a small centred square before; a photograph is
what couples reach for in a sign-off, and a 200px thumbnail read like a stray
avatar rather than the page's closing image. The section's horizontal padding
therefore moved off the `<section>` onto the note's own block — the band has to
reach past it.

**Above 1536px it stops growing** and settles onto the design pack's events
column — `column-xl` (640px) in `classic`, `column-2xl` (960px) in `gala` —
centred in both. See
[[#The bleed stops at the events column]].

Two choices sit underneath that, and both are choices against a treatment that
already exists elsewhere on the same page.

## The crop decides the shape, unlike the hero

| Option | What it is | Where it is used |
|---|---|---|
| Fixed box, crop as focal point | Pin a viewport-shaped box (`min-h-dvh`) and render the crop as a *cover* focal point — uniform scale, the crop region's centre at the box's centre, whatever falls outside gets cut | The hero backdrop (`designs/*/InviteHeader.tsx` → `heroCropBackgroundStyle`) |
| **Box takes the crop's aspect** | The box adopts the crop's true pixel aspect and renders the framed region exactly (`cropBackgroundStyle`, the story photo's technique) | **What shipped here** |

The hero's box is dictated by the screen it fills, so a crop there can only ever
be a hint about what to keep in view. The closing band has no shape of its own to
defend, so the crop editor can be honest: an organiser who crops a 3∶1 panorama
gets a 3∶1 panorama, one who crops a 4∶3 scene gets a 4∶3 scene, and the
builder's preview shows it. **What you frame is what publishes.**

With no crop saved nothing was chosen, so nothing is cut: the image keeps its
natural aspect (`h-auto`), bounded only by the screen, with `object-cover`
biting only when that bound does.

## The height bound bounds the WIDTH, not the height

A band may not grow taller than `BAND_MAX_HEIGHT` (`85dvh`). A 4∶5 portrait at
1440px wide wants 1800px of band, which buries the note and the footer under
screens of image. The obvious way to enforce that is a `max-height` on the box,
and it is the wrong way.

| Option | What it does | Why not |
|---|---|---|
| `max-height: 85dvh` | Clip the box's height | Renders only the crop's **top strip**. The background layer is positioned at the crop's own offset and has no idea the box got shorter, so a top-anchored tall crop loses everything below the fold of the box — silently breaking the promise the whole cropped path exists to keep |
| **`max-width: calc(85dvh × aspect)`** paired with `width: 100%` | `min(100%, max-height × aspect)`, centred | **What shipped.** An extreme portrait crop stops being edge-to-edge — it becomes a centred column at the widest size that fits a screen — but is still shown **whole and exact** |

*Unverified — the source recorded the top-strip behaviour as "measured in
Chromium", with no date and no script kept. Re-check it in the Chromium tier
([[browser-tests]]) before relying on it.*

Losing the full bleed on a rare shape beats cutting the framing on it. The
uncropped `<img>` path keeps its `max-h` + `object-cover`, which genuinely does
crop centred — acceptable for an image nobody framed.

Two details of the shipped form are deliberate and easy to undo by accident:

- It is written as a `max-width` paired with `width: 100%` rather than a literal
  `min()`. The two compute the same box, and `InviteClosing.test.tsx` pins the
  shape of the string it produces, so a `min()` written in its place would fail
  a test that is checking the contract rather than the arithmetic.

  *Measured 2026-09-18 — jsdom 30 keeps `min()`: `el.style.setProperty("max-width",
  "min(100%, calc(85dvh * 0.8))")` reads back as `min(100%, 68dvh)`. The parser
  is no longer the reason.*
- `BAND_MAX_HEIGHT` is exported because the value appears **twice** — as a
  literal inside `BAND_IMG_CLASS` (Tailwind's scanner reads source text; a
  computed class emits no CSS at all) and inside the cropped path's width
  `calc`. `InviteClosing.test.tsx` asserts the two are equal rather than trusting
  them, and asserts the cropped layer carries **no** `max-height` at all.

## The bleed stops at the events column

Edge to edge was the whole point of the band, and above 1536px it stopped paying
for itself: on a 2560px display the sign-off rendered **2560 × 765** while the
event cards it closes sat in a 640px column, so the last thing a guest saw was
several times the size of everything it was closing. Capped, the same band is
**640 × 320** in `classic` and **960 × 480** in `gala`.

*Measured 2026-09-18 — `InviteClosing` rendered at a 2560×900 viewport in the
Chromium tier ([[browser-tests]]), with and without the cap.*

| | Below 1536px | 1536px and above |
|---|---|---|
| Width | the viewport, edge to edge | the pack's events-column token — `classic` `column-xl` (640px), `gala` `column-2xl` (960px) |
| Alignment | edge to edge | centred, in **both** packs |
| Band's own height bound | `max-width: calc(85dvh × aspect)`, unchanged | unchanged |

Three details carry it, and each is load-bearing:

- **One custom property, `--invite-band-width`.** The section declares it at
  `100vw` and a literal Tailwind class narrows it at `2xl`. The band's box reads
  it as its `max-width`, and the section's `contain-intrinsic-size` reserve
  divides it by the crop's aspect — so the reserve and the rendered width cannot
  disagree, which is what keeps the scrollbar still as the guest scrolls into a
  `content-visibility: auto` section.
- **The cap is per pack, and the pack names its own content-cap token.**
  `bandCap` takes `"column-xl"` or `"column-2xl"` — the same token the pack's
  events column is measured with a few hundred lines up the same file — and the
  component holds the Tailwind class string for each, because the scanner reads
  source text and a class assembled at runtime emits no CSS at all. The class
  sets the band-width property to `var(--container-column-xl)`, so a change to
  the token moves the column and the band together. `sizes` is the one place
  that must restate the number in pixels, since an `img` attribute cannot read a
  custom property; `InviteClosing.test.tsx` reads the token block in
  `cire/invites/src/styles/global.css` and fails when the two disagree.
- **Gala's band is centred although gala's events column is not.** That column is
  `max-w-column-2xl` flush left inside a centred `max-w-column-4xl`. A band
  inheriting that alignment reads as a misalignment rather than as the pack's
  grid.

The band eases between the two widths (`transition-[max-width]`), which only a
guest dragging a window across 1536px ever sees — a guest who *loads* at 1600px
gets the capped band with no animation, which is right. The global
`prefers-reduced-motion` clamp in `cire/invites/src/styles/global.css` cuts the
duration to 0.01ms, asserted in `InviteClosing.browser.test.tsx` alongside the
widths themselves.

`sizes` on the uncropped path states the cap too
(`(min-width: 1536px) 640px, 100vw`): a bare `100vw` would ask a 2560px screen
for a render three times the box it fills.

## What would make this worth revisiting

- CSS gains a way to clip a background-positioned crop from its own anchor
  rather than from the box's top edge, which would make a `max-height` bound
  safe and keep the full bleed on every shape.
- The crop editor starts constraining the closing slot's aspect at capture time,
  so an over-tall crop cannot be saved and the bound stops binding in practice.
- The hero and the band converge on one treatment — at which point the first
  decision above is the one to re-argue, not this one.
