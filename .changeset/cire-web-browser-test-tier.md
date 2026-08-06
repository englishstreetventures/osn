---
"@cire/web": patch
---

Add a real-browser Vitest project to `@cire/web`, for the bugs jsdom cannot see.

**The gap this closes was measured, not assumed.** jsdom computes no CSS and no
layout: it never parses the stylesheet, `getComputedStyle` returns roughly what
was set inline, and `getBoundingClientRect` is all zeroes. A whole class of this
app's bugs is therefore structurally invisible to the existing suite — including
ones that have already shipped.

`#203` put the Add-to-Calendar popover at `z-90`, below the `z-100` modal it
opens from, so it painted behind the backdrop: invisible and unclickable. The
guard added afterwards asserts the *numbers* in `Z_LAYER`, which is the most a
jsdom test can do, and it leaves three ways to reintroduce the same bug. A
`Z_CLASS` entry could name a class Tailwind never emitted — the scanner only
sees literal source text, so a concatenated class compiles to **no CSS at all**,
silently, while `expect(Z_CLASS.MODAL_POPOVER).toBe("z-110")` passes either way.
An ancestor could gain a stacking context and trap the portalled popover
regardless of how large its z-index is. Or the paint order could simply invert.
The same blindness covers Tailwind v4's `scale-*` setting the standalone `scale`
property rather than `transform`, conflicting utilities resolving by stylesheet
order rather than class-attribute order, the sticky action bar whose `bottom`
resolves against the scrollport, and whether the global `prefers-reduced-motion`
clamp actually applies.

The existing answer to all of these is text-matching drift guards
(`styles/root-type-scale.test.ts`, `components/rsvp-saved.test.ts`,
`components/invite-theme.test.ts`), which `readFileSync` a CSS file and regex
it. They stay — they are fast and they catch a source change. But they pin only
that the source *says* the right thing, never that the render *does*.

**What was added.** `cire/web/vitest.config.ts` becomes two projects: `unit`
(jsdom, unchanged behaviour, excludes `*.browser.test.*`) and `browser`
(Playwright + headless Chromium, includes only `src/**/*.browser.test.{ts,tsx}`).
Naming decides the project, so every file lands in exactly one and neither glob
can swallow the other's. `bun run test` still runs the fast tier only — and so
does CI's default path and the pre-push hook. The browser tier is opt-in via
`bun run test:browser`, with its own CI step that installs Chromium first,
mirroring how `test:d1` is already split out.

Three files prove the tier against pre-existing, documented gaps rather than
against new code:

- `z-index.browser.test.tsx` — every `Z_CLASS` entry emits real CSS; a
  modal-launched popover **hit-tests** above the modal via
  `document.elementFromPoint`; no ancestor traps it in a stacking context; the
  modal blocks the page beneath it. Verified to fail when the popover is put
  back at `z-90`, so it reproduces #203 rather than restating the constants.
- `RsvpModal.browser.test.tsx` — the sticky action bar sits on the scrollport's
  bottom edge, stays put while content scrolls under it, runs full-bleed to the
  panel's content box, and both buttons are the topmost element at their own
  centre. `cire/CLAUDE.md` names this exact case as one to "measure the real
  thing in a browser".
- `reduced-motion.browser.test.tsx` — the clamp applies to transitions *and*
  animations, `animate-spin` keeps its documented exemption, and a clamped
  transition still lands on its end state and fires `transitionend`.

**Notes for anyone extending it.** `@solidjs/testing-library` works unchanged in
browser mode, so there is no second render API and no `vitest-browser-solid`
dependency — a browser test reads like every other component test here. Both
projects share `tailwindcss()`, so a browser test gets the same Tailwind build
the app ships; import `../styles/global.css` to apply it. Two provider details
cost real time to rediscover and are now documented: `launchOptions` belongs to
`playwright({...})`, not to an entry in `instances` where it is accepted and
silently ignored; and `headless` must sit at `browser` level, not inside
`instances` (vitest-dev/vitest#7661). `prefers-reduced-motion` is a property of
the browser context, so it is flipped per-test through an `emulateMedia` browser
command rather than by adding a second instance that would run the whole suite
twice.

`VITEST_BROWSER_EXECUTABLE_PATH` lets dev containers and cloud sessions point at
their prebuilt Chromium instead of downloading a ~300MB matching build. It is
declared in `turbo.json` under `passThroughEnv`, not `env`: it says *where* the
browser is, never *what* the tests assert, so it must not enter the cache key.

New convention page at `cire/wiki/conventions/browser-tests.md`, covering what
belongs in the tier and — as importantly — what does not, since every test that
could have lived in the fast tier and didn't is a tax on every run.
