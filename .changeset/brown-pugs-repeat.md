---
"@osn/client": patch
"@osn/landing": patch
"@osn/social": patch
"@osn/ui": patch
"@pulse/landing": patch
"@pulse/web": patch
"@shared/rp-auth": patch
"@shared/sortable": patch
"@shared/toast": patch
"@tools/lab": patch
---

Pin browserslist to ^4.28.8 via a root override, clearing two high-severity advisories (GHSA-c83g-rgw3-j3cx unbounded query-cache growth, GHSA-73wf-gq98-2v4g crash and prototype write on untrusted browserslist-stats.json). Both affect <= 4.28.6, and the tree resolved 4.28.2 transitively through the @babel/core that vite-plugin-solid and @astrojs/solid-js pull in. Every package listed here sits on that chain. Build output is byte-identical.
