---
"@cire/api": minor
"@cire/db": minor
---

Cire: optional guest → OSN/Pulse account linking (backend).

An invitee can now optionally attach their seat to a real OSN/Pulse account so
they can see the invitation in Pulse and — within a family group — see other
invitees' RSVPs. New `guest_account_links` table (per invitee) and
`/api/account/link` routes: `POST` is the one deliberate dual-credential route
(guest `cire_session` cookie binds the household, OSN access token names the
account), `GET`/`DELETE` are guest-only. The POST resolves the OSN profile to
its account id server-to-server over ARC; account id is S2S-only and never
returned to clients. Linking is additive and opt-in — when no ARC key is
configured the endpoint answers 503.

Frontend (the guest-site "link my Pulse account" affordance) is deferred.
