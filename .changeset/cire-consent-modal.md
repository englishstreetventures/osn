---
"@cire/invites": patch
---

The consent preferences dialog becomes a `Modal`

It was a `fixed inset-0` overlay with its own backdrop div, its own `Tab` cycle
and its own Escape handler — a hand-rolled dialog, on the one surface where an
unreachable control is worse than no control. `Modal` is the platform's
`<dialog>`, so the focus trap, Escape and the backdrop all arrive from
`showModal()` instead.

It still does not reuse `AnimatedModal`, for the reason that component's own
comment gives: `AnimatedModal` applies the invite's per-section theme variables,
and this dialog also renders on `/privacy` and `/terms`, which have no invite
theme at all.

`Z_LAYER.CONSENT_DIALOG` goes with it. The top layer paints above every stacking
context in the document by definition, so there is no longer a number to get
wrong or for a future overlay to outbid — which is the stronger version of the
guarantee that layer existed to make, not a gap left where it was.
