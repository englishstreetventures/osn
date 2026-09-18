---
"@cire/invites": patch
"@cire/host": patch
---

Three fixes to the guest invite, two of them geometry measured in the browser
tier rather than asserted in jsdom.

**The Respond label no longer clips at 320px** (#1107). The answer button
carried `overflow-hidden` for the confirmation fill that sweeps across it, which
also made it a scroll container — and a scroll container's automatic minimum
size is zero. As a `flex-1` item beside an "Event Details" button carrying
`whitespace-nowrap`, it absorbed the whole shortfall: at 320px inside the events
section's own `px-6` it rendered 60px wide, of which 42px was padding and border,
leaving an 18px box for a word needing 46px. `overflow-clip` clips the fill to
the same rounded box without making the button a scroll container, so it keeps
the minimum width of its own label; the row now wraps and each button takes the
full 222px. Both labels are measured, and the harder one is not the one it looks
like: "RSVPs closed" is the longer line but holds a space and so breaks, while
"Respond" is one unbreakable word and therefore the larger minimum.

**The closing band stops growing above 1536px** (#1077) and settles onto its
design pack's events-column token — `column-xl` (640px) in `classic`,
`column-2xl` (960px) in `gala`, centred in both. On a 2560px display the sign-off
rendered 2560×765 against event cards in a 640px column; capped it is 640×320 and
960×480. Below 1536px nothing changes. One custom property carries the width and
it resolves the pack's own token, so the band, the column and the section's
`contain-intrinsic-size` reserve cannot disagree. `sizes` restates the cap in
pixels — an `img` attribute cannot read a custom property — and a drift guard
reads the token block in `global.css` to keep the two in step.
The band eases across the boundary on `max-width`, clamped by the global
reduced-motion rule. This reverses the band's original full-bleed intent, so the
component's doc comment, the host builder's miniature and both wiki pages say the
new rule.

**The RSVP deadline notice stays a `<p role="status">`** (#1113), with the reason
on the `role` line: the sentence rewrites itself under a guest who is only
reading, and `<output>` is form-associated. No markup change.
