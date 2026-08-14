-- Wipes a cire D1 back to empty. GENERATED FILE — do not edit by hand.
-- Regenerate with: bun run --cwd cire/db seed:generate
-- The table list is read from cire/db/src/schema.ts; seed.test.ts fails CI on drift.
--
-- DESTRUCTIVE. Only ever run against a disposable database. The dev deploy runs
-- it on every merge (reset -> migrate -> seed), and scripts/cire-db-seed.sh
-- refuses any remote target whose name is not `cire-db-dev`.
--
-- Tables are dropped children first (deepest reference chain first). wrangler
-- sends a --file as separate statements, so a PRAGMA cannot hold foreign keys off
-- across the batch: drop a parent early and the child's own drop fails.

DROP TABLE IF EXISTS d1_migrations;
DROP TABLE IF EXISTS guest_account_links;
DROP TABLE IF EXISTS guest_events;
DROP TABLE IF EXISTS rsvps;
DROP TABLE IF EXISTS guests;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS vendor_enquiries;
DROP TABLE IF EXISTS budget_items;
DROP TABLE IF EXISTS directory_vendor_categories;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS families;
DROP TABLE IF EXISTS imports;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS vendor_claims;
DROP TABLE IF EXISTS vendors;
DROP TABLE IF EXISTS wedding_entitlements;
DROP TABLE IF EXISTS wedding_hosts;
DROP TABLE IF EXISTS wedding_invite_customisations;
DROP TABLE IF EXISTS directory_vendors;
DROP TABLE IF EXISTS organiser_sessions;
DROP TABLE IF EXISTS weddings;
