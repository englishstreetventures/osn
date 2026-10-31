import type { WorkersRateLimitBinding } from "@shared/rate-limit";

/** A native rate-limit binding that admits everything. */
export const allowingBinding = (): WorkersRateLimitBinding => ({
  limit: async () => ({ success: true }),
});

/** The per-user tiers a deployed Worker refuses to serve without. */
export const userTierBindings = () => ({
  RL_USER_20_60: allowingBinding(),
  RL_USER_60_60: allowingBinding(),
});
