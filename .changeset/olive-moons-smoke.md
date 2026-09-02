---
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/vendor": patch
---

Pin browserslist to ^4.28.8 via a root override, clearing two high-severity advisories (GHSA-c83g-rgw3-j3cx unbounded query-cache growth, GHSA-73wf-gq98-2v4g crash and prototype write on untrusted browserslist-stats.json). Both affect <= 4.28.6, and the tree resolved 4.28.2 transitively through the @babel/core that vite-plugin-solid and @astrojs/solid-js pull in. Build output is byte-identical.
