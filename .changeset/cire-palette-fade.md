---
"@cire/host": patch
---

The command palette fades up through the page instead of sliding in from the
left edge: from transparent, 10px below its place and at 98.5% of its size,
scaled from its centre, with its scrim fading in on the same clock
(`--dur-base`, `--ease-out`). It closes at once, and appears at once under
reduced motion. A wedding tile's hover — the gold rule, the "Open dashboard"
ink and the arrow — now runs on `--dur-fast`, as every hover does.
