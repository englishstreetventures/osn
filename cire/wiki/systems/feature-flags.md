---
title: Feature flags — GrowthBook (key-optional, fail-safe)
tags: [systems, cire, feature-flags, growthbook]
related:
  - "[[overview]]"
  - "[[observability]]"
last-reviewed: 2026-07-23
---

# Feature flags — GrowthBook

Flag + experiment evaluation for `cire/api`, via the shared
`@shared/feature-flags` package (used by every Workers backend). Chosen over an
all-in-one analytics-plus-flags tool so flags and analytics stay separate —
GrowthBook does flags/experiments only.

## Why GrowthBook on Workers

Flags evaluate **offline** at the edge. cire/api hands the GrowthBook SDK a
pre-fetched payload (`initSync`); the SDK does no I/O and needs no Node APIs, so
it runs cleanly in workerd. The only network is a cached fetch of the SDK payload,
and that fetch fails safe. A flag read never blocks a request on GrowthBook and
never throws.

## Design (mirrors `[[cire-auth]]`-era key-optional integrations)

- **Key-optional.** `GROWTHBOOK_CLIENT_KEY` unset ⇒ every flag reads its coded
  default from the `FLAGS` registry with zero network. This is the state before
  a GrowthBook account exists — the code ships and deploys inert and behaves
  exactly as it did before flags. Same pattern as `@shared/turnstile` and the
  maps-embed key.
- **Fail-safe ladder.** Fresh CDN fetch → last-good cached payload → registry
  default.
- **Two-layer cache.** Per-isolate in-memory memo + an OPTIONAL shared KV
  namespace (`KV_GB_PAYLOAD`). TTL 60s. KV absent ⇒ per-isolate cache only
  (still correct — just re-fetches once per cold isolate per TTL).
- **Typed registry.** `FLAGS` (in `shared/feature-flags/src/index.ts`) is the
  single source of truth for which flags exist and their fail-safe defaults.
  Callers reference flags by a typed key — a typo is a compile error.

## Wiring in `cire/api`

The provider is built once per isolate in `src/index.ts` (from
`GROWTHBOOK_CLIENT_KEY` / `GROWTHBOOK_API_HOST` / optional `KV_GB_PAYLOAD`),
alongside the cached Elysia app, and **decorated** onto the request context as
`flags`. Any route handler evaluates a flag with:

```ts
async ({ flags, session }) => {
  const f = await flags.forRequest({ id: session.familyId });
  return f.isOn("cire.account-linking") ? renderLinking() : null;
};
```

`forRequest(attributes)` binds the request's targeting attributes (`id` is the
bucketing key for percentage rollouts). Evaluation itself is synchronous. For
tests, `createStaticFlags({ "cire.account-linking": true })` builds a provider
with explicit values and no network.

## First gate — OSN account linking

`cire.account-linking` (default **off**) gates the whole guest "Link your Pulse
account" surface. Both `GET` and `POST /api/account/link` (`routes/account-link.ts`)
call `flags.forRequest({ id: familyId })` and answer **503** ("disabled") when
the flag is off. The guest UI (`cire/web` `PulseAccountLink`) already treats a
503 status probe as disabled and renders nothing, so the flag hides the section
with **no frontend change** — independent of whether the ARC linking keys exist.
The POST guard is defense in depth (a crafted request can't link while off).
Turn the flag on in the GrowthBook dashboard (feature key `cire.account-linking`)
to reveal it. Add further flags to the registry + the dashboard as features land.

## Config

`wrangler.toml` carries `GROWTHBOOK_API_HOST` (top-level + `env.production`, both
pinned to `https://cdn.growthbook.io`), plus commented `GROWTHBOOK_CLIENT_KEY`
and `KV_GB_PAYLOAD` setup. Named envs do NOT inherit top-level `[vars]` /
`[[kv_namespaces]]`, so both are redeclared per-env.

## GrowthBook Cloud setup (one-time)

See `shared/feature-flags/README.md` for the full checklist. In short: create a
GrowthBook Cloud account (free Starter — unlimited flags + experiments, 3
seats), make an SDK connection, set `GROWTHBOOK_CLIENT_KEY` (secret or var),
optionally create the `KV_GB_PAYLOAD` namespace, redeploy. Flag changes take
effect within the cache TTL (~60s). No webhook required.

## Observability

The payload fetch goes through `@shared/observability`'s `instrumentedFetch`, so
it appears on the trace tree. Flag reads themselves emit no logs. See
`[[observability]]`.
