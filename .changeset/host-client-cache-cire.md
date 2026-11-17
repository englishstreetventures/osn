---
"@cire/host": minor
"@cire/api": patch
---

The organiser portal keeps what each view read, per wedding, so moving between views draws at once instead of loading again. The Overview, the RSVP table, the guest and events editors, the starter checklist dialog, Settings › Profile and Co-hosts, the invite builder and the vendor directory reopen with no request when their data is under a minute old, and read again behind what they show after that. The change editors reuse rows read after their change head and check the head once drawn. The RSVP table still marks each change it shows as seen. Saves, imports, reverts, re-mints and plus-one removals drop the caches they make stale; everything is still dropped when the wedding's dashboard closes.

The local E2E seed (`CIRE_E2E_ORGANISER=1`) adds `wed_e2e_cache`, a Gold wedding with two events, one household and one unseen reply.
