-- The footer's optional image — a small centred monogram, motif or signature
-- rendered above the closing note added by `0049_invite_footer_message.sql`.
-- The two are independent: a couple can have the note, the image, both, or
-- neither, and the footer's decorative block only renders for whichever is set.
--
-- `footer_image_key` stores an R2 object key (not a URL), exactly like
-- `hero_image_key` / `story_image_key`; `footer_image_crop` is the same
-- `{x,y,w,h,natW,natH}` JSON rectangle in source fractions the other slots use,
-- validated on write and applied in CSS on the guest site. Both nullable ⇒ every
-- existing wedding reads as "no footer image" and renders unchanged.
ALTER TABLE `wedding_invite_customisations` ADD `footer_image_key` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `footer_image_crop` text;
