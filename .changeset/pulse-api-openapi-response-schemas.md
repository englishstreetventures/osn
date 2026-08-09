---
"@pulse/api": minor
---

Add OpenAPI 3.1.0 `response:` schemas to every public route (37 operations
across events, series, closeFriends, venues, account, onboarding, settings),
pin JSON-body routes to `parse: "application/json"` so the document no
longer over-declares `multipart/form-data`/urlencoded support, and commit a
deterministically-regenerated `shared/openapi/pulse.json` (via
`bun run openapi:generate`) for the downstream Swift client generator. A new
CI job regenerates the document and fails on drift.
