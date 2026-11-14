-- A nullable column: every stored row reads NULL and the Worker this release
-- replaces never names it, so that Worker runs beside it unchanged. A rollback
-- to that Worker leaves the column unread, and with it the limit it puts on a
-- replaced cancel handle (wiki/osn/sessions.md, Endpoints). It moves no row.
ALTER TABLE `sessions` ADD `replaced_at` integer;