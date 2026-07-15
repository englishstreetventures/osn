---
"@cire/api": patch
"@cire/db": patch
---

Cire guest+event editor E3: change history + before-image revert.

Additive migration `0034_change_history.sql` on `imports` (pure `ADD COLUMN`, no
rebuild): `kind text NOT NULL DEFAULT 'import'` (`'import'|'editor'`; the default
back-fills legacy rows) plus nullable `before_events_r2_key` /
`before_guests_r2_key`. All three DDL surfaces (schema.ts, setup.ts, migration)
mirrored — T-S1 lockstep green across 0001…0034.

At apply time, BEFORE mutating, the wedding's current state is serialised at full
fidelity (via `state-export.ts` — `Family Code`/`Family ID`/`Guest ID`/`Event ID`
+ provenance) and stored in R2 as the change's before-image, with its keys
recorded on the change row (`services/checkpoint.ts`). Revert now reconciles the
change's before-image, restoring the exact pre-change state regardless of
interleaved changes; full fidelity means id-matched updates preserve claim codes
and stable ids (rename-proof, no re-mint). Rows without a before-image (legacy
imports) keep the previous "re-apply the previous import's sheets" fallback.
After each apply, before-images beyond the most recent 10 changes per wedding are
pruned — the stale R2 objects are reaped (shared `reapR2Objects`) and their keys
NULLed, while the history rows all survive (only their revertability ages out).
