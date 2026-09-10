-- C1: per-wedding claim-code tier. `secure` (default) mints a 10-char Crockford
-- base32 hash (~60-bit total code); `simple` mints a 6-char hash (~40-bit). The
-- tiered generator in `cire/api/src/services/family-code.ts` reads this column
-- at family mint time.
--
-- NOT NULL with a DEFAULT so the column can be added in place (D1/sqlite allows
-- ADD COLUMN ... NOT NULL only when a DEFAULT is supplied) and every existing
-- wedding — including the bootstrap row — back-fills onto `secure`, the stronger
-- tier. New API inserts that omit the column also land on `secure`.
ALTER TABLE `weddings` ADD COLUMN `code_style` text DEFAULT 'secure' NOT NULL;
