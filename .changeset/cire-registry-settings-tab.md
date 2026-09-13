---
"@cire/api": patch
"@cire/host": patch
---

Give the registry its settings, so a couple can actually open their gift list.

Four decisions the guest surface has been reading all along had nowhere to be
made: whether the list is published, what it says at the top, where parcels go,
and whether guests may give money instead. They are now a third sub-tab in the
registry module, beside the gift list and the gifts received — deep-linkable at
`#/w/<id>/registry/settings`, and reading the same cached snapshot the list
does, so switching costs no fetch and a save patches the settings row in place.

**Publishing is blocked while the list is empty**, and the notice says why:
guests reach the list — and the money-gift option with it — only once it is
published. An already-published list keeps the toggle live, or deleting the last
gift would freeze a couple on "Published" with no way back.

**Stripe onboarding is owner-only, and an editor sees that.** Everything else on
the tab is `weddingEditor`, because a co-host helping with the list may write it;
naming the bank account gifts are paid into is not ordinary help. The panel is
visible to an editor, disabled, with the reason — a co-host who wonders why money
gifts are off gets an answer rather than a missing section.

**Intent and capability stay two things.** "Let guests give money" is disabled
until Stripe can take a charge, and the API's own `stripe_not_ready` 409 is
answered by saying so, rather than "check the fields". One live Stripe read
happens on mount for a couple mid-onboarding — they have just come back from
Stripe and the webhook can be seconds behind them — and for nobody else.

**The gift log stopped printing enum values.** A claim now reads Promised /
Bought / No longer coming and a contribution reads Not cleared yet / Received /
Refunded — the two tables behind that log share the column and share none of its
values, and a couple should not meet the word "succeeded" about a wedding
present. A refunded gift keeps its row and gets a sentence: it went back to the
guest, and it is not in the total above.

**Reasons stay reachable.** The Connect button an editor cannot press is
`aria-disabled` rather than `disabled`, so it keeps its place in the tab order
and its `aria-describedby` reason with it — a `disabled` button is skipped by the
keyboard and by a screen reader in forms mode, which hides the explanation from
the one person asking for it. The empty-list publish block hangs its notice off
the Visibility fieldset for the same reason, since the blocked radio itself is
`disabled` and unreachable. And the Connect URL is parsed before the browser is
sent to it: `https://connect.stripe.com` or nothing.
