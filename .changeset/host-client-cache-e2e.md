---
"@tools/e2e": patch
---

`cire-checklist-starter` logs what the organiser portal reads from cire-api for each view it opens on a wedding of its own (`tests/support/request-log.ts`), checks that a second visit reads nothing before it draws, and writes the whole log to `e2e-artifacts/request-logs/`.
