-- An owner or editor can hide a guest's gift note from the gift log and its
-- CSV. Four nullable ADD COLUMNs: nothing is rebuilt or copied, and every
-- existing gift reads as not hidden. The note text itself is untouched.

ALTER TABLE `registry_claims` ADD `note_hidden_at` integer;--> statement-breakpoint
ALTER TABLE `registry_claims` ADD `note_hidden_by_osn_profile_id` text;--> statement-breakpoint
ALTER TABLE `registry_contributions` ADD `note_hidden_at` integer;--> statement-breakpoint
ALTER TABLE `registry_contributions` ADD `note_hidden_by_osn_profile_id` text;