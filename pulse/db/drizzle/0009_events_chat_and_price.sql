-- D-H1 remediation — three `events` columns reached src/schema without ever
-- being migrated, so the chain could not build the schema it describes.
--
-- 1. `chat_id` — the Zap chat backing an event's group conversation
--    (see @zap/api; Pulse consumes it, users don't need Zap installed).
-- 2. `price_amount` / `price_currency` — ticketed-event pricing, minor units
--    plus an ISO-4217 code (see pulse/api/src/lib/currency.ts).
--
-- Appended as a new migration rather than folded into 0000 because these are
-- genuinely later additions; the `user_id` -> `profile_id` rename in 0000 was
-- corrected in place instead, since it restates what that migration always
-- meant. No Pulse D1 exists in any tier (every `database_id` in
-- pulse/api/wrangler.toml is still a placeholder), so neither edit can
-- conflict with an applied-migrations table.
--
-- Guarded from here on by pulse/db/tests/ddl-lockstep.test.ts.
ALTER TABLE `events` ADD `chat_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `price_amount` integer;--> statement-breakpoint
ALTER TABLE `events` ADD `price_currency` text;
