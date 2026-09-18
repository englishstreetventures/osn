---
"@cire/host": patch
---

36 more `@shadcn/lint` sites in the organiser portal, including a call site that
was reinstating a fixed contrast defect.

**`ChangePreview`'s confirm button carried `hover:bg-gold-dim`.**
`cire/host/tests/styles/tokens.test.ts` names that exact pairing as one of three
defects its conformance sweep found — *"the same button's hover, `bg-gold-dim`
composited over the page, at **1.80:1** in dark"* — and records `--gold-hi` as
the token that fixed it. `primary`'s hover is
`base:hover:bg-ui-accent-strong`, which is `--gold-hi`. The call site was
overriding the fix back out, on "Apply changes" and "Confirm & save". It was the
last surviving instance in the package.

**Two changes are visible and worth knowing about.** Eight glyph buttons
hand-drew a disabled state over Button's `base:disabled:opacity-40` — six as
`disabled:opacity-30`, two as an unconditional `opacity-60` on permanently
disabled buttons, three numbers for one state. They take the component's 0.40
now. Three sites weakened `quiet`'s `base:hover:border-ui-accent` to `gold/40`,
`/50` and `/60`; those go to full-strength gold.

The rest are restatements of a default (`gap-2` against `base:gap-2`;
`border-border` against `base:border-ui-hairline`, which `global.css` maps to
the same `var(--border)`; nine bare `transition` classes against
`base:transition-colors`, each checked for a non-colour hover first), and three
provable no-ops: two `text-[1em]` (an `em` font-size *is* the inherited size)
and a `font-normal` on a `<Td>`, which no user-agent bolds.
