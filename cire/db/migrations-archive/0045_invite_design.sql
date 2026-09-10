-- Invite design selector: which full template pack the wedding's invite
-- renders as. Stored on the customisation row so the guest site's single
-- SSR fetch resolves it with no extra round-trip. Additive with a default —
-- existing rows stay on the current look ('classic'); no backfill needed.
ALTER TABLE wedding_invite_customisations ADD COLUMN design_id TEXT NOT NULL DEFAULT 'classic';
