/**
 * Selects which auth rate limiters run on the Cloudflare Workers native Rate
 * Limiting binding vs the Upstash/Redis fallback (Part 2 of the ratelimit
 * hardening).
 *
 * Only the **60-second-window, per-IP** auth limiters move onto the native
 * binding. They are the brute-force-facing pre-auth throttles where the native
 * binding's global+atomic edge enforcement is a strict win over the per-isolate
 * in-memory fallback, and where its per-colo accounting trade-off is acceptable
 * (a single attacker is pinned to one colo). The window/budget live in
 * `wrangler.toml` (`simple = { limit, period }`), keyed here by tier.
 *
 * Everything else stays on Redis, untouched, and is built in `build-deps.ts`:
 *   - the three **1-hour-window** per-IP limiters (`recoveryGenerate`,
 *     `recoveryComplete`, `emailChangeBegin`) — the native binding only supports
 *     `period` 10 or 60s, so 1-hour windows CANNOT move;
 *   - every per-user / per-account limiter (graph/org writes, recommendations,
 *     the profile-switch + email-change caps) and every stateful store
 *     (recovery lockout, step-up JTI, rotated-session, ceremony stores).
 *
 * The native binding tiers are grouped by request budget so each endpoint keeps
 * the exact 60s budget it has today; the per-endpoint namespace prefix in the
 * key string keeps two endpoints that share a tier from sharing a bucket.
 */

import {
  createWorkersRateLimiter,
  type RateLimiterBackend,
  type WorkersRateLimitBinding,
} from "@shared/rate-limit";

import type { AuthRateLimiters } from "../routes/auth";

/**
 * The five native binding tiers, named `RL_AUTH_IP_<limit>_<periodSeconds>`.
 * Each is declared as a `[[ratelimits]]` block in `osn/api/wrangler.toml` with
 * `simple = { limit = <limit>, period = 60 }`, mirrored into every named env.
 * Optional in the type: absent (local / Bun / non-Workers) ⇒ Redis fallback.
 */
export interface OsnRateLimitBindings {
  RL_AUTH_IP_5_60: WorkersRateLimitBinding;
  RL_AUTH_IP_10_60: WorkersRateLimitBinding;
  RL_AUTH_IP_20_60: WorkersRateLimitBinding;
  RL_AUTH_IP_30_60: WorkersRateLimitBinding;
  RL_AUTH_IP_60_60: WorkersRateLimitBinding;
}

type TierName = keyof OsnRateLimitBindings;

/**
 * Every 60s-window per-IP auth limiter, mapped to its native binding tier (by
 * existing budget) and a per-endpoint namespace prefix for the key string.
 * Budgets mirror `createDefaultAuthRateLimiters()` in `routes/auth.ts` exactly.
 *
 * The three 1-hour-window limiters are deliberately ABSENT here — they stay on
 * Redis ({@link HOUR_WINDOW_IP_AUTH_LIMITERS}).
 */
export const NATIVE_BINDING_FOR_AUTH_LIMITER = {
  registerBegin: { tier: "RL_AUTH_IP_5_60", ns: "register_begin" },
  registerComplete: { tier: "RL_AUTH_IP_10_60", ns: "register_complete" },
  // handle-check fires as-you-type; login-begin is auto-fired by the passkey
  // conditional-UI / autofill ceremony on every page load — both are cheap and
  // legitimately exceed 10/min in normal use, so they get generous headroom
  // (the real gates are register-complete / login-complete, which require a
  // valid assertion and stay tight).
  handleCheck: { tier: "RL_AUTH_IP_30_60", ns: "handle_check" },
  passkeyLoginBegin: { tier: "RL_AUTH_IP_60_60", ns: "passkey_login_begin" },
  passkeyLoginComplete: { tier: "RL_AUTH_IP_20_60", ns: "passkey_login_complete" },
  passkeyRegisterBegin: { tier: "RL_AUTH_IP_10_60", ns: "passkey_register_begin" },
  passkeyRegisterComplete: { tier: "RL_AUTH_IP_10_60", ns: "passkey_register_complete" },
  profileSwitch: { tier: "RL_AUTH_IP_10_60", ns: "profile_switch" },
  profileList: { tier: "RL_AUTH_IP_10_60", ns: "profile_list" },
  stepUpPasskeyBegin: { tier: "RL_AUTH_IP_10_60", ns: "step_up_passkey_begin" },
  stepUpPasskeyComplete: { tier: "RL_AUTH_IP_10_60", ns: "step_up_passkey_complete" },
  stepUpOtpBegin: { tier: "RL_AUTH_IP_5_60", ns: "step_up_otp_begin" },
  stepUpOtpComplete: { tier: "RL_AUTH_IP_10_60", ns: "step_up_otp_complete" },
  sessionList: { tier: "RL_AUTH_IP_30_60", ns: "session_list" },
  sessionRevoke: { tier: "RL_AUTH_IP_10_60", ns: "session_revoke" },
  emailChangeComplete: { tier: "RL_AUTH_IP_10_60", ns: "email_change_complete" },
  securityEventList: { tier: "RL_AUTH_IP_30_60", ns: "security_event_list" },
  securityEventAck: { tier: "RL_AUTH_IP_10_60", ns: "security_event_ack" },
  passkeyList: { tier: "RL_AUTH_IP_30_60", ns: "passkey_list" },
  passkeyRename: { tier: "RL_AUTH_IP_20_60", ns: "passkey_rename" },
  passkeyDelete: { tier: "RL_AUTH_IP_10_60", ns: "passkey_delete" },
  crossDeviceBegin: { tier: "RL_AUTH_IP_5_60", ns: "cross_device_begin" },
  crossDevicePoll: { tier: "RL_AUTH_IP_60_60", ns: "cross_device_poll" },
  crossDeviceApprove: { tier: "RL_AUTH_IP_10_60", ns: "cross_device_approve" },
  crossDeviceReject: { tier: "RL_AUTH_IP_10_60", ns: "cross_device_reject" },
} satisfies Partial<Record<keyof AuthRateLimiters, { tier: TierName; ns: string }>>;

/**
 * The per-IP auth limiters that MUST stay on Redis because their window is
 * 1 hour — the native binding only supports `period` 10 or 60s. Kept as a set so
 * the selector can leave these slots on the Redis fallback untouched.
 */
export const HOUR_WINDOW_IP_AUTH_LIMITERS: ReadonlySet<keyof AuthRateLimiters> = new Set([
  "recoveryGenerate",
  "recoveryComplete",
  "emailChangeBegin",
]);

/**
 * Collect the native rate-limit bindings off a runtime `env` record. Returns
 * `undefined` when NONE are present (local `wrangler dev` without the bindings,
 * the Bun dev server, or any non-Workers runtime) so the caller keeps the Redis
 * path. When at least one is present we surface the partial map; the selector
 * only routes the slots whose tier binding actually exists.
 */
export function readOsnRateLimitBindings(
  env: Readonly<Record<string, unknown>>,
): Partial<OsnRateLimitBindings> | undefined {
  const tiers: TierName[] = [
    "RL_AUTH_IP_5_60",
    "RL_AUTH_IP_10_60",
    "RL_AUTH_IP_20_60",
    "RL_AUTH_IP_30_60",
    "RL_AUTH_IP_60_60",
  ];
  const present: Partial<OsnRateLimitBindings> = {};
  let any = false;
  for (const tier of tiers) {
    const binding = env[tier];
    if (binding && typeof (binding as WorkersRateLimitBinding).limit === "function") {
      present[tier] = binding as WorkersRateLimitBinding;
      any = true;
    }
  }
  return any ? present : undefined;
}

/**
 * Return an {@link AuthRateLimiters} bundle where every 60s-window per-IP slot is
 * backed by its native binding tier (key = `"<endpoint_ns>:" + ip`), and every
 * 1-hour-window slot is left on the supplied Redis `fallback` unchanged.
 *
 * A 60s slot whose tier binding is absent from `bindings` also falls back to
 * Redis, so a partial binding set degrades gracefully rather than dropping the
 * throttle. Fail-closed is preserved: `createWorkersRateLimiter` denies on any
 * binding throw.
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

  const out: Record<string, RateLimiterBackend> = { ...fallback };
  for (const [endpoint, { tier, ns }] of Object.entries(NATIVE_BINDING_FOR_AUTH_LIMITER) as [
    keyof AuthRateLimiters,
    { tier: TierName; ns: string },
  ][]) {
    const backend = backendFor(tier);
    if (!backend) continue; // tier binding absent ⇒ keep the Redis fallback slot.
    out[endpoint] = {
      check: (ip: string) => backend.check(`${ns}:${ip}`),
    };
  }
  return out as AuthRateLimiters;
}
