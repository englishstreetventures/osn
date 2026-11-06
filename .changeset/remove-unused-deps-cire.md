---
"@cire/host": patch
"@cire/invites": patch
"@cire/ui": patch
"@cire/vendor": patch
---

Drop dependencies no file imports: the direct `@vitest/browser`, which `@vitest/browser-playwright` already brings in, and `@capsizecss/metrics`, whose font metrics are copied into `global.css`. No behaviour changes.
