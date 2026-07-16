---
"@osn/api": patch
---

Prune the transitional `app.cireweddings.com` origin from osn-api's production
`OSN_ORIGIN` / `OSN_CORS_ORIGIN` allowlists now that the organiser portal has
cut over to `host.cireweddings.com`. RP ID stays the registrable apex, so
existing organiser passkeys are unaffected. Also drops a stale "deploy osn-api
manually" comment (osn-api is CI-deployed since 2026-07-16).
