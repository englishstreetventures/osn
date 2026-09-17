---
"@cire/landing": patch
---

The demo sheet becomes `@shared/ui`'s `Modal`, and `motion` leaves the bundle

`DemoModal` was a 130-line port of `cire/invites`' `AnimatedModal`: a scrim, a
40-line `Tab` focus trap, Escape handling, a scroll lock, focus restore and an
enter/exit animation lazily imported from `Modal.motion`. All of it is the
shared component's now.

Deleting `Modal.motion.ts` removed the only module importing `motion`, and the
library left the bundle with it: **185,383 → 164,847 bytes gzip**, a 20.5 KB
saving. The dependency is dropped and the threshold re-baselined *down*, since
leaving it would have banked a gap larger than the mistake the guard exists to
catch.

Tests move from jsdom to happy-dom, which is not a preference: jsdom has no
`showModal`, so the sheet cannot open there at all.

One behaviour needed writing down rather than inheriting. The sheet used to be
mounted inside `<Show when={rsvpEvent()}>`, so each event got a fresh component
and its state reset by construction. It stays mounted now — it has to, to
animate its own exit — so the per-event reset is an explicit effect. Without it
`responses` stayed empty, every guest counted as answered, and the "respond for
everyone" guard never fired: a quiet failure that a test caught and that nothing
about the rendered sheet would have shown.
