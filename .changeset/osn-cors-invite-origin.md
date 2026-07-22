---
"@osn/api": patch
---

Allow the guest invite site on osn-api's CORS and WebAuthn origin allowlists. The guest "Link my Pulse account" island talks to the OSN issuer from `invite.cireweddings.com`, but production `OSN_CORS_ORIGIN`/`OSN_ORIGIN` only listed the organiser and vendor portals, so every token call died on CORS. Adds the invite origin in production and `localhost:4321` to the local dev lists.
