-- Data-layer review (2026-07-30): index tuning. Three asymmetries closed, one
-- dead index dropped, one redundant index dropped, one browse index widened.
--
-- (1) Guest `sessions` was missing BOTH indexes its organiser twin has had
-- since 0047: `family_id` is hit by four `DELETE WHERE family_id = ?` sites
-- (session revoke, code regenerate, family deactivate, and the bulk remint —
-- which issues one such delete PER FAMILY), and `expires_at` is hit by the
-- nightly sweep. Each was a full-table scan. (SQLite does not index child FK
-- columns automatically, so the `families` cascade also walks this index now.)
CREATE INDEX `sessions_family_idx` ON `sessions` (`family_id`);
--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);
--> statement-breakpoint
-- (2) `GET /api/primary-wedding` (public, unauthenticated, hit on every
-- bare-domain load) does `ORDER BY created_at DESC LIMIT 1` with no WHERE —
-- previously a full scan + sort of `weddings`.
CREATE INDEX `weddings_created_at_idx` ON `weddings` (`created_at`);
--> statement-breakpoint
-- (3) `families_family_name_idx` (0001) is dead weight: no query filters,
-- joins, or sorts on family_name — the import diff matches on a NORMALISED
-- (trimmed, lowercased) name in JS, which this case-sensitive b-tree could
-- never serve. It cost a write per row on every import/remint and bought
-- nothing. (`vendor_claims_vendor_idx` looks similar but stays: it serves the
-- `directory_vendors → vendor_claims` ON DELETE CASCADE child lookup.)
DROP INDEX `families_family_name_idx`;
--> statement-breakpoint
-- (4) `directory_vendor_categories_category_idx` is redundant: the only
-- category predicate is the browse EXISTS probe on
-- (directory_vendor_id, category), which the primary key serves.
DROP INDEX `directory_vendor_categories_category_idx`;
--> statement-breakpoint
-- (5) Directory browse runs `WHERE listed = 'live' … ORDER BY name, id
-- LIMIT/OFFSET`. The old single-column `listed` index filtered but forced a
-- sort of the whole live set on every page (and `listed = 'live'` will be
-- nearly all rows, making it a no-op filter anyway — VD-P-I4). The composite
-- serves filter + order in one b-tree walk; its `listed` prefix still covers
-- everything the old index did.
DROP INDEX `directory_vendors_listed_idx`;
--> statement-breakpoint
CREATE INDEX `directory_vendors_listed_name_idx` ON `directory_vendors` (`listed`, `name`, `id`);
