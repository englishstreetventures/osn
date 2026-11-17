---
"@shared/crypto": patch
"@shared/observability": patch
"@shared/realtime": patch
"@shared/email": patch
"@shared/db-utils": patch
"@shared/coordination": patch
"@shared/sortable": patch
"@shared/osn-auth-client": patch
"@musubi/infra": patch
---

Tests only: cases a kept sibling already fails on are removed, each checked by breaking the source and watching both fail, and the observability Worker import walk now follows multi-line exports. Tests that could not fail now can, and realtime and email tests that waited on the real clock run on the test clock.
