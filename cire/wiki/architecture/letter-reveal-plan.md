---
title: "Letter-reveal invite — plan (Canvas UI study)"
tags: [architecture, web, plan, design-packs]
related:
  - "[[index]]"
  - "[[invite-designs]]"
  - "[[invite-builder]]"
  - "[[consent]]"
last-reviewed: 2026-07-29
---

# Letter-reveal invite — plan

Goal: a closed letter/envelope on screen that opens up to reveal the cire
invite. This page records the study of the **Canvas UI** GitHub repo
([DavidHDev/canvas-ui](https://github.com/DavidHDev/canvas-ui), docs at
canvasui.dev) and the resulting build plan.

## 1. What Canvas UI actually is

- A library of ~26 "creative canvas" components (Peel, Cloth, Shatter,
  Particle Reveal, Particle Scroll, Laser, Liquid, Glass, Frost, Ripple, …)
  that run **WebGL effects over live HTML**.
- **Distribution:** shadcn-compatible registry, source-vendored into the
  consuming repo — `npx shadcn@latest add @canvas-ui/<component>-<framework>`.
  There is a first-class **Solid** variant of every component
  (e.g. `Peel.solid.tsx` + framework-agnostic `PeelVanilla.ts`), which matches
  `cire/web` (Astro + SolidJS). The interesting components have **zero npm
  runtime dependencies** (hand-rolled WebGL2, no three.js — three.js is only
  used by the two `*Object` model-viewer components).
- **License:** MIT + Commons Clause — free to use inside a product; the
  restriction is only on reselling the components themselves. Fine for cire.
- **How it reads the page:** the experimental **HTML-in-canvas API**
  (`ctx.drawElementImage()` + `canvas.requestPaint()` + a `layoutsubtree`
  canvas attribute). The live DOM is painted into a texture each frame, a
  WebGL2 output canvas draws the effect, and the real DOM stays interactive
  underneath.

### The critical constraint

HTML-in-canvas currently exists **only in Chrome/Edge 140+ behind
`chrome://flags/#canvas-draw-element`**, or in production via an
**origin-trial token**. Every component runtime-gates on
`supportsHtmlInCanvas()`; when unsupported, the DOM-reading components
(Peel included) render their children as plain HTML and the effect
**silently no-ops** — `capture()` and the pointer handlers return early.
There is no software fallback that still peels.

For a wedding invite, most guests are on **iOS Safari / mobile browsers**
(platform priority is iOS > Web > Android), so the Canvas UI effect would be
invisible to the majority of guests today. Any plan that makes Canvas UI
*the* letter-opening mechanism fails the audience.

### Closest components to "a letter that opens"

| Component | What it does | Fit |
|---|---|---|
| **Peel** | Curls live HTML back from a chosen edge in 3D, revealing a second `under` layer | Closest — reads exactly like lifting a letter flap / peeling the top sheet |
| Cloth | Hangs live HTML on rippling fabric | Lovely ambience for the letter page itself |
| Particle Scroll / Laser | Scroll-driven dissolve/reveal of the page | Alternative reveal grammar, not letter-like |
| Shatter / Particle Reveal | Glass shards / particle field around cursor | Too aggressive for a wedding invite |

**Peel API (from source):** props `side` (`left|right|top|bottom`), `mode`
(`cursor` = progressive with pointer proximity, `hover` = full peel in the
edge zone), `reveal` (px of `under` exposed at full peel), `zone`, `curl`,
`bow`, `shade`, `shine`, `shineColor`, `bulge`, `perspective`, `smoothing`;
Solid component takes `children` (the sheet) + `under` (revealed layer).
Instance exposes only `setOptions` / `resize` / `destroy`.

Two more limits worth naming:

1. **Peel is pointer-driven, not scriptable.** There is no `open()` — the
   peel follows cursor proximity to an edge. It's a hover flourish, not a
   choreographed "letter opens" sequence. On touch it only reacts to
   press-drag.
2. `reveal` exposes a strip of the under layer (default 250 px), not a full
   page transition.

## 2. Recommendation

**Own the letter-opening as a cire design pack; use Canvas UI's Peel as a
progressive enhancement, not the mechanism.**

- The baseline letter/envelope opening is built with what the guest site
  already ships: CSS 3D transforms + the `motion` package, choreographed in a
  `*.motion.ts` file exactly like the existing
  `designs/*/UnlockReveal.motion.ts` (inline end-state writes, `tryAnimate`
  timeout guards, `prefersReducedMotion()` → `settleRevealed()`). This works
  for **every** guest, including iOS.
- On browsers where `supportsHtmlInCanvas()` is true, the vendored Peel adds
  the tactile touch: the letter's folded top sheet peels under the cursor
  before the guest commits to opening (and/or the envelope flap gets the
  curl+shine treatment). Everyone else simply doesn't get the flourish —
  never a broken or missing invite.

## 3. Build plan

### Phase 1 — `letter` design pack (baseline, no Canvas UI)

1. **Catalog:** add `{ id: "letter", name: "Letter", tier: "free" }` to
   `DESIGNS` in `cire/invite-designs/src/index.ts`. The `DesignId` union then
   forces a matching pack in `cire/web/src/designs/registry.ts` (type error
   until it exists); the organiser selector picks it up from the catalog
   automatically.
2. **Pack:** `cire/web/src/designs/letter/` mirroring classic/gala —
   `Document.astro`, `InviteHeader.tsx`, `InvitePage.tsx`,
   `LetterReveal.motion.ts` (+ tests for each). Reuse the shared islands
   (`LoginSection`, `EventCard`, RSVP flow) unchanged.
3. **Scene:** a centred closed envelope built from layered elements —
   envelope back, interior, letter card, flap (CSS `perspective` +
   `rotateX` on the flap, `transform-origin: top`), and a wax-seal button
   reusing the cire-landing seal's visual identity (flat/CSS rendition — do
   **not** pull in the landing's three.js scene).
4. **Choreography** in `LetterReveal.motion.ts`:
   - *Arrive:* envelope settles in, seal glints once.
   - *Open:* tap/click the seal → flap rotates open → letter card rises out
     of the envelope and scales up to become the invite header, greeting +
     claim form (`LoginSection`) rendered **on the letter**.
   - *Unlock:* successful claim plays the existing unlock grammar (welcome +
     staggered event cards), now framed as the letter unfolding to full
     length. Returning guests with a live session get a short auto-open
     (envelope already slit) instead of the seal interaction.
   - Every step writes its end state inline and is timeout-guarded so a
     stalled animation can never hide the invite (Motion v12 reverts final
     keyframe values — same trap `UnlockReveal.motion.ts` documents).
   - `prefers-reduced-motion`: skip to the opened, fully-revealed state.
5. **Tests:** mirror `UnlockReveal.motion.test.ts` (reduced-motion settle,
   guarded steps, end-state invariants), pack render tests, and the
   registry/resolve coverage that keeps unknown ids falling back to classic.

### Phase 2 — Canvas UI Peel enhancement (vendored)

1. Vendor the Solid Peel via the registry —
   `npx shadcn@latest add @canvas-ui/peel-solid` — landing the source under
   `cire/web/src/components/canvasui/Peel/` (`Peel.solid.tsx`,
   `PeelVanilla.ts`; no new npm deps). Keep the license header; note the
   Commons Clause in the file.
2. Wrap the letter's folded top sheet: `<Peel side="top" mode="cursor"
   under={<detail layer>}>` so hovering the fold curls it with shade + shine
   before the guest opens the letter. Mount only when
   `supportsHtmlInCanvas()` is true; call `destroy()` once the open
   choreography starts so no GPU loop idles behind the invite (perf-backlog
   hygiene; the component caps DPR at 2 and runs its rAF on demand).
3. Lint note: `PeelVanilla.ts` uses `console.error` for shader-compile
   failures — route through the frontend's accepted pattern or strip, so
   oxlint stays clean.
4. **No consent/CSP work needed:** the code is vendored source, no
   third-party origin is contacted at runtime, so it needs no vendor-registry
   entry and no CSP change (see [[consent]] — the framework governs third
   *parties*, not first-party WebGL).

### Phase 3 (optional) — origin trial for native mode

Register `invite.cireweddings.com` for the Chrome `canvas-draw-element`
origin trial and ship the token (meta tag or `_headers`) so flag-less Chrome
guests get the Peel flourish in production. Pure enhancement; revisit when
the API's standardisation picture is clearer. Skipping this phase costs
nothing — the effect stays flag-gated for developers only.

## 4. Open decisions

- **New pack vs. reskinning classic** — plan assumes a third pack `letter`,
  which keeps classic/gala untouched and gives organisers the choice; if the
  couple wants it as *the* look, it can also ship as the wedding's stored
  `designId` default.
- **Tier** — `free` for now; the `premium` entitlement gate exists but is
  dormant. A letter pack is a plausible first premium design if that gate is
  ever switched on.
- **Touch affordance for Peel** — `mode: "cursor"` does nothing meaningful
  on touch; the enhancement is desktop-only by nature. Acceptable (baseline
  handles touch), but worth confirming.
