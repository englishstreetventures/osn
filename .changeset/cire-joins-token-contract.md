---
"@cire/host": patch
"@cire/vendor": patch
"@cire/theme": patch
---

cire's two portals join the token contract, and it finds three contrast defects

`cire/host` and `cire/vendor` now import `@shared/design-tokens` and map their
ramp onto the `--ui-*` roles. The accent is **gold, not the brand green**:
counted across both portals' components, gold appears in 422 colour utilities
and the green in 8, so gold is what a shared component means by "accent".

The eighteen shadcn semantic aliases each portal carried are gone. They were
mapped against the day a shared component layer arrived; it arrived reading
`--ui-*` instead, so they had become aliases nothing read — and a misleading
set, sending `primary` to the green and `accent` to a neutral surface.

**The conformance harness found three defects the hand-written pair table
could not**, because it checks every ink against every ground rather than the
subset somebody thought to list:

- the primary button's label — `text-bg` on a gold fill — at **2.42:1** in
  light, against a 4.5:1 floor;
- that button's hover, `bg-gold-dim` composited over the page, at **1.80:1** in
  dark, which is the most-pressed control in the portal going illegible the
  moment a pointer touches it;
- `success` and `warn` on `bg-deep` and `surface-sunk`, two grounds the old
  table never paired them with, at 4.20–4.39:1.

Two new ramp tokens fix the first two. `--on-gold` is the ink for a gold fill —
dark in both themes, because gold is mid-lightness in both. `--gold-hi` is the
emphatic step, and it goes *lighter* in both themes where `--brand-hi` goes
lighter in dark and darker in light: a brand fill carries a near-white so
darkening adds contrast, and a gold fill carries `on-gold` so lightening does.
Light `--success` and `--warn` drop 3% lightness.

Both `tests/styles/tokens.test.ts` copies lose their pair tables and their
alpha-compositing machinery to one `checkContractConformance` call. What is left
is what the contract has no name for — the brand green's own pairs — and the
ramp's shape. The stylesheet-parsing helpers they had each copied, and already
diverged on, move to `@cire/theme` as `cssRamp`/`cssBlockBody`.
