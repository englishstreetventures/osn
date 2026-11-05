---
"@cire/host": patch
"@cire/vendor": patch
"@cire/landing": patch
---

Cire screens drop the small-caps eyebrow over a heading that the module, the
tab, the top bar or the heading itself already names. "Settings" over
"Wedding profile", "Guest list" over the Households tab, "Enquiries" over the
vendor inbox, "See it live" over the marketing demo and seventeen more are gone,
and `SectionIntro` draws no eyebrow. An eyebrow stays where it carries
something the screen lacks: the upgrade dialog's tier, a locked module's
"Included with Gold", the sign-in pages' portal name, the marketing hero's
"Digital wedding invitations". A wedding tile prints its slug, the guest
link's path, under the name rather than over it, as the wedding switcher
does.

The invite builder's envelope picker now draws its cards and its label as the
design picker does: both take their cards from `pickerCardClass` (the card at
its small step, chosen and half-chosen as a block pressed to choose), and the
envelope group's head is a muted `Eyebrow`. An unchosen design or envelope
card goes halfway to chosen only while the pointer is on a radio a press
would choose, never over its padding, its preview link or a locked choice.
