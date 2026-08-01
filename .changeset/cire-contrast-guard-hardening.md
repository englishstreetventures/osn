---
"@cire/theme": patch
"@cire/web": patch
---

Close the gaps a mutation-tested review found in the contrast work.

**A missing residual pair.** The prose walk runs `[card, raised, ground]`, so
only the last surface is guaranteed on exit — a later step can push a colour
back off `card`. `--color-surface` is the modal shell, and the sweep had just
moved six RSVP-sheet sites onto `--color-gold-ink` there. A brute-force sweep
put roughly 1 in 100 random schemes below 4.5:1 on that surface with no warning
firing, on *coherent* palettes, not the acknowledged straddling case. Both prose
tokens now have an on-surface pair.

**`global.css` had drifted from the derivation.** Widening the lockstep test
from four spot-checked tokens to all of them found five: `--color-text-muted`
(an alpha form composited to 4.24:1 on raised), `--color-surface-raised`,
`--color-border`, `--color-error`, `--color-success` and `--invite-hero-grad-1`.
This is not cosmetic — `/privacy` and `/terms` never receive a derived palette,
so they paint these literals verbatim, which is why the sweep across
`LegalLayout.astro` had been a no-op.

**The guard could be bypassed three ways**, each mutation-proved: a Tailwind
arbitrary value (`text-[var(--color-gold)]`), the JSX style-object form this
codebase already uses (`style={{ color: "var(--color-gold)" }}`), and a class
string in a plain `.ts` module, which the walk never opened. It now scans `.ts`
and matches both variable spellings.

**Comment stripping could erase real code.** A `/*` inside a string literal — a
CSP source list, a path glob — opened a fake comment that swallowed everything
to the next `*/`. Block stripping is anchored now; the first attempt at that
anchoring was itself too loose and ate an entire Astro file (`interface Props {`
followed by a JSDoc line looks like a JSX comment opener), which the count-based
allow-list caught.

Also restores coverage for `muted-on-ground`, whose only two assertions were
rewritten away, via a scheme that fires every pair.
