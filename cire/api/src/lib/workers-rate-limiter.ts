/**
 * Global, atomic per-key rate limiter backed by the native Cloudflare Workers
 * Rate Limiting binding (C1/C4).
 *
 * The in-memory `createRateLimiter` from `@shared/rate-limit` keeps state in a
 * single isolate's heap. On Workers that state is per-isolate and resets on
 * eviction, so a determined caller spread across isolates (or one that simply
 * waits out an eviction) gets far more than the configured budget. The native
 * `ratelimit` binding is enforced globally + atomically at the edge, which is
 * what brute-force protection on the pre-auth claim surface actually needs.
 *
 * This backend satisfies the same {@link RateLimiterBackend} contract as the
 * in-memory one (`check(key): Promise<boolean>`), so it drops into the existing
 * `rateLimitMiddleware` and route wiring with no call-site changes. The
 * window/limit live in `wrangler.toml` (`simple = { limit, period }`) — they are
 * deliberately NOT configurable here so the throttle has one source of truth.
 */

import type { RateLimiterBackend } from "@shared/rate-limit";

/**
 * Minimal shape of the Cloudflare Workers Rate Limiting binding. We type only
 * what we call rather than depending on the generated `RateLimit` type, mirroring
 * the hand-typed `R2Bucket` style used elsewhere in cire/api (`index.ts`,
 * `services/r2-imports.ts`).
 */
export interface WorkersRateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Wrap a Workers `ratelimit` binding as a {@link RateLimiterBackend}.
 *
 * **Fail-closed (C1/C4):** any throw from the binding (transient platform error)
 * is treated as "not allowed". The limiter gates a credential-exchange endpoint,
 * so degrading to "deny" on an unexpected error is correct — degrading to
 * "allow" would open the brute-force window precisely when the platform is
 * unhealthy. This matches the posture of the rest of cire's pre-auth surface.
 */
export function createWorkersRateLimiter(binding: WorkersRateLimitBinding): RateLimiterBackend {
  return {
    async check(key: string): Promise<boolean> {
      try {
        const { success } = await binding.limit({ key });
        return success;
      } catch {
        return false;
      }
    },
  };
}
