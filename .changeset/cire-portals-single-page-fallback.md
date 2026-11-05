---
"@cire/infra": patch
"@cire/host": patch
"@cire/vendor": patch
---

The organiser and vendor portal Workers serve the portal's own page at a path no file answers, as their Pages projects do, so the enquiry emails' `/vendors/enquiries/<id>` links open the organiser portal; the marketing site still answers such a path 404. Both portals send `Cache-Control: no-store` on every page, wherever it is served, and keep the year-long cache on their hashed bundles alone.
