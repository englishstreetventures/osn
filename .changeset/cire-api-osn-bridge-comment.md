---
"@cire/api": patch
---

The comments on cire-api's calls to osn-api and zap-api say what those calls carry: `instrumentedFetch` writes its `traceparent` through the global OpenTelemetry registry, which nothing in cire-api fills, so the calls carry none, and the osn-api Worker reads none. Comment-only; no behaviour changes.
