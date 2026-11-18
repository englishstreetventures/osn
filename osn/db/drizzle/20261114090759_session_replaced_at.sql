-- A nullable column: every stored row reads NULL and the Worker this release
-- replaces never names it, so that Worker runs beside it unchanged. A rollback
-- to that Worker waits for the owner while a marked cancel handle's deletion is
-- pending (wiki/osn/sessions.md, Endpoints). It moves no row.
ALTER TABLE `sessions` ADD `replaced_at` integer;