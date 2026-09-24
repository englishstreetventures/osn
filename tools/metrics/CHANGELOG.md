# @tools/metrics

## 0.2.17

### Patch Changes

- 76aa4f6: Point code comments at the wiki's new layout. The wiki now has one folder per
  product (`osn/`, `musubi/`, `pulse/`, `cire/`, `zap/`) and `shared/` for what
  applies to all of them, so references such as `wiki/systems/rate-limiting.md`
  now read `wiki/shared/rate-limiting.md`. Comments only; no behaviour changes.
- Updated dependencies [76aa4f6]
  - @shared/ui@0.2.3

## 0.2.16

### Patch Changes

- Updated dependencies [82a106a]
  - @shared/ui@0.2.2

## 0.2.15

### Patch Changes

- Updated dependencies [f3b4cd1]
  - @shared/ui@0.2.1

## 0.2.14

### Patch Changes

- 21f3cff: First pass of the `@shadcn/lint` migration: 183 of 530 call sites cleared.

  `no-arbitrary-values` sites move onto the contract's scales, and `no-restyle`
  sites either drop a class the component already applies or switch to a variant
  that already exists. Neither rule is at `error` yet — the remaining 347 sites
  are in a second pass, and a rule goes to `error` only when its count is zero.

  Where a `no-restyle` site genuinely needs a variant that does not exist, the
  call site is left alone and the proposal recorded rather than guessed at. Those
  land with the variant, not before.

  One test changed. `ResponsiveDialogContent` was overriding `DialogContent`'s
  radius with `rounded-card`, and `musubi/social/src/App.css` maps
  `--ui-radius-lg: var(--radius-card)` — so the component's own default already
  resolved to musubi's 16px and the override restated it. The wrapper drops it and
  the test now asserts `rounded-ui-lg`, which is the class that has to keep
  resolving to 16px for the two to stay equivalent.

- 21f3cff: Split `@osn/ui` into `@shared/ui` and `@osn/auth-ui`, and re-key the design-token
  contract from `--osn-*` to `--ui-*`.

  `wiki/architecture/osn-and-musubi.md` states the discriminator: if an independent
  implementation must use the same string to interoperate, it is OSN; otherwise it
  is not. A `Button` fails that test — nobody has to spell it the way we do — so
  the primitives were never OSN's, and the old page carved them out by hand
  ("it keeps its name because `@pulse/web` and `tools/lab` consume it as well")
  rather than applying the rule. The carve-out is gone.

  | Was                                 | Is                                        | Holds                                                                   |
  | ----------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
  | `@osn/ui/ui/*`, `@osn/ui/lib/utils` | `@shared/ui/ui/*`, `@shared/ui/lib/utils` | The primitives: `Button`, `Card`, `Modal`, `Field`, `Table`, `cn()`     |
  | `@osn/ui/auth`, `@osn/ui/auth/*`    | `@osn/auth-ui`, `@osn/auth-ui/*`          | The auth views: `SignIn`, `Register`, `PasskeysView`, `StepUpDialog`, … |

  `@osn/auth-ui` stays under `osn/` because every view in it is the client half of
  a named ceremony in the spec — its shape is fixed by the protocol, not by our
  styling — and it now depends on `@shared/ui` like any other consumer. Its
  subpaths flatten (`@osn/ui/auth/SignIn` → `@osn/auth-ui/SignIn`), and the
  package's bare specifier is the barrel that `@osn/ui/auth` used to be.

  The token prefix moves with it. `--ui-surface` becomes `--ui-surface`,
  `bg-ui-ground` becomes `bg-ui-ground`, `.ui-toast` becomes `.ui-toast`, and
  `--ui-modal-enter` becomes `--ui-modal-enter`. A prefix naming the system a
  component is _not_ part of was the last thing asserting the old shape. Apps map
  the new names in exactly one place each, the contract block in their global
  stylesheet.

  The rename was driven by an explicit allowlist of the contract's own token
  suffixes rather than a blanket `osn-` → `ui-` substitution, because the same
  compound shape carries protocol identifiers that must not move: `osn-access`,
  `osn-step-up`, `osn-kid`, `osn-pairwise-salt`, the `osn-api`/`osn-social`
  Cloudflare project names. A missed token fails safe by staying `osn-`; a
  mangled audience string would not.

  One string is deliberately left spelled the old way: `ProfileOnboarding`'s
  `localStorage` key. Every browser that has already dismissed that prompt holds
  it under `@osn/ui:profile_onboarding_dismissed`, and renaming the key would show
  the prompt again to exactly the people who said no.

- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
- Updated dependencies [21f3cff]
  - @shared/ui@0.2.0

## 0.2.13

### Patch Changes

- Updated dependencies [d326ae3]
  - @shared/ui@0.1.1

## 0.2.12

### Patch Changes

- ac41e37: Split `@osn/ui` into `@shared/ui` and `@osn/auth-ui`, and re-key the design-token
  contract from `--osn-*` to `--ui-*`.

  `wiki/architecture/osn-and-musubi.md` states the discriminator: if an independent
  implementation must use the same string to interoperate, it is OSN; otherwise it
  is not. A `Button` fails that test — nobody has to spell it the way we do — so
  the primitives were never OSN's, and the old page carved them out by hand
  ("it keeps its name because `@pulse/web` and `tools/lab` consume it as well")
  rather than applying the rule. The carve-out is gone.

  | Was                                 | Is                                        | Holds                                                                   |
  | ----------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
  | `@osn/ui/ui/*`, `@osn/ui/lib/utils` | `@shared/ui/ui/*`, `@shared/ui/lib/utils` | The primitives: `Button`, `Card`, `Modal`, `Field`, `Table`, `cn()`     |
  | `@osn/ui/auth`, `@osn/ui/auth/*`    | `@osn/auth-ui`, `@osn/auth-ui/*`          | The auth views: `SignIn`, `Register`, `PasskeysView`, `StepUpDialog`, … |

  `@osn/auth-ui` stays under `osn/` because every view in it is the client half of
  a named ceremony in the spec — its shape is fixed by the protocol, not by our
  styling — and it now depends on `@shared/ui` like any other consumer. Its
  subpaths flatten (`@osn/ui/auth/SignIn` → `@osn/auth-ui/SignIn`), and the
  package's bare specifier is the barrel that `@osn/ui/auth` used to be.

  The token prefix moves with it. `--osn-surface` becomes `--ui-surface`,
  `bg-osn-ground` becomes `bg-ui-ground`, `.osn-toast` becomes `.ui-toast`, and
  `--osn-modal-enter` becomes `--ui-modal-enter`. A prefix naming the system a
  component is _not_ part of was the last thing asserting the old shape. Apps map
  the new names in exactly one place each, the contract block in their global
  stylesheet.

  The rename was driven by an explicit allowlist of the contract's own token
  suffixes rather than a blanket `osn-` → `ui-` substitution, because the same
  compound shape carries protocol identifiers that must not move: `osn-access`,
  `osn-step-up`, `osn-kid`, `osn-pairwise-salt`, the `osn-api`/`osn-social`
  Cloudflare project names. A missed token fails safe by staying `osn-`; a
  mangled audience string would not.

  One string is deliberately left spelled the old way: `ProfileOnboarding`'s
  `localStorage` key. Every browser that has already dismissed that prompt holds
  it under `@osn/ui:profile_onboarding_dismissed`, and renaming the key would show
  the prompt again to exactly the people who said no.

- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
- Updated dependencies [ac41e37]
  - @shared/ui@0.1.0

## 0.2.11

### Patch Changes

- Updated dependencies [894a26f]
  - @osn/ui@1.13.0

## 0.2.10

### Patch Changes

- Updated dependencies [a12d743]
  - @osn/ui@1.12.0

## 0.2.9

### Patch Changes

- Updated dependencies [2c2f120]
  - @osn/ui@1.11.4

## 0.2.8

### Patch Changes

- Updated dependencies [98fd9ee]
  - @osn/ui@1.11.3

## 0.2.7

### Patch Changes

- Updated dependencies [f9cffd9]
  - @osn/ui@1.11.2

## 0.2.6

### Patch Changes

- @osn/ui@1.11.1

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
