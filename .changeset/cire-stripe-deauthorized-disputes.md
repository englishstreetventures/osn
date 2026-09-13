---
"@cire/db": patch
"@cire/api": patch
"@cire/host": patch
---

Handle the two Stripe events that cost money when nobody listens.

`account.application.deauthorized` — a couple can revoke cire's access from
their own Stripe dashboard, and until now nothing here noticed. The cached
`stripe_charges_enabled` stayed true, so the contribute button stayed armed
against an account that would refuse every charge: the guest reached a Stripe
error and the couple received nothing. The webhook now clears
`stripe_account_id` and both capability booleans, which shuts the guest gate and
is also what lets the couple reconnect — the attach path only ever fills a NULL
id, so a stale one would have wedged them on a dead account for good. Two new
columns, `stripe_deauthorized_at` and `stripe_deauthorized_account_id`, keep the
record of which account the earlier gifts settled into. `cash_gifts_enabled` is
untouched, on the same rule `account.updated` follows: that column is the
couple's intent, not Stripe's capability.

`charge.dispute.created` / `.closed` — a gift whose money the guest's bank has
pulled back was left reading as Received in the couple's own log. It now holds
at a new `disputed` status, out of the received total and still in the log, and
the close moves it where the verdict says: back to `succeeded` if the couple won,
`refunded` if they lost. A lost dispute may act on a `succeeded` row too, since
`closed` arriving when `created` did not is ordinary. `warning_closed` ends an
enquiry where no money moved and is ignored. Disputes are the one gift event
that reaches the platform's own balance — Express leaves cire liable for a
connected account that goes negative — so a silent one was the expensive kind.

Migration 0061.
