# @tools/metrics

## 0.2.1

### Patch Changes

- aa46757: Fix the blank dashboard. `Dashboard.tsx` value-imported `compactTokens` from
  `tools/pr-metrics/index.ts`, which reads `node:fs` at module scope; Vite's
  browser stub throws on first property access, so the app died during module
  evaluation and left an empty page with nothing but a console error. It now
  imports from the new `tools/pr-metrics/format.ts`, and a test guards both the
  import and that file's no-imports contract.

## 0.2.0

### Minor Changes

- beb75ec: New `@tools/metrics`: a local-only Vite + SolidJS dashboard over the
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
