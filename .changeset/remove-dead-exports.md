---
"@shared/db-utils": minor
"@shared/osn-auth-client": minor
"@pulse/landing": patch
---

Delete three pieces of code that nothing called.

`@shared/db-utils` no longer publishes `./effect/batch` or its `commitEffectWrites`; no package imported either.

`@shared/osn-auth-client` no longer publishes `./middleware/elysia`, the Elysia middleware no service used, and drops its `elysia` peer and dev dependency. `OsnAuthOptions`, the options shape a service's own middleware takes, is now exported from the package root.

`@pulse/landing` drops its Cloudflare Pages Function for `GET /api/geo`. The pulse stack's Worker entry (`worker/index.ts`) serves that route from the same handler, and its tests now include the one case the Pages Function's test held: the count's place is the region before the city, then the country.
