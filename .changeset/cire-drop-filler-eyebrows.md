---
"@cire/host": patch
"@cire/vendor": patch
"@cire/landing": patch
---

Cire screens no longer put a small-caps eyebrow over a heading that the module,
the tab, the top bar or the heading itself already names: "Settings" over
"Wedding profile", "Guest list" over the Households tab, "Enquiries" over the
vendor inbox, "See it live" over the marketing demo and sixteen more are gone,
and `SectionIntro` draws no eyebrow. An eyebrow stays where it carries
something the screen lacks: the upgrade dialog's tier, a locked module's
"Included with Gold", the sign-in pages' portal name, the marketing hero's
"Digital wedding invitations".

The invite builder's envelope picker now draws its cards and its label as the
design picker does: both take their cards from `pickerCardClass` (the card at
its small step, chosen and half-chosen as a block pressed to choose), and the
envelope group's head is a muted `Eyebrow`.
