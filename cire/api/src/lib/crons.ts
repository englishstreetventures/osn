/**
 * cire-api's two cron triggers, as `wrangler.toml` and the cire stack declare
 * them (`tests/wrangler-config.test.ts` holds the three equal). Cloudflare
 * hands `scheduled` the expression exactly as configured, character for
 * character, so `event.cron` tells the two apart.
 *
 * - {@link DAILY_CRON}: 04:00 UTC, every maintenance job but one, in one
 *   invocation (`src/index.ts` `scheduled`).
 * - {@link HAND_BACK_CRON}: 04:30 UTC, the retired Standard account hand-back
 *   alone (`maintenanceSweeps.handBackRetiredAccounts`), so its Stripe calls
 *   and queries spend an invocation of their own.
 */
export const DAILY_CRON = "0 4 * * *";
export const HAND_BACK_CRON = "30 4 * * *";
