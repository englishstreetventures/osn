-- Replace the eight per-section theme colours with a five-seed COLOUR SCHEME.
--
-- WHY. `0014` + `0027` gave an organiser an accent and a surface for each of
-- hero / story / details / welcome — eight independent colours. That is eight
-- chances to pick a set that doesn't hang together, and it still only reached
-- five of the guest site's thirteen design tokens (page background, borders,
-- text, muted text and the hero gradient stayed locked). The scheme inverts it:
-- five seeds named by their role, every other colour derived from them by one
-- shared function (`derivePalette` in `@cire/theme`), and a per-section TONE
-- choosing which derived surface a section sits on. Fewer inputs, whole-page
-- coverage.
--
-- SEEDS: ground (the page), card (raised paper), ink (everything written),
-- gilt (the metal), bloom (the festive counter-colour). Each is validated
-- against the same `isSafeCssColor` allow-list the dropped columns used — the
-- CSS-injection gate is unchanged, only the field count shrinks.
--
-- TONES: `ground` | `card` | `raised`, one per section, NULL ⇒ `ground`.
--
-- BACKFILL. `hero_accent_color` → `palette_gilt` and `hero_surface_color` →
-- `palette_card`, because the hero accent/surface are the two colours an
-- organiser was most likely to have actually set and they map cleanly onto the
-- new roles. Everything else falls back to the built-in `evergreen` preset at
-- read time (a NULL seed resolves to that preset's value for the role), so a
-- row that never set a colour renders exactly as it always has.
--
-- ⚠️ DESTRUCTIVE: a wedding that set a DIVERGENT story/details/welcome accent
-- loses that divergence — one scheme now drives the whole invite. That is the
-- intended product change, not a data-loss accident.
--
-- MECHANISM — plain `ALTER TABLE … DROP COLUMN` (as `0036`). None of the eight
-- dropped columns participates in an index, PK, FK, UNIQUE, CHECK or generated
-- column: `wedding_invite_customisations` is keyed on `wedding_id` alone and
-- carries no other index over theme colours.

ALTER TABLE `wedding_invite_customisations` ADD `palette_preset` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `palette_ground` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `palette_card` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `palette_ink` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `palette_gilt` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `palette_bloom` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `hero_tone` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `story_tone` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `details_tone` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `welcome_tone` text;--> statement-breakpoint

UPDATE `wedding_invite_customisations`
  SET `palette_gilt` = `hero_accent_color`
  WHERE `hero_accent_color` IS NOT NULL;--> statement-breakpoint
UPDATE `wedding_invite_customisations`
  SET `palette_card` = `hero_surface_color`
  WHERE `hero_surface_color` IS NOT NULL;--> statement-breakpoint

-- Preserve each section's BACKGROUND as a tone. Without this the drop below
-- silently flattens every section that painted a surface onto the page colour —
-- a visible change to a live invite, which is not what "replace the colour
-- model" is allowed to mean.
--
-- The story band has always painted `bg-surface`, so it becomes `card`
-- unconditionally. The other two only painted one when the organiser picked it,
-- so their tone is conditional on that pick. The hero is deliberately left
-- alone: its "surface" was the title panel behind the text, not a section
-- background (it is carried by `palette_card` above and consumed by
-- `--invite-panel`), so giving it a tone would paint a backdrop it never had.
UPDATE `wedding_invite_customisations` SET `story_tone` = 'card';--> statement-breakpoint
UPDATE `wedding_invite_customisations`
  SET `details_tone` = 'card'
  WHERE `details_surface_color` IS NOT NULL;--> statement-breakpoint
UPDATE `wedding_invite_customisations`
  SET `welcome_tone` = 'card'
  WHERE `welcome_surface_color` IS NOT NULL;--> statement-breakpoint

ALTER TABLE `wedding_invite_customisations` DROP COLUMN `hero_accent_color`;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` DROP COLUMN `hero_surface_color`;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` DROP COLUMN `story_accent_color`;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` DROP COLUMN `story_surface_color`;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` DROP COLUMN `details_accent_color`;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` DROP COLUMN `details_surface_color`;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` DROP COLUMN `welcome_accent_color`;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` DROP COLUMN `welcome_surface_color`;
