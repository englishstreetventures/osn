---
"@cire/api": patch
"@cire/infra": patch
"@tools/e2e": patch
---

cire's organiser sessions now end when the OSN account signs out everywhere else or revokes cire's connection: osn-api calls cire-api's `POST /internal/revoke-organiser-sessions` with the `CIRE_INTERNAL_REVOKE_SECRET` both hold. cire-api's Bun dev server now reads that secret as the Worker does, so the route works locally. The cire stack declares the secret as optional, and a cross-stack test holds osn-api's cire client id and URL equal to cire-api's own. The E2E suite gives both APIs the secret, and the `cire-registry-money` flow now ends by signing the account out everywhere else and checking cire-api holds none of the organiser's sessions.
