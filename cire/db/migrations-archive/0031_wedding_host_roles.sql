-- Phase 0 PR 2 (roles): split the single co-host role into editor/viewer.
-- Data-only migration — `role` has no CHECK constraint (0013 made it app-layer
-- on purpose), so widening the enum needs no table rebuild. Every existing
-- co-host already had full member write access (import + invite builder), so
-- they map to 'editor'; 'viewer' only ever appears on new adds. The column's
-- DDL DEFAULT 'host' is unchanged (SQLite can't alter a default without a
-- rebuild) — the app always writes an explicit role, and readers normalise a
-- stray legacy 'host' to 'editor'.
UPDATE wedding_hosts SET role = 'editor' WHERE role = 'host';
