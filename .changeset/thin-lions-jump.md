---
"@osn/ui": patch
"@musubi/social": patch
---

Thread the product name shown in `@osn/ui`'s shared auth components as a
required `productName` prop instead of hardcoding it. `Register`, `SignIn` and
`SecurityEventsBanner` no longer say "OSN" or, in one spot, the wrong product
("Loading Pulse…") — every call site in `@musubi/social` now passes
`"Musubi"`.
