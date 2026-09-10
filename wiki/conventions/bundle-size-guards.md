---
title: Guards that gate on a number
description: The two rules any committed threshold obeys, and the guards that hold them — scripts/guard-bundle-size.sh over each Astro app's deployed bundle, the src/pages test-route check beside it, and scripts/guard-d1-migration-cost.ts over what a from-zero D1 rebuild spends against the free-tier ceiling
tags: [convention, build, astro, performance, ops, d1]
related:
  - "[[cire-development]]"
  - "[[frontend-patterns]]"
  - "[[testing-patterns]]"
  - "[[review-findings]]"
  - "[[free-tier-limits]]"
  - "[[dev-environment]]"
last-reviewed: 2026-09-10
---

# Guards that gate on a number

Tracker #287 found cire/invites' SSR Worker bundle at 470 KB gzip, unnoticed,
from two mistakes: a whole animation library reachable from the server module
graph though nothing there ran it, and drift-guard tests routed as live pages
because they sat un-prefixed under `src/pages`. Tracker #619 generalised the
fix cire/invites got: both mistakes can happen in any of the repo's six Astro
apps, and both are now checked on every one of them.

Two separate scripts, because the two mistakes are different shapes.

A third guard on this page measures nothing to do with bundles. `scripts/guard-d1-migration-cost.ts`
gates what a from-zero D1 rebuild spends against a free-tier quota, and it is
here because it obeys the same two rules and was built from this page. The page
name still says bundles because the file has not moved.

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

*Unverified — the method is on record, the date is not. Gzip
`cire/invites/dist/client/_astro/animate.*.js` from a clean build, or rebuild
with `stubMotionForSsr()` removed and diff the total. Written into this page
2026-09-07.*

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
- **`static`** — `cire/host`, `cire/landing`, `cire/vendor`, `musubi/landing`,
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
> musubi/landing: 5 inline style blocks + 4 inline script blocks in
> `dist/index.html` alone, about 3116 bytes gzip-equivalent — real budget the
> guard cannot see. Tracker issue `xchromo/osn-tracker#636` holds the two ways to close this
> (parse the HTML too, or force `inlineStylesheets: "never"` so everything
> lands in `dist/_astro` where the guard already looks); this is a product
> decision, not something fixed in this script.
>
> *Unverified — no command on record. Written into this page 2026-09-07;
> recount the inline `<style>`/`<script>` blocks in
> `musubi/landing/dist/index.html` before acting on the 3116.*

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

`musubi/landing` and `pulse/landing` also deploy from
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
| musubi/landing | static | 15182 B | 26865 B |
| pulse/landing | static | 16683 B | 28366 B |

*Measured 2026-09-06 — clean `bun run build` at the worktree root with no
`PUBLIC_*` vars set, then `scripts/guard-bundle-size.sh --all`, which prints
each app's gzip total. `scripts/bundle-size-budgets.txt` is still the file the
guard reads; this table only mirrors it.*

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

## `scripts/guard-d1-migration-cost.ts` — the D1 rebuild-cost guard

Same shape, different number: what a **job** spends against a **quota**, rather
than how big an artefact is.

The cire dev deploy crossed a hard ceiling by growing. Every
`ALTER TABLE ... DROP COLUMN` added to the migration chain made each from-zero
rebuild a little dearer, and on 2026-09-09 thirteen merges spent 104,091 D1 rows
written against a free-tier limit of 100,000 a day account-wide
(xchromo/osn#979). No commit was wrong; no version of the job failed a test.
[[free-tier-limits]] holds the ceiling itself; [[dev-environment]] holds what the
rebuild now does.

```
bun run scripts/guard-d1-migration-cost.ts --all              # every chain — what ci.yml calls
bun run scripts/guard-d1-migration-cost.ts <migrations-dir>   # one chain
```

### What it counts, and how tight the correlation is

The measurement is local and offline — no D1 call. The guard replays every
`.sql` file in the chain into an in-memory `bun:sqlite` database and counts
**schema writes**: one per statement that changes the schema, two for a
statement that makes SQLite rebuild a whole table (`ALTER TABLE ... DROP
COLUMN`). Rows that a data statement in a migration really writes are counted
exactly, from SQLite's own `changes`. Replaying rather than parsing means a
chain that no longer applies fails the guard instead of measuring cheap.

`bun:sqlite` cannot report D1's rows-read/rows-written accounting, so the row
figure is a **proxy priced by one constant**: 27 D1 rows written per schema
write. A from-zero rebuild runs against empty tables, so nearly all of what it
spends is schema churn — D1 bills a table rebuild whatever the table holds — and
the constant asserts that each schema statement therefore has a roughly fixed
price. One measurement fixes it; a second only bounds it.

**The hard anchor.** One `ALTER TABLE ... DROP COLUMN` on
`wedding_invite_customisations`, against a table with no rows in it, cost **54
D1 rows written** — two schema writes at 27 apiece.
*Measured 2026-09-10 — `bunx wrangler d1 insights cire-db-dev --time-period=7d --sort-by=writes --limit=200`. The `--limit` is the point: it returns the 200 heaviest queries, not the week.*

**The soft anchor**, which agrees within about a fifth and no better. The
57-file chain squashed by xchromo/osn#984 measures 269 schema writes here, and
its rebuild cost **8,007 D1 rows written** in total — but that total covers
drop, replay *and* seed, so it bounds the chain only once the seed is taken off,
and the seed's cost is the part not known precisely.
<!-- 8,007 is unverified here: taken from [[free-tier-limits]] and the xchromo/osn#979 investigation, not re-derived -->

| Bound on the constant | Where it comes from |
|---:|---|
| **≤ 22.1** rows per schema write | `cire/db/seed/dev-seed.sql` inserts **2,063 tuples**, and D1 bills index entries as rows written too, so the seed cost at least that. The chain is then at most 8,007 − 2,063 = 5,944.<br>*Measured 2026-09-10 — replay `cire/db/migrations/0001_initial.sql` then `cire/db/seed/dev-seed.sql` into `bun:sqlite` and sum SQLite's `changes`.* |
| **27** rows per schema write | The hard anchor above — the only figure measured directly. |

> [!warning] The "89% schema, 11% seed" split does not settle this
> That split is taken from the **200 heaviest queries** — 56,852 rows written
> across those 200, against roughly 409,000 on the database over the week's
> rebuild days — so it is a share of a sample, not a share of a rebuild.
> Multiplying 8,007 by 0.89 is not sound: the seed cost it implies, 881 rows,
> is below the seed's own floor of 2,063, which is the tell that the sample
> over-represents schema statements. Neither sampling figure was re-derived
> when this section was written.

So the constant sits somewhere around **22 to 27**, and the guard uses 27: the
top of the band, the only directly measured point, and the safe side, since
over-stating a rebuild is the error that does not lose a day's quota.

> [!important] What the uncertainty touches
> The **schema-write count is exact** — counted, not modelled — and it is what
> to trust. Every **row** figure on this page or in the guard's output, and
> every "replays a day" derived from one, carries the 22–27 band: read them as
> indicative, and as pessimistic by up to about a fifth rather than optimistic.
> The guard prints its line in schema writes beside the row budget for that
> reason, so the threshold can be read without the constant.
>
> Three things sit outside the number on purpose: the **seed** a full dev
> rebuild runs after the replay (2,063 tuples, on top), the per-file
> `d1_migrations` ledger insert (folded into the constant, which over-charges a
> short chain slightly), and **rows read**, whose ceiling is 5,000,000 a day
> against 100,000 written and has never been the binding one.

### The budget — mirrors `scripts/d1-migration-cost-budgets.txt`

**This table is documentation, not enforcement.** The `.txt` file is what the
guard reads; if the two disagree, it is right and this page is stale.

| Chain | Schema writes now | Line | Priced at 27 | Replays a day (indicative) |
|---|---:|---:|---:|---:|
| `cire/db/migrations` | **68** | **137** | 1,836 → 3,700 rows | ~54 now, ~27 at the line |

The left two columns are exact; the right two move with the constant. The
pre-squash chain, for scale: 269 schema writes, about 7,265 rows, roughly 13
replays a day. Point the guard at `cire/db/migrations-archive` and it goes red,
which is the fastest way to see it fail.
*Measured 2026-09-10 — `bun run scripts/guard-d1-migration-cost.ts --all`.*

**Note the arithmetic on the pre-squash chain does not reproduce 8,007.** At 27
it prices at 7,265 and the seed floor is 2,063, which sums past the reported
total — which is another way of saying the true constant is nearer the bottom
of the band than the top, and that the guard is deliberately charging more than
a rebuild probably costs.

### Why the headroom is a doubling, not a hair

The rule further up this page — headroom smaller than the smallest mistake —
assumes a baseline that is not supposed to move. A migration chain is supposed
to grow, and the mistake here is not one bad migration: nothing in the chain
that went over the ceiling was wrong. So the line is drawn at a **doubling** of
the chain — 68 schema writes now, tripping at 137 — which is the smallest step
that materially changes the answer to "how many rebuilds a day can we afford".
A budget tight enough to trip on one ordinary feature migration —
`0057_registry` was 15 schema writes on its own — would be raised on sight every
few pull requests, which is the failure the second rule names. The doubling is
in the exact unit, so it holds wherever in the 22–27 band the constant really
sits.

The other half of that: **this guard has a remedy the bundle guards do not.**
Squashing the chain into a fresh baseline puts the number back down instead of
moving the line up, which is exactly what xchromo/osn#984 did — 269 schema
writes to 68. Reach for that before raising the budget.

### Where it runs

One step in `ci.yml`'s `script-tests` job. That job does no `bun install` on
purpose, and the script imports `bun:sqlite` and Node built-ins and nothing
else, so it belongs there rather than in `build-test`. Its own tests
(`scripts/tests/guard-d1-migration-cost.test.ts` for the measurement,
`.cli.test.ts` for exit codes and messages) run in the same job under
`bun run test:scripts`, and one of them re-asserts the committed budget against
the committed chain — so a migration that busts it fails the tests as well as
the guard step.

## Related

- [[free-tier-limits]] — the D1 ceilings this guard is measured against
- [[dev-environment]] — what the nightly cire dev rebuild does and costs
- [[cire-development]] — cire/invites' own bundle history (#618 sessions off,
  #616 SSR minification, #617 why `zod` stays)
- [[frontend-patterns]] — general Astro/Solid patterns
- [[review-findings]] — P-I8 (tracker #619) is where this convention traces
  back to
