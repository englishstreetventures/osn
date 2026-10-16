---
"@tools/e2e": patch
"@cire/api": patch
"@cire/invites": patch
---

Add the end-to-end suite (`bun run test:e2e`): it boots osn-api, pulse-api,
cire-api and the Musubi, Pulse and cire invite frontends on fixed ports, seeds
fixed data on a fixed clock, drives Chromium through three flows (Musubi passkey
sign-in, a cire guest RSVP, a Pulse event and RSVP) and writes traces,
screenshots and a byte-reproducible `results.json` to `e2e-artifacts/`.

`@cire/api`: the local server keeps its database in the file `CIRE_LOCAL_DB_PATH`
names, when set, instead of in memory, and applies its schema and its seed in
one transaction each.

`@cire/invites`: `astro dev` no longer exits on its first request (two SSR
dependencies are pre-bundled), and the consent prompt appears even when the
footer's preferences link hydrates first.
