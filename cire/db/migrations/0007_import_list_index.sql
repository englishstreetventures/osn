-- P-W1: back the import-list pagination query with a composite index.
-- The list query is `WHERE wedding_id = ? [AND uploaded_at < cursor]
-- ORDER BY uploaded_at DESC`, which the single-column `imports_wedding_idx`
-- and the `(status, uploaded_at)` index could not serve. Replace both with a
-- composite `(wedding_id, uploaded_at)` that covers the scope + cursor/order
-- in one b-tree (and also serves revert.ts's
-- `wedding_id = ? AND status = 'applied' ORDER BY uploaded_at DESC`). Nothing
-- filters imports by status alone, so dropping that index loses no plan.
-- Index-only changes — no table rebuild required.
DROP INDEX `imports_status_uploaded_at_idx`;--> statement-breakpoint
DROP INDEX `imports_wedding_idx`;--> statement-breakpoint
CREATE INDEX `imports_wedding_uploaded_at_idx` ON `imports` (`wedding_id`,`uploaded_at`);
