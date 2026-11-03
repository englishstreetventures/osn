---
"@cire/invites": patch
"@cire/host": patch
"@cire/vendor": patch
"@cire/landing": patch
---

Every Astro app now has a bundle-size guard. Only cire/invites had one, and
its assumption that the other five apps build the same way was wrong: they are
all `output: "static"` (Cloudflare Pages), with no Worker and no
`dist/server`/`dist/client` split.

`scripts/guard-bundle-size.sh` replaces `cire/invites/scripts/guard-ssr-size.sh`
with one script that takes a `worker` or `static` mode. Worker mode measures
cire/invites' `dist/server`. Static mode measures the other five apps'
`dist/_astro/*.js` and `*.css` only, because Google Fonts binaries and per-page
HTML in `dist` move for reasons that have nothing to do with a regression. The
new path is covered by CODEOWNERS. Each app's `build` script now chains its own
invocation, and `ci.yml` and `deploy.yml` each carry an explicit step per app,
since a Turborepo cache replay of `build` never runs the chained script.

`scripts/tests/guard-bundle-size.cli.test.ts` runs the script as a real
subprocess against fixture directories, covering both modes' exclusion and
allowlist logic and the threshold comparison.

A new `scripts/check-astro-test-routes.ts`, wired into the fast `lint` job in
`ci.yml`, checks that none of the six apps can route an un-prefixed
`*.test.*` or `*.spec.*` file, as cire/invites once did.
