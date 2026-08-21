---
title: "Toasts — @shared/toast and the --toast-* contract"
tags: [systems, frontend, accessibility, design-system]
related:
  - "[[index]]"
  - "[[drag-and-drop]]"
  - "[[component-library]]"
  - "[[cire-invite-builder]]"
  - "[[browser-tests]]"
  - "[[component-lab]]"
last-reviewed: 2026-08-21
---
# Toasts — `@shared/toast` and the `--toast-*` contract

Transient confirmations and errors across every frontend. An internal package
since 2026-08-21, replacing [solid-toast](https://github.com/ardeora/solid-toast)
(unmaintained since 2023).

## Why we own it

Three concrete costs, all visible in the code it replaced:

- **A hardcoded `z-index: 9999`.** solid-toast spread its own
  `defaultContainerStyle` onto the container's inline `style`, and inline style
  beats a Tailwind utility — so `containerClassName={Z_CLASS.TOAST}` was
  *silently inert* and cire's toasts sat above the consent banner, the one layer
  they must never cover. The only override that won was `containerStyle`.
- **`!important` as the only way to theme.** The cire invite carried
  `!bg-surface-raised !text-text !border-border !font-body`, which existed purely
  to out-shout the library's inline defaults.
- **No contrast story.** Four of the six mounts passed no styling at all and
  rendered a white pill in dark apps.

## The API

```ts
import { toast, Toaster } from "@shared/toast";

toast.success("Saved");
toast.error("Could not save");
toast.info(msg); toast.warning(msg); toast.loading(msg);

toast.success("Saved", {
  duration: 6000,          // ms; `Infinity` pins it
  id: "save",              // stable identity — re-raising UPDATES in place
  dismissible: true,       // adds a close button
  action: { label: "Undo", onClick: undo },
  politeness: "polite",    // overrides the per-tone default
});

toast.dismiss(id?);        // animate out; no id dismisses everything
await toast.promise(save(), {
  loading: "Saving…", success: (v) => `Saved ${v}`, error: (e) => `Failed: ${e}`,
});
```

`toast.promise` re-throws on rejection — the toast reports on the promise, it
does not handle it. Swallowing would turn a failed save into a caller that
believes it succeeded.

Two behaviours worth knowing, because both were bugs caught by the package's own
tests while it was written:

- An upsert **replaces** the toast's options rather than merging over them. A
  merge lets the previous state leak: `toast.promise` turning a `loading` (pinned
  at `Infinity`) into a `success` would carry that duration across and pin the
  result on screen for ever.
- Re-raising an id mid-exit **cancels the pending removal**. Without that, the
  revived toast dies a moment later when the stale timer fires.

## The `--toast-*` contract

The package serves two token vocabularies — shadcn names in `@osn/social` and
`@pulse/web`, cire's own in `@cire/*` — so it hardcodes neither. It styles itself
from its own custom properties, each with a neutral fallback, and every app maps
its vocabulary onto them once:

| Variable | What it is |
|---|---|
| `--toast-surface` | The toast's background |
| `--toast-ink` | Message colour |
| `--toast-border` | Border |
| `--toast-radius`, `--toast-shadow`, `--toast-font`, `--toast-font-size` | Shape and type |
| `--toast-focus` | Focus ring on the action/close buttons |
| `--toast-accent-success` / `-error` / `-warn` / `-info` | The tone glyph's colour |

```css
/* osn/social, pulse/web — the shadcn ramp */
--toast-surface: var(--popover);
--toast-ink: var(--popover-foreground);
--toast-accent-error: var(--destructive);

/* cire — the derived invite palette */
--toast-surface: var(--color-surface-raised);
--toast-accent-error: var(--toast-error);      /* note the alias; see below */
```

**Styled in plain CSS, not Tailwind.** Only `pulse/web` and `osn/social` declare
`@custom-variant base (:where(&))`, and none of the three cire apps declares
`@source` for a workspace package. Utilities in the package would mean threading
Tailwind config into five apps across two vocabularies; a stylesheet keyed off
custom properties needs none of it. Each app adds one line —
`@import "@shared/toast/toast.css";` — to its global CSS.

## Contrast, and the gap this closed

`derivePalette` in `@cire/theme` enforces WCAG contrast on what it emits, but
`--color-error` and `--color-success` are walked against `card`
(`--color-surface`). **A toast paints on `--color-surface-raised`**, which is
derived as `card ± 0.05` lightness and sits outside that walk — the same gap
`RESIDUAL_PAIRS` documents for `ink` and `gilt`.

That was not theoretical. On the built-in **jewel** preset, `--color-success`
measures **4.29:1** against the raised surface — under the 4.5 text minimum.
Every jewel invite that raised an RSVP confirmation rendered a sub-threshold
green.

So `derivePalette` also emits `--toast-surface`, `--toast-ink`, `--toast-border`,
`--toast-error` and `--toast-success`: identical in hue and chroma to the page's
pair, so an organiser's red is still their red, but walked against the surface
the toast actually sits on. A scheme that already works gets its colours back
untouched (`evergreen`'s two pairs are byte-identical). Because the names are in
`DERIVED_TOKENS`, they ride the existing `ALLOWED_THEME_VAR_KEYS` allow-list, the
`styleAttr` injection gate and `applyPaletteToRoot`'s stale-key tracking — no new
CSS sink.

> [!warning]
> `derivePalette` emits `--toast-error` / `--toast-success`; the package reads
> `--toast-accent-error` / `--toast-accent-success`. `cire/invites`'s
> `global.css` aliases between them, and that alias is load-bearing: without it
> the package falls back to its built-in green, which measures **2.9:1** on
> evergreen's raised surface. The browser test below catches exactly this — it
> did, on its first run.

## Accessibility

- **Tone is never hue alone.** Each tone leads with a differently-*shaped* glyph
  (`✓ ✕ ! i`), `aria-hidden`, with an `sr-only` word read in its place —
  following `cire/host`'s `Notice.tsx`. `error` and `warning` are exactly the
  pair red-green colour blindness collapses.
- **Errors interrupt, confirmations wait.** `role="alert"` +
  `aria-live="assertive"` for `error`; `role="status"` + `polite` otherwise. The
  thing the user just did did not happen — that is worth interrupting for; a
  confirmation is not. Override per call with `politeness`.
- **The dwell pauses** on hover and on focus-within, so a toast can't expire
  mid-sentence.
- **Motion is opt-out at the source**, not only via an app's global clamp:
  animations collapse to ~0.01ms under `prefers-reduced-motion: reduce` (near-zero
  rather than `none`, so `animationend` listeners still fire).

## Mounting

One `<Toaster>` per page, as a sibling of your modals at the page root.

The container is `position: fixed` and **portalled to `<body>`**. That matters: a
`transform`, `filter`, `contain` or `will-change` on any ancestor makes that
ancestor the containing block for a fixed descendant — and a stacking context
with it — so a toast mounted inside an animated section is positioned against
that section and stacked inside it, below every page-level overlay, whatever
`z-index` it carries. That is exactly what put cire's RSVP toast behind the sheet
it fires under (Motion One leaves an inline `transform` on the events section).
The portal makes it robust by construction.

The package sets **no `z-index`**. Pass the layer as a class —
`class={Z_CLASS.TOAST}` — so it participates in the consumer's own stacking
order. For cire that order is `MODAL (100) < TOAST (150) < CONSENT (200)`; see
`cire/invites/src/lib/z-index.ts`.

Current mounts:

| App | Position | Notes |
|---|---|---|
| `@cire/invites` | `top-center` | Per design pack; `Z_CLASS.TOAST`, 4s dwell. The RSVP sheet's sticky bar owns the bottom edge |
| `@cire/host`, `@cire/vendor` | `bottom-right` | — |
| `@osn/social` | responsive | `top-center` on mobile with a `top` offset clearing the 3rem bar + `env(safe-area-inset-top)` |
| `@pulse/web` | `bottom-right` | — |

## Testing

Unit: mock `@shared/toast`. Two shared factories exist —
`cire/host/src/test-support/mocks.ts` (`toastMock()`) and
`pulse/web/tests/helpers/toast.ts` — see `[[testing-patterns]]`.

**The DOM contract, which is easy to break.**
`cire/invites/src/designs/InvitePage.browser.test.tsx` finds a toast with
`[...document.querySelectorAll("div")].find(d => d.textContent === message)` and
then walks parents until `position: fixed`. So the message must live in an
element whose `textContent` is **exactly** the message — the tone glyph and its
`sr-only` word are siblings *outside* it, deliberately. Fold them in and the
lookup breaks, taking the z-index regression guard with it.

`document.elementFromPoint` is useless against the container: it is
`pointer-events: none` and hit-testing sees straight through it. Assert computed
style, DOM position and containing-block ancestry instead.

**Contrast needs the browser tier.** jsdom parses no stylesheet, so every
`getComputedStyle` returns the empty string and a contrast assertion is
meaningless there. `InvitePage.browser.test.tsx` composites the painted toast on
a 1×1 canvas (`paintedBackdrop` / `paintedInk`) and asserts both the message and
the tone glyph clear 4.5:1 against the surface they land on. Compositing rather
than reading one node's colour is the point — `--toast-border` is an alpha
colour and Tailwind's `/12`-style modifiers compute to `color-mix` results Chrome
serialises as `oklab(… / .12)`. The canvas parses whatever `getComputedStyle`
returns, so no colour parser here has to keep up with CSS Color 4.

```bash
bun run --cwd shared/toast test:run
bun run --cwd cire/invites test:browser     # the contrast + stacking assertions
```

**By hand.** `bun run dev:lab` → **shared/toast** benches the half no assertion
reaches: how a toast enters and leaves, whether the tone glyphs are tellable
apart at a glance, how the stack behaves when five arrive at once, and what a
three-line message does to the layout. The lab borrows `@osn/social`'s
stylesheet — the one that maps the shadcn ramp onto `--toast-*` — so its
**light · dark** toggle re-themes toasts exactly as the app does, which is where
a too-dark accent shows up. See [[component-lab]].
