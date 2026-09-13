---
"@cire/api": patch
"@cire/invites": patch
"@cire/db": patch
---

Let a guest give money, whether or not anything is left on the list.

The other half of cash gifts: hosted Checkout, the gift row the webhook settles
when Stripe says the money moved, and the panel a guest actually uses.

**`POST /api/invite/:slug/registry/contribute`** answers with a Stripe Checkout
URL for a DIRECT charge on the couple's connected account — the money is theirs
from the moment it is taken. Every gate runs before Stripe does: the registry
must be visible, the household must belong to this wedding, and the couple must
both have said yes and be able to take a charge today. A guest is turned away
before their card is, or not at all. Its own per-IP limiter, at the claim
route's 20/min: every call is an outbound Stripe request, but the limit is per
IP and a wedding reception is one NAT.

**The gift row is written FIRST, as `pending`, before the guest is handed a
payment page** — and Stripe is told one opaque id and the money, nothing about
the guest. A forged session settles nothing: the webhook settles the row that id
names, and there is no row to conjure from an event. That matters because this
endpoint also hears about sessions a connected account created for ITSELF, where
every metadata field is whatever its owner typed. `settleContribution` checks
the completed session is the one on the row and that the row's wedding owns the
account the event arrived on, then answers `settled` / `duplicate` / `unknown` /
`rejected` — at-least-once delivery makes a duplicate ordinary, and the states
are where refunds will hang. If the row cannot be written the guest is not sent
to pay at all: a payment with no record is the one outcome there is no way back
from. The idempotency key is a hash of the whole request plus a five-minute
bucket, so a double-tap is one attempt and everything else is its own.

**The panel sits above the shelves and outside the items-exist branch**, on
purpose. A guest who finds every gift taken has not stopped wanting to give
something, and an option that appears only once the list runs dry reads as a
consolation prize. It takes no card details — the button hands off to Stripe's
own page, and only to Stripe's own origin — and says so before the guest
presses, along with who reads the name and note they wrote: the couple, never
the other guests. Amounts are typed in major units and converted once through
the currency's real exponent, so a yen gift is not 100× wrong. Coming back,
`?gift=thanks` thanks the guest without claiming money moved; it is a query
parameter anyone can type.

**Gifts leave with the rest of the guest data at one year, but the fact of them
stays.** The sweep writes a summary to `registry_settings` before it deletes
(migration 0058): counts and per-currency totals, no household, no name, no
note. Released claims and unsettled contributions are not counted, totals are
never converted across currencies, and a summary that cannot be written is
logged and stepped over — the deletion is the obligation.

**A checkout session is not over when it completes.** Four more Stripe events
are handled, because three of them decide whether a gift exists.
`checkout.session.async_payment_succeeded` settles a delayed bank debit — BECS
here, SEPA in Europe — that completes the session in seconds and clears days
later; without it a real gift sat `pending` forever and never reached the
couple's log. `async_payment_failed` and `expired` close a gift whose money is
never coming, and `charge.refunded` marks a settled one refunded, found by the
payment intent the settle path wrote (migration 0059 indexes that column). A
partial refund is left alone: a couple who returned half a gift still received
the other half.

Every one of those transitions is one-way and guarded in the service — only a
`pending` row may fail, only a `succeeded` row may refund, and the row is kept
rather than deleted. A replayed or forged `expired` cannot un-settle a gift
somebody actually gave. A `failed` gift is hidden from the couple's log
entirely, since money that never moved is not a gift and a guest who abandoned
checkout never meant to tell them anything; a refunded one stays visible and out
of the total, because a refund is a thing that happened to their record.

The account lookup that guards all of this is one query rather than two — a
`LEFT JOIN` on the settings row, inside a handler Stripe gives twenty seconds.

`PublicRegistryDto.cashGiftsEnabled` is now the couple's intent ANDed with
Stripe's capability, so the guest surface never reasons about the two
separately. Still inert without `STRIPE_SECRET_KEY`: no client, no route, no
button.
