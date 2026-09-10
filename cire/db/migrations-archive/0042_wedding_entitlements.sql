-- 0042_wedding_entitlements.sql — platform tiering Phase 1 (additive; no drops).
-- Per-wedding unlocked packs. Row-presence = entitled. Composite PK (wedding_id,
-- entitlement) makes a double-grant a swallowed conflict, never a duplicate row.
CREATE TABLE `wedding_entitlements` (
  `wedding_id` text NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `entitlement` text NOT NULL,
  `source` text NOT NULL,
  `granted_at` integer NOT NULL,
  `granted_by` text NOT NULL,
  `provider_ref` text,
  PRIMARY KEY (`wedding_id`, `entitlement`)
);
