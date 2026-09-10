-- Decouple the guest image-cache version from copy/theme writes (WT-P-I1).
-- `updated_at` doubled as the image version (the ?v= cache-buster and the
-- server-side transform cache key), so ANY save — a colour, a greeting — busted
-- every cached image variant and forced fresh, per-call-billed Cloudflare
-- Images transforms for zero visual change. `images_updated_at` is bumped ONLY
-- by image upload/remove/crop and a hero-blur change (the one theme field that
-- alters the served bytes); everything else leaves the image caches warm.
-- Backfill from updated_at so every existing row keeps serving its current
-- cache version (no mass bust, no stale flip) — reads coalesce NULL to
-- updated_at as a safety net for rows created by copy-only saves.
ALTER TABLE `wedding_invite_customisations` ADD `images_updated_at` INTEGER;--> statement-breakpoint
UPDATE `wedding_invite_customisations` SET `images_updated_at` = `updated_at`;
