-- Data-layer review (2026-07-30), finding 1: `events_slug_unique` was GLOBAL
-- across all tenants — created by 0001 (single-tenant era) and recreated
-- verbatim by 0006, the very migration that introduced `wedding_id`. Every
-- sibling uniqueness constraint is wedding-scoped (`wedding_hosts`, `vendors`,
-- `vendor_enquiries`, the host-family partial index); `events` was the outlier.
-- The collision was reachable: `mintEventSlug` (cire/api services/import.ts)
-- slugifies the event NAME alone, so two weddings each importing an event
-- named "Reception" both mint `reception`, and the second wedding's import
-- apply failed on the unique index.
--
-- Scope uniqueness to the tenant: (wedding_id, slug). Always satisfiable —
-- the old global constraint was strictly stronger, so existing rows cannot
-- conflict under the new one. The import service additionally de-dupes fresh
-- slugs WITHIN a wedding at mint time (`-2`, `-3`, … suffixes); existing
-- events keep their slugs (updates never re-mint).
DROP INDEX `events_slug_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `events_wedding_slug_unique` ON `events` (`wedding_id`, `slug`);
