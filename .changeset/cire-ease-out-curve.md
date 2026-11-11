---
"@cire/host": patch
"@cire/vendor": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/ui": patch
---

Cire's `--ease-out` is now `cubic-bezier(0.23, 1, 0.32, 1)`, the strong ease-out
the motion skills name, in all four apps: the host and vendor portals, the
guest site and the marketing site. Everything that arrives on `--ease-out` — a
hover, a menu, a panel, a disclosure, the unlock reveal's rises — is a touch
further along from about an eighth of the way in: at no moment do the two
curves differ by more than 1.1% of the distance. `@cire/ui`'s test stylesheet
carries the same curve, and the vendor portal's token test now holds that copy
to the host's ladder. `Modal`, and the tooltips and popovers that run on
`@shared/design-tokens`' `animate-in` and `animate-out`, keep the shared
contract's `--ui-ease-out`.
