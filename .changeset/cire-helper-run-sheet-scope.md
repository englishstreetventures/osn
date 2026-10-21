---
"@cire/api": patch
"@cire/host": patch
---

An owner can set how much of the day's run sheet a helper sees: their own
tasks, or the whole run sheet and who holds each task.
`PUT /api/organiser/weddings/:weddingId/hosts/:osnProfileId/run-sheet-scope`
takes `{scope: "own" | "full"}`, owner only; a seat that is not a helper's is
409 `not_a_helper`. Any role change resets the scope to `own` unless a helper
stays a helper, and new helpers start at `own`. `GET /hosts` and the role
change's answer carry `runSheetScope` on helper seats. The co-host panel shows
an owner a "Sees:" dropdown on each helper's row, asking before it opens the
whole run sheet, and shows editors and viewers the same as text.
