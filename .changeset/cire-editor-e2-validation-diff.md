---
"@cire/api": patch
---

Cire guest+event editor E2: shared validation module + ID-aware diff.

Extracts the parser's semantic rules into `services/guest-event-validation.ts` (pure, Effect-free) so both front doors of the reconcile pipeline — the CSV import today and the editor draft-save later — accept/reject identically (parser parity). Adds the canonical `DesiredState` Effect Schema (`{ events, families }`, optional stable ids, a `publicId` per household). The parser now **honours** the fidelity columns the E1 exporter emits (`Event ID`, `Guest ID`, `Family Code`, and the internal `Family ID` under full fidelity) instead of ignoring them, while preserving E1's header-collision contract exactly. `diffAgainstDb` becomes ID-aware: when a stable id is present a rename is an update (not remove+create), and the no-id path stays byte-identical to today's plans. No DB migration.
