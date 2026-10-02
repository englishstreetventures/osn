---
"@cire/api": patch
"@cire/host": patch
---

A wedding below Gold can take back the budget lines and tasks it entered.

The budget and the checklist are Gold modules, reads included, so a wedding on
Ivory could no longer read rows it had entered. Owners can now download them
at any tier:

- `GET /api/organiser/weddings/:weddingId/budget.csv`: one row per budget line,
  each followed by its payments, with per-head estimates computed as the portal
  computes them.
- `GET /api/organiser/weddings/:weddingId/tasks.csv`: one row per task, in the
  checklist's lead-time order.
- `GET /api/organiser/weddings/:weddingId/module-rows`: how many rows
  `budget.csv`, `tasks.csv` and the existing `gifts.csv` would carry.

All three sit in the owner-only export group behind the per-user limiter, with
no tier gate. Every cell is guarded against spreadsheet formulas, and each file
stops at 1,000 rows with a logged warning.

In the portal, an owner's locked Budget, Checklist and Registry cards offer
"Download as CSV" when the wedding has rows there, or when the count cannot be
read. The Registry card matters only for a wedding an operator has moved back
below Gold, since only a Gold wedding can receive gifts.
