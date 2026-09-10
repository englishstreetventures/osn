-- The "kindly respond by" date (RSVP deadline). Past it the guest invite stops
-- accepting RSVP writes and renders read-only; organiser-recorded RSVPs are
-- deliberately unaffected, so a phone/paper reply can still be entered late.
--
-- `rsvp_deadline` is a date-only ISO string (`YYYY-MM-DD`) like `wedding_date`,
-- INCLUSIVE of its whole day. `rsvp_deadline_timezone` is the IANA zone that
-- day is measured in (the same wall-time + zone idiom `events` uses) — stamped
-- from the organiser's own zone when they pick the date. Both NULL on every
-- existing row, which reads as "no deadline", so nothing changes until an
-- organiser sets one.
ALTER TABLE `weddings` ADD `rsvp_deadline` text;--> statement-breakpoint
ALTER TABLE `weddings` ADD `rsvp_deadline_timezone` text;
