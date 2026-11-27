---
"@cire/api": patch
---

Turning a wedding's money gifts on now re-checks, inside the write itself, that the wedding still names a payout account, that its holder still holds an owner seat and that Stripe can still take a charge on it. An erasure of the holder, a Stripe deauthorization or a charges change landing between the save's read and its write leaves the switch off and answers `payout_holder_absent` or `stripe_not_ready`. A settings row that records charges but names no account reads as `stripe_not_ready` everywhere, the guest gate included.
