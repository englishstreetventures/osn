---
"@cire/api": patch
"@cire/organiser": patch
---

Fix: a household rename in the guests editor never saved. The reconcile plan
had create and remove ops for families but no UPDATE op at all, so an
id-matched household with a changed name consumed the existing row (keeping
the row and its claim code, correctly) and then wrote nothing — the editor's
save applied "successfully" and the old name was back on reload. The same gap
meant a before-image revert could not restore a renamed household's old name.

- `@cire/api`: new `FamilyUpdate` (`{id, familyName}`) op in `ImportPlan`,
  emitted by `diffAgainstDb` only on the id-matched path — mirroring
  `GuestUpdate.firstName`'s rule, so the no-id CSV plan stays byte-identical —
  and applied as its own step in `applyImport`'s write set. `ImportSummary`
  gains `familiesUpdated`; the change row's persisted summary and the preview
  response carry `familyUpdates`.
- `@cire/organiser`: `ChangePreview`'s households "update" cell was hard-coded
  0, so a rename-only save previewed as an all-zero plan — it now counts
  `plan.familyUpdates`. `ImportPanel`'s applied summary line shows the new
  families-updated count.
