---
"@cire/api": patch
"@cire/host": patch
---

The registry link picker shows each candidate through cire-api, and the organiser portal's CSP `img-src` no longer admits any https origin.

`POST /api/organiser/weddings/:weddingId/registry/link-preview/image` takes `{ url }`, fetches it under the link-preview SSRF guard, caps it at 5 MB, checks its magic bytes and re-encodes it to 320px through the Images binding, answering `Cache-Control: private, no-store`. It sits behind the preview's gates with its own 60-a-minute limiter (`REGISTRY_THUMB_RATE_LIMITER`). A deployed tier with no Images binding answers 503 rather than serve the shop's bytes. Transformed thumbnails are kept in the Workers Cache API so a repeat costs no fetch and no transform.

`RegistryImageField` reads each thumbnail through `authFetch` into an object URL, so `cire/host/public/_headers` drops `https:` from `img-src` and its report-only header.
