---
"@cire/api": patch
---

Allow `PATCH` in the API's CORS preflight. The organiser portal calls the API
cross-origin with credentials, so the browser preflights every `PATCH` it
sends, and the preflight answered `GET, POST, PUT, DELETE, OPTIONS` whatever
was asked. Every checklist, budget, gift-list and vendor edit or reorder was
refused before it left the browser. The allowed methods are now exactly the
ones the routes answer, and a test fails when a mounted route uses a method
the list leaves out.

CORS now matches the request's `Origin` by exact membership in the allowlist,
the rule the CSRF origin guard already applies, instead of the plugin's own
matcher.
