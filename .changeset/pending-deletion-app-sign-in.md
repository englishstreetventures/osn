---
"@osn/api": minor
"@osn/client": minor
---

A sign-in from an app by an account whose deletion is pending no longer answers the app `access_denied` at once. `/authorize` parks the request for Musubi's page, and `GET /authorize/context` says `pendingDeletion: true`, so the page can show the deletion screen. The app hears nothing until the person acts: going back sends the refusal a Cancel sends, and keeping the account lets them approve the same request. `prompt=none` answers as for a browser with no session. An approval from such an account is refused with `access_denied` before the request is spent. `@osn/client`'s authorize client reads `pendingDeletion`, names `access_denied`, and gains `decline(requestId)`.
