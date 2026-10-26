/**
 * Selects which auth rate limiters run on the Cloudflare Workers native Rate
 * Limiting binding and which stay on the fallback bundle the caller supplies.
 *
 * Only the **60-second-window, per-IP** auth limiters move onto the native
 * binding. They are the brute-force-facing pre-auth throttles where the native
 * binding's global+atomic edge enforcement is a strict win over the per-isolate
 * in-memory fallback, and where its per-colo accounting trade-off is acceptable
 * (a single attacker is pinned to one colo). The window/budget live in
 * `wrangler.toml` (`simple = { limit, period }`), keyed here by tier, and a
 * test holds those numbers to `AUTH_RATE_LIMITS`.
 *
 * The **1-hour-window** per-IP limiters stay on the fallback: the native
 * binding only supports `period` 10 or 60s. {@link HOUR_WINDOW_IP_AUTH_LIMITERS}
 * is the list, derived from the budget table, so a budget's window decides
 * where it runs.
 *
 * The native binding tiers are grouped by request budget so each endpoint keeps
 * its exact 60s budget; the per-endpoint namespace prefix in the key string
 * keeps two endpoints that share a tier from sharing a bucket.
 */

import {
  createWorkersRateLimiter,
  type RateLimiterBackend,
  type WorkersRateLimitBinding,
} from "@shared/rate-limit";

import type { AuthRateLimiters } from "../routes/auth";
import { AUTH_RATE_LIMITS, MINUTE_MS } from "../routes/auth/limiters";

/**
 * The five native binding tiers, named `RL_AUTH_IP_<limit>_<periodSeconds>`.
 * Each is declared as a `[[ratelimits]]` block in `osn/api/wrangler.toml` with
 * `simple = { limit = <limit>, period = 60 }`, mirrored into every named env.
 * Optional in the type: absent (local / Bun / non-Workers) ⇒ the fallback.
 */
export interface OsnRateLimitBindings {
  RL_AUTH_IP_5_60: WorkersRateLimitBinding;
  RL_AUTH_IP_10_60: WorkersRateLimitBinding;
  RL_AUTH_IP_20_60: WorkersRateLimitBinding;
  RL_AUTH_IP_30_60: WorkersRateLimitBinding;
  RL_AUTH_IP_60_60: WorkersRateLimitBinding;
}

type TierName = keyof OsnRateLimitBindings;

const AUTH_IP_TIERS: readonly TierName[] = [
  "RL_AUTH_IP_5_60",
  "RL_AUTH_IP_10_60",
  "RL_AUTH_IP_20_60",
  "RL_AUTH_IP_30_60",
  "RL_AUTH_IP_60_60",
];

/**
 * The tier binding a one-minute budget of `maxRequests` runs on, or
 * `undefined` when no tier has that limit. A test fails if any one-minute auth
 * budget has no tier, so the fallback here is never what production runs.
 */
export function authIpTierFor(maxRequests: number): TierName | undefined {
  const name = `RL_AUTH_IP_${maxRequests}_60`;
  return AUTH_IP_TIERS.find((tier) => tier === name);
}

type AuthLimiterKey = keyof AuthRateLimiters;

/**
 * Every 60s-window per-IP auth limiter, mapped to its native binding tier (by
 * budget) and its endpoint name, which prefixes the key. Derived from
 * {@link AUTH_RATE_LIMITS}; the hour-window limiters are absent.
 */
export const NATIVE_BINDING_FOR_AUTH_LIMITER: Readonly<
  Partial<Record<AuthLimiterKey, { readonly tier: TierName; readonly ns: string }>>
> = Object.fromEntries(
  (Object.keys(AUTH_RATE_LIMITS) as AuthLimiterKey[]).flatMap((key) => {
    const budget = AUTH_RATE_LIMITS[key];
    if (budget.windowMs !== MINUTE_MS) return [];
    const tier = authIpTierFor(budget.maxRequests);
    return tier ? [[key, { tier, ns: budget.ns }]] : [];
  }),
);

/**
 * The per-IP auth limiters whose window is longer than a minute, so no native
 * binding can carry them. Derived from {@link AUTH_RATE_LIMITS}.
 */
export const HOUR_WINDOW_IP_AUTH_LIMITERS: ReadonlySet<AuthLimiterKey> = new Set(
  (Object.keys(AUTH_RATE_LIMITS) as AuthLimiterKey[]).filter(
    (key) => AUTH_RATE_LIMITS[key].windowMs !== MINUTE_MS,
  ),
);

/**
 * Collect the native rate-limit bindings off a runtime `env`. Returns
 * `undefined` when NONE are present (local `wrangler dev` without the bindings,
 * the Bun dev server, or any non-Workers runtime) so the caller keeps the
 * fallback. When at least one is present we surface the partial map; the
 * selector only routes the slots whose tier binding actually exists.
 *
 * The parameter names the tier slots and makes every one optional, which is
 * all a runtime env promises: a key may simply be absent (no binding declared
 * for this environment). The `limit`-is-a-function check below is still what
 * earns a slot a place in the returned map — a declared binding that workerd
 * handed us as something else never reaches the selector.
 */
export function readOsnRateLimitBindings(
  env: Readonly<Partial<OsnRateLimitBindings>>,
): Partial<OsnRateLimitBindings> | undefined {
  const present: Partial<OsnRateLimitBindings> = {};
  let any = false;
  for (const tier of AUTH_IP_TIERS) {
    const binding = env[tier];
    if (binding && typeof binding.limit === "function") {
      present[tier] = binding;
      any = true;
    }
  }
  return any ? present : undefined;
}

/**
 * `AuthRateLimiters` with the `readonly` stripped — the bundle is assembled
 * slot by slot below before it is handed out as the immutable public type.
 */
type MutableAuthRateLimiters = {
  -readonly [K in keyof AuthRateLimiters]: AuthRateLimiters[K];
};

/**
 * Return an {@link AuthRateLimiters} bundle where every 60s-window per-IP slot is
 * backed by its native binding tier (key = `"<endpoint_ns>:" + ip`), and every
 * 1-hour-window slot is left on the supplied `fallback` unchanged.
 *
 * A 60s slot whose tier binding is absent from `bindings` also stays on the
 * fallback, so a partial binding set degrades gracefully rather than dropping
 * the throttle. Fail-closed is preserved: `createWorkersRateLimiter` denies on
 * any binding throw.
 */
export function selectAuthRateLimiters(
  bindings: Partial<OsnRateLimitBindings>,
  fallback: AuthRateLimiters,
): AuthRateLimiters {
  // Cache one wrapped backend per present tier so endpoints sharing a tier share
  // the wrapper (they stay isolated via the per-endpoint key prefix below).
  const wrapped = new Map<TierName, RateLimiterBackend>();
  const backendFor = (tier: TierName): RateLimiterBackend | undefined => {
    const binding = bindings[tier];
    if (!binding) return undefined;
    let backend = wrapped.get(tier);
    if (!backend) {
      backend = createWorkersRateLimiter(binding);
      wrapped.set(tier, backend);
    }
    return backend;
  };

  const out: MutableAuthRateLimiters = { ...fallback };
  for (const [endpoint, entry] of Object.entries(NATIVE_BINDING_FOR_AUTH_LIMITER) as [
    AuthLimiterKey,
    { tier: TierName; ns: string },
  ][]) {
    const backend = backendFor(entry.tier);
    if (!backend) continue; // tier binding absent ⇒ keep the fallback slot.
    out[endpoint] = {
      check: (ip: string) => backend.check(`${entry.ns}:${ip}`),
    };
  }
  return out;
}
