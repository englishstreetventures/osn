# @shared/dev-urls

## 0.1.4

### Patch Changes

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

## 0.1.3

### Patch Changes

- 3fbf1b7: Take @changesets/cli 3.0.1, and make the `privatePackages` setting explicit first.

  `@changesets/config` changed its default between the two CLI majors: with no `privatePackages` key, 3.1.4 (used by CLI 2.31.1) resolves `{ version: true, tag: false }`, while 4.0.0 (used by CLI 3.0.1) resolves `{ version: false, tag: false }`. Every one of the 38 workspace packages is `private: true`, so on the new default all of them would be skipped, `versionablePackages` would be empty, and `changeset add` would abort with "No versionable packages found" — breaking the command every PR here is required to run.

  Writing `{ "version": true, "tag": false }` into `.changeset/config.json` pins the behaviour the repo already had. Verified as a no-op on 2.31.1 (identical 28-package queue before and after) and then verified again on 3.0.1 by a real `changeset version` pass, which produced correct version bumps and CHANGELOG entries across 66 files.

  Because that key is load-bearing and its absence fails loudly but obscurely, `CLAUDE.md`'s Changesets row now records it: a future tidy-up of `.changeset/config.json` would otherwise read the line as redundant and delete it.

- 00ed19f: Take the latest in-range release of 28 dependencies, raising each declared floor to what the lockfile already resolves to. Runtime: effect 3.22.1, elysia 1.4.30, @effect/platform 0.97.1, solid-js 1.9.15, @solidjs/router 0.16.3, @solidjs/start 2.0.4, @kobalte/core 0.13.13, motion 12.43.0, astro 7.2.9, @astrojs/solid-js 7.0.2, @astrojs/cloudflare 14.2.5, @simplewebauthn/server 13.3.3, @upstash/redis 1.38.3, @growthbook/growthbook 1.7.0, cropperjs 2.2.0. Tooling and types: vite 8.2.2, vitest 4.1.11 (with @vitest/browser, @vitest/browser-playwright and @vitest/coverage-istanbul), wrangler 4.127.1, miniflare 4.20260730.0, happy-dom 20.12.0, turbo 2.10.12, lefthook 2.1.12, portless 0.15.6, @types/leaflet 1.9.22, @types/three 0.185.4.

  No source change. Every gate passes unchanged, including the Miniflare D1 tier and the real-Chromium browser tier.

  Two consequences of the wrangler bump that the version list does not show, recorded here so they are accepted rather than discovered. Wrangler 4.127.1 nests `miniflare@5.20260828.0-alpha` — an alpha build of the local Workers runtime — under both itself and `@cloudflare/vite-plugin`, so `wrangler dev` and the vite plugin now run on a prerelease. The top-level `miniflare` stays stable at 4.20260730.0, so the `test:d1` tier is untouched. The three-day `minimumReleaseAge` soak still applies to the alpha and `minimumReleaseAgeExcludes` is empty, so nothing here skips the gate. Separately, raising `vite` to 8.2.2 raises what vite requires: it now asks for `postcss ^8.5.26` and `picomatch ^4.0.5`, both above the floors the root overrides pin. Those floors are corrected in a later PR in this stack rather than here, because they need a lockfile refresh.

## 0.1.2

### Patch Changes

- e382c40: Enforce the access-token `issuer` claim in every downstream verifier.

  `@shared/osn-auth-client` has always accepted an expected `iss`, but every consumer left it unset — deliberately, because a verifier that pins the issuer rejects every token minted before osn-api started stamping one, and the rollout had to be verifier-first. Access tokens live five minutes, so that window closed long ago: every live token carries `iss`, and leaving the check off means a token from any other OSN deployment verifies here as long as it is signed by a key that deployment's JWKS vouches for.

  `cire/api`, `pulse/api` and `zap/api` now pass the expected issuer on every `extractClaims` call. In pulse and zap the JWKS URL and the issuer travel as one `OsnTokenVerification` value rather than two loose strings, so a call site cannot supply one and silently forget the other — which is the failure mode that left this unenforced, since an unset expected issuer is not an error, it is simply no check.

  `OSN_ISSUER_URL` is now required in a deployed tier and must equal osn-api's own value byte for byte; a mismatch 401s every authenticated request, so the two flip in the same deploy. `zap/api` gains the var, which it did not read before. `@shared/crypto/testing`'s signer stamps the local issuer by default, so a suite that injects a test key mints tokens its routes accept; pass a different origin, or `null`, to exercise the rejection paths.

  Three things fell out of reviewing it. `extractClaims` now treats an expected issuer that is present but **empty** as a configuration failure rather than as "no issuer check" — an unset env var reaching the verifier was the one way this could look configured while checking nothing. The comparison normalises a trailing slash on both sides, since six hand-maintained `wrangler.toml` values feed it and `jose` compares byte for byte. And `zap/api` gains `OSN_ISSUER_URL`/`OSN_JWKS_URL` in the portless devloop, which it never had — every bearer-authenticated zap route was 401ing locally, and pinning the issuer is what made that visible.

## 0.1.1

### Patch Changes

- 7a75d6c: Run the component lab behind portless like every other dev server: `bun run dev:lab` now answers on `https://lab.localhost`, and a branch worktree gets its own copy of it. Also puts `PORTLESS` in turbo's `globalPassThroughEnv` — strict env mode was stripping it, so the documented `PORTLESS=0` fallback never reached any app.

## 0.1.0

### Minor Changes

- fe3ee5d: Run the devloop behind portless: named HTTPS hosts instead of ports, and one stack per worktree.

  Every app's `dev` script is now `portless`, which reads that package's own `"portless"` key and runs its real command (`dev:app`) behind the proxy. `@osn/api` answers on `https://id.musubi.localhost`, `@pulse/web` on `https://pulse.localhost`, and so on — twelve port numbers nobody has to remember, and no clash when two things want 4321. The names mirror production hostnames.

  The nesting under a shared parent is load-bearing rather than cosmetic. A WebAuthn RP ID has to be the origin's host or a registrable suffix of it, so passkeys created on `@osn/social` are only verifiable by `@osn/api` if both sit under one parent: `musubi.localhost` and `id.musubi.localhost`, RP ID `musubi.localhost`. Flat names would have put every local passkey out of reach of the API that checks it.

  In a linked worktree portless prepends the branch, so `bun run dev` in two worktrees gives two complete, independent stacks. That is also why no app can be told where its siblings live from a committed `.env` — the answer differs per worktree. The new `@shared/dev-urls` package derives it instead: its `dev-env` launcher fronts each `dev:app`, reads the app's own `PORTLESS_URL`, splits off the shared worktree prefix and TLD, and rebuilds every sibling's origin from them. It exports the same env vars the deployed tiers set (`OSN_ISSUER_URL`, `OSN_RP_ID`, `OSN_ORIGIN`, `PULSE_CORS_ORIGIN`, `PUBLIC_API_URL`, …), so no app source knows portless exists.

  Two posture changes worth naming. `OSN_RP_ID` was the bare `localhost`, which every app on the machine shares; it is now `musubi.localhost`, so a local passkey is scoped to the account family — existing `localhost` passkeys will not resolve and need re-enrolling. And `DEV_LOGIN_RETURN_ORIGINS`, which the Bun devloop left unset (closed: every `return_to` a 400), now carries the same four frontend origins `wrangler.toml` already set for `wrangler dev`. The route still only mounts when `DEV_LOGIN_SECRET` is set.

  `PORTLESS=0 bun run dev` still gives the old fixed-port devloop. The ports the frontends lost from their `dev` scripts moved into their configs behind `devPort()`, which prefers the `PORT` portless assigns and falls back to the old literal, so the bypass keeps working and the four Astro apps do not all land on 4321.
