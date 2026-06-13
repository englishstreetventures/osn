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
request.json() semantics. All route paths, status codes, response
bodies, and headers are preserved, with two deliberate exceptions:
unhandled errors now return a generic JSON 500 ({ "error": "Internal
error" }) instead of Hono's plain-text default, and the Worker entry
now fails closed (503) on a schemeless WEB_ORIGIN entry instead of
serving with a scheme-stripped CORS allowlist. The Worker also builds
the app once per isolate instead of per request.
