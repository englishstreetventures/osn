---
"@pulse/web": patch
---

The explore nav's three pills, the filter rail's two chips and the carousel's two arrows each become one component

Seven hand-written buttons, three shapes. Every pair had drifted in the way
copies do: the sign-in pill had no hover state and the Host pill did, while the
filter rail's two chips differed only in a label colour.

`--pulse-accent` is now in the Tailwind theme (`--color-pulse-accent` and
friends), which is what made `NavPill` possible at all. The coral was previously
reachable only through an inline `style={{ background: "var(--pulse-accent)" }}`
plus a `text-[var(--pulse-accent-fg)]` arbitrary value, because no utility
existed. A browser test asserts the new utility actually paints the coral — an
inline style cannot silently fail, and a utility Tailwind never compiled emits
no rule at all.

`FilterChip` adds `aria-pressed`, which neither call site had. The rail marked
its selected chip by inverting its colours and nothing else, so every chip read
the same in both states to anyone not looking at it.
