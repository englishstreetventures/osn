---
"@cire/api": patch
"@cire/web": patch
---

Add a first-party CSP violation-report collector so the cire/web Report-Only CSP
(shipped in #205) surfaces what would break in real guests' browsers — logged to
observability, no third-party service.

**cire-api — `POST /api/csp-report`** (`routes/csp-report.ts`): a public,
unauthenticated collector that normalises BOTH wire formats — legacy `report-uri`
(`application/csp-report`, `{ "csp-report": { … } }`) and the modern Reporting API
(`application/reports+json`, an array of `{ type: "csp-violation", body: { … } }`)
— sniffing the shape and tolerating malformed bodies. Each violation is logged via
`Effect.logWarning` (through `runCire`) with a SMALL, BOUNDED slice: the
effective/violated directive, the blocked URI **reduced to its origin** (or
truncated to 128 chars — never the full URL with its query, which could carry a
claim code), the document **path only** (query/hash stripped), and the
disposition. A bounded-cardinality `cire.csp.report` counter is incremented by a
fixed `effectiveDirective` label (`bucketCspDirective` maps anything unknown to
`other`; the blocked URI is NEVER a metric attribute). The route always answers
**204 No Content** and reflects nothing.

Abuse-hardened (it's public + creds-less): 16 KB body cap (declared
`Content-Length` pre-check + post-read guard), a generous per-IP rate limit
(`cspReportLimiter`, ~60/min, reusing `middleware/rate-limit` keying) that
fail-OPENs to a silent drop (still 204, never 429/500 on a fire-and-forget
endpoint), and **no D1 write** (log + metric only — no write-amplification DoS).
No Turnstile and no Origin/auth gate (browsers POST reports automatically, with no
creds and a cross-origin/null Origin) — the route is mounted BEFORE the CSRF origin
guard so it isn't 403'd.

**cire/web** (`lib/security-headers.ts`, `public/_headers`): the guest CSP now
carries `report-uri https://api.cireweddings.com/api/csp-report` (legacy) and
`report-to csp-endpoint` (modern), and `securityHeaders()` (hence the SSR
middleware) + `_headers` emit the companion `Reporting-Endpoints:
csp-endpoint="…"` header so `report-to` resolves. The collector URL is derived
from the same `ORIGINS.api` const `connect-src`/`img-src` already use, so it can't
drift. This works in the current Report-Only mode (Report-Only still sends
reports) — `CSP_ENFORCE` is unchanged.

View reports: `wrangler tail cire-api` (Workers tail) or the Cloudflare
observability/Workers Logs dashboard — they stay visible in DevTools too. No DB
migration.
