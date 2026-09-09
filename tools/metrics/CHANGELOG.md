# @tools/metrics

## 0.2.5

### Patch Changes

- Updated dependencies [4b73ff4]
  - @osn/ui@1.11.0

## 0.2.4

### Patch Changes

- @osn/ui@1.10.12

## 0.2.3

### Patch Changes

- @osn/ui@1.10.11

## 0.2.2

### Patch Changes

- 13d8ee3: Separate OSN, the system, from Musubi, our implementation of it.

  OSN is now the headless core — identity, the social graph, authorisation and
  the OpenID Connect issuer — with no user interface, runnable by anyone for
  their own private social graph. Musubi is our implementation and the product
  built on it: the social app, its marketing site, the brand, and the
  `musubi.social` instance we host.

  `@osn/social` becomes `@musubi/social` and `@osn/landing` becomes
  `@musubi/landing`, both moving to a new top-level `musubi/` workspace
  directory. The backend packages, `@osn/ui`, the shared packages and every
  wire-level identifier — the `osn-access` and `osn-step-up` token audiences,
  `/.well-known/jwks.json`, claim names, the pairwise subject derivation and the
  ARC token format — keep the OSN name, because an independent implementation has
  to match them to interoperate. That is the rule the split now runs on: if
  another implementation must use the same string, it is OSN; otherwise it is
  Musubi.

  The remaining packages change only in the references they carry. Two of them
  were resolving the moved package by filesystem path rather than by package name
  — `tools/lab/src/lab.css` and `tools/metrics/src/metrics.css` both `@import`
  the social app's stylesheet — and would have failed to build without the
  update.

  Two repository guards learned about the new directory: `fmt` and `fmt:check`
  hardcode the list of workspace directories oxfmt walks, and
  `scripts/validate-changesets.sh` builds its known-workspace-name set from a
  hardcoded `find`. Neither would have reported anything unusual; the format
  check would simply have stopped covering two packages.

  Cloudflare Pages project names (`osn-social`, `osn-social-dev`, `osn-landing`)
  are deliberately unchanged — renaming a Pages project attached to a live apex
  is a deploy operation, not a rename.

- Updated dependencies [13d8ee3]
  - @osn/ui@1.10.10

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
