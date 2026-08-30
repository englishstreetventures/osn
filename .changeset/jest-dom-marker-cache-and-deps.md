---
"@osn/client": patch
"@osn/landing": patch
"@osn/social": patch
"@osn/ui": patch
"@pulse/landing": patch
"@shared/rp-auth": patch
"@shared/sortable": patch
"@shared/toast": patch
---

Drop the unused `@testing-library/jest-dom` devDependency from every package that declared it but imports no matcher, now that `vite-plugin-solid` no longer injects its setup file. Guard the suppression markers in CI, and list the marker file under turbo's `globalDependencies` so an edit to it can no longer be served from cache.
