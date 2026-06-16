/**
 * Global, atomic per-IP rate limiter backed by the native Cloudflare Workers
 * Rate Limiting binding (C1/C4).
 *
 * The in-memory `createRateLimiter` from `@shared/rate-limit` keeps state in a
 * single isolate's heap. On Workers that state is per-isolate and resets on
 * eviction, so a determined caller spread across isolates (or one that simply
 * waits out an eviction) gets far more than the configured budget. The native
 * `ratelimit` binding is enforced globally and atomically at the edge, which is
 * what the claim brute-force protection actually needs.
 *
 * This backend satisfies the same `RateLimiterBackend` contract as the
 * in-memory one (`check(key): Promise<boolean>`), so it drops into the existing
 * `rateLimitMiddleware` and route wiring without call-site changes. The
 * window/limit live in `wrangler.toml` (`simple = { limit, period }`) — they are
 * NOT configurable here, by design, so the throttle is one source of truth.
 */

import type { RateLimiterBackend } from "@shared/rate-limit";

/**
 * Minimal shape of the Cloudflare Workers Rate Limiting binding. We type only
 * what we use rather than pulling the full generated `RateLimit` type, so this
 * file has no dependency on `wrangler types` output (mirrors the hand-typed
 * `R2Bucket` style used elsewhere in cire/api).
 */
export interface WorkersRateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Wrap a Workers `ratelimit` binding as a `RateLimiterBackend`.
 *
 * Fail-closed: any throw from the binding (transient platform error) is treated
 * as "not allowed" — the same posture as the rest of cire's pre-auth surface.
 * The limiter gates a credential-exchange endpoint, so degrading to "deny" on
 * an unexpected error is correct; degrading to "allow" would open the
 * brute-force window precisely when the platform is unhealthy.
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
