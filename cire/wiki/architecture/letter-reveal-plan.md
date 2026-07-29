---
title: "Letter-reveal invite — plan (own HTML-in-canvas effect)"
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
invite. Decision: we do **not** take components from Canvas UI
([DavidHDev/canvas-ui](https://github.com/DavidHDev/canvas-ui)) — we use it
as a **reference implementation** for the HTML-in-canvas technique and build
our own letter-opening effect on the raw API. Two reasons this is the right
call beyond preference:

1. Canvas UI has no letter/envelope component, and its closest one (Peel) is
   **pointer-driven with no programmatic `open()`** — a hover flourish, not
   the scripted "letter opens" choreography we want. Building our own gives
   us a timeline-driven effect Peel structurally can't be.
2. Owning the code removes the MIT + Commons Clause question entirely and
   keeps `cire/web` free of vendored third-party source.

## 1. The HTML-in-canvas API (what we're building on)

The experimental API lets a canvas paint **live DOM** as a texture while the
real elements stay laid out and interactive:

- `<canvas layoutsubtree>` — child DOM of the canvas is laid out and
  interactive; the canvas can capture it.
- `ctx.drawElementImage(element, x, y)` (2D context) paints the live element
  into the canvas.
- `canvas.requestPaint()` kick-starts the pipeline; the `paint` event /
  `onpaint` fires whenever the captured subtree repaints, so captures stay
  fresh without polling.

**Availability (checked 2026-07-29):** origin trial in **Chrome 148–150**
(May–July 2026, token per origin; an Edge origin trial exists too), local dev
via `chrome://flags/#canvas-draw-element`. Stable estimated **late 2026** if
trial metrics hold. **No Safari/WebKit or Firefox support** — so on iOS
(our top-priority guest platform) the API does not exist and a DOM/CSS
fallback is mandatory, not optional. Sources:
[Chrome origin-trial announcement](https://developer.chrome.com/blog/html-in-canvas-origin-trial),
[Codrops walkthrough](https://tympanus.net/codrops/2026/05/13/exploring-the-html-in-canvas-proposal/).

## 2. Reference notes from the Canvas UI source

What their vanilla cores (`src/lib/*/⟨Name⟩Vanilla.ts`, esp. `PeelVanilla.ts`)
demonstrate, worth mirroring in shape (technique, not code):

- **Two canvases + the content between them.** A *source* canvas carries
  `layoutsubtree` and hosts the live DOM as its child; a separate *output*
  WebGL2 canvas (`position: absolute; inset: 0; pointer-events: none`)
  renders the effect on top. The DOM stays clickable/selectable because it
  is real DOM the whole time.
- **Feature detection** is a runtime probe, not UA sniffing:
  `typeof ctx.drawElementImage === "function" &&
  typeof canvas.requestPaint === "function"` (their
  `supportsHtmlInCanvas()`), plus a null-return when `webgl2` context
  creation fails — jsdom/test environments fall through to the DOM path for
  free.
- **Capture pipeline:** `source.onpaint = capture`; `capture()` does
  `ctx.reset()` → `drawElementImage(content, 0, 0)` → upload the source
  canvas into a WebGL texture with `texImage2D(..., source)` → `ctx.reset()`.
  `requestPaint()` is called on every resize; `onpaint` re-fires on DOM
  repaints so live regions (countdowns, images loading in) stay fresh.
- **Geometry:** a subdivided unit-grid mesh (~90×90) deformed entirely in
  the vertex shader; the DOM texture is just sampled across it. A fold/curl
  is a per-vertex transform — exactly what a letter unfold needs.
- **Hygiene worth copying:** on-demand rAF (a `wake()`/`start()` pair — the
  loop parks when the animation settles), DPR capped at 2,
  `ResizeObserver` + `IntersectionObserver` gating, a `prefers-reduced-motion`
  listener, an "under" layer kept `visibility: hidden` until the first
  capture lands, and a `destroy()` that removes every listener/observer and
  deletes every GL resource.
- **Their gap (our opportunity):** effects are pointer-reactive
  (`pointermove` → target → damped spring). None expose a timeline. Our core
  will instead expose `progress(t)` / `open()` so the choreographer scripts
  the opening — which also makes the effect work on **touch** (tap to open),
  where Peel's cursor model does nothing.

## 3. Build plan

### Phase 1 — `letter` design pack with the DOM/CSS opening (the baseline)

This ships first and is the experience most guests get (all of iOS, and any
Chrome without the trial token).

1. **Catalog:** add `{ id: "letter", name: "Letter", tier: "free" }` to
   `DESIGNS` in `cire/invite-designs/src/index.ts`; the `DesignId` union
   forces the matching pack in `cire/web/src/designs/registry.ts`, and the
   organiser selector picks it up from the catalog automatically.
2. **Pack:** `cire/web/src/designs/letter/` mirroring classic/gala —
   `Document.astro`, `InviteHeader.tsx`, `InvitePage.tsx`,
   `LetterReveal.motion.ts` (+ tests). Shared islands (`LoginSection`,
   `EventCard`, RSVP flow) unchanged.
3. **Scene:** layered elements — envelope back, interior, letter card, flap
   (CSS `perspective` + `rotateX`, `transform-origin: top`), a wax-seal
   button echoing the cire-landing seal's visual identity (flat/CSS — not
   the landing's three.js scene).
4. **Choreography** in `LetterReveal.motion.ts`: arrive (envelope settles,
   seal glints) → open (tap the seal, flap rotates, letter rises and scales
   into the invite header with greeting + claim form on the letter) →
   unlock (successful claim plays the unlock grammar as the letter unfolding
   to full length). Returning guests with a live session get a short
   auto-open. Every step writes its end state inline and is timeout-guarded
   (Motion v12 reverts final keyframe values — the trap
   `UnlockReveal.motion.ts` documents); `prefers-reduced-motion` settles
   straight to the opened state.
5. **Tests:** mirror `UnlockReveal.motion.test.ts` (reduced-motion settle,
   guarded steps, end-state invariants) + pack render tests + registry/
   resolve fallback coverage.

### Phase 2 — our own HTML-in-canvas unfold (progressive enhancement)

A bespoke effect where the **invite itself is the sheet**: the live DOM is
captured as the texture, folded closed, and unfolds in 3D on open.

1. **Module:** `cire/web/src/lib/letter-open/` — a vanilla TS core
   `createLetterUnfold(elements, options): LetterUnfoldInstance | null` plus
   a thin Solid wrapper island. Same layering discipline as the reference
   (core is framework-free and unit-testable; wrapper only wires refs and
   lifecycle).
2. **Core contract** (the part Peel doesn't have):
   - `progress(t: 0..1)` — pure function of timeline position; and
     `open({ duration, ease }): Promise<void>` driving it on the on-demand
     rAF loop.
   - Geometry: subdivided grid mesh; vertex shader folds the sheet at one or
     two crease lines (tri-fold letter) with soft self-shading near the
     creases; `t = 0` fully folded, `t = 1` flat.
   - Capture pipeline and hygiene exactly as the reference notes above
     (probe, `onpaint` → texture upload, DPR cap, observers, full
     `destroy()`).
   - Returns `null` when the probe or `webgl2` context fails — the caller
     falls back to the CSS path. This also keeps jsdom tests trivially on
     the fallback branch.
3. **Handoff:** at `t = 1` the output canvas cross-fades out, the real DOM
   (which was there, laid out, the whole time) takes over, and the instance
   is `destroy()`ed — no capture loop or GL context lingers behind an
   invite the guest is now just reading (perf-backlog hygiene).
4. **Integration:** `LetterReveal.motion.ts` stays the single choreographer.
   On the open beat it asks the module: native path → `await unfold.open()`;
   null → the Phase 1 CSS flap/rise animation. Same beats, same end state,
   same reduced-motion settle either way.
5. **Tests:** fold geometry + timeline easing as pure functions
   (deterministic, no GL); wrapper tests assert the null-probe fallback
   renders plain DOM and that `destroy()` is called after open completes.

### Phase 3 — origin trial token (makes Phase 2 real for guests)

The trial is running **now** (Chrome 148–150). Register
`invite.cireweddings.com` for the HTML-in-canvas origin trial and ship the
token (meta tag in the letter pack's `Document.astro`, or a header). During
the trial, real Chrome guests get the WebGL unfold with no flags; everyone
else keeps the baseline. Watch for API renames landing with the stable
release (late 2026 estimate) — the probe isolates us: only
`supportsHtmlInCanvas()` and `capture()` touch the experimental surface.

## 4. Open decisions

- **New pack vs. reskinning classic** — plan assumes a third pack `letter`;
  a couple can still make it their default via the stored `designId`.
- **Tier** — `free` for now; the dormant `premium` gate makes this a
  plausible first premium design later.
- **Fold grammar** — tri-fold letter unfold vs. envelope-flap + rise with a
  single curl. Decide on the storyboard before building the mesh; the core
  contract (`progress(t)`) is the same either way.
- **Trial expiry behaviour** — when the origin trial lapses (or the API
  ships stable under a changed name), the probe fails and guests silently
  get the baseline. Acceptable by design; note it in the deploy runbook when
  Phase 3 lands.
