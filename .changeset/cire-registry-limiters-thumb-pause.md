---
"@cire/api": patch
---

The link preview, image save and picker thumbnail routes answer 503 in a deployed tier when their rate-limit binding is missing, instead of counting per isolate. The picker thumbnail route stops fetching for a minute after three failed Images transforms inside a minute, then lets one trial request through.
