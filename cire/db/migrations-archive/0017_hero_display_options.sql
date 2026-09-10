-- Hero display options (organiser choice) on the per-wedding invite
-- customisation. Both columns default to the values that reproduce TODAY's
-- look, so every existing row + any new D1 insert that omits them renders
-- exactly as before — a pure forward-only ADD COLUMN, no backfill needed.
--
-- `hero_image_style` picks which served variant the hero backdrop requests:
--   'blurred' (default) ⇒ the soft `hero-bg` backdrop (current behaviour);
--   'regular'           ⇒ the sharp full-bleed `hero` variant (no blur).
-- `hero_title_backdrop` controls the legibility panel behind the hero title:
--   'none'  (default) ⇒ just the radial scrim (current behaviour);
--   'solid'           ⇒ a translucent panel so the title reads over a busy photo.
ALTER TABLE `wedding_invite_customisations` ADD `hero_image_style` text DEFAULT 'blurred' NOT NULL;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `hero_title_backdrop` text DEFAULT 'none' NOT NULL;
