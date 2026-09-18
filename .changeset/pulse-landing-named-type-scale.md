---
"@pulse/landing": patch
---

Give the marketing sections a named type scale.

The seven `src/components/sections/*.astro` files carried **53 literal
`text-[…]`, `tracking-[…]` and `leading-[…]` values across 23 distinct sizes,
trackings and leadings**. `shadcn/no-arbitrary-values` has been at `error` since
the design-system work, and reported none of them: `*.astro` is in
`oxlintrc.json`'s `ignorePatterns`, so oxlint never parses the files this site's
type actually lives in.

23 steps for one marketing page was the finding, not the literals themselves, so
the answer is a small scale rather than 23 tokens. Eight sizes, three trackings
and three leadings now cover every one of them: `1.02rem` and `1.05rem` were
0.48px apart and are one step; so are `0.72rem` and `0.8rem`, and `1.7` / `1.75`
/ `1.8` leading. Seven `tracking-[0.28em]` sites read the
`--tracking-mono-widest` token that already existed for them.

Named rather than snapped to Tailwind's own `text-xs` / `sm` / `lg` / `xl`, even
where a built-in step sits within a pixel of the literal. A built-in `text-*`
also sets `line-height`; an arbitrary `text-[…]` sets font-size alone. Snapping
would have moved the leading as well on every site that carries no `leading-*` of
its own — upward on some and downward on others. Built-in _leading_ utilities
have no such coupling, so `leading-relaxed` is used directly.

Every new utility was verified against the built CSS rather than assumed: a
`@theme` entry that is wrong emits no rule at all, with no error and no warning.

Visible changes, all of them collapses onto a shared step: the how-it-works
numeral 2.75rem → 3rem, the two closing-CTA buttons 0.9rem → 0.95rem, a feature
card's body 0.875rem → 0.95rem, a category name 1.1rem → 1.05rem, a venue set
time 0.8rem → 0.72rem, two card labels 0.62rem → 0.6rem, the closing headline's
leading 1.08 → 1.05, and a feature card's 1.6 → 1.625.

`tests/named-type-scale.test.ts` is the guard the linter cannot be. It fails on a
literal type value anywhere under `src/`, and on a `@theme` entry going missing.
