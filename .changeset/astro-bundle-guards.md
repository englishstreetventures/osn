---
"@cire/invites": patch
"@cire/host": patch
"@cire/vendor": patch
"@cire/landing": patch
---

P-I8 (tracker #619) — only cire/invites had a bundle-size guard, and its
premise that the other five Astro apps "build the same way" was wrong: they
are all `output: "static"` (Cloudflare Pages), with no Worker and no
`dist/server`/`dist/client` split. `scripts/guard-bundle-size.sh` replaces
`cire/invites/scripts/guard-ssr-size.sh` (also closing tracker #612's
CODEOWNERS gap for that path) with a `worker`/`static` mode argument, so the
same script measures cire/invites' `dist/server` and the other five apps'
`dist/_astro/*.js` + `*.css` (an allowlist — Google Fonts binaries and
per-page HTML in `dist` move for reasons that have nothing to do with a
regression). Each app's `build` script now chains its own invocation, and
`ci.yml`/`deploy.yml` each carry an explicit step too, per app — the same
double coverage cire/invites' own guard already had, needed because a
Turborepo cache replay of `build` never runs the chained script.

Also closes tracker #635: `scripts/tests/guard-bundle-size.cli.test.ts` runs
the script as a real subprocess against fixture directories, covering both
modes' exclusion/allowlist logic and the threshold comparison.

A new `scripts/check-astro-test-routes.ts`, wired into `ci.yml`'s fast `lint`
job, covers the general half of tracker #287: any of the six apps can route
an un-prefixed `*.test.*`/`*.spec.*` file the same way cire/invites once did.
