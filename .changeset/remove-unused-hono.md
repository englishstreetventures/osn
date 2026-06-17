---
"@shared/osn-auth-client": patch
---

Remove the unused Hono middleware adapter and its `hono` devDependency. Every OSN consumer (osn, pulse, cire) uses the Elysia adapter; the Hono adapter was a type-only shim with no runtime user, and `hono` only existed in the dependency tree as a devDependency. Dropping it also clears the hono CORS advisory (GHSA-88fw-hqm2-52qc) from `bun audit`. A Hono adapter can be re-added if/when an external Hono consumer needs one.
