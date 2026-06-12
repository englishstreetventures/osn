---
"@cire/api": minor
---

Migrate cire/api from Hono to Elysia to match the platform convention.
Route factories (createClaimRoutes, createRsvpRoutes,
createOrganiserWeddingsRoutes, createOrganiserImportRoutes) composed by
createApp; middleware rewritten as Elysia plugins (scoped derive +
onBeforeHandle); organiser auth now uses the shared Elysia adapter from
@shared/osn-auth-client/middleware/elysia. Runs with aot: false
(Cloudflare Workers forbids dynamic code evaluation) and a sentinel
parse hook on POST routes so handlers keep the lenient manual
request.json() semantics. No route, status code, response body, or
header changes.
