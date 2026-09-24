---
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/vendor": patch
---

First pass of the `@shadcn/lint` migration across the cire surfaces.

Arbitrary values move onto the contract's scales; call-site classes that a
shared component already applies are dropped. Values built from `var()`,
`calc()` or `clamp()` are exempt by configuration and untouched — a value that
reads a runtime custom property is the opposite of an off-token hardcode, and
`englishstventures/osn#1048` scopes them out. That matters most in `cire/invites`, whose
invite heading scale is computed at runtime from the wedding's own palette.
