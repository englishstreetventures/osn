---
title: Astro bundle-size guards
description: scripts/guard-bundle-size.sh — measuring and gating each Astro app's deployed bundle, and the src/pages test-route check beside it
tags: [convention, build, astro, performance]
related:
  - "[[cire-development]]"
  - "[[frontend-patterns]]"
  - "[[testing-patterns]]"
  - "[[review-findings]]"
last-reviewed: 2026-09-07
---

# Astro bundle-size guards

Tracker #287 found cire/invites' SSR Worker bundle at 470 KB gzip, unnoticed,
from two mistakes: a whole animation library reachable from the server module
graph though nothing there ran it, and drift-guard tests routed as live pages
because they sat un-prefixed under `src/pages`. Tracker #619 generalised the
fix cire/invites got: both mistakes can happen in any of the repo's six Astro
apps, and both are now checked on every one of them.

Two separate scripts, because the two mistakes are different shapes.

## Two rules for any guard that gates on a number

These are not about bundles. They apply to any guard with a threshold in it —
a size budget, a query-count cap, a timing ceiling — and both were learned here
by getting them wrong first.

**The number lives in one committed file the guard reads.** Never as an
argument at each call site. `scripts/bundle-size-budgets.txt` is the worked
example, and what it replaced was the same threshold typed into six
`package.json` build scripts, one `ci.yml` step and eight `deploy.yml` steps —
fifteen copies, and a re-baseline that missed one left a guard enforcing a
number nobody meant. One file also means the guard can refuse to run for a
package with no row, rather than passing silently.

**The headroom is smaller than the smallest mistake the guard exists to
catch**, measured against the current build rather than carried over from an
older one. A guard whose slack exceeds the mistake cannot fire, whatever it
prints. This one nearly shipped: the invites threshold budgeted 47657 bytes of
headroom, which was `motion`'s cost back when that build was *unminified*. In
the minified build the same library costs 21261 bytes, so a fresh dependency of
exactly the class the guard was written for would have landed under the line
and deployed. The fix was to re-measure against the build as it is now and set
the headroom to ~11.7 KB, roughly half the mistake.

The corollary is a check, not a rule: **you have not verified a guard until you
have seen it fail.** Break the input, watch the non-zero exit. A guard that
only ever passes is indistinguishable from one that cannot fail.

## `scripts/guard-bundle-size.sh` — the size guard

```
scripts/guard-bundle-size.sh <package-dir>   # one app, e.g. from a build script
scripts/guard-bundle-size.sh --all           # every app, what ci.yml calls
```

Mode and threshold are not arguments — **`scripts/bundle-size-budgets.txt` is
the single source of truth**, and this page's table below is a mirror of it
for a human reading the wiki. If the two ever disagree, the `.txt` file is
right and this page is stale; re-read it rather than trusting the table below.
That split used to not exist: the threshold was a third command-line argument,
copied by hand into six `package.json` build scripts, one `ci.yml` step and
eight `deploy.yml` steps — fifteen copies of the same number, silently
divergeable by missing one on a re-baseline. There is now exactly one place to
edit.

`<package-dir>` is `cd`'d into and also supplies the label the budgets file is
looked up by (the last two path segments of the *resolved* directory — `.` and
`cire/host` both label themselves "cire/host", and both match the same row).
`--all` resolves every row against the repo root instead, since a row's
package-dir is a repo-relative path by definition. A `<package-dir>` with no
row in the budgets file is an error, not a skip — the guard refuses to run
silently-successfully for an app nobody added a budget for.

The full reasoning for the two modes, the exclusion vs. allowlist logic, and
the threshold arithmetic lives in the script's own comment — read that before
touching a threshold. In short:

- **`worker`** — cire/invites, the only `output: "server"` app. Measures
  `dist/server` (every file except the adapter's generated `wrangler.json` and
  `*.map`, since `no_bundle: true` ships each chunk as its own module) and
  separately refuses any `*.map` under the sibling `dist/client`, which is
  served publicly as Static Assets. See [[cire-development]] for why
  cire/invites' bundle is shaped the way it is (sessions off, SSR-only
  minification, server-only source maps, why `zod` stays).
- **`static`** — `cire/host`, `cire/landing`, `cire/vendor`, `osn/landing`,
  `pulse/landing`. All five are `output: "static"`: no Worker, no `dist/server`,
  no `dist/client` split — they deploy `dist` wholesale to Cloudflare Pages.
  Measures `dist/_astro/*.js` and `dist/_astro/*.css` **only** — an allowlist,
  not a directory sum, because `dist/_astro/fonts/` holds Google Fonts binaries
  fetched at build time (hashed names, moves whenever Google's metadata moves,
  not a repo change) and `dist` holds one HTML file per page (grows with
  ordinary content). Neither belongs in a guard whose job is catching a library
  that shouldn't have shipped.

> [!warning] Known blind spot: inline `<style>`/`<script>` in the HTML
> `build.inlineStylesheets: "auto"` is Astro's default and is unset in all
> five static apps, which writes some generated CSS/JS inline into each
> page's HTML instead of into `dist/_astro`. `static` mode's allowlist cannot
> see bytes that never land in the directory it reads. Measured on
> osn/landing: 5 inline style blocks + 4 inline script blocks in
> `dist/index.html` alone, about 3116 bytes gzip-equivalent — real budget the
> guard cannot see. Tracker issue `xchromo/osn-tracker#636` holds the two ways to close this
> (parse the HTML too, or force `inlineStylesheets: "never"` so everything
> lands in `dist/_astro` where the guard already looks); this is a product
> decision, not something fixed in this script.

### Where it runs, and why twice

Every app's own `build` script chains the guard on with `&&` (`astro build &&
… guard-bundle-size.sh .`) — that is what runs it on a local build and the
by-hand cire/invites deploy. It ALSO runs as its own step in `ci.yml`'s
`build-test` job (one `--all` step covering every app) and in both
`deploy.yml` jobs (dev and production) that build a guarded app (one
`guard-bundle-size.sh <app>` step each — `deploy.yml` builds one app per job,
so there is no `--all` there). That is not a redundant belt-and-suspenders: a
Turborepo cache replay of `build` replays its logged output without executing
the script, so the chained invocation never runs on a cache hit — the explicit
workflow step is what still checks the artifact that IS on disk in that case.
Both invocations matter; neither one alone covers both paths.

`osn/landing` and `pulse/landing` also deploy from
`.github/workflows/deploy-osn-pulse-landing.yml` (a feature-branch preview,
`bun run --cwd <dir> build`) — that already runs each app's own chained `build`
script, so the guard applies there too with no separate step needed.

### Per-app thresholds — mirrors `scripts/bundle-size-budgets.txt`

**This table is documentation, not enforcement.** `scripts/bundle-size-budgets.txt`
is what every caller actually reads; this table exists so a human can see every
app's number without opening it. If they disagree, trust the `.txt` file and
fix this page.

Built once (2026-09-06 baseline), from a clean `bun run build` at the worktree
root with no `PUBLIC_*` vars set (CI's own build has none either; the deploy
jobs inline real URLs and sitekeys, and the headroom absorbs the difference).
Headroom is fixed at the same **~11.7 KB** cire/invites' own guard uses,
deliberately smaller than a motion-class dependency (21261 bytes gzip,
minified — see the script comment) so a mistake of that class always trips
the guard regardless of how large or small the app's own baseline is:

| App | Mode | Measured | Threshold |
|---|---|---:|---:|
| cire/invites | worker | 163332 B | 175000 B *(pre-existing, tracker #287/#616)* |
| cire/host | static | 212832 B | 224515 B |
| cire/vendor | static | 69961 B | 81644 B |
| cire/landing | static | 177641 B | 189324 B |
| osn/landing | static | 15182 B | 26865 B |
| pulse/landing | static | 16683 B | 28366 B |

`cire/landing` ships a Three.js scene by design (the wax-seal hero) — its
JS number is dominated by one intentional dependency, which is exactly why
each app gets its own baseline rather than a shared number.

**Re-baselining** after an intentional change: build (clean, alone — two builds
running at once in one checkout interleave their chunks and the guard then
reads a number that is not real), read the printed total, and edit **only**
`scripts/bundle-size-budgets.txt`'s row for that app, to that total plus
~11.7 KB. Nothing else names a threshold — not the app's `package.json`, not
`ci.yml`, not `deploy.yml` — so there is nowhere else to update. Mirror the new
number into the table above so this page stays honest.

## `scripts/check-astro-test-routes.ts` — the `src/pages` check

Astro routes every file under `src/pages` into a live page, except one whose
name — or an ancestor directory's name, anywhere between `src/pages` and the
file — starts with `_`. A `*.test.ts`/`*.spec.ts` left un-prefixed there is
therefore built and deployed as a real route, which is exactly how
cire/invites picked up 119 KB gzip of vitest. This check walks all six apps'
`src/pages` looking for that shape.

It needs no build and no per-app baseline — a plain directory walk — so it runs
in the fast `lint` job in `ci.yml`, not `build-test`.

## Related

- [[cire-development]] — cire/invites' own bundle history (#618 sessions off,
  #616 SSR minification, #617 why `zod` stays)
- [[frontend-patterns]] — general Astro/Solid patterns
- [[review-findings]] — P-I8 (tracker #619) is where this convention traces
  back to
