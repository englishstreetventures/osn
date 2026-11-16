---
"@cire/api": patch
"@cire/host": patch
---

The organiser portal's Enquiries thread shows "Messaging is temporarily unavailable" when its messages cannot be read, instead of leaving the panel on its loading line. When that read fails because the session has expired, the portal sends the organiser to sign in, as the inbox already does. The local E2E seed (`CIRE_E2E_ORGANISER=1`) adds two weddings the dev profile owns: `wed_e2e_settings`, on Gold, with two households, one code already sent, and a Gold and a Crimson unlock code; and `wed_e2e_enquiries`, on Crimson, with two live directory listings, one unclaimed and one whose enquiry carries a $4,800 quote.
