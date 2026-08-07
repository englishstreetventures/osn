---
"@cire/host": patch
---

Host portal: the CSV import moves into each module's Edit mode, and `Schedule`
is renamed `Events`.

Both sheets used to be uploaded from one panel sitting above the guest list on
**Guests → Households** — so importing a schedule meant going to a tab about
people, on a read view, through a control that also offered to overwrite the
guest list. `ImportPanel` is now scoped to one sheet (`kind: "events" |
"guests"`): one file input, one template, one export, one guide, and it posts
only its own CSV key, so a module's import cannot express "reconcile the other
half" at all.

Edit is now a choice rather than a surface. The new `EditWorkspace` offers **Web
editor | Spreadsheet import** and mounts exactly one of them — the editor by
default, the import not mounted (and not fetching change history) until it is
picked — with a mode switch routed through `confirmNavigation()` so an unsaved
draft is never dropped silently.

Two fixes ride along:

- The CSV format guide opens itself **once**. A first-time organiser gets it
  expanded with a slow gold glow around it; every visit after that starts
  collapsed and quiet (one `localStorage` bit, shared by both sheets). The glow
  clears on the summary's click rather than the disclosure's `toggle` event —
  setting `open` fires `toggle` too, which would kill the glow in the same tick
  it appeared.
- Mandatory column chips were `text-gold-dim`: `--gold` at ~30% alpha, a rule
  colour, and as ink the least readable text in the panel while marking the one
  thing an organiser must not misread. Measured as painted, they were **1.8:1**
  in the dark ramp and **1.3:1** in the light one. They now read in `--gold-ink`
  — the variant the token contract actually holds to 4.5:1 — on a gold-tinted,
  gold-bordered ground: **9.6:1** and **4.8:1**. They also carry a `*` plus an
  `sr-only` "(mandatory)", so the distinction survives greyscale, a
  colour-vision deficiency and a screen reader alike. The panel's other
  `gold-dim` ink (diff heading, tips summary, matrix header, IANA link) moved to
  `gold-ink` with them.

`@cire/host` also gains a **real-Chromium test tier**, the same second
Vitest project `@cire/invites` has run since 2026-08-06, because those numbers were
unmeasurable without one: happy-dom parses no stylesheet, so nothing in the fast
tier could see that a chip's ink was 1.3:1 against what was actually painted
under it. `ImportPanel.browser.test.tsx` measures the composited result in both
ramps (compositing on a 1×1 canvas, which parses whatever syntax
`getComputedStyle` returns), and pins the first-run glow: that the hand-written
`attention-glow` utility emits a real, finite animation, that it is a shadow
rather than a border, and that the global reduced-motion clamp silences it. Run
with `bun run --cwd cire/host test:browser`; CI already runs the tier for
every package that has one.

Pre-PR review fixed five things in the above, and the first is a real bug:

- **A standing diff preview survived picking a different file.** Preview sheet A,
  then re-pick sheet B on the same input, and the diff plus its "Apply import"
  button stayed on screen holding A's `importId` — which is what Apply posts. The
  plan behind it can reconcile away a whole half of the wedding, so re-picking
  after a mis-pick was a way to write the wrong sheet under a plausible diff. The
  panel's own `clearFile()` documented that invariant and held it for Remove
  only. Every change of selection now drops the preview.
- **The glow animated `box-shadow`**, the one property Chromium won't composite,
  on the open guide — the tallest box on screen — for 7.8s while the organiser is
  scrolling it. The ring is now static on an `::after` and only its `opacity`
  animates: rastered once, composited on the GPU, visually identical.
- The panel now refuses an oversized file before reading it (the 1 MB cap was
  only discovered server-side, after the tab had materialised the file twice),
  and the pre-Apply reassurance is read off the server's echoed scope rather than
  the client's assumption, which is what its comment already claimed.
- The edit-mode hints moved out of `title` (unreachable on touch and by
  keyboard) into real text wired with `aria-describedby`.
- `PANEL_LOADERS` is typed `Partial<Record<\`${Module}:${string}\`, …>>`, so the
  next module rename can't silently kill the hover prefetch — the lookup swallows
  a miss, so the only symptom would be every Edit click paying a full round trip.

The `schedule` module id becomes `events` everywhere (routes, nav, sub-tab
labels, chunk-prefetch keys, Overview's jump targets), with its read sub-tab
relabelled `List`. No legacy alias — nothing links to the old hash.
