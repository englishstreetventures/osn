---
"@shared/db-utils": minor
"@shared/osn-auth-client": minor
"@pulse/landing": patch
---

Delete three pieces of code that nothing called.

`@shared/db-utils` drops `./effect/batch` and its `commitEffectWrites`; no package imported either.

`@shared/osn-auth-client` drops `./middleware/elysia`, the Elysia middleware no service used, and its `elysia` peer and dev dependency. `OsnAuthOptions`, the options shape a service's own middleware takes, is exported from the package root, and its README example sets every option, the issuer included.

`@pulse/landing` drops its Cloudflare Pages Function for `GET /api/geo`. The pulse stack's Worker entry (`worker/index.ts`) serves that route from the same handler, and its tests hold the one case the Pages Function's test held: the count's place is the region, then the city, then the country.
