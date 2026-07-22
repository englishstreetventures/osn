# @shared/feature-flags

GrowthBook feature-flag evaluation for the monorepo's Cloudflare Workers
backends. Key-optional, fail-safe, edge-native.

## Why GrowthBook

Flags evaluate **offline** at the edge: the SDK is handed a pre-fetched payload
(`initSync`) and does no I/O and needs no Node APIs, so it runs cleanly in the
Workers runtime. The only network is a cached fetch of the feature payload, and
that fails safe. Flags and analytics are kept **separate** on purpose —
GrowthBook does flags/experiments, analytics lives in its own tool.

## Design

- **Key-optional.** No `GROWTHBOOK_CLIENT_KEY` ⇒ every flag reads its coded
  default from the `FLAGS` registry with **zero network**. This mirrors
  `@shared/turnstile`: the code ships and deploys safely *before* a GrowthBook
  account exists, behaving exactly as it did before flags.
- **Fail-safe ladder.** Fresh CDN fetch → last-good cached payload → registry
  default. A flag read never throws and never blocks a request on GrowthBook.
- **Two-layer cache.** An in-isolate memo (per Worker isolate) plus an optional
  KV namespace shared across isolates. TTL default 60s.
- **Typed registry.** `FLAGS` is the single source of truth for which flags
  exist and their fail-safe defaults. Callers reference flags by a typed key, so
  a typo is a compile error.

## Usage

Build one provider per isolate, then evaluate per request:

```ts
import { createFeatureFlags } from "@shared/feature-flags";

// Once per isolate (e.g. in the Worker's cached app build):
const flags = createFeatureFlags({
  clientKey: env.GROWTHBOOK_CLIENT_KEY, // unset ⇒ inert, defaults only
  apiHost: env.GROWTHBOOK_API_HOST, // defaults to https://cdn.growthbook.io
  kv: env.KV_GB_PAYLOAD, // optional cross-isolate cache
});

// Per request, with that request's targeting attributes:
const f = await flags.forRequest({ id: osnProfileId, role: "owner" });
if (f.isOn("cire.account-linking")) {
  // ...
}
const value = f.getValue("cire.account-linking"); // typed to the flag's value type
```

For tests (or to force flags from code) use `createStaticFlags` — no GrowthBook,
no network:

```ts
import { createStaticFlags } from "@shared/feature-flags";
const flags = createStaticFlags({ "cire.account-linking": true });
```

In `@cire/api` the provider is decorated onto the Elysia context as `flags`, so
any route handler can:

```ts
async ({ flags, session }) => {
  const f = await flags.forRequest({ id: session.familyId });
  return f.isOn("cire.account-linking") ? renderLinking() : null;
};
```

The first real gate is OSN account linking: `cire.account-linking` (default off)
gates `GET`/`POST /api/account/link`, so the guest "Link your Pulse account"
section stays hidden until the flag is turned on.

### Adding a flag

1. Add the key + fail-safe default to `FLAGS` in `src/index.ts` (namespace by
   product: `cire.*`, `osn.*`).
2. Create the matching feature in the GrowthBook dashboard with the same key.
3. Read it via `f.isOn("your.key")` / `f.getValue("your.key")`.

The default in `FLAGS` is what callers get when GrowthBook is unconfigured,
unreachable, or has no rule — so choose the safe value (usually "off"/current
behaviour).

## GrowthBook Cloud setup (one-time)

The code ships inert until these are done — nothing here blocks a deploy.

1. Create a **GrowthBook Cloud** account (free Starter: unlimited flags +
   experiments, 3 seats). Create an organisation.
2. **SDK Connection** → new connection for the environment → copy the **client
   key** (`sdk-...`).
3. Set it on the Worker:
   `bunx wrangler secret put GROWTHBOOK_CLIENT_KEY --env production`
   (or add it under `[vars]` — the client key only authorises reading the public
   payload, so a var is acceptable; a secret keeps it out of git).
4. (Optional, recommended for prod) create the KV cache namespace and uncomment
   the `KV_GB_PAYLOAD` binding in `wrangler.toml`:
   `bunx wrangler kv namespace create KV_GB_PAYLOAD`
5. Redeploy. Flags now evaluate live; changes propagate within the cache TTL
   (~60s). No webhook is required — the SDK payload is fetched + cached. A push
   webhook (instant propagation, zero fetches) is a later optimisation.

## Test

```bash
bun run --cwd shared/feature-flags test
```
