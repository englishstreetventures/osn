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

import type { AccountErasureRateLimiters } from "../routes/account-erasure";
import type { AuthRateLimiters } from "../routes/auth";
import { AUTH_RATE_LIMITS, MINUTE_MS, OSN_RATE_LIMITS } from "../routes/auth/limiters";
import type { ProfileRateLimiters } from "../routes/profile";
import type { RecommendationRateLimiters } from "../routes/recommendations";

/**
 * The native binding tiers, named `RL_<kind>_<limit>_<periodSeconds>`. Each is
 * declared as a `[[ratelimits]]` block in `osn/api/wrangler.toml` with
 * `simple = { limit = <limit>, period = 60 }`, mirrored into every named env.
 *
 * - `RL_AUTH_IP_*`: per-IP, for the auth routes and profile create, delete
 *   and set-default. Optional: absent ⇒ those limiters stay on the fallback.
 * - `RL_USER_*`: per-user, for graph and organisation writes and the two
 *   recommendation endpoints. A deployed Worker without them answers 503
 *   ({@link USER_TIERS}); only local tiers fall back.
 */
export interface OsnRateLimitBindings {
  RL_AUTH_IP_5_60: WorkersRateLimitBinding;
  RL_AUTH_IP_10_60: WorkersRateLimitBinding;
  RL_AUTH_IP_20_60: WorkersRateLimitBinding;
  RL_AUTH_IP_30_60: WorkersRateLimitBinding;
  RL_AUTH_IP_60_60: WorkersRateLimitBinding;
  RL_USER_20_60: WorkersRateLimitBinding;
  RL_USER_60_60: WorkersRateLimitBinding;
}

type TierName = keyof OsnRateLimitBindings;

const AUTH_IP_TIERS: readonly TierName[] = [
  "RL_AUTH_IP_5_60",
  "RL_AUTH_IP_10_60",
  "RL_AUTH_IP_20_60",
  "RL_AUTH_IP_30_60",
  "RL_AUTH_IP_60_60",
];

/** The per-user tiers. Required outside local: `fetch` answers 503 without them. */
export const USER_TIERS = ["RL_USER_20_60", "RL_USER_60_60"] as const satisfies readonly TierName[];

/** Every tier, in the order `wrangler.toml` declares them. */
export const ALL_TIERS: readonly TierName[] = [...AUTH_IP_TIERS, ...USER_TIERS];

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
  for (const tier of ALL_TIERS) {
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

/** The non-auth limiters a native binding can carry: every one-minute one. */
export interface OsnMinuteLimiters {
  readonly graphRateLimiter: RateLimiterBackend;
  readonly orgRateLimiter: RateLimiterBackend;
  readonly profileRateLimiters: ProfileRateLimiters;
  readonly recommendationRateLimiters: RecommendationRateLimiters;
  readonly healthProbeLimiter: RateLimiterBackend;
  readonly accountExportIpLimiter: RateLimiterBackend;
  readonly accountErasureRateLimiters: AccountErasureRateLimiters;
}

type OsnMinuteBudget =
  | "graphWrite"
  | "orgWrite"
  | "recommendationSuggest"
  | "recommendationSearch"
  | "profileCreate"
  | "profileDelete"
  | "profileSetDefault"
  | "healthCoordination"
  | "accountExportIp"
  | "accountDeletionStatus";

/**
 * Which tier each one-minute non-auth limiter runs on. Per-user keys (graph,
 * organisation, recommendations) take an `RL_USER_*` tier; profile create,
 * delete and set-default, `GET /health/coordination`, the account export's
 * IP guard and `GET /account/deletion-status` are keyed per IP, so they share
 * the `RL_AUTH_IP_*` tiers under their own key prefix. The limit in each
 * tier's name is the budget's `maxRequests`; a test holds the two together.
 */
export const NATIVE_BINDING_FOR_OSN_LIMITER = {
  graphWrite: "RL_USER_60_60",
  orgWrite: "RL_USER_60_60",
  recommendationSuggest: "RL_USER_20_60",
  recommendationSearch: "RL_USER_60_60",
  profileCreate: "RL_AUTH_IP_5_60",
  profileDelete: "RL_AUTH_IP_5_60",
  profileSetDefault: "RL_AUTH_IP_10_60",
  healthCoordination: "RL_AUTH_IP_10_60",
  accountExportIp: "RL_AUTH_IP_30_60",
  accountDeletionStatus: "RL_AUTH_IP_30_60",
} as const satisfies Readonly<Record<OsnMinuteBudget, TierName>>;

/**
 * Return `fallback` with each one-minute non-auth limiter moved onto its tier
 * binding, keyed `"<store>:" + key` (the budget's coordination store name, so
 * two limiters sharing a tier never share a bucket). A limiter whose tier is
 * absent stays on the fallback; `fetch` refuses to serve a deployed tier
 * without the per-user ones.
 */
export function selectOsnLimiters(
  bindings: Partial<OsnRateLimitBindings>,
  fallback: OsnMinuteLimiters,
): OsnMinuteLimiters {
  const wrapped = new Map<TierName, RateLimiterBackend>();
  const pick = (budget: OsnMinuteBudget, slot: RateLimiterBackend): RateLimiterBackend => {
    const tier = NATIVE_BINDING_FOR_OSN_LIMITER[budget];
    const binding = bindings[tier];
    if (!binding) return slot;
    let backend = wrapped.get(tier);
    if (!backend) {
      backend = createWorkersRateLimiter(binding);
      wrapped.set(tier, backend);
    }
    const prefix = OSN_RATE_LIMITS[budget].store;
    const native = backend;
    return { check: (key: string) => native.check(`${prefix}:${key}`) };
  };
  return {
    graphRateLimiter: pick("graphWrite", fallback.graphRateLimiter),
    orgRateLimiter: pick("orgWrite", fallback.orgRateLimiter),
    profileRateLimiters: {
      profileCreate: pick("profileCreate", fallback.profileRateLimiters.profileCreate),
      profileDelete: pick("profileDelete", fallback.profileRateLimiters.profileDelete),
      profileSetDefault: pick("profileSetDefault", fallback.profileRateLimiters.profileSetDefault),
    },
    recommendationRateLimiters: {
      suggest: pick("recommendationSuggest", fallback.recommendationRateLimiters.suggest),
      search: pick("recommendationSearch", fallback.recommendationRateLimiters.search),
    },
    healthProbeLimiter: pick("healthCoordination", fallback.healthProbeLimiter),
    accountExportIpLimiter: pick("accountExportIp", fallback.accountExportIpLimiter),
    // Deletion and restore are per account and an hour long, so they stay on
    // the store.
    accountErasureRateLimiters: {
      ...fallback.accountErasureRateLimiters,
      accountDeletionStatus: pick(
        "accountDeletionStatus",
        fallback.accountErasureRateLimiters.accountDeletionStatus,
      ),
    },
  };
}
