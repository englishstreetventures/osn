---
"@cire/host": patch
"@cire/vendor": patch
---

Point each portal build's Content-Security-Policy at its own cire-api.

`public/_headers` is the production policy, and it shipped unchanged to the
dev tier, whose portals call `api.dev.cireweddings.com` — an origin the policy
did not allow — and sent their violation reports to the production collector.
The build now rewrites `dist/_headers` so `connect-src`, `img-src`,
`report-uri` and `Reporting-Endpoints` name the origin of the
`PUBLIC_CIRE_API_URL` the bundle was built with, and fails if no client script
names that origin. A production build leaves the file exactly as committed,
which no longer lists `http://localhost:8787`. Both policies stay report-only.

The account avatar falls back to the initial when its image fails to load,
including when the CSP blocks its host.
