---
"@cire/invites": patch
"@cire/theme": patch
---

Swap the RSVP confirmation button's sweep fill and tick from a fixed green
(`--color-success`) to the `bloom` accent — the second chromatic colour every
invite's palette already derives, previously unused on the guest site. Reusing
`gold` (the button's base colour) would have made the "before" and "after"
states the same colour family, so this gives the confirmation its own accent
instead.

Giving `bloom` a real render site (the fill + permanent tick, both painted on
`--color-surface-raised`) meant closing the gap `@cire/theme`'s contrast system
had deliberately left open for it: added a `bloom-on-raised` residual pair,
mirroring the existing `gilt-on-raised` one, so a straddling palette warns the
organiser instead of shipping an unreadable tick. That pair caught a real
failure in the built-in `fog` preset (2.88:1 against the raised surface,
requires 3:1) — `fog`'s `bloom` seed moved from 63% to 60% lightness to clear
it; all five curated presets stay clean.
