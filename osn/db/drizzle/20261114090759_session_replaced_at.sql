-- A nullable column: every stored row reads NULL, the Worker this release
-- replaces never names it, and a rollback leaves it unread. It moves no row.
ALTER TABLE `sessions` ADD `replaced_at` integer;