-- One visibility switch per switchable invite section: hero, Our Story and the
-- closing section (`footer`). A section renders on the guest invite only when
-- its switch is on AND it has content.
--
-- The three ADD COLUMNs default every row to on. The three UPDATEs then set each
-- existing row's switch to what the emptiness check gave before this migration,
-- so an empty section comes out switched off and a filled one switched on:
--
--   hero   — an image, a title or a subtitle
--   story  — a heading, a body or an image (the eyebrow is a label, not content)
--   footer — a closing note or an image
--
-- Text counts only when something other than whitespace is left after trimming
-- the same characters JavaScript's `String.prototype.trim` removes, which is
-- what `hasText` in both emptiness modules tests. An image counts when its R2
-- key is a non-empty string, which is when the API builds a URL for it. Every
-- term is guarded with IS NOT NULL so none is NULL inside the NOT (...).
--
-- drizzle-kit writes a boolean default as `DEFAULT true`; it is `DEFAULT 1` here
-- so the column reads back the same as the mirror in cire/api/src/db/setup.ts
-- and the Drizzle schema (`ddl-lockstep.test.ts`).

ALTER TABLE `wedding_invite_customisations` ADD `hero_visible` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `story_visible` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `footer_visible` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE `wedding_invite_customisations` SET `hero_visible` = 0 WHERE NOT (
  (`hero_image_key` IS NOT NULL AND `hero_image_key` <> '')
  OR (`hero_title` IS NOT NULL AND trim(`hero_title`, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) <> '')
  OR (`hero_subtitle` IS NOT NULL AND trim(`hero_subtitle`, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) <> '')
);--> statement-breakpoint
UPDATE `wedding_invite_customisations` SET `story_visible` = 0 WHERE NOT (
  (`story_image_key` IS NOT NULL AND `story_image_key` <> '')
  OR (`story_heading` IS NOT NULL AND trim(`story_heading`, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) <> '')
  OR (`story_body` IS NOT NULL AND trim(`story_body`, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) <> '')
);--> statement-breakpoint
UPDATE `wedding_invite_customisations` SET `footer_visible` = 0 WHERE NOT (
  (`footer_image_key` IS NOT NULL AND `footer_image_key` <> '')
  OR (`footer_message` IS NOT NULL AND trim(`footer_message`, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)) <> '')
);
