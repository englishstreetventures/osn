-- Switches the hero, Our Story and the closing section (`footer`) on for every
-- invite that exists when this runs.
--
-- 0063 filled each switch from the section's emptiness check, so a section that
-- was blank then is switched off, and filling it in later would show nothing
-- until an organiser found the switch. Switched on, a blank section still
-- renders nothing (a section shows only when it is on AND has content), so no
-- guest sees a change; content added later shows without a second step.
--
-- The FAQ switch (`faq_visible`) is left as it is: 0064 gave it no backfill.
-- Only rows with a switch off are written, and no other column is touched:
-- `updated_at` and `images_updated_at` keep their values, since a switch moves
-- no image and the guest read is served no-store.

UPDATE `wedding_invite_customisations`
SET `hero_visible` = 1, `story_visible` = 1, `footer_visible` = 1
WHERE `hero_visible` = 0 OR `story_visible` = 0 OR `footer_visible` = 0;
