---
"@cire/build-tools": patch
"@cire/invites": patch
"@cire/host": patch
---

Cire's dev tier gets its own Chrome origin-trial tokens: `@cire/build-tools/origin-trial` holds an `HTMLInCanvas` and a `WebMCP` token for the dev zone and its subdomains beside the production ones. The guest site sends both `HTMLInCanvas` tokens in its `Origin-Trial` header and the organiser portal's `_headers` both `WebMCP` tokens, so the envelope opening and the portal's agent tools work on the dev hosts as on production. The token test checks each token's Chrome signature and that none is third-party.
