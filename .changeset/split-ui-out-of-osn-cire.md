---
"@cire/ui": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/vendor": patch
---

Follow the `@osn/ui` split and the `--osn-*` → `--ui-*` token rename.

`@cire/ui` and the four cire surfaces import the primitives from `@shared/ui`
now, and each app's contract block maps its palette onto `--ui-*` instead of
`--osn-*`. `@cire/ui` keeps its own identity unchanged — it is cire's house
style (gold primary, 4px corners), which is one product's chrome and belongs
to that product.
