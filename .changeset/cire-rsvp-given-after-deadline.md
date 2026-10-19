---
"@cire/invites": patch
"@cire/theme": patch
"@cire/api": patch
"@cire/host": patch
"@tools/e2e": patch
---

An answered event's button reads "RSVP given" and stays usable after the RSVP
deadline, opening the reply read-only; an event nobody answered loses its
button, and every card carries an "RSVPs closed" badge.

`@cire/invites`: the card shows "RSVP given" (bloom fill and tick once every
invited member has answered; plain gold for a part reply after the deadline)
and no answer button once closed with no reply. The details panel offers "View
your RSVP" to a household with a reply after the deadline; the read-only sheet
is titled "Your RSVP" and shows a stored "maybe" as "Not decided". Focus moves
to Event Details when the answer button unmounts under it. Every gold button's
label uses the new `--color-on-gold` ink, and the RSVP button's hover
underlines rather than easing the gold.

`@cire/theme`: `derivePalette` emits `--color-on-gold`, held to 4.5:1 on the
gold by walking toward whichever of black or white contrasts more; bloom is
held to 4.5:1 against the page; garden's bloom seed is `oklch(50% 0.068 128)`;
`RESIDUAL_PAIRS` gains `label-on-bloom` and `label-on-gold`.

`@cire/host`: the palette and invite previews paint their sample gold button's
label in `--color-on-gold`.

`@cire/api`: the local server sets the sample wedding's RSVP deadline from
`CIRE_E2E_RSVP_DEADLINE` (`setSampleRsvpDeadline`), refusing a malformed date.

`@tools/e2e`: the stack sets that deadline to 2099-01-01, and a new flow,
`cire-rsvp-after-deadline`, moves the browser past it.
