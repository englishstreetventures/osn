---
"@cire/envelope": patch
"@cire/db": patch
"@cire/api": patch
"@cire/infra": patch
---

A wedding can now store an envelope for its guests to open before the invite. `@cire/envelope` is a new package holding the envelope catalog (one envelope, the premium "Wax seal") and how its seal breaks. Migration `20261102053336_add_envelope_id` adds a nullable `envelope_id` to the invite customisation; none is every wedding's default. Organisers save it with `PUT /api/organiser/weddings/:weddingId/invite/envelope`, as owners and editors only: an id outside the catalog is refused with a 422, and a wedding without Crimson or the `premium_templates` entitlement with a 403. Choosing none always saves. Both invite reads carry `envelopeId`. Guests are served none once a wedding loses premium templates, and the organiser read keeps the stored choice and says whether it is allowed (`envelopeEntitled`). The design save and these reads share one premium rule. The E2E stack seeds a Crimson wedding whose guests open the envelope. cire/infra's tests rerun when `@cire/envelope` changes. Nothing shows the envelope to guests yet.
