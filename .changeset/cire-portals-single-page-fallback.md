---
"@cire/infra": patch
"@cire/host": patch
---

The organiser and vendor portal Workers serve the portal's own page at a path no file answers, as their Pages projects do, so the enquiry emails' `/vendors/enquiries/<id>` links open the organiser portal; the marketing site still answers such a path 404. The organiser portal keeps that page out of the browser's caches under `/vendors/`, as it does at `/`.
