---
"@cire/organiser": patch
---

Add an import history + one-click revert UI to the organiser portal. `ImportPanel` now renders an `ImportHistory` disclosure that lazy-loads past CSV imports (date, a human diff summary, and status), with a confirm-gated Revert on applied entries that calls the existing `import/revert` endpoint and refreshes events + guests. Co-host accessible, matching the `weddingMember()`-gated backend routes.
