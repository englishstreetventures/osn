# @shared/feature-flags

## 0.2.0

### Minor Changes

- 59b6e26: Add GrowthBook feature flags (key-optional, fail-safe) + wire into `@cire/api`.

  New `@shared/feature-flags` package: GrowthBook evaluation for the Workers
  backends. Flags evaluate offline at the edge (`initSync` on a pre-fetched
  payload — no Node APIs, no per-request network). The only network is a cached
  fetch of the SDK payload, and it fails safe.

  Design mirrors `@shared/turnstile`:

  - **Key-optional.** No `GROWTHBOOK_CLIENT_KEY` ⇒ every flag reads its coded
    default from the `FLAGS` registry with zero network, so this ships and deploys
    safely _before_ a GrowthBook account exists — behaviour is unchanged until the
    key is set.
  - **Fail-safe ladder.** Fresh CDN fetch → last-good cached payload → registry
    default. A flag read never throws and never blocks a request on GrowthBook.
  - **Two-layer cache.** Per-isolate memo + optional shared KV namespace
    (`KV_GB_PAYLOAD`); TTL 60s. KV is a pure optimisation — absent ⇒ per-isolate
    in-memory cache.
  - **Typed registry.** `FLAGS` is the single source of truth for flag keys +
    fail-safe defaults; callers reference flags by a typed key (typo ⇒ compile
    error).

  `@cire/api`: the provider is built once per isolate from
  `GROWTHBOOK_CLIENT_KEY` / `GROWTHBOOK_API_HOST` / optional `KV_GB_PAYLOAD`, and
  injected into the route factories (and decorated onto the Elysia context as
  `flags`). `wrangler.toml` carries the `GROWTHBOOK_API_HOST` var and commented
  `GROWTHBOOK_CLIENT_KEY` + `KV_GB_PAYLOAD` setup (top-level + `env.production`).
  Inert until the client key is set — see the package README for the GrowthBook
  Cloud setup checklist.

  **First gate — OSN account linking.** `cire.account-linking` (default off) gates
  the whole guest "Link your Pulse account" surface: `GET`/`POST /api/account/link`
  answer 503 ("disabled") when the flag is off, and the guest UI (`PulseAccountLink`)
  already hides the section on a 503 probe — so linking stays hidden with no
  frontend change, independent of the ARC keys. The POST guard is defense in depth.
  Turn the flag on in the GrowthBook dashboard to reveal it. Also adds
  `createStaticFlags(overrides)` — a network-free provider for tests / forcing
  flags from code.
