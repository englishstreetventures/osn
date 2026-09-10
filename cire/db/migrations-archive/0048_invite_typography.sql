-- Global invite TYPOGRAPHY options: heading size / weight / style plus body
-- weight / style, alongside the two font faces from 0014.
--
-- Each column stores a CLOSED enum key (`@cire/theme` `HEADING_SIZE_CHOICES` /
-- `FONT_WEIGHT_CHOICES` / `FONT_STYLE_CHOICES`, validated in
-- `cire/api/src/schemas/invite.ts`) — never a free-text CSS value; the key
-- resolves to a fixed value in `@cire/theme`, so nothing new crosses the
-- CSS-injection gate. NULL ⇒ the design pack's built-in look, so this is a
-- forward-only ADD COLUMN with no backfill and an un-customised wedding
-- renders exactly as it always has.
ALTER TABLE wedding_invite_customisations ADD COLUMN theme_heading_size TEXT;
ALTER TABLE wedding_invite_customisations ADD COLUMN theme_heading_weight TEXT;
ALTER TABLE wedding_invite_customisations ADD COLUMN theme_heading_style TEXT;
ALTER TABLE wedding_invite_customisations ADD COLUMN theme_body_weight TEXT;
ALTER TABLE wedding_invite_customisations ADD COLUMN theme_body_style TEXT;
