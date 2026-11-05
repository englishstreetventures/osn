---
"@cire/host": patch
---

The organiser portal's return from Stripe now ends its purchase poll on the two
statuses it used to treat as still pending. A payment that went through but did
not upgrade the wedding (`mismatch`) raises an error toast, pinned until closed,
asking the organiser to write to the contact address, shown as a `mailto:` link.
The address is `@shared/legal`'s `LEGAL_ENTITY.contactEmail`, which cire/host now
depends on. A refunded purchase raises an info toast saying so. Before, both kept the poll running to its last attempt and
ended with "Your payment is still being confirmed."
