---
"@cire/api": patch
---

Guest gift images now tell browsers and proxies to keep them for an hour, not a
year. `GET /api/invite/:slug/registry/image/:name` has no auth, and its bytes
went out as `public, max-age=31536000, immutable`, so unpublishing the gift
list could not reach a copy a browser or proxy already held. The route now
answers `public, max-age=3600` with no `immutable`, on a fresh transform and on
a Worker-cache hit alike.

`serveTransformedImage` takes a `lifetime` (`"immutable"`, the default, or
`"revocable"`), and `imageCacheControl` builds the header for both serve paths.
Every other image route keeps a year, and so does the Worker's own cached copy,
since every lookup in it runs after the publish gate. A cache hit now goes to
the client with no `Age` and a `Date` of now, so an entry stored more than an
hour ago does not arrive already stale.
