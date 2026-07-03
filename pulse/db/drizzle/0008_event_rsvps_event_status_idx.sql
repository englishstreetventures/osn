-- P-I2 (pulse) — composite index for status-filtered RSVP reads.
-- `GET /events/:id/rsvps?status=…` and the counts GROUP BY seek on
-- event_id then filter on status; the old `event_rsvps_event_idx`
-- left the status filter as a post-index scan.
CREATE INDEX `event_rsvps_event_status_idx` ON `event_rsvps` (`event_id`,`status`);--> statement-breakpoint
-- P-I1 (prep-pr review) — the composite's leading column serves any
-- event_id-only lookup (as does the unique pair index), so the
-- single-column index is subsumed: drop it to remove per-RSVP-write
-- maintenance of a redundant B-tree. Mirrors cire migration 0026.
DROP INDEX `event_rsvps_event_idx`;
