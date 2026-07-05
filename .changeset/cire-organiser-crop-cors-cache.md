---
"@cire/organiser": patch
---

Fix the crop editor opening dead in production: drop `crossOrigin="anonymous"`
from the `ImageCropModal` image.

The dashboard thumbnail loads the same cache-busted invite-image URL as a plain
no-cors `<img>` first, and the API serves it with `Cache-Control: immutable`
and no `Vary: Origin` — so the browser HTTP-caches the response **without**
CORS headers. The modal's crossorigin load of the identical URL was then
answered from that cache entry and hard-failed the CORS check without ever
reaching the network; cropperjs's `$ready` rejected, the selection never
seeded, and the editor appeared broken regardless of the earlier geometry
fixes (verified in headless Chromium against cropperjs 2.1.1, including the
fixed flow end-to-end). The editor only reads element geometry and
`naturalWidth`/`naturalHeight` — never canvas pixels — so it needs no
CORS-mode image at all.
