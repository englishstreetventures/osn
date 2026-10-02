---
"@cire/api": patch
"@cire/host": patch
---

The organiser portal can see and crop the invite's closing image without a guest session. A new route, `GET /api/organiser/weddings/:weddingId/invite/image/:slot`, serves invite images to the wedding's owners, editors and viewers, and the organiser read links the closing image there. The guest route still answers 404 to anyone who has not claimed a code at that wedding. Both routes now let a browser keep the closing image for an hour rather than a year, then ask the gate again. The builder's thumbnail, crop editor and previews load each image from one URL, so the browser fetches it once.
