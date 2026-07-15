---
"@cire/api": patch
"@cire/db": patch
---

Cire guest+event editor E4: provenance + changes endpoints.

Additive migration `0035_provenance.sql` adds `source text NOT NULL DEFAULT
'import'` (`'import' | 'manual'`) to both `families` and `guests`, back-filling
every legacy row as `'import'` (pure `ADD COLUMN`, no rebuild; all three DDL
surfaces mirrored, T-S1 lockstep green 0001…0035).

The diff (`diffAgainstDb`) becomes provenance-aware: a CSV import manages only
`source='import'` rows by default — an unmatched manually-added household/guest
is left intact — and a new `removeManual` toggle (which the editor's DesiredState
front door always sets) widens it back to "the sheet is the whole truth".

New general change API (`changes/{preview,apply,revert,list}`, factory
`routes/organiser-changes.ts` + `services/changes.ts`): both a DesiredState JSON
(editor) and a `{eventsCsv, guestsCsv}` upload funnel into one reconcile pipeline
(parse → DesiredState → diff → E3 checkpoint → apply). Apply enforces optimistic
concurrency — it 409s when the wedding's head revision (`baseRevision`, the id of
the most-recently applied-or-reverted change) moved since preview. The same
factory is mounted at both `/changes` (canonical) and `/import` (a one-release
alias, deleted next release); both serve identically. Gated by
`weddingEditor()`.
