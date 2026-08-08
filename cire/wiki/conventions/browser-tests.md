---
title: "Browser Tests"
tags: [conventions, testing]
related:
  - "[[contributing]]"
  - "[[review-findings]]"
  - "[[index]]"
packages:
  - "@cire/invites"
  - "@cire/host"
last-reviewed: 2026-08-08
---

# Browser Tests

A second Vitest project — in `@cire/invites` and, since 2026-08-06, in
`@cire/host` — that runs a handful of tests in a **real Chromium** instead
of jsdom/happy-dom. Files are named `*.browser.test.ts(x)`.

```bash
bun run --cwd cire/invites test                 # fast tier (jsdom) — the default
bun run --cwd cire/invites test:browser         # browser tier
bun run --cwd cire/host test:run       # fast tier (happy-dom)
bun run --cwd cire/host test:browser   # browser tier
bun run test:browser                        # every package that has one (turbo)
```

The organiser's tier exists for one thing the portal has and the guest site
doesn't: **two ramps and mostly translucent ink tokens**. `tokens.test.ts`
measures the tokens as authored; only a browser can measure what an organiser's
screen ends up with once `bg-gold/12` over `bg-surface/30` over the page has
been composited under the text — which is exactly how the CSV panel's mandatory
column chips came to be marked in ink at **1.8:1** (dark) and **1.3:1** (light)
with a green suite. `ImportPanel.browser.test.tsx` measures the painted result
in both ramps; see the `paintedBackdrop` / `paintedInk` helpers there, which
composite on a 1×1 canvas rather than parsing colours by hand (the canvas parses
whatever syntax `getComputedStyle` returns — Tailwind's `/12` modifier computes
to a `color-mix` result Chrome serialises as `oklab(… / .12)`).

## Why it exists

jsdom computes **no CSS and no layout**. It never parses the stylesheet,
`getComputedStyle` returns roughly what was set inline, and
`getBoundingClientRect` is all zeroes. A whole class of this app's bugs is
therefore structurally invisible to the default tier — not hypothetically, but
in ways that have already shipped:

| Failure mode | Why jsdom can't see it |
|---|---|
| **#203** — the Add-to-Calendar popover shipped at `z-90`, below the `z-100` modal it opens from, so it painted behind the backdrop: invisible and unclickable | jsdom has no paint order. `z-index.test.ts` can only assert the *numbers* in `Z_LAYER` |
| A `Z_CLASS` entry naming a class Tailwind never emitted | The scanner only sees literal source text, so a concatenated class compiles to **no CSS at all**, silently. `expect(Z_CLASS.MODAL_POPOVER).toBe("z-110")` passes either way |
| An ancestor gaining a stacking context (`transform`, `filter`, `opacity < 1`, `contain`) and trapping a portalled overlay | Requires resolving containing blocks |
| Tailwind v4's `scale-*` setting the standalone `scale` property, not `transform` — so a `transition-transform` that didn't list `scale` animates nothing | Requires the compiled `transition-property` |
| Two conflicting utilities on one element resolving by **stylesheet order**, not class-attribute order | Requires the generated stylesheet |
| A `position: sticky` action bar resolving `bottom` against the scrollport (see `[[contributing]]` and the rule in `cire/CLAUDE.md`) | Requires layout |
| The global `prefers-reduced-motion` clamp actually applying | Requires the cascade plus media emulation |

The pre-existing answer to all of these is **text-matching drift guards** —
`styles/root-type-scale.test.ts`, `components/rsvp-responded.test.ts` (the
tick keyframe's drift guard — moved here from `rsvp-saved.test.ts` when the
recorded-reply confirmation itself moved off the Save button onto the events
section's Respond button, `claude/rsvp-respond-button-feedback-fop0di`,
2026-08-06),
`components/invite-theme.test.ts` all `readFileSync` a CSS file and regex it.
Those are still worth having: they are fast, and they catch a source change. But
they pin only that the source *says* the right thing, never that the render
*does*. This tier is the other half.

## What belongs here (and what doesn't)

Put a test here **only if it needs a real engine.** The browser tier is ~10x the
startup cost of jsdom and needs a downloaded Chromium; every test that could
have lived in the fast tier and didn't is a tax on every CI run.

Good reasons: computed style from a real stylesheet, real geometry
(`getBoundingClientRect`, `elementFromPoint`), paint/stacking order, sticky or
scroll behaviour, media-query emulation, focus behaviour that depends on real
layout.

Not reasons: component logic, props, ARIA attributes, event handlers, class
strings. Those all belong in the fast tier — and a class-contract assertion
there is a genuinely useful complement, because it names the mechanism while the
browser test proves the outcome. `RsvpModal.test.tsx` and
`RsvpModal.browser.test.tsx` are the worked example of that pairing.

## How it is wired

`cire/invites/vitest.config.ts` and `cire/host/vitest.config.ts` each define two
projects:

- **`unit`** — jsdom, `exclude`s `**/*.browser.test.{ts,tsx}`
- **`browser`** — `include`s only `src/**/*.browser.test.{ts,tsx}`, Playwright
  provider, headless Chromium

Naming rather than directory placement decides the project, so a file lands in
exactly one and neither glob can swallow the other's files. Browser tests sit
next to the code they cover, like every other test in the repo.

Both projects share `solidPlugin()` and `tailwindcss()`, so a browser test gets
the **same Tailwind build the app ships**. Import `../styles/global.css` at the
top of the file to have it applied.

### Two provider gotchas

Both cost real time to rediscover:

- **`launchOptions` belongs to the provider**, i.e. `playwright({ launchOptions })`
  — not to an entry in `browser.instances`, where it is accepted and silently
  ignored.
- **`headless` must sit at `browser` level**, not inside `instances`
  ([vitest-dev/vitest#7661](https://github.com/vitest-dev/vitest/issues/7661)).

### Rendering

`@solidjs/testing-library` works unchanged in browser mode — same `render`,
same queries, same `cleanup`. There is no separate render API to learn and no
`vitest-browser-solid` dependency; a browser test reads like every other
component test in the package.

### Media emulation

`prefers-reduced-motion` and `prefers-color-scheme` are properties of the browser
*context*, so nothing inside the page can change them.
`src/test-support/browser-commands.ts` registers an `emulateMedia` browser
command that runs in the node process with the Playwright `page` handle:

```ts
await emulate({ reducedMotion: "reduce" });
```

Always restore it in an `afterEach` — the context is shared across tests in a
file, so a leaked preference silently rewrites every later assertion about
motion. A second `browser.instances` entry with `contextOptions.reducedMotion`
would also work, but runs the *entire* suite twice to serve the few tests that
care.

The organiser's copy of the command also takes `colorScheme` (its two ramps are
`prefers-color-scheme` plus a `data-theme` override, and the ink contract has to
hold in both), and augments Vitest's `BrowserCommands` interface so `commands`
is typed at the call site rather than cast — `@cire/invites`'s copy predates that
and still casts.

## Running it locally

Nothing extra on a normal machine — `playwright` is a devDependency of
`@cire/invites` and `bunx playwright install chromium` fetches the browser once.

Dev containers and this repo's cloud sessions ship a **prebuilt Chromium** whose
build number won't match the pinned Playwright, which otherwise makes the tier
unrunnable there short of a ~300MB download. Point it at the existing binary:

```bash
VITEST_BROWSER_EXECUTABLE_PATH=/opt/pw-browsers/chromium bun run test:browser
```

The variable is declared in `turbo.json` under `passThroughEnv`, not `env` — it
says *where* Chromium is, never *what* the tests assert, so it must not enter
the cache key.

## CI

A separate step in `.github/workflows/ci.yml`, after the D1 step and for the
same reason: it needs a dependency the default path doesn't, and splitting it
keeps the fast tier fast.

```yaml
- name: Install Chromium for browser tests
  run: bunx playwright install --with-deps chromium

- name: Browser tests
  run: bun run test:browser
```

`--with-deps` is required on `ubuntu-latest` — the browser alone won't launch
without its shared libraries. Only `chromium` is installed: the tier pins a
single instance, so pulling Firefox and WebKit too would triple the download for
nothing.

## Current coverage

| Package | File | Pins |
|---|---|---|
| `@cire/invites` | `src/lib/z-index.browser.test.tsx` | Every `Z_CLASS` entry emits real CSS; a modal-launched popover hit-tests **above** the modal (#203); no ancestor traps it in a stacking context; the modal blocks page content beneath it |
| `@cire/invites` | `src/components/RsvpModal.browser.test.tsx` | The sticky action bar sits on the scrollport's bottom edge, stays put while content scrolls under it, runs full-bleed to the panel's content box, and both buttons are the topmost element at their own centre |
| `@cire/invites` | `src/styles/reduced-motion.browser.test.tsx` | The clamp applies to transitions *and* animations, `animate-spin` keeps its documented exemption, and a clamped transition still lands on its end state and fires `transitionend` |
| `@cire/invites` | `src/components/EventCard.browser.test.tsx` | The RSVP confirmation fill **travels** (mid-sweep scale strictly between 0 and 1, so the transition is wired to the property Tailwind actually writes), lands on the `bloom` token, and is still painted seconds past `TOTAL_DURATION_MS`; a reply already on file paints filled on the first frame; the two `scale-x-*` utilities never coexist |
| `@cire/invites` | `src/components/rsvp-confirmation.browser.test.tsx` | The same fill, driven through the real `RsvpModal` → `EventCard` seam on real timers: nothing shows while the sheet still covers the button, a partial save leaves it plain, and a completing save's fill survives 5s+ |
| `@cire/invites` | `src/designs/InvitePage.browser.test.tsx` | The confirmation and the save toast inside the page they ship in, `describe.each`'d over **both** design packs — including the first-visit path, where Motion One's reveal has left its inline `transform` on the events section. The toast must have no fixed-position containing block between it and `<body>`, must stack above `Z_LAYER.MODAL` **and below `Z_LAYER.CONSENT`**, and must be anchored to the viewport |
| `@cire/host` | `src/components/ImportPanel.browser.test.tsx` | The mandatory-column chip's ink clears WCAG against the composited stack it actually sits on; the first-run `attention-glow` exists, animates `opacity` only, and honours the reduced-motion clamp |
| `@cire/host` | `src/components/PreviewInviteButton.browser.test.tsx` | "Preview invite" is genuinely painted at phone width with its label clipped to the 1×1 `sr-only` box rather than `display: none`, and swaps to the written label — glyph gone — once the `frame` container passes 42rem |

Three of these were verified against the bug rather than merely written green.
The #203 test fails when the popover is put back at `z-90`. The
`PreviewInviteButton` test fails when its label is put back to
`hidden @2xl/frame:inline`, the exact class pair that left the invite preview
with no entry point on a phone — the failure is the narrow-width case, which is
the one a class-string assertion in the fast tier cannot distinguish. The
`InvitePage` toast test fails when the `<Toaster>` is put back inside the events
section: on the first-visit path it reports the section itself as the toast's
containing block, which is precisely why the toast was painting behind the RSVP
sheet.

The `EventCard` pair exists because of a **two-PR miss**. The RSVP
confirmation's fill was reported as reverting twice in a row while every test in
the repo stayed green, because every assertion about it was class-presence in
happy-dom — the fill's whole job is a painted colour a second later, and nothing
measured that. Note also what the browser tier does NOT relieve you of: the
`elementFromPoint` trick used elsewhere on this page is useless against a
`solid-toast` container, which is deliberately `pointer-events: none` and so
hit-tests as transparent even when painted perfectly. Assert the mechanism
(containing block, stacking context, computed `z-index`) in that case, not the
hit test.

**Two timing rules this tier learned the hard way**, both from the same branch:

- **An assertion that can only fail LATE belongs in `vi.waitFor`, not behind a
  sleep.** The RSVP fill's end state is permanent, so waiting longer can never
  overshoot it, while a sleep sized to `SAVED_DWELL_MS + SWEEP_DURATION_MS` has
  only its slack to absorb one long task and otherwise samples the sweep
  mid-travel. Pass an explicit `timeout` — the 1000ms default is shorter than the
  ~1400ms choreography it has to outlast. An assertion that must hold EARLY (a
  ceiling: "the fill is still 0 while the sheet is up") gets anchored to the
  state that defines the window instead — the sheet's label flipping to "Saved" —
  because a stall would otherwise let the dwell fire first and quietly make the
  assertion vacuous.
- **To sample a transition mid-flight, drive it, don't race it.**
  `fill.getAnimations()[0]`, then `pause()` and set `currentTime`. A
  `wait(duration / 2)` is the one assertion shape here with a hard *upper* bound,
  and it was guarding the silently-failing mechanism (Tailwind v4's `scale-*`
  writes the standalone `scale` property, so a `transition-transform` that
  stopped listing `scale` animates nothing). A flaky test protecting a silent
  failure is the worst combination — it gets skipped rather than fixed. Assert
  `transitionDuration` first, so a clamped transition fails on its cause rather
  than as a confusing `scale === 1`.
