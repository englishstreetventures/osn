# Invite Design "Gala" — Design Spec

**Date:** 2026-07-23
**Status:** Approved for planning (autonomous session; assumptions listed below)
**Depends on:** `docs/superpowers/specs/2026-07-22-invite-design-selector-design.md` (shipped on branch `feat/invite-design-selector`, PR #309). Gala is the first non-classic pack the selector was built for.
**Branch:** `feat/invite-design-gala`, stacked on `feat/invite-design-selector`.

## Goal

Ship a second invite design pack, **Gala**: an editorial, asymmetric restructure of the guest invite. Same data contract, same claim flow, same palette tokens — different structure. Three structural moves from the user's brief:

1. **Asymmetric story section with the story image visible on mobile.** Classic hides the story photo below `md` (`hidden md:block` in `designs/classic/InviteHeader.tsx`). Gala shows it at every width.
2. **Narrow bordered claim panel treated as an object.** Classic's claim form is a full-width centered section. Gala renders it as a compact bordered card sitting on the page ground.
3. **Events column widened to ~960px, left-aligned.** Classic centers a 540/640px column. Gala left-aligns a wider column with a left-aligned section head.

Also lands the selector's deferred gala-milestone bundle in the organiser: per-design thumbnails, per-card "Preview live" links, roving tabindex on the design radiogroup, multi-card DOM tests.

## Design Read + Dials (design-taste-frontend)

Reading this as: **guest wedding-invite page (second design pack) for wedding guests on phones, editorial/asymmetric language, built on Cire's existing token + type system.**

- `DESIGN_VARIANCE: 8` — asymmetry is the brief. Anti-center bias applies: left-aligned hero content, offset story grid, left-aligned events head.
- `MOTION_INTENSITY: 5` — keep the guarded post-claim reveal; no new scroll-driven machinery.
- `VISUAL_DENSITY: 3` — airy; wider measure than classic but generous whitespace.

**Fonts and colours are locked, not chosen.** Pre-flight: the project's established pairing is Cormorant Garamond (display) + Lato (body), and every colour flows from the five-seed palette (`ground`/`card`/`ink`/`gilt`/`bloom`) derived by `@cire/theme` and applied at the document root. Gala consumes the SAME tokens (`--invite-*` vars, `text-gold` / `font-display` / `border-border` utilities) and the SAME section keys (`hero`, `story`, `welcome`, `details`) so organiser theming works identically across designs. No new colours, no new fonts, no inline hex. Serif use is pre-justified: Cormorant Garamond is the project's committed display face, not a fresh reach.

Differentiation comes from **structure and scale only**: alignment, column widths, grid asymmetry, hairline rules, offset rhythm.

## Assumptions (autonomous decisions — flag on review if wrong)

1. **Tier: `free`.** Matches the selector spec's launch posture (gate built, dormant). Flipping gala to `premium` later is a one-word catalog change.
2. **Name: "Gala".** Working id from the selector spec, promoted to the display name.
3. **Thumbnails are abstract layout marks** (inline SVG showing each design's section rhythm), not screenshots. Honest, tiny, no fake chrome, no screenshot pipeline.
4. **`?design=` preview override** added to `[slug].astro` SSR so organiser cards can preview a design without saving it. Validated through `resolveDesignId` (unknown → classic). Presentation-only, no data exposure — acceptable that a curious guest could append it.
5. Hero direction (left-aligned editorial hero) is my extrapolation of the brief's asymmetry; the brief named story/claim/events explicitly, hero direction was open.

## Scope

### In

- `@shared/invite-designs`: add `{ id: "gala", name: "Gala", tier: "free" }` to `DESIGNS`.
- `cire/web/src/designs/gala/`: full pack — `Document.astro`, `InviteHeader.tsx`, `InvitePage.tsx`, `UnlockReveal.motion.ts`, co-located tests.
- Two small shared extractions so claim logic and hero-image lifecycle stay single-source (see Architecture).
- `[slug].astro`: `?design=` SSR override.
- Organiser `InviteBuilder`: thumbnails, per-card "Preview live" link, roving tabindex + arrow keys, multi-card/locked-badge DOM tests.
- Changesets (split versioned/version-less), wiki shard updates.

### Out

- New API surface (the design PUT route already validates against the catalog — gala works with zero cire-api code changes; add one test case only).
- Any change to classic's rendered output (regression-guarded by its existing tests).
- New palette seeds, tone presets, or theme-editor changes.
- Builder WYSIWYG preview in gala shape (selector spec: inline preview stays classic-shaped; other designs preview live).
- Prod rollout steps beyond the selector PR's (no new migrations).

## Architecture

### Pack structure (mirrors classic)

```
cire/web/src/designs/gala/
  Document.astro          # fonts, preloads, SSR palette, island wiring
  InviteHeader.tsx        # hero + asymmetric story (client:load)
  InvitePage.tsx          # claim panel + events column + modals (client:visible)
  UnlockReveal.motion.ts  # gala's post-claim reveal choreography
  InviteHeader.test.tsx
  InvitePage.test.tsx
  UnlockReveal.motion.test.ts
```

`registry.ts` gains `gala: { Document: GalaDocument }` — the catalog entry without this is a type error (by design). Packs never import from each other.

### Shared extractions (pre-launch, breaking changes free)

Two pieces of subtle logic currently live inside classic components that gala also needs. Fork-and-copy would duplicate bug-prone code; both get extracted into `components/` as headless primitives, with classic refactored to consume them (behavior identical, existing tests must stay green):

1. **`components/claim-code.ts`** — extract from `LoginSection.tsx` everything non-visual: code signal, loading/error state, Turnstile token wiring, `submitCode` (fetch + 401/validation branches), `handleSubmit`, and the `?code=` auto-claim mount logic (S-L1 URL-stripping included). Shape:

   ```ts
   export function createClaimCode(props: {
     apiUrl: string;
     result: () => ClaimResult | null;
     onClaimed: (r: ClaimResult) => void;
   }): {
     code: Accessor<string>; setCode(v: string): void;
     loading: Accessor<boolean>; error: Accessor<string | null>;
     turnstileEnabled: () => boolean;
     setTurnstileToken(t: string | null): void;
     handleSubmit(e: SubmitEvent): Promise<void>;
   }
   ```

   `LoginSection` keeps its markup (classic's shell + welcome states) on top of the primitive; gala's claim panel is a new shell on the same primitive.

2. **`components/hero-backdrop.ts`** — extract from `designs/classic/InviteHeader.tsx` the hero image load lifecycle: `HeroState` (`pending | loaded | error`), the SSR-hydration `complete && naturalWidth > 0` mount check, and the src-change re-arm guard (the "stuck invisible" fix, including the queueMicrotask recheck). Returns `{ state, imgRef, onLoad, onError }` keyed off a `src` accessor. Both packs consume it.

### `?design=` preview override

In `[slug].astro`, before rendering:

```astro
const designOverride = Astro.url.searchParams.get('design')
const { Document } = registry[resolveDesignId(designOverride ?? invite?.designId)]
```

`resolveDesignId` already collapses unknown/missing to classic, so a garbage param can never 500. The param is never persisted and never appears in generated share links.

## Visual Spec (tokens only; mobile-first)

All colours via existing `--invite-*` vars / palette utilities; all type via the project's display/body faces. Sections keep classic's tone plumbing: `sectionVars(theme, <section>)` + `background-color: var(--invite-section-bg)`.

### Hero (`hero` section key)

- Same data behavior as classic: gradient base layer, `hero-bg` variant backdrop with crop support, radial scrim, emptiness gate (`isHeroEmpty`), `heroDisplay` sliders honored (title backdrop panel + frost blur), `min-h-dvh` (grows with long titles, never fixed `h-dvh`).
- **Structure differs:** content block anchored **bottom-left** (flex column, `justify-end items-start`), left-aligned text, padding respecting safe-area insets. Title `text-[clamp(2.75rem,9vw,6.5rem)] leading-[1.1] pb-1` (descender clearance). Subtitle row below a short hairline rule (`border-border`, ~64px wide) instead of stacked-centered; keeps `tracking-[0.25em] uppercase`. Title-backdrop panel (when opacity > 0) wraps the left-aligned block with the same `color-mix` + both `backdrop-filter` spellings as classic.
- Fallback title "You're Invited" unchanged.

### Story (`story` section key) — asymmetric, image visible on mobile

- **Mobile (< md):** stacked, image first — full column width, `rounded-sm border border-border`, crop-aware (same crop/aspect logic as classic, `STORY_DEFAULT_ASPECT` 4/3), `loading="lazy" decoding="async"` on the img path (below the fold; classic never loaded it on mobile so lazy keeps the cost off first paint). Text below, left-aligned.
- **md+:** 12-col grid, `max-w-[1100px]`: image spans cols 1–5, text cols 7–12. Image offset down (`md:mt-12`) for editorial stagger; text vertically centered against it. Left-aligned eyebrow/heading/body; body measure capped `max-w-[480px]`, `whitespace-pre-line` kept.
- Emptiness gate (`isStoryEmpty`) and copy fallbacks ("Our Story" / "How It All Began" / neutral body) identical to classic. No viewport-bleed negative margins — asymmetry comes from unequal columns + vertical offset, so the 320px no-horizontal-scroll gate never depends on `overflow-x: clip` catching a bleed.

### Claim panel (`welcome` section key) — the object

- Section spans full width on the page ground (no section border), containing one **narrow bordered panel**: `max-w-[400px]`, `border border-border rounded-sm`, section-tone background via `sectionVars(theme, "welcome")` applied to the panel (not the section), generous padding (`px-7 py-10`).
- Mobile: centered with side gutters. md+: **left-aligned to the same left edge as the events column** (shared container widths) so the page has one alignment spine.
- Contents: eyebrow, heading (`text-[clamp(1.5rem,4vw,2rem)]` — panel scale, smaller than classic's section scale), helper line, form (input, error, Turnstile, submit) — markup rebuilt on `createClaimCode`; identical copy, `maxLength={48}`, `pattern="[A-Za-z0-9\-]+"` (hyphen escaped), focus ring `focus-visible:outline-[var(--invite-focus)]`, and disabled logic as classic.
- Post-claim: panel swaps to the welcome state (greeting heading — "Dear {nickname||firstName}" / "Welcome, the {familyName} Family" + member list — welcome message, preview-mode chip) inside the same bordered object. Form/welcome visibility driven by the same `display` toggling on refs so the motion sequence works.
- Buttons: one line at 320px (audit "Open Invitation" at panel width).

### Events (`details` section key)

- Outer container `mx-auto max-w-[1200px] px-6 md:px-10`; inner column `max-w-[960px]`, **left-aligned** (no `mx-auto` on the inner column).
- Section head left-aligned: eyebrow (default "Celebrate With Us"), heading (default "Your Events"), then a hairline rule (`border-border`) running the remaining column width.
- Event cards: reuse shared `EventCard` unchanged, all `orientation="norm"` (a constant orientation reinforces the left spine; classic keeps its alternation as its own signature). Keep the `data-event-card` wrapper (motion target).
- RSVP + Details modals, PulseAccountLink (`<Show when={!data().preview}>` + AuthProvider + Toaster), themeVars wiring: identical to classic.

### Footer

Reuse `SiteFooter.astro` unchanged (closing = hero title).

### Document.astro

Mirrors classic's contract: SSR palette on `<html style>` via `paletteRootVars`/`styleAttr`; `inviteTitle` tab title; **`<meta name="referrer" content="strict-origin-when-cross-origin" />` (S-L1) mandatory**; Google Fonts Cormorant Garamond + Lato preload-as-style with onload swap + noscript fallback; exact `?variant=hero-bg` hero preload (kept in step with `HERO_BG_VARIANT`, no imagesrcset); islands `client:load` (header) / `client:visible` (page).

## Motion (`gala/UnlockReveal.motion.ts`)

Same contract and guards as classic's, gala choreography:

- Sequence: claim form fades/translates out inside the panel → welcome state fades in → events section reveals with a small per-card upward stagger (`data-event-card` targets, `{ startDelay }` stagger — Motion v12 semantics, `ease` not `easing`).
- **All classic guards preserved verbatim:** JS `prefersReducedMotion()` check (Motion drives WAAPI — CSS reduced-motion overrides don't reach it) → `settleRevealed()` instant path; inline end-state writes after each animation; every `animate` call guarded; total sequence capped ≤ 1s; dynamic `import()` at claim time with catch → force `opacity = "1"` on the events section (invite must never stay hidden).

## Organiser Selector — gala-milestone bundle

All in `cire/organiser/src/components/InviteBuilder.tsx` (+ its test file):

1. **Thumbnails.** Each design card gets a small (~120×84) inline-SVG layout mark using `currentColor` strokes (inherits theme tokens): classic = centered stacked bands; gala = offset asymmetric bands. Rendered above the design name inside the existing card button. Abstract marks, not screenshots, no fake chrome.
2. **"Preview live" link.** Per card, a small link (`target="_blank" rel="noopener"`) to the existing host-preview invite URL with `&design=<id>` appended — previews that design without saving it. Reuses the builder's existing preview-URL source; rendered outside the radio button element so link-click ≠ select.
3. **Roving tabindex.** WAI-ARIA radio-group pattern: only the checked card (or first, if none) has `tabindex="0"`, others `-1`; ArrowRight/ArrowDown and ArrowLeft/ArrowUp move focus AND selection (skipping locked designs), Home/End to first/last unlocked. Selection still goes through `selectDesign` (its `savingDesign` guard + skip-if-current stay).
4. **Multi-card DOM tests.** With the 2-design catalog now real: both cards render; `aria-checked` follows saved `designId`; a `premium`-tier design without entitlement renders disabled + Locked badge and is skipped by arrow nav (force the locked state via the entitlements prop against a stubbed premium entry, or by testing `isDesignLocked` composition); arrow-key selection calls the design PUT.

## Data Contract + Fallbacks

- Gala accepts `InviteDesignProps` unchanged; consumes `InviteCustomisation` fully — including `heroDisplay` sliders (clamped defensively like classic's `clampNum`) and both `imageCrop`s. No pack-specific data.
- Older-API payload without `designId` → `resolveDesignId` → classic (existing behavior; gala adds a resolve test for `"gala"`).
- Islands revalidate on mount exactly like classic (no-store fetch, `initialValue` from props, keep-painted-values on non-OK).

## Performance

- No new fetches: single SSR fetch in `[slug].astro`, per-island no-store revalidation as today.
- Gala ships only via its own `Document.astro` import graph — a classic wedding downloads zero gala JS (registry structure already guarantees per-design bundles).
- Story image on mobile is new payload classic didn't have: mitigated with `loading="lazy"`, `decoding="async"`, thumb/card `srcset` (`buildSrcSet(url, ["thumb","card"])`) sized to the column.
- Hero preload identical to classic (exact variant URL, no srcset).

## Testing

- `designs/resolve.test.ts`: `"gala"` resolves to itself; garbage still → classic.
- `gala/InviteHeader.test.tsx`: story image rendered WITHOUT `hidden` at mobile (regression anchor for the brief's move 1); emptiness gates; heroDisplay clamps; crop paths.
- `gala/InvitePage.test.tsx`: claim panel renders form pre-claim, welcome post-claim; events column renders cards `orientation="norm"`; preview chip; modal wiring.
- `gala/UnlockReveal.motion.test.ts`: reduced-motion instant path; failed-import force-reveal; ≤1s cap.
- `components/claim-code` tests: extracted claim-flow branches (401, invalid payload, network error, Turnstile-required gate, `?code=` auto-claim + URL strip); classic `LoginSection` tests unchanged and green.
- `components/hero-backdrop` tests: already-loaded mount check, error path, src-change re-arm; classic header tests unchanged and green.
- Organiser: multi-card + roving-tabindex + locked-skip tests as above.
- cire-api: one added case — design PUT accepts `"gala"` for a non-entitled wedding (free tier).
- Verification gates: `bun run --cwd cire/web test`, `bun run --cwd cire/web build`, `bun run --cwd cire/organiser test`, full monorepo suite (`@shared/invite-designs` is a shared package — repo rule). Headless Chrome screenshots at **320/375/414/768px**: no horizontal scroll, no two-line buttons, story image visible at 320px.

## Accessibility

- `:focus-visible` + `--invite-focus` outline conventions on every interactive element.
- Roving tabindex per WAI-ARIA; Locked state stays `disabled` + visually badged.
- Hairline rules are decorative (`aria-hidden`); story/hero images keep `alt=""` (decorative — copy carries meaning).
- Headings: one page-title-level heading (hero title), one heading per section — same hierarchy as classic.

## Changesets + Wiki

- Changeset A (versioned): `@shared/invite-designs` minor — "Add the Gala design to the invite design catalog."
- Changeset B (version-less, separate file): `@cire/web` + `@cire/organiser` — gala pack + selector bundle. Never mixed with A (`scripts/validate-changesets.sh` enforces).
- Wiki: update `cire/wiki/todo/web.md` — the deferred layout-restructure note is exactly this work; close it against the gala pack, note classic keeps its original layout — plus any new findings; bump `last-reviewed: 2026-07-23` on every shard touched.

## Rollout

Stacked draft PR: `feat/invite-design-gala` → base `feat/invite-design-selector`. Merges after #309; no new migrations or secrets. Selecting Gala in prod is organiser-driven per wedding; default stays classic.
