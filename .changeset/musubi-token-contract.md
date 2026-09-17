---
"@musubi/social": minor
---

Map `@musubi/social` onto the `@shared/design-tokens` contract, and fix a
dark-mode contrast failure the conformance test found on first contact.

The mapping is aliases onto the existing shadcn ramp, so `.dark` carries the
whole contract with it and not a single `bg-card` or `text-muted-foreground`
in the app changes. Two mappings are deliberately not the obvious ones:
`--ui-accent-soft` takes `--muted` rather than `--accent`, because shadcn's
`--accent` here is a neutral grey and the contract's `accent-soft` means a tint
of the *accent*; and `--ui-ground-deep` takes `--secondary`, the surface the
page recedes to, which in dark mode is lighter than the page rather than
darker.

All seven type steps are mapped in musubi's own sizes. The app's scale is four
steps by design (DESIGN.md), so the gaps are filled by continuing its own
progression rather than by letting the package's neutral defaults show through
in the middle of it.

**`--destructive-foreground` in dark mode was white on a lightened red at
2.89:1**, against a 4.5:1 floor — on the one control where a misread is
destructive. It is now `#1c1c1c` at 5.89:1. Darkening the fill instead would
have rescued white text at 4.72:1 but dulled the button against the page it
has to stand out from, which is why shadcn lightens it in the first place.

`@source` and `@custom-variant base` are dropped from `App.css`: the contract
stylesheet carries both, per xchromo/osn#1041.

Two tokens are mapped but waived, each with the reason in the test: the input
boundary at 1.30:1 and tertiary ink at 2.68:1, both predating this work and
both a design decision rather than a patch.
