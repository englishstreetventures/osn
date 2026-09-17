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
last-reviewed: 2026-09-17
---

# The closing band follows the crop, and its height bound bounds the width

The invite's closing image (`cire/invites/src/components/InviteClosing.tsx`) is a
**full-bleed band** spanning the viewport edge to edge, and its **height follows
the crop the organiser framed**. It was a small centred square before; a
photograph is what couples reach for in a sign-off, and a 200px thumbnail read
like a stray avatar rather than the page's closing image. The section's
horizontal padding therefore moved off the `<section>` onto the note's own block
— the band has to reach past it.

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

- It is written as a `max-width` rather than a literal `min()` because `min()` is
  the one form the test tier's CSS parser discards, and a contract nothing can
  assert is a contract that rots.
- `BAND_MAX_HEIGHT` is exported because the value appears **twice** — as a
  literal inside `BAND_IMG_CLASS` (Tailwind's scanner reads source text; a
  computed class emits no CSS at all) and inside the cropped path's width
  `calc`. `InviteClosing.test.tsx` asserts the two are equal rather than trusting
  them, and asserts the cropped layer carries **no** `max-height` at all.

## What would make this worth revisiting

- CSS gains a way to clip a background-positioned crop from its own anchor
  rather than from the box's top edge, which would make a `max-height` bound
  safe and keep the full bleed on every shape.
- The crop editor starts constraining the closing slot's aspect at capture time,
  so an over-tall crop cannot be saved and the bound stops binding in practice.
- The hero and the band converge on one treatment — at which point the first
  decision above is the one to re-argue, not this one.
