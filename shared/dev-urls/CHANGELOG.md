# @shared/dev-urls

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
