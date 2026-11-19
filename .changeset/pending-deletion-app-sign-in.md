---
"@osn/api": minor
"@osn/client": minor
"@musubi/social": minor
---

A sign-in from an app by an account whose deletion is pending no longer answers the app `access_denied` at once. `/authorize` parks the request for Musubi's page, and `GET /authorize/context` says `pendingDeletion: true`, so the page can show the deletion screen. The app hears nothing until the person acts: going back sends the refusal a Cancel sends, and keeping the account lets them approve the same request. `prompt=none` answers as for a browser with no session. An approval from such an account is refused with `access_denied` before the request is spent. `@osn/client`'s authorize client reads `pendingDeletion`, names `access_denied`, and gains `decline(requestId)`; its Solid `AuthProvider` takes `listProfiles={false}` for a screen that shows no profile.

Musubi's `/authorize` shows such an account the deletion screen under the app's card: the day the account is deleted, Keep my account, Download my data, Back to the app and Sign out, with a line saying the person is not signed in to the app. After a keep the page goes on to consent for the same request; if the request has expired by then, it says the account is back and to start again from the app. If the screen's code fails to load, the page still offers Back to the app.
