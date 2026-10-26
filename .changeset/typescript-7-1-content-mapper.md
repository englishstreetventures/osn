---
"@musubi/landing": patch
"@musubi/social": patch
"@pulse/landing": patch
"@pulse/web": patch
"@tools/lab": patch
"@tools/metrics": patch
---

Move to TypeScript 7.1 (`typescript@7.1.0-beta`). The Astro landing sites drop `astro check` and `@astrojs/check` and type-check with `tsc -p . --runExternalCode` and `@astrojs/ts-content-mapper`, which checks every `.astro` page and component; `astro` moves to 7.4.2.
