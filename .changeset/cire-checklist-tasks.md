---
---

Phase 1 Checklist / Tasks module: a freeform per-wedding checklist. Organisers add
tasks, file each under a lead-time bucket (12 months out → day-of) with an optional
due date, check them off, and reorder within a bucket. New `tasks` table
(migration 0038, additive), a `/api/organiser/weddings/:weddingId/tasks` CRUD
router (member reads / editor writes), a `ChecklistView` module in the organiser
IA, and a live "open tasks" count on the Overview.
