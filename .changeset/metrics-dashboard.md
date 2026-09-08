---
"@tools/metrics": minor
"@shared/dev-urls": patch
---

New `@tools/metrics`: a local-only Vite + SolidJS dashboard over the
session-metrics cards in `.claude/metrics/`. `bun run dev:metrics` serves it at
`https://metrics.localhost`. It leads with a coverage banner (cards, confirmed
complexity ratings, `at-open` share), then charts API-equivalent spend and
tokens per month as box plots with one dot per pull request, spend against
declared complexity (with an explicit empty state while nothing is rated),
sessions per pull request against spend, the corrective-turn rate, exploration
share, and the model and effort mix. Every distribution is a median, `null`
ratios are excluded and counted rather than zeroed, and `toRow` and `median`
are reused from `@tools/pr-metrics` so the dashboard and the CLI report cannot
disagree about a ratio.

`@shared/dev-urls` registers the app as `metrics` on fallback port 4401.
