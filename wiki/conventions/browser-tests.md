---
title: "Browser Tests"
tags: [conventions, testing]
related:
  - "[[contributing]]"
  - "[[review-findings]]"
  - "[[testing-patterns]]"
packages:
  - "@cire/invites"
  - "@cire/host"
  - "@musubi/social"
  - "@pulse/web"
  - "@shared/ui"
last-reviewed: 2026-10-27
---

# Browser Tests

A second Vitest project — in `@cire/invites`, in `@cire/host` since 2026-08-06,
and in `@musubi/social` and `@pulse/web` since 2026-09-16 — that runs a handful
of tests in a **real Chromium** instead of jsdom/happy-dom. Files are named
`*.browser.test.ts(x)`.

```bash
bun run --cwd cire/invites test                 # fast tier (jsdom) — the default
bun run --cwd cire/invites test:browser         # browser tier
bun run --cwd cire/host test:run       # fast tier (happy-dom)
bun run --cwd cire/host test:browser   # browser tier
bun run --cwd musubi/social test:browser
bun run --cwd pulse/web test:browser
bun run test:browser                        # every package that has one (turbo)
```

> [!important] Every primitive carries `transition-colors`, so a theme flip lags
> the assertion.
> `getComputedStyle` read immediately after toggling `.dark` returns the value
> part-way through the transition — at t=0, the **old** colour. A test that
> switches themes and measures must kill transitions first
> (`*, *::before, *::after { transition: none !important }` injected in
> `beforeAll`). Without it the assertion fails while the token chain underneath
> is entirely correct, and the failure points at the wrong thing.

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

| Failure mode                                                                                                                                                  | Why jsdom can't see it                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#203** — the Add-to-Calendar popover shipped at `z-90`, below the `z-100` modal it opens from, so it painted behind the backdrop: invisible and unclickable | jsdom has no paint order. `z-index.test.ts` can only assert the _numbers_ in `Z_LAYER`                                                                                      |
| A `Z_CLASS` entry naming a class Tailwind never emitted                                                                                                       | The scanner only sees literal source text, so a concatenated class compiles to **no CSS at all**, silently. `expect(Z_CLASS.MODAL_POPOVER).toBe("z-110")` passes either way |
| An ancestor gaining a stacking context (`transform`, `filter`, `opacity < 1`, `contain`) and trapping a portalled overlay                                     | Requires resolving containing blocks                                                                                                                                        |
| Tailwind v4's `scale-*` setting the standalone `scale` property, not `transform` — so a `transition-transform` that didn't list `scale` animates nothing      | Requires the compiled `transition-property`                                                                                                                                 |
| Two conflicting utilities on one element resolving by **stylesheet order**, not class-attribute order                                                         | Requires the generated stylesheet                                                                                                                                           |
| A `position: sticky` action bar resolving `bottom` against the scrollport (see [[frontend-patterns]] § Rendering and animation gotchas)                       | Requires layout                                                                                                                                                             |
| The global `prefers-reduced-motion` clamp actually applying                                                                                                   | Requires the cascade plus media emulation                                                                                                                                   |
| An `sr-only` control resolving against a distant positioned ancestor, so focusing it scrolls a whole dialog sideways (see [[frontend-patterns]] § Rendering and animation gotchas) | Requires containing blocks, scroll offsets and the browser's own focus-scroll                                                                                               |
| `overflow: hidden` still being a scroll container, and `overflow-x: clip` computing to `hidden` beside an `auto` axis                                         | Requires computed values and a real scroll offset                                                                                                                           |

The pre-existing answer to all of these is **text-matching drift guards** —
`styles/root-type-scale.test.ts`, `components/rsvp-responded.test.ts` (the
tick keyframe's drift guard — moved here from `rsvp-saved.test.ts` when the
recorded-reply confirmation itself moved off the Save button onto the events
section's Respond button, `claude/rsvp-respond-button-feedback-fop0di`,
2026-08-06),
`components/invite-theme.test.ts` all `readFileSync` a CSS file and regex it.
Those are still worth having: they are fast, and they catch a source change. But
they pin only that the source _says_ the right thing, never that the render
_does_. This tier is the other half.

## What belongs here (and what doesn't)

Put a test here **only if it needs a real engine.** The browser tier is ~10x the
startup cost of jsdom and needs a downloaded Chromium; every test that could
have lived in the fast tier and didn't is a tax on every CI run.

Good reasons: computed style from a real stylesheet, real geometry
(`getBoundingClientRect`, `elementFromPoint`), paint/stacking order, sticky or
scroll behaviour, media-query emulation, focus behaviour that depends on real
layout, and what Chrome's accessibility tree exposes, which both CSS and
Chrome's own mapping of HTML change ([[#Chrome's accessibility tree]]).

Not reasons: component logic, props, ARIA attributes, event handlers, class
strings. Those all belong in the fast tier — and a class-contract assertion
there is a genuinely useful complement, because it names the mechanism while the
browser test proves the outcome. `RsvpPanel.test.tsx` and
`RsvpPanel.browser.test.tsx` are the worked example of that pairing.

## How it is wired

`cire/invites/vitest.config.ts` and `cire/host/vitest.config.ts` each define a
`unit` and a `browser` project, and `cire/invites` adds a third, `ssr`:

- **`unit`** — jsdom, `exclude`s `**/*.browser.test.{ts,tsx}` (and, in
  `cire/invites`, `**/*.ssr.test.{ts,tsx}`)
- **`browser`** — `include`s only `tests/**/*.browser.test.{ts,tsx}`, Playwright
  provider, headless Chromium
- **`ssr`** (`cire/invites`) — `include`s only `tests/**/*.ssr.test.{ts,tsx}`,
  Node, Solid's server build; see [[cire-development#Tests]]

Naming rather than directory placement decides the project, so a file lands in
exactly one and no glob can swallow another's files. Browser tests live
in the package's `tests/` tree beside their fast-tier siblings, like every other
test in the repo — #867 moved the whole cire suite there, and a browser test
left next to its component matches no glob and silently never runs.

`unit` and `browser` share `solidPlugin()` and `tailwindcss()`, so a browser test gets
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

The shared-factory idiom `cire/host/tests/test-support/mocks.ts` documents for
the fast tier —

```ts
vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});
```

— is **fast-tier only**. In the `browser` project the factory is resolved
before the imported module exists, so the dynamic `import()` inside it never
lands. A browser-tier file writes its `vi.mock` factories **literally**
instead, with `vi.hoisted` for anything the factory needs to close over. The
failure mode is a run-level error in the mocker, naming neither the test nor
the file, and its text blames top-level variables — which is not the cause:

```
Error: [vitest] There was an error when mocking a module. If you are using "vi.mock" factory, make sure there are no top level variables inside, since this call is hoisted to top of the file.
```

The same error appears whenever a factory throws, so it says only that some
factory failed.

`vi.importActual` of the module being mocked does work in this tier. A literal
factory spreads the real `lib/api` exactly as a fast-tier one does
([[testing-patterns#Shared test harnesses]]);
[`ImportPanel.browser.test.tsx`](../../cire/host/tests/components/ImportPanel.browser.test.tsx)
and
[`PreviewInviteButton.browser.test.tsx`](../../cire/host/tests/components/PreviewInviteButton.browser.test.tsx)
both do. What fails is importing a different module inside the factory.

### Media emulation

`prefers-reduced-motion` and `prefers-color-scheme` are properties of the browser
_context_, so nothing inside the page can change them.
`tests/test-support/browser-commands.ts` registers an `emulateMedia` browser
command that runs in the node process with the Playwright `page` handle:

```ts
await emulate({ reducedMotion: "reduce" });
```

Always restore it in an `afterEach` — the context is shared across tests in a
file, so a leaked preference silently rewrites every later assertion about
motion. A second `browser.instances` entry with `contextOptions.reducedMotion`
would also work, but runs the _entire_ suite twice to serve the few tests that
care.

The organiser's copy of the command also takes `colorScheme` (its two ramps are
`prefers-color-scheme` plus a `data-theme` override, and the ink contract has to
hold in both) and `media` (`"print"` lays the page out as it prints, `null` puts
the screen back — the seating chart's print sheet is checked this way), and
augments Vitest's `BrowserCommands` interface so `commands` is typed at the call
site rather than cast — `@cire/invites`'s copy predates that and still casts.

### Width

Unlike the media preferences above, width is **not** a property of the browser
context, so it needs no command. `page.viewport(width, height)` from
`vitest/browser` resizes the iframe the tests render into, and everything inside
it — `innerWidth`, `getBoundingClientRect`, `clientWidth`, media queries — is the
CSS pixels asked for. A `<dialog>` opened with `showModal()` follows, because its
containing block is that same viewport. The Playwright provider resizes the
page to match (`setViewportSize`), and a headless run leaves the iframe
unscaled at the page's origin, so a CDP input event's `x` and `y` are the
iframe's own CSS pixels — what `SeatingView.browser.test.tsx` and
`ImageCropModal.browser.test.tsx` pass straight from `getBoundingClientRect`.
Only Vitest's browser UI (`browser.ui`) CSS-scales the iframe to fit its panel,
and there those coordinates miss.

Two rules, both cheap to get wrong:

- **Every `it` sets its own viewport.** It persists for the rest of the file, so
  otherwise the order tests happen to run in decides what they measure.
- **Render after the resize, not before.** A component rendered at the previous
  width plays its entry transition against a box that is about to change.

And one that is not about the viewport at all but bites the same tests: **await
`document.fonts.ready` before measuring anything text-shaped.** The invite's
faces are self-hosted, and a line count taken against the fallback metrics is a
different number.

**This Chromium never shows a scrollbar.** Playwright launches headless
Chromium with `--hide-scrollbars`, so `innerWidth` equals
`document.documentElement.clientWidth` at every width, even on a page that
overflows or carries `overflow-y: scroll`. A test that compares widths with and
without a scrollbar passes whatever the code does. A test of code that
branches on a visible scrollbar stubs the one reading the code makes
(`vi.stubGlobal("innerWidth", clientWidth + 15)`) and measures everything else in
the engine, as `AnimatedModal.browser.test.tsx` does. A sideways shift on a
desktop with classic scrollbars stays a manual check.

*Measured 2026-10-21 — `AnimatedModal.browser.test.tsx` probes at 414×896 and 1280×800, Chromium 1194: `innerWidth` = `clientWidth` with a 4000px page; a `scrollbar-gutter: stable` root narrows a full-width block 1024 → 1009px*

**A gutter's width depends on the machine's scrollbars.** Hidden is not
overlay: `scrollbar-gutter: stable` reserves a classic scrollbar's width,
hidden or not, and nothing for an overlay scrollbar. Chromium on Linux, CI
included, uses classic scrollbars, and the root's gutter takes 15px there: the
1024 → 1009px above, measured with Chromium 1194, the Linux build cloud
sessions provide ([[#Running it locally]]). On macOS with "Show scroll bars"
left at "Automatically based on mouse or trackpad" and no mouse connected,
Chromium uses overlay scrollbars and the root's gutter takes 0px. In this tier a page rule does not change that: a
`::-webkit-scrollbar` width gives a `<div>`'s gutter 15px and leaves the root's
at 0. So a test never assumes a gutter narrows the page. It measures the root's
gutter in the engine first (set the same properties, read the width, put them
back), asserts against that, and also asserts the computed `scrollbar-gutter`,
the only evidence left where the gutter takes no width. `rootGutter` in
`AnimatedModal.browser.test.tsx` is the worked example.

*Verified 2026-10-21 — CI run 39613801944 on `main` at `da153aff3` (ubuntu, `chromium_headless_shell-1234`): its Browser tests step passed while `AnimatedModal.browser.test.tsx` asserted that the open page was narrower than before*

*Measured 2026-10-22 — a throwaway test in `cire/invites`, `bunx --bun vitest run --project browser`, at 414×896, macOS 27.0.1 on Apple silicon with `AppleShowScrollBars` unset (the default), `chromium_headless_shell-1234` (HeadlessChrome 151.0.7922.34): the root given `overflow: hidden; scrollbar-gutter: stable` left `<body>` at 414px with no scrollbar rule and with each of `::-webkit-scrollbar`, `html::-webkit-scrollbar`, `body::-webkit-scrollbar` and `:root::-webkit-scrollbar` set to `{ width: 15px }`; a `<div>` 200px wide with the same two properties had a `clientWidth` of 200 with no rule and 185 under `::-webkit-scrollbar { width: 15px }`. Through the wrapper below, with no rule, `<body>` went to 399px and the `<div>` to 185*

**Classic scrollbars on a Mac.** To run the tier with the scrollbars CI has,
point `VITEST_BROWSER_EXECUTABLE_PATH` at an executable wrapper that hands
Chromium `-AppleShowScrollBars Always`. Playwright refuses that pair in
`launchOptions`, because it reads an argument without a leading dash as a page
to open. This works in fish and bash; the build number moves with Playwright
(`ls ~/Library/Caches/ms-playwright`), and an Intel Mac's folder is
`chrome-headless-shell-mac-x64`:

```sh
printf '%s\n' '#!/bin/sh' \
  'exec ~/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell "$@" -AppleShowScrollBars Always' \
  > /tmp/chromium-classic.sh
chmod +x /tmp/chromium-classic.sh
VITEST_BROWSER_EXECUTABLE_PATH=/tmp/chromium-classic.sh bun run --cwd cire/invites test:browser
```

### Chrome's accessibility tree

Testing Library and the `page` locators compute accessible names in JavaScript,
from the DOM. They cannot say what Chrome itself hands a screen reader, and
three things change it. Chrome carries a `text-transform` into the text it
exposes, so text inside an `uppercase` badge reaches a screen reader in
capitals. It exposes a `title` on a plain `<span>` as that span's description,
on top of any text inside it. And it exposes the node an `aria-describedby`
names as a description too, even when that node is `aria-hidden`. Capitals
matter for a hidden sentence, not a one-word label; the badge section of
[[frontend-patterns]] says why.

*Measured 2026-10-19 — `bun run --cwd cire/host test:browser tests/components/RsvpView.badges.browser.test.tsx`, once with a badge's `normal-case` removed and once with a `title` added back*

*Measured 2026-10-20 — the same command, once with `Tooltip`'s trigger keeping Kobalte's `aria-describedby` and once with `aria-hidden` taken off its panel*

To read Chrome's own tree, `cdp()` from `vitest/browser` opens a DevTools
Protocol session. The test renders inside an iframe and the top-level frame
holds only the runner, so find the frame whose URL is the test's own
`location.href` in `Page.getFrameTree`, then pass its id to
`Accessibility.getFullAXTree`.
[`RsvpView.badges.browser.test.tsx`](../../cire/host/tests/components/RsvpView.badges.browser.test.tsx)
is the worked example. It counts descriptions on every node, ignored ones
included, so an element Chrome leaves out of the tree cannot hide one.

## Running it locally

Nothing extra on a normal machine — `playwright` is a devDependency of
`@cire/invites` and `bunx playwright install chromium` fetches the browser once.
On a Mac, the same variable as below runs the tier with classic scrollbars
([[#Width]]).

Dev containers and this repo's cloud sessions ship a **prebuilt Chromium** whose
build number won't match the pinned Playwright, which otherwise makes the tier
unrunnable there short of a ~300MB download. Point it at the existing binary:

```bash
VITEST_BROWSER_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome bun run test:browser
```

The path is the **binary**, not the `/opt/pw-browsers/chromium` symlink beside
it: Playwright appends its own suffix to whatever it is given, so the symlink
fails with `executable doesn't exist at /opt/pw-browsers/chromium/chrome-linux/chrome`
— a message that reads like a missing browser rather than a wrong path, and has
twice been taken for the tier being unrunnable here. It is runnable.

The build number moves. `ls /opt/pw-browsers` and use what is there; do not run
`playwright install`, which is what the prebuilt browser exists to avoid.

_Verified 2026-09-18 — `VITEST_BROWSER_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome bun run --cwd cire/host test:browser`, against a pinned Playwright that wants 1234._

The variable is declared in `turbo.json` under `passThroughEnv`, not `env` — it
says _where_ Chromium is, never _what_ the tests assert, so it must not enter
the cache key.

A failing test leaves a screenshot of the page as it failed, at
`<package>/.vitest/attachments/failure-screenshots/<test file>/<full test name>.png`,
with every non-word character in the name turned into `-`.
Look there before re-running a failure that only Chromium shows. `.vitest/` is
gitignored.

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

| Package          | File                                                    | Pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cire/invites`  | `tests/lib/z-index.browser.test.tsx`                    | Every `Z_CLASS` entry emits real CSS; a modal-launched popover hit-tests **above** the modal (#203); no ancestor traps it in a stacking context; the modal blocks page content beneath it                                                                                                                                                                                                                                                                                                                                                                                                            |
| `@cire/invites`  | `tests/components/DietaryPresets.browser.test.tsx`      | On a phone the dietary picker's preset track overflows **inside** the sheet rather than widening it (a `<fieldset>` sizes to its content unless every box down to the scrollport may be narrower than what it holds); from `md:` (1024 and 1440px) the pills wrap into rows of several inside the same 480px sheet, every pill inside the track with nothing to scroll sideways, a stored unknown key's pill included; at 767px the sheet is still a bottom sheet with a sideways track and at 768px a centred panel with wrapped pills, so the picker's switch and the sheet's stay on one breakpoint. The picker stays inline at desktop width — a `showModal()` dialog paints above every stacking context, so a portalled popover opened from inside it would be unreachable at any z-index; and on a phone, ticking a pill after scrolling the track sideways leaves the sheet where it was, because each hidden `sr-only` checkbox resolves inside its own pill rather than against the `<dialog>` (measured without that, when the track scrolled at every width: `dialog.scrollLeft` 0 → 1213 at 1024px, 0 → 1182 at 414px). Plus a hit test on a phone that the close chip still paints over sixteen now-positioned pills |
| `@cire/invites`  | `tests/components/DietaryOther.browser.test.tsx`        | The "Anything else" field opens on a real `grid-template-rows` transition when "Other" is ticked, is simply open with no transition for a reply that already carries prose, and leaves the document at once when "Other" is unticked — so nothing focusable survives inside a collapsing box                                                                                                                                                                                                                                                                                                         |
| `@shared/ui`     | `tests/modal.browser.test.tsx`                          | Among the platform behaviours `<dialog>` is chosen for: that a `frame` panel computes `clip` on **both** axes and so is not a scroll container — a `scrollIntoView` on a descendant outside it leaves `dialog.scrollLeft` at 0, which `overflow: hidden` does not; and that a close finishes while an endless animation, such as a loading spinner, is still running inside the dialog                                                                                                                                                                                                                                                                                                                                    |
| `@cire/invites`  | `tests/components/RsvpPanel.browser.test.tsx`           | The RSVP form's sticky action bar, in its sheet, sits on the scrollport's bottom edge, stays put while content scrolls under it, runs full-bleed to the panel's content box, and both buttons are the topmost element at their own centre                                                                                                                                                                                                                                                                                                                                                                                       |
| `@cire/invites`  | `tests/components/EventSheet.browser.test.tsx`          | The event sheet's two panels ([[cire-invite-designs#The event sheet]]): from the details to the form and back inside one `:modal` dialog, the hidden panel `display: none`, focus on each new panel's title (an `<h2>` in the bar), an answer and typed text still there on return; Escape from either panel hands focus back to the card button that opened it; the scroll goes back to the top of the new panel. The form slides in from the end and the details from the start, paused at t=0 to read the offset; mid-slide the arriving panel takes no pointer input and the scrollport has nothing to scroll sideways, and both limits lift once it settles; the panel the sheet opens on does not slide; the sheet keeps one height, read on every frame of a journey by the badge and by swipe opened on either panel, for a sparse event and a full one at 390×844, 1280×800 and 1280×720, within 1px of its height, with the details' facts 1.25rem under the bar and a screenshot of each panel under `__screenshots__/`; a full event's details and form scroll to their ends with the details' bottom padding under their last line and the last guest above the form's bar; the form's action bar sits on the scrollport's edge after a switch, and mid-drag, with the arriving panel ending on that edge and adding no scroll height, when a swipe draws the form in beside a short details panel or a scrolled long one; under emulated reduced motion the switch is instant; a spinner still turning inside the arriving panel does not hold its input off; a switch back mid-slide keeps the new slide's limits; a double tap on Give RSVP leaves the sheet on the form for a party and for a household of one, the second tap landing on the same badge, now See details; the badge on both panels and Add to Calendar are 44px targets at phone width, the badge centred level with the close button, a pill filled like it whose hairline reaches full strength under a hovering pointer, and the details' facts below the bar, which stays inside the sheet's edges, at 320px. The bar: unmoved while a full event's details scroll 200px under it at 390×844 and 320×568, the facts beneath it in `elementsFromPoint` with the bar on top, with screenshots at rest, scrolled and on the form; on every scheme a computed `backdrop-filter` blur and a fill neither clear nor opaque, the title and the badge's words at 4.5:1 and the cross at 3:1 over `#000` and `#fff` composited through every fill from the bar down, and a scrolled screenshot per scheme; at 390×844 and 320×568, for a short name and a long one, beside Give RSVP, See details and View your RSVP: the title, the badge and the cross in a row inside the bar, the badge's words whole at 44px, the cross 44px, the whole name with no horizontal or vertical overflow and no ellipsis, no closing punctuation on a line apart from the character before it (each character's `Range` box; red with the title at `text-ui-lg` on every width), and the scrollport's computed `scroll-padding-top` at the bar's height, with a screenshot of each; the title's font size a step smaller at 379px than at 390px; at 320px the long name on more than one line, the bar taller than its 3.75rem floor and the facts 1.25rem under it; Shift+Tab from Save up a ten-guest form under that bar until a control above the view is reached, no control on the way parked under the bar (red with the scroll padding removed, and with it fixed at the floor); past the deadline, the facts 1.5rem under the closed notice; neither panel's text names a panel, and the title's spoken prefix is clipped to 1px. The badge's words: mid-drag at 20px and 60px holds, each label moved by the finger's share of its own width (±5%) and faded by it (±0.05), the details' out by the start and the form's in from the end, both partly shown through the badge's window and not overlapping, and neither answering `elementsFromPoint` 1px outside the window (red without the clip), with `data-dragging` set and no transition; at a 45% hold both opacities between 0.3 and 0.7; back to 1 and 0 when the drag is cancelled, swapped after a swipe and back after the swipe home, easing on `opacity` and `transform` after a press, and with no transition when the sheet opens on the form; the badge's width the same at rest on both panels and mid-drag; and screenshots of the badge on the details, mid-swipe and on the form at 390px. Focus after a switch: the arriving title marked `data-quiet-focus` and drawn with no outline after a swipe and after a click, not after Enter on the badge, which matches `:focus-visible` and paints the ring on a title inside the bar, while the same title with the mark computes `outline-style: none`; the mark goes on blur; a drag clears a text selection and the panels are `user-select: none` until it settles, with the rail and the title at a transparent `-webkit-tap-highlight-color` |
| `@cire/invites`  | `tests/components/AnimatedModal.browser.test.tsx`       | The guest sheet in an engine: opened with `showModal()` (`:modal`, the top layer); first focus on the scrollport, not the close button nor a toolbar's action, with and without a toolbar; Escape closes it and says so; focus goes back to whatever opened it; the panel capped at 480 real pixels on both sides of the root font-size step. The page lock on the root element: wheels over the close button and over the dialog leave `scrollY` at 0 with the root at `overscroll-behavior: none`, closing restores the root's inline `overflow` and `overscroll-behavior` and the page scrolls again, and a page scrolled to 300px is still at 300px after the sheet closes. The scrollbar gutter: a page that shows no scrollbar (this engine shows none on the root) keeps its width and `scrollbar-gutter: auto` while the sheet is open; with `innerWidth` stubbed 15px wider than the root, as a classic scrollbar reports, the root computes `scrollbar-gutter: stable` while open and narrows by the gutter the engine measures for it (a classic scrollbar's width on Linux, none where scrollbars overlay the page), and closing gives back its full width and `auto` |
| `@cire/invites`  | `tests/styles/reduced-motion.browser.test.tsx`          | The clamp applies to transitions _and_ animations, `animate-spin` keeps its documented exemption, and a clamped transition still lands on its end state and fires `transitionend`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@cire/invites`  | `tests/components/EventCard.browser.test.tsx`           | The RSVP confirmation fill **travels** (mid-sweep scale strictly between 0 and 1, so the transition is wired to the property Tailwind actually writes), lands on the `bloom` token, and is still painted seconds past `TOTAL_DURATION_MS`; a reply already on file paints filled on the first frame; the two `scale-x-*` utilities never coexist                                                                                                                                                                                                                                                     |
| `@cire/invites`  | `tests/components/rsvp-confirmation.browser.test.tsx`   | The same fill, driven through the real `RsvpPanel` → `EventCard` seam on real timers: nothing shows while the sheet still covers the button, a partial save leaves it plain, and a completing save's fill survives 5s+                                                                                                                                                                                                                                                                                                                                                                               |
| `@cire/invites`  | `tests/designs/InvitePage.browser.test.tsx`             | The confirmation and the save toast inside the page they ship in, `describe.each`'d over **both** design packs — including the first-visit path, where Motion One's reveal has left its inline `transform` on the events section. The toast must have no fixed-position containing block between it and `<body>`, must stack above `Z_LAYER.MODAL` **and below `Z_LAYER.CONSENT`**, and must be anchored to the viewport                                                                                                                                                                             |
| `@cire/invites`  | `tests/designs/InviteHeader.browser.test.tsx` | The hero's scroll cue in **both** packs at 390 and 1440px: its entry holds it at opacity 0 through the 1s delay, and once played it is painted, on screen, inside the hero, and centred (classic) or on the 1.5rem gutter (gala); its drift really moves `transform` 6px, twice, and the fade and drift together last under WCAG 2.2.2's five seconds, leaving the cue still and in view with no animation left in effect; the first scroll fades it out (held mid-fade it is part-way, so it is a fade and not a blink) and pauses the drift, and scrolling back to the top leaves it hidden; it sits below the title block even when a long title grows the hero past the viewport; and under emulated reduced motion it is painted, still and untransformed, and still hides on scroll. With a two-name title at 320x568, 375x667, 390x844, 844x390 and 1440x900, the consent prompt is a `:modal` dialog with no banner, no layout shift is recorded as it arrives, the cue rests on the hero's foot clear of the title, and after "Reject all" the hero's own content is what hit-tests at the on-screen part of the title and the cue. On a hero with no couple title at 320x568 and 1440x900, both strings share one grid cell as tall as the taller, the shorter centred (classic) or on the cell's foot (gala); turning to the welcome-back title records no `layout-shift` entry and moves neither the title block nor the subtitle, and only the painted title is accessible before and after (`isInaccessible`, the other `visibility: hidden`). A control case shows the observer does report a shift in this frame when a painted box moves |
| `@cire/invites`  | `tests/components/consent/ConsentBanner.browser.test.tsx` | The first-layer consent prompt against a real `<dialog>`: a `:modal` dialog at 390 and 1440px with no banner; it opens with focus on its heading, the page behind cannot take focus, and Tab walks the privacy and terms links and then "Accept all", "Reject all" and "Choose", in that order; both links are on screen and the top element at their centre; two real Escapes fire no `cancel` at all (`closedby="none"`) and leave the same dialog open; a click dispatched outside the panel leaves it open; a `close()` forced on it brings a new dialog up at once with focus on its heading; an answer closes it for good; all three answers are painted alike — same type, box and colours, same height — in that reading order, at 320, 390 and 1440px; "Choose" leaves exactly one `:modal` dialog, the preferences one, of the same width and holding focus, and its Escape brings the prompt back on its heading; an answer, direct or through "Save choices", gives focus back to the field that held it before the prompt arrived; the prompt opens above a sheet already open and leaves the sheet modal and usable once answered; and `prompt="banner"` shows the banner with no dialog, which at the end of a legal page leaves the footer's "Privacy Choices" uncovered at 320 and 390px and keeps every link Tab reaches clear of it |
| `@cire/host`     | `tests/components/ImportPanel.browser.test.tsx`         | The mandatory-column chip's ink clears WCAG against the composited stack it actually sits on; the first-run `attention-glow` exists, animates `opacity` only, and honours the reduced-motion clamp                                                                                                                                                                                                                                                                                                                                                                                                   |
| `@cire/host`     | `tests/components/invite/gold-label-preview.browser.test.tsx` | The colour-scheme preview and the events-section sample paint their "Respond" chip in the invite's derived gold and `--color-on-gold` on chapel and garden, not the page colour or the portal's own `--color-on-gold`. Verified against the bug: with the chips' label set back to `--color-bg`, all four fail |
| `@musubi/social` | `tests/styles/token-contract.browser.test.tsx`          | A contract utility emits CSS **at all** (an unresolvable one emits nothing, silently); `bg-ui-accent` paints exactly what `--primary` holds; the destructive button's ink comes from `--destructive-foreground` rather than the `text-white` it used to hard-code; the mapping follows `.dark` because it is aliases and not literals; `base:` still compiles to `:where(…)`, so a call-site `class` still wins                                                                                                                                                                                      |
| `@pulse/web`     | `tests/styles/token-contract.browser.test.tsx`          | The same chain on a different ramp, plus the mapping decision that only a colour can check: `--ui-accent` paints `--primary` and **not** the coral `--pulse-accent`, so nobody can "fix" the mapping to the brand colour and repaint every shared button                                                                                                                                                                                                                                                                                                                                             |
| `@cire/host`     | `tests/components/PreviewInviteButton.browser.test.tsx` | "Preview invite" is genuinely painted at phone width with its label clipped to the 1×1 `sr-only` box rather than `display: none`, and swaps to the written label — glyph gone — once the `frame` container passes 42rem                                                                                                                                                                                                                                                                                                                                                                              |
| `@cire/host`     | `tests/components/SeatingView.browser.test.tsx`         | A guest dragged with a real pointer (CDP mouse events) onto a table is seated there, the table lights while the pointer is over it, and the dragged row — not the card under it — is what `elementFromPoint` finds mid-drag; at phone width the "Not seated" list stacks above the tables with no sideways scroll; a guest's menu opens from the keyboard with focus on the first item (on the last for ArrowUp), seats the guest, and Escape returns focus to the row; a real mouse press and a CDP tap open it, and a touch that moves 40px does not; no print sheet exists until `beforeprint`, then under print media every child of `<body>` but the sheet is `display: none` and the sheet prints black ink, and `afterprint` removes it. Writes `cire/host/.vitest/attachments/seating/{chart-desktop-dark,chart-phone-light,menu-open,print}.png` |
| `@cire/invites`  | `tests/components/MapPreview.browser.test.tsx`          | The venue address in the details sheet's venue row is unclipped in **both** axes at 320 / 768 / 1440 — for an ordinary address and for a full one down to its country, three lines in the 238px column at 320px under a cap of four — `white-space` is not `nowrap` in the computed cascade, and "Open in maps" (the maps menu's trigger) sits under the address, inside the row, at a 44px target. Two more pin that the address genuinely wraps at 320px, so the rest cannot pass by happening to fit, and that an address of unlimited length is capped at four lines |
| `@cire/invites`  | `tests/components/DetailsPanel.browser.test.tsx`        | The event details panel on **every** built-in palette applied to the document root: each key fact — the day, the time with its spelt-out zone, the guest's own time, Add to calendar, the address, Open in maps — at 4.5:1 and each dress-code swatch's ring at 3:1, read back from Chromium and composited on a canvas over the sheet; the map card painted in that scheme's `--color-bg`, and differently on two schemes. At 390px: the date and the venue on the first screen, and every control in the panel 44px tall with the calendar menu open. The calendar menu: opened by Enter on its first item, filled gold under keyboard focus; opened by a click on the menu itself, marked `data-quiet-focus`, an item then focused by script left unfilled (the fill is `focus-visible:`), the arrows reaching the items from there; the menu marked `data-quiet-focus` and focused after a key press draws no ring, and unmarked draws one; the arrows (wrapping), Home and End move focus with every key's default cancelled; Escape returns focus to the trigger with the sheet open, and so does choosing a calendar; Tab closes it and moves on to Open in maps; it opens upward with no room below, downward under its trigger's left edge when there is room both ways, and inside the 8px gutter from a trigger at the right edge. Every text action is underlined before any pointer moves. "Show it here" leaves focus inside the sheet, and "Stop showing moodboards" is 44px, ignores the second tap of a double tap (the clock frozen between the two presses) and, pressed later, keeps focus in the sheet. The maps menu: Google Maps (the organiser's pin in its place), Apple Maps and Waze, opened over the sheet with `:popover-open`, Waze answering `elementFromPoint` at its own centre, each item 44px, with a screenshot at 390px; ArrowUp on its trigger opens it on Waze, and the arrows walk its three items both ways round, wrapping, with Home and End, every key (the trigger's included) left `defaultPrevented`. The consent framework's default placeholder, rendered alone, gives both its buttons 44px |
| `@cire/invites`  | `tests/components/EventCard.actions.browser.test.tsx`   | Which of the card's two actions a guest reads first, at one line and wrapped; and at the 320px Reflow floor, inside the events section's real padding, that the answer button shows the whole of "Respond" and of the longer "RSVP given" with its tick rather than a half-word, while still clipping the confirmation fill to its rounded box; and that the "RSVPs closed" badge beside a long event name stays inside the card on one line                                                                                                                                                                                                                                                                   |
| `@cire/invites`  | `tests/components/EventCard.contrast.browser.test.tsx`  | Every label the event card writes on a fill, on **every** built-in palette applied to the document root: "Respond" in the on-gold ink on gold, at rest and on hover (where the gold must stay solid); "RSVP given" and its tick on bloom; the part-answered "RSVP given" on plain gold after the deadline; the "RSVPs closed" badge on the card; and `@cire/ui`'s primary and cta-hover labels on gold — each at 4.5:1, read back from Chromium and composited on a canvas over the card, since the bloom fill is the label's sibling and no ancestor says what is behind the word. Verified against the bug: the page colour on gold fails chapel and garden, and a `gold/85` hover fails all five |
| `@cire/invites`  | `tests/components/InviteClosing.browser.test.tsx`       | Both `background-image` declarations survive parsing, with `image-set()` naming the 800w `card` at DPR 1; and the closing band's width cap — 640px in `classic`, 960px in `gala`, centred in both at 2560px and at 1536px, unchanged from the uncapped component at 1535px, applied to the cropped and uncropped paths alike, easing on `max-width` and clamped to 0.01ms under emulated reduced motion                                                                                                                                                                                              |
| `@cire/invites`  | `tests/components/edge-colors.browser.test.tsx`         | The edge loop on the real classic hero: the hero colours at rest and once scrolled past the bottom strip zone (both sides of the boundary, `scrollY` checked), the page colour when there is no hero and the hero's colour once it arrives, a cleaned-up loop stops updating, the strips take no pointer, and the scroll cue paints above the bottom strip |
| `@cire/host`     | `tests/components/RsvpView.layout.browser.test.tsx`     | The organiser RSVP table computes `table-layout: fixed` (reached through `[&>table]`, because `Table`'s `class` lands on its scrolling `<section>`); one table is drawn, the event on screen; a column's share of the table does not move while a search narrows the list; every heading, sort-head button, status, Host-entered and Household-entered badge, plus-one marker, row button and word fits inside its column at 1280, 768 and 414px for an editor (five columns) and a viewer (four), against a 900-row event carrying a 35-letter unbroken surname and plus-ones whose marker names it; and a phone scrolls the region sideways at the 45rem / 37rem floor. The 900 rows come from `tests/test-support/rsvp-guests.ts`, shared with the events suite. An opt-in timing bench sits at the bottom of the file — see below |
| `@cire/host`     | `tests/components/RsvpView.events.browser.test.tsx`     | The RSVP page inside the real `ModuleShell`: no id repeats beside the shell's `subtab-*` / `subpanel-*` and every `aria-controls` / `aria-labelledby` resolves; Chrome's accessibility tree carries both tab lists and names each event tab in sentence case with its count and, on one holding a change, "changed since you last looked"; the arrows, Home and End move focus with wrap and choose nothing, Enter and Space choose, Tab lands in the panel's search box, and the pill and gold ink follow the chosen tab; twelve events at 390px scroll the strip, not the page, bringing a deep-linked or focused tab into the strip with `scrollY` unchanged, landing a mid-strip deep link just inside the strip's edge and leaving the strip still for a tab already in view; Guest sorts both ways and Household ascending, with `aria-sort` on the sorted head only, the arrows drawn and the head button in capitals; the pinned head row holds at the box top at 1280, where the Guest column stays in flow, and the Guest column at the box's start at 390, each painted over what passes beneath, the corner over both, the row hover reaching the pinned cell; a focused Edit button and sort button scroll clear of the pinned cells at 390; switching event puts the box back at its top; and the box fits on screen under the top bar at both widths, with rows on a 1280×800 first screen. Leaves light and dark screenshots at 390 and 1280, first screen and scrolled, in the gitignored `__screenshots__/` beside the file |
| `@shared/ui`     | `tests/data.browser.test.tsx`                           | `Table` scrolls sideways itself, is focusable and named, separates its borders; `Th` scopes and aligns by prop; `Td numeric` lines figures up. Pinned cells (`pin`): in a box scrolled both ways the head row holds at the top and the first column at the start, each painted over what passes beneath, opaque on the ground, with a full hairline at the column's end edge, while a plain cell stays transparent and in flow. Verified against the bug: the three pinned-cell cases fail with `pin` absent |
| `@cire/host`     | `tests/components/RsvpView.badges.browser.test.tsx`     | Each RSVP-table badge's explanation (New, Host-entered, Host-updated, Household-entered, linked musubi), as hidden text, paints nothing, its box at most 1×1. Chrome's own accessibility tree, read over CDP ([[#Chrome's accessibility tree]]), carries it once as text in the case it was written, with no node giving it again as a description, both with every hover panel closed and with each one open. Hovering each badge at 1280px, light and dark, shows its explanation in a panel that is in view, at full opacity, on top at its centre and clear of the badge, on an opaque ground whose ink clears 4.5:1, and no badge is a tab stop; each hover writes a screenshot under `__screenshots__/`. Verified against the bug: the open-panel test fails with `aria-describedby` left on the trigger and with `aria-hidden` taken off the panel; the hover test fails with the trigger left a `<button>`, and on the two-line Household-entered badge with the trigger left inline; the closed-tree test fails with a `title` put back on one badge, and with `uppercase` on the trigger and `normal-case` off the hidden text; every test fails with the panel mounted while closed; the hover test fails with the panel's background class removed; and the paint test fails with `sr-only` removed |
| `@cire/host`     | `tests/components/ChecklistView.assign.browser.test.tsx` | Who holds a checklist task, painted. At 390 and 1280px in both ramps, as an editor and as a viewer: every row's stack, + and count stay inside the row beside a 70-character title, the faces overlap and each paints over the one before it (`elementFromPoint` just inside the second face, the count and the + finds that layer on top), the reader comes first, three faces then "+2", the editor's + sits over the count's edge, the count's figures (a range's box over its text) sit inside it and end at least 2px before the + and its ring begin — it fails against a count that does not pad itself clear of the + — and the same holds for the "+12" of a task held by fifteen, whose stack stays inside its row; the "+2" count is a disc with its figures centred for a viewer and a pill for an editor, a viewer sees the empty dotted circle on the open task nobody holds and nothing on a done one, a face with no photo is the empty avatar, its background opaque under the `linear-gradient` disc, and a photo loads. The assign popover with four people shows them whole with no search, two ticked; with eight it opens on the search with between four and five rows showing and the rest scrolling; both stay inside the viewport. Five people show whole with no search and six bring one, measured. Opening the popover on a 390×844 page scrolled to a row mid-screen leaves the page where it was, with the people read before it opens and with them arriving after it opened, when eight bring a search that takes the focus. It fails against a `scrollIntoView` of the highlighted person, which carries the page up to the corner where the panel mounts. The page has room below the checklist, so a row that grows shorter as the names land cannot pull the scroll up. The popover's animation is `droplet-grow, droplet-round` on the `linear()` spring, its transform origin is the corner at the trigger, and under reduced motion every duration is under 1ms with no delay. From the keyboard, Space and Enter toggle two people while both writes are held, the focus stays on the list and both end ticked. In the eight-person popover the highlight is painted on its row alone and a fill in the ticked circles alone, one ArrowDown past the fold scrolls the list just far enough to show that person whole, moving onto a person already in view scrolls nothing, End scrolls to the last person and Home back to the first, a click on a row leaves the focus in the search — it fails without the rows' `mousedown` guard — and Tab closes the popover with the focus back on its +. In both ramps the highlighted person carries a bar of at least 2px whose colour measures 3:1 or more against the row as painted, an idle row has none, the name's ink changes and reads at 4.5:1, and the marks follow ArrowDown. The status line under the list takes no room beside a failed read, shows "Finding the people…" at the start edge and "Nobody matches" centred inside the panel, and keeps a match count to 1px for a screen reader. A re-read of the seats under an open popover keeps the ticks, the highlighted person and their option node. Photos come from `https://photos.example`, answered in the runner by the `servePhotos` command. Leaves `rows-*`, `popover-4-*`, `popover-8-*`, `popover-highlight-*`, `popover-nobody-matches`, `popover-keyboard` and `popover-reread` screenshots in the gitignored `__screenshots__/` beside the file |
| `@cire/host`     | `tests/components/RunSheetView.browser.test.tsx` | The run sheet, painted ([[cire-run-sheet#In the portal]]). At 390 and 1280px in both ramps, an owner's two-day sheet (one day in one zone, one mixing Sydney and Kolkata, untimed tasks last) and an `own` helper's: nothing scrolls sideways, every row and its words, flags and faces stay inside their day and row, every row's marker sits on its day's thread (an event band's 1px border included — it fails without the band's inset) and level with its title's first line, the time ends before the thread and the words start after it, a task's holders sit beside its words in a third column at 1280 and under them at 390, and a row has three grid tracks wide and two narrow. Every word on the sheet — times, zones, titles, notes, the four flags on their fills and the coming-up wash — reads at 4.5:1 on what it is painted over (it fails at 2.08:1 with "Coming up" in `--gold`), and the reader's bar at 3:1. Below Gold the neutral line reads at 4.5:1 and no request is sent. The page clock is pinned to the day with fake timers, so one task is coming up. Leaves `owner-*`, `helper-*` and `below-gold-*` screenshots in the gitignored `__screenshots__/` beside the file |
| `@cire/host`     | `tests/components/RunTimeEditor.browser.test.tsx` | A task's time on its checklist row, painted. At 390 and 1280px in both ramps: each row's time control stays inside its row, the empty slot is a 28px circle whose dotted edge clears 3:1, a time's words and the removed one's warning ink read at 4.5:1, and a Kolkata task reads 10:00 am with its zone. The popover on a linked task opens on its event, "Before or after the start", 30 minutes before, with where that lands and no zone field; on an untimed task it opens on no event, with the day and zone the events bring once they land after it opened. Both stay inside the screen with every field whole, every word in them reads at 4.5:1, and the panel grows on `droplet-grow, droplet-round`. From the keyboard, Tab stays inside the open popover, Escape gives the focus back to its trigger, and Enter in the time field saves a fixed time and leaves the focus on the trigger, now showing it. A viewer's rows show the time as words with nothing to press. Leaves `rows-*`, `editor-linked-*`, `editor-unlinked-*` and `rows-viewer-*` screenshots in the gitignored `__screenshots__/` beside the file |
| `@shared/ui`     | `tests/tooltip.browser.test.tsx`                        | The two `Tooltip` guarantees a caller's page can hide: inside an `uppercase` run, Chrome's accessibility tree carries the hidden copy as written and never in capitals; and with `prefers-reduced-motion: reduce` emulated the open panel has no animation, against a `no-preference` control that has one. This tier's stylesheet has no `*` reduced-motion switch, so only the component's `motion-safe:` prefix can pass it. Verified against the bug: the first fails with `normal-case` removed, the third with `motion-safe:` removed |
| `@cire/host`     | `tests/components/invite/InviteMessageCopy.browser.test.tsx` | The invite builder's message preview wraps a link and a household code with no space in them inside its card at the 320px Reflow floor, rather than widening the card — verified against the bug: it fails with `wrap-break-word` removed |
| `@shared/ui`     | `tests/checkbox.browser.test.tsx`, `tests/radio-group.browser.test.tsx` | Tab lands on Kobalte's clipped `<input>` and the box or circle beside it paints a ring in `--ui-focus`, keyed off the input through `peer`; a pointer click checks it and paints none — verified against the bug: with the ring on the box's own `:focus-visible` the Tab case reads `box-shadow: none` |
| `@cire/host`     | `tests/components/ModuleSidebar.keyboard.browser.test.tsx` | A locked nav row's card, from the keyboard alone, on the rail at 1200px and in the sheet at 375px: Enter moves focus to a named, outlined **Upgrade to Gold**; Shift+Tab returns to the row with the card open, Tab goes back in, and Tab from the card's last button reaches the next row and closes it; an owner's **Download as CSV** follows the upgrade; Escape returns to the row and, in the sheet, leaves the sheet open; the card's last button leads to the next row in the sheet as well, past the sheet's paused focus trap; the purchase dialog opens with focus on Cancel, outside anything the closing sheet marked `aria-hidden` at that moment, and Escape or Cancel hands focus back to the row, or to the sheet's trigger; a card a resting pointer opened stays once the keyboard has gone into it, and closing a preview moves no focus — verified against the bug: the nine walking the card fail on the hover card, the `aria-hidden` check fails with the dialog mounted in place, and the preview check fails without the close-focus guard |
| `@cire/host`     | `tests/components/ImageCropModal.browser.test.tsx` | The crop editor with real pointer, wheel and touch input (CDP) on an 800×400 picture at 1280×900: dragging the crop box calls neither `getBoundingClientRect` nor `getComputedStyle`, refused moves included; after one wheel notch in, and after one out, each 200px left of the image's centre so the image moves as well as resizes, a drag past the image's right edge stops within one 4px move of the zoomed image's edge, and a 1:1 shape chosen after the zoom spans the zoomed image's height inside its edges; with the modal's entry animation paused at its starting scale, the box opens spanning the image's height and a saved crop saves back within 0.003 of itself; for a picture the page already holds (`complete` before anything yields) the box opens over the image once cropperjs has placed it, and moves; a two-finger twist zooms the image without tilting it; Chrome's accessibility tree holds no `grid` and leaves out the shade, guide grid and crosshair; every window `resize` listener added is removed on close. Writes `cire/host/.vitest/attachments/image-crop/{zoomed-in-refused,zoomed-out-refused,opened-mid-animation,held-image}.png` — verified against the bug: the held-picture case fails with the box opened from `$ready`, the two zoom cases with the `transform` listener removed or reading the matrix before cropperjs applies it, the twist case with `rotatable` back on the image, the overlay case with any one overlay's `aria-hidden` removed, and the close case with the `resize` listener left in place |

Six of these were verified against the bug rather than merely written green.
The #203 test fails when the popover is put back at `z-90`. The
`PreviewInviteButton` test fails when its label is put back to
`hidden @2xl/frame:inline`, the exact class pair that left the invite preview
with no entry point on a phone — the failure is the narrow-width case, which is
the one a class-string assertion in the fast tier cannot distinguish. The
`InvitePage` toast test fails when the `<Toaster>` is put back inside the events
section: on the first-visit path it reports the section itself as the toast's
containing block, which is precisely why the toast was painting behind the RSVP
sheet. The `MapPreview` file fails with `truncate` put back on the venue
address. And the `DetailsPanel` file fails against each revert it guards: the
timezone line back at `text-text-muted/80` or the swatch ring back at
`border-border` on all five presets; `--color-border-strong` back at the static
evergreen value on fog, chapel and garden; `min-h-11` off Open in maps; the
calendar menu without its flip, or without `preventDefault` on its keys, or
opening on its first item after a click; the
menu's placement preferring above, pinned to the left gutter, or unclamped at
the right; a chosen calendar leaving focus where it was; the text actions back
on the hover-only `link` variant; no focus move after "Show it here"; the
switch-off's double-tap guard removed, or its focus move; `min-h-11` off the
placeholder's buttons.

_Measured 2026-10-20 — each revert applied to the working tree, then `VITEST_BROWSER_EXECUTABLE_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome bunx --bun vitest run --project browser tests/components/{MapPreview,DetailsPanel}.browser.test.tsx` in `cire/invites`: `truncate` 9 failed / 5 passed; the `/80` ink and the `border-border` ring together 10 failed / 14 passed; the static boundary 3 failed (fog, chapel, garden); `min-h-11` off and the flip removed 2 failed; `preventDefault` removed 1 failed (5 keys unclaimed)_

_Measured 2026-10-20 — the same command with `-t`, one revert at a time: `fitsBelow` forced false, `!fitsBelow || above >= MARGIN`, and `Math.min(MARGIN, maxLeft)` each 1 failed (B11, below); the right clamp removed 1 failed (B11, right edge); the items back on `dismiss` 1 failed (B9); the `link` variant 1 failed (B10); the wrapper's `focus()` removed 1 failed (B8); the guard's early return removed, or `shownAt` never set, 1 failed (B13); the wrapper's `focus()` after a withdrawal removed 1 failed (B14); `min-h-11` off the placeholder 1 failed (B12)_

_Measured 2026-10-21 — `LinkMenu`'s `toggle` forced to `show("first")`, then `VITEST_BROWSER_EXECUTABLE_PATH=/opt/pw-browsers/chromium bunx --bun vitest run --project browser tests/components/DetailsPanel.browser.test.tsx -t "opens on the menu itself"` in `cire/invites`: 1 failed. The items' `focus-visible:` fill put back to `focus:` passes it, since after a click no item holds focus; the drift guard in `gold-fill-label.test.ts` pins that class list._

The `InviteHeader` file fails when classic's hero scrim is given back its old
bottom padding, `py-[max(1.5rem,…)]`: a long title then runs to 24px above the
hero's edge, and the cue, whose top sits 30px up, overlaps it by 6px. It also fails with the
drift keyframes moved from `transform` to `translate`, which is what keeps its
reduced-motion `transform: none` assertion from passing vacuously.

_Measured 2026-10-02 — classic's scrim padding put back to
`py-[max(1.5rem,env(safe-area-inset-top))]`, then
`bunx --bun vitest run --project browser tests/designs/InviteHeader.browser.test.tsx`
from `cire/invites`: 2 failed / 14 passed, reporting `expected 1878.734375 to be
greater than or equal to 1884.734375` at 390px. Separately, the drift written
as `translate: 0 6px`: 2 failed / 14 passed, `expected +0 to be close to 6`_

Each of the three things that keep the consent prompt open has a test that
fails without it: `closedby="none"`, the refused `cancel`, and the reopen
after a forced close.

_Measured 2026-10-07 — from `cire/invites`, one change at a time.
`closedby="none"` removed: `bunx --bun vitest run --project browser
tests/components/consent/ConsentBanner.browser.test.tsx` 1 failed / 14 passed
(the Escape test counts a `cancel`). The `onCancel` refusal removed:
`bunx --bun vitest run --project unit tests/components/consent/ConsentBanner.test.tsx`
1 failed / 40 passed. `onClose` made a no-op: the browser file 1 failed / 14
passed (the forced-close test)_

The legal pages' banner tests fail against the `fixed` banner the branch
replaced, and the Tab test fails on its own when the scroll padding is
dropped.

_Measured 2026-10-07 — same browser file, `-t "legal pages"`: with the banner
`fixed` and no padding, 3 failed / 2 passed (`expected 544 to be less than or
equal to 303.171875` at 320px); `sticky` with the padding removed, 1 failed /
4 passed_

The event sheet's sideways check fails with the clip on the panels' wrapper
removed: the sliding form carries its full-bleed action bar past the
scrollport's edge, by the slide's offset. Only the details-to-form direction
can show it; the other overflows toward the start, which never scrolls.

_Measured 2026-10-08 — `"overflow-x-clip"` dropped from `EventSheet.tsx`, then
`bunx --bun vitest run --project browser tests/components/EventSheet.browser.test.tsx -t "slides the form in"`
from `cire/invites`: 1 failed, `expected 436 to be less than or equal to 412`
at 414px_

`Modal`'s endless-animation test fails against a close that waits on every
running animation: the dialog never closes.

_Measured 2026-10-08 — `closeWhenAnimationsFinish` without its endless-animation
filter, then `bun run --cwd shared/ui test:browser -- -t "endless animation"`:
1 failed / 74 skipped, `Error: dialog never closed`_

The `EventCard` pair exists because of a **two-PR miss**. The RSVP
confirmation's fill was reported as reverting twice in a row while every test in
the repo stayed green, because every assertion about it was class-presence in
happy-dom — the fill's whole job is a painted colour a second later, and nothing
measured that. Note also what the browser tier does NOT relieve you of: the
`elementFromPoint` trick used elsewhere on this page is useless against a
`@shared/toast` container, which is deliberately `pointer-events: none` and so
hit-tests as transparent even when painted perfectly. Assert the mechanism
(containing block, stacking context, computed `z-index`) in that case, not the
hit test.

The RSVP layout file carries the tier's one **timing measurement**, opt-in
because layout time varies by machine and a timing assertion in CI is a flaky
test by construction. It asserts nothing about the numbers; the verbose reporter
prints them. Each arm is an injected stylesheet rule, not an inline style,
because a search that empties an event unmounts its table and remounts a fresh
element the inline style never reached. The figures are for the component alone
on Solid's development build — a ratio between the arms, not what a keystroke
costs in the portal. On a 900-row list (three events of 300, all drawn at once,
the fixture of that date) the forced layout after a narrowing keystroke falls
from **about 0.9ms to 0.2ms** with fixed layout, and after clearing the search
from **about 28.8ms to 27.1ms**.

_Measured 2026-09-25 — `VITE_RSVP_LAYOUT_BENCH=1 bun run --cwd cire/host
test:browser --reporter=verbose
tests/components/RsvpView.layout.browser.test.tsx`, three runs each on the
component before and after the change, medians, headless Chromium on an
Apple-silicon Mac_

A third arm keeps fixed layout and turns the pinned head row and Guest column
back to static. The pair times layout only: on the 900-row event pinning adds
**about 0.6ms** to the **30ms** forced layout after clearing the search, and
nothing measurable to a narrowing keystroke (0.2ms either way). What pinning
costs after layout — every scrolled frame — the bench cannot see; the figures
below it come from a one-off probe. The fixed
arm on that event measures the same as before the page showed one event at a
time: 30.6ms after clearing, against 30.3–31.4ms.

_Measured 2026-10-21 — the same command, three runs, medians (fixed 30.6 /
30.6 / 30.6ms, sticky off 30.8 / 29.9 / 30.0ms); the before figures from the
base commit's file with its payload set to one
`eventPayload("evt_ceremony", "Ceremony", guestList(900), 0)`, three runs;
headless Chromium on an Apple-silicon Mac_

Scrolling the 900-row event's box with touch gestures, pinning every Guest cell
takes **about 400ms** of main-thread task time where the unpinned table takes
**about 70ms** over the same 2.6 seconds of scrolling at 414px. At 4× and 6× CPU
throttling the pinned cells take **620–930ms** against **45–140ms**, and the
frames hold: a 95th-percentile frame gap of 10.7–12.5ms against 10.1–10.5ms,
with one frame of 34ms in eight runs. Clearing a search, which puts all 900
rows back, takes **342ms** to the next frame against **310ms** at 4×. Hence the
RSVP table pins its Guest column only while its panel is too narrow for every
column ([[cire-rsvp-table]]). At 1280px, where only the five head cells stay
pinned, the same gestures take **58–67ms** against **37–42ms** with nothing
pinned, and 120 frames of scripted scrolling take **17.5–17.9ms** against
**19–21ms**.

_Measured 2026-10-21 — a one-off probe, not kept in the repository, beside the
bench file: the 900-row event in a `@container/panel` frame, 900 pinned against
none (`th, td { position: static !important }`); three
`Input.synthesizeScrollGesture` touch gestures (1500px down, 300px across,
1500px down) over CDP, `Performance.getMetrics` `TaskDuration` before and
after, `requestAnimationFrame` gaps throughout, `Emulation.setCPUThrottlingRate`
for the throttled runs; 120 frames of `scrollTop` and `scrollLeft` set from
script for the scripted figures; six alternating search steps timed from the
input event to the frame after it; two runs each, headless Chromium on an
Apple-silicon Mac_

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
  `wait(duration / 2)` is the one assertion shape here with a hard _upper_ bound,
  and it was guarding the silently-failing mechanism (Tailwind v4's `scale-*`
  writes the standalone `scale` property, so a `transition-transform` that
  stopped listing `scale` animates nothing). A flaky test protecting a silent
  failure is the worst combination — it gets skipped rather than fixed. Assert
  `transitionDuration` first, so a clamped transition fails on its cause rather
  than as a confusing `scale === 1`.

## Driving the whole app by hand

This tier proves a component in isolation. The other half — opening the built
app and watching it — has no automated home, and is worth writing down because
the two reveal bugs on the guest invite were both found that way while the whole
suite stayed green: **#296**, where the unlock reveal broke under motion v12 and
guests saw no events after a successful claim, and **#742**, where the reveal
flashed at full brightness before snapping back and then animated a section
whose cards had not arrived.

For a still frame, headless Chrome needs nothing installed:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --screenshot=out.png --window-size=1440,900 --hide-scrollbars \
  --virtual-time-budget=15000 "https://invite.cire.localhost/<slug>"
```

Point it at a wedding slug, never the bare host: `src/pages/index.astro` 302s
`/` to `MARKETING_URL`, which falls back to the **live** `cireweddings.com` when
`PUBLIC_MARKETING_URL` is unset — which is what copying `.env.example` gives
you. A screenshot of `/` is a picture of the marketing site, with no error to
say so.

`--virtual-time-budget` fast-forwards timers and `requestAnimationFrame`, so a
lazy scene or a fade-in has finished by the time the frame is taken. Vary
`--window-size` for the phone case (390×844). The same command renders WebGL
through SwiftShader, which is how [[cire-landing]]'s wax seal is checked — at
`https://cire.localhost`, the landing site's own host.

**A still frame cannot see an animation bug.** #742 was a single frame, and a
one-frame flash is invisible both to jsdom and to any assertion made after the
animation has settled. Drive the page with Playwright (see
[Running it locally](#running-it-locally)) and sample `getComputedStyle` on
every `requestAnimationFrame`.

Five traps, each of which has cost an hour or more:

| Trap                                                       | What it looks like                                                                                                                       | What to do                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `astro dev` backgrounds itself under an agent              | The URL 404s seconds after `bun run dev` reported success, while a stray daemon still holds the port                                     | Astro 7 detects the agent environment and portless deregisters the route when its child exits. Run `CLAUDECODE= bun run dev`; clear a stray with `bunx astro dev stop`                                                    |
| `astro dev` never reaches `networkidle`                    | `page.goto` hangs until it times out                                                                                                     | The HMR socket stays open by design — use `waitUntil: "load"`                                                                                                                                                             |
| Below-the-fold islands hydrate on visibility               | The component under test never mounts, and the page reads as broken rather than un-hydrated                                              | Both invite designs mount `InvitePage` and `GiftRegistryTeaserIsland` as `client:visible={{ rootMargin: "600px" }}` (`ConsentBanner` is `client:idle`) — scroll them into view, or assert against the `client:load` header only |
| The claim endpoint allows **5 attempts per minute per IP** | Back-to-back runs 429, and the invite renders "Something went wrong" with no events — identical to the reveal regression you are chasing | `defaultClaimLimiter` in `cire/api/src/app.ts`. Space the runs out before believing a result                                                                                                                              |
| A credentialed stub API echoing `*`                        | `…/registry/mine` silently reads as signed out                                                                                           | A CORS stub for a credentialed fetch must echo the exact origin                                                                                                                                                           |

Anything proved this way that can be pinned belongs back in the tier above:
`InvitePage.browser.test.tsx` covers the first-visit reveal path precisely
because that is where the reveal left its inline `transform` behind.
