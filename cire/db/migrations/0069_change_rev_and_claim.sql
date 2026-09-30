-- The organiser change pipeline's head revision and its one-writer claim.
--
-- `change_rev` replaces a digest of every committed change row: the head is
-- now this counter, moved in the same D1 batch as each committed apply or
-- revert. It starts at 0 for every wedding, existing ones included. Nothing
-- needs backfilling: the API now writes revisions as decimal strings, which the
-- digest scheme never produced, so a draft or preview taken before this
-- migration no longer matches any head and is refused once, and a reload
-- picks up the new form.
--
-- `change_claim` / `change_claimed_at` hold the token of the apply or revert
-- currently writing the wedding, and when it took it, so a second one is
-- refused instead of interleaving its batches with the first. Both are NULL
-- when no change holds the wedding, which is every existing row.

ALTER TABLE `weddings` ADD `change_rev` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `weddings` ADD `change_claim` text;--> statement-breakpoint
ALTER TABLE `weddings` ADD `change_claimed_at` integer;