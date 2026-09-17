---
"@cire/invites": patch
"@cire/landing": patch
---

`cire/invites` and `cire/landing` join the token contract

Both map their brand tokens onto the `--ui-*` roles and assert conformance from
their own suite, so all four cire apps now read the same contract.

**The invite's mapping aliases `--color-*`, never the literals behind them**,
and that is load-bearing on this surface. An invite's palette is derived per
wedding and injected as `--color-*` overrides on `<html>` by `paletteRootVars`,
so pointing at those names carries every organiser's palette through the
contract unchanged — the same join, for the same reason, as the existing
`--toast-accent-*` aliases. A literal would pin the evergreen fallback into
every invite.

Two ramp changes came out of it.

`--color-border-strong` is new in both, and it is a name for something that
already existed: `border-text/55` is written out at every form control on the
guest site — the claim-code box, the three gift-registry fields — which is a
token by any other measure, and one the contract needs by name to hold to its
3:1 floor.

`cire/landing`'s `--color-text-muted` was `--color-text / 0.5`, which composites
to **4.24:1** on `--color-surface-raised` against a 4.5:1 floor. No contrast
check sees an alpha — `contrastOklch` ignores it by design — which is how it
survived. `cire/invites` had already replaced the alpha form with the solid
`oklch(69.24% 0.0186 109.31)` for exactly this reason, so taking the same value
fixes legibility and restores brand parity at once.

That parity is now tested rather than asserted in a comment. `cire/landing`'s
`@theme` block says it is kept byte-identical to the guest site's; six of the
ten shared tokens had drifted. One was the defect above; the remaining four are
listed as known divergences, so a *new* drift fails immediately, and a second
test fails if a listed token is brought back into line without the exemption
being removed. Which value each should take is a design decision, tracked as
xchromo/osn#1050.
