---
"@musubi/landing": patch
"@pulse/landing": patch
---

Raise the root `devalue` override from `^5.8.1` to `^5.9.4`, clearing three high advisories on `devalue` 5.9.2 (shared-memory serialisation, quadratic `uneval` expansion, and an unhandled rejection in `stringifyAsync`). Astro pulls `devalue` in for these sites.
