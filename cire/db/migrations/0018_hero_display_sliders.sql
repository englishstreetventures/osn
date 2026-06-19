-- Replace the coarse hero display ENUMS (added in 0017) with fine-grained
-- INTEGER sliders. Pre-launch every row is on the 0017 defaults
-- (`blurred`/`none`), so a clean DROP + ADD needs no value migration — there is
-- nothing but defaults to preserve. D1/SQLite ≥ 3.35 supports DROP COLUMN.
--
-- New columns (all NOT NULL with defaults that reproduce TODAY's look):
--   `hero_blur`                   0–40 server-side Gaussian blur on the hero
--                                 backdrop. Default 28 = the current soft
--                                 `hero-bg` look; 0 = the sharp full-bleed photo.
--   `hero_title_backdrop_opacity` 0–100 opacity (×/100) of the legibility panel
--                                 behind the hero title. Default 0 = no panel
--                                 (today's look — just the radial scrim).
--   `hero_title_backdrop_blur`    0–20 px frosted-glass `backdrop-filter` blur
--                                 behind the title. Default 0 = no frost.
ALTER TABLE `wedding_invite_customisations` DROP COLUMN `hero_image_style`;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` DROP COLUMN `hero_title_backdrop`;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `hero_blur` integer DEFAULT 28 NOT NULL;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `hero_title_backdrop_opacity` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `hero_title_backdrop_blur` integer DEFAULT 0 NOT NULL;
