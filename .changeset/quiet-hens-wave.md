---
"@cire/api": patch
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/vendor": patch
---

Clear six new high advisories and refresh a lockfile that had drifted behind its own ranges. The cire half of the same sweep.

`fast-uri` 3.1.5 → 3.1.7 and `smol-toml` 1.6.1 → 1.8.0 both clear high advisories, and in both cases the version the advisory database names as fixed is not far enough: `fast-uri` 3.1.7 and `smol-toml` 1.7.1 each carry further high fixes that are not in the database yet, so no audit tool reports them. The `fast-uri` path runs through `@astrojs/check`, which every cire Astro package declares — the reachability is the type-checker's language server, not the request path.

`astro` 7.2.9 → 7.2.10 matters most here, because `@cire/invites`, `@cire/host` and `@cire/vendor` are deployed. It fixes an SSR manifest placeholder not being replaced when the server build is minified, which caused a runtime `Invalid URL` crash at server boot. `@astrojs/cloudflare` 14.2.5 → 14.2.6 fixes React SSR failures on the first Cloudflare dev request when JSON logging is enabled. Astro is pinned at 7.2.10 rather than left to float: 7.3.x clears the three-day soak but not the fourteen-day rule for a minor.

`cire/api/tests/index.test.ts` gains one member on its `StubSpan`: `@cloudflare/workers-types` 5.20260903.1 makes `recordException` required on `Span`. It is typed off the interface rather than restated, so the next daily types release cannot silently drift the stub away from the real signature. Nothing in the boot path records an exception.

The gates that cover these packages all pass on the refreshed tree: type check across all 37 tasks, the full test suite, the Miniflare D1 tier, and every Worker and site build.
