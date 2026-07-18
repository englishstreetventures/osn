---
"@cire/landing": patch
---

Expand the draft legal pages from site-only to full service scope.

The Terms page becomes draft service Terms of Service (free plan + one-time
per-wedding add-ons, purchases via a merchant of record, ACL non-excludable
guarantees, NSW governing law); the Privacy Notice covers the whole service
(organiser/guest role split, guest data handled on the couple's instructions,
provider list, cross-border disclosure, OAIC + GDPR rights, the enforced
1-year guest-data retention window); and a new draft Refund Policy page lands
(14-day change-of-mind + ACL rights preserved, refunds executed via the
merchant of record). All entity/provider/contact specifics are highlighted
`{{PLACEHOLDER}}` values filled at publish time; draft banners stay until
lawyer review. A vitest guard enforces banner-while-placeholders and the
footer linking all three legal routes; `wiki/business/` is gitignored for
private planning notes.
