---
---

Phase 1 Budget v1 module: a per-category wedding budget. Organisers add line items
under a service category, track estimate → quoted → actual per item, attach payment
schedule rows (deposit/balance with due + paid dates), and edit the overall cap
from the Budget tab. New `budget_items` + `payments` tables (migration 0039,
additive), a `/api/organiser/weddings/:weddingId/budget` CRUD router (member reads /
editor writes / owner cap), a `BudgetView` module in the organiser IA, and a live
spend-vs-cap + upcoming-payments widget on the Overview. The shared
service-category enum lands here (its first consumer); the cap editor moves out of
Settings.
