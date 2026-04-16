// Re-exported from @shared/rate-limit for backwards compatibility within this package.
// External consumers should import from @shared/rate-limit directly.
export type { RateLimiterBackend, RateLimiterConfig, RateLimiter } from "@shared/rate-limit";
export { createRateLimiter, getClientIp } from "@shared/rate-limit";
