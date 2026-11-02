---
"@musubi/landing": patch
"@musubi/social": patch
"@osn/auth-ui": patch
"@osn/client": patch
"@pulse/landing": patch
"@pulse/web": patch
"@shared/realtime": patch
"@shared/rp-auth": patch
"@shared/sortable": patch
"@shared/toast": patch
"@shared/ui": patch
"@tools/lab": patch
"@tools/metrics": patch
---

Move `solid-js` from 1.9.15 to 1.9.18. In 1.9.18 a module-level `lazy()`
keeps its loaded component across an unmount, so a remounted lazy panel
renders at once instead of a microtask later. The Settings tab test now waits
for the router to write the fragment, which lands when the navigation's
transition settles rather than with the panel. `@solidjs/router` stays at
1.0.0: 1.0.1 is newer than the install's minimum release age.
