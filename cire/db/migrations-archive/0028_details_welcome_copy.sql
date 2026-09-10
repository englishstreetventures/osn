-- Customisable copy for the two guest-invite sections that were still hardcoded
-- (organiser reports: "parts of the invite can't be customised"):
--   details_eyebrow / details_heading — the events ("Your Events") section header,
--     previously fixed to "Celebrate With Us" / "Your Events" while the hero and
--     story copy were already editable.
--   welcome_message — the post-claim greeting line ("We are delighted to invite
--     you to celebrate with us."), shown under the family/guest name.
-- All nullable: NULL ⇒ the built-in default copy, so existing weddings render
-- exactly as before.
ALTER TABLE `wedding_invite_customisations` ADD `details_eyebrow` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `details_heading` text;--> statement-breakpoint
ALTER TABLE `wedding_invite_customisations` ADD `welcome_message` text;
