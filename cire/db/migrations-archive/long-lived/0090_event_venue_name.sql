-- An event's venue name ("The Grounds of Alexandria"), kept apart from its
-- street address: the invite shows it above the address and calendar entries
-- put it before it. The events sheet's Location column and the organiser's
-- event drawer write it. Nullable, so no back-fill; ALTER TABLE ADD, never a
-- table rebuild.
ALTER TABLE `events` ADD `venue_name` text;
