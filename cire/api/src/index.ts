// Cloudflare Workers entry point — D1 integration pending.
// For local development, use: bun run dev (src/local.ts).
//
// When the D1 entry path lands, this handler builds the app once per isolate
// via `createApp(db, { ..., claimRateLimitBinding: env.CLAIM_RATE_LIMITER })` so
// the claim endpoint is throttled by the native Cloudflare Workers Rate Limiting
// binding (C1/C4) instead of the per-isolate in-memory limiter. The binding is
// declared in `wrangler.toml` under `[[unsafe.bindings]]` (type `ratelimit`).

// The worker bindings (`DB`, `SHEETS`, `CLAIM_RATE_LIMITER`, vars) are typed by
// the generated `worker-configuration.d.ts` (`bunx wrangler types`) as the
// ambient `Env` interface — regenerate it after any `wrangler.toml` change.

export default {
  fetch(): Response {
    return new Response(JSON.stringify({ error: "D1 integration pending — use dev:local" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  },
};
