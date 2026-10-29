---
title: Guards with a threshold
description: The two rules any committed threshold obeys, and the guards that hold them — scripts/guard-bundle-size.sh, which warns when an Astro app's deployed bundle passes its budget and refuses a source map in its public output, the src/pages test-route check beside it, scripts/guard-d1-migration-cost.ts over what a from-zero D1 rebuild spends against the free-tier ceiling, and scripts/guard-lint-warnings.sh over how many warning-severity oxlint diagnostics the whole monorepo may carry
tags: [convention, build, astro, performance, ops, d1, lint]
related:
  - "[[cire-development]]"
  - "[[frontend-patterns]]"
  - "[[testing-patterns]]"
  - "[[review-findings]]"
  - "[[free-tier-limits]]"
  - "[[dev-environment]]"
last-reviewed: 2026-10-29
---

# Guards with a threshold

cire/invites' SSR Worker bundle once reached 470 KB gzip with nobody
noticing, from two mistakes: a whole animation library reachable from the
server module graph though nothing there ran it, and drift-guard tests routed
as live pages because they sat un-prefixed under `src/pages`. Both mistakes can
happen in any of the repo's six Astro apps, and both are checked on every one
of them.

Two separate scripts, because the two mistakes are different shapes.

A third guard on this page measures nothing to do with bundles. `scripts/guard-d1-migration-cost.ts`
gates what a from-zero D1 rebuild spends against a free-tier quota, and it is
here because it obeys the same two rules and was built from this page. The page
name still says bundles because the file has not moved.

A fourth guard, `scripts/guard-lint-warnings.sh` (englishstreetventures/osn#1008), gates how
many warning-severity `oxlint` diagnostics the whole monorepo may carry —
again nothing to do with bundles, again built from this page's two rules.

## Two rules for any guard with a threshold

These are not about bundles. They apply to any guard with a threshold in it —
a size budget, a query-count cap, a timing ceiling — and both were learned here
by getting them wrong first.

**The number lives in one committed file the guard reads.** Never as an
argument at each call site. `scripts/bundle-size-budgets.txt` is the worked
example, and what it replaced was the same threshold typed into six
`package.json` build scripts, one `ci.yml` step and eight deploy-job steps —
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
have seen it fire.** Break the input and watch what it does: the non-zero exit,
for a guard that gates — the D1 migration-cost guard, the lint-warning ceiling,
and every refusal in the size guard — or the `::warning::` line, for the size
budget, which warns and never exits non-zero. A guard that only ever passes is
indistinguishable from one that cannot fire.

## `scripts/guard-bundle-size.sh` — the size guard

```
scripts/guard-bundle-size.sh <package-dir>   # one app, e.g. from a build script
scripts/guard-bundle-size.sh --all           # every app, what ci.yml calls
```

**Going over a budget is a warning, not a failure.** The guard prints
`::warning::<app> <dir> gzip total <n> bytes exceeds the <budget> byte guard`
and exits 0, so the line shows in a local build's output and GitHub annotates
the CI or deploy run with it, but nothing goes red. Everything else it refuses
fails with a non-zero exit, which fails the `ci` gate on a pull request and
stops a deploy or release:

- **a source map where the app is served publicly**, in either form — a
  `*.map` file (any case), or a `.js`, `.mjs` or `.css` file carrying an inline
  `sourceMappingURL=data:` map. For a `static` app that is anywhere under
  `dist`, which Pages serves whole; for cire/invites it is `dist/client`, its
  Static Assets (maps under `dist/server` are uploaded for symbolication, never
  served). Either form publishes the app's unminified source. This runs before
  anything is measured, so no budget can hide it. A file is read through a
  symlink, since a link is served as what it points at, and one that cannot be
  read is refused;
- a measured directory that is missing, empty or holds a symlink;
- in `worker` mode, a Worker whose modules and source maps together gzip past
  Workers Free's 3 MiB (3,145,728 bytes) limit on a Worker's compressed size.
  Both uploads of cire-invites send the maps beside the modules (Wrangler's
  `upload_source_maps` on production, the cire stack's staged upload on dev),
  and no Cloudflare source says whether the limit counts them — Wrangler's own
  size report leaves them out — so the guard counts them, as each stack's K10
  test does for the bundled API Workers ([[free-tier-limits]]);
- `bun` missing in `worker` mode;
- a budgets file that is absent, empty or malformed, or has no row for the app.

A warning is acted on the way a failure would be: find what is newly reachable
from an import that runs in the build, or, if the growth is intended,
re-baseline the row as below.

*Checked 2026-10-20 — `bunx --bun astro build` in each of the five static apps
and `npx astro build` in cire/invites, then `scripts/guard-bundle-size.sh
--all`: no app's public output holds a `.map` file or an inline map, and the
guard passes all six. The same builds with `vite.build.sourcemap` set — to
`"inline"` and to `true` in musubi/landing, and to `"inline"` in cire/invites,
which puts maps in 30 of its client scripts — are each refused. Google
Fonts could not be fetched there, so font files were missing; the check reads
only scripts, stylesheets and `.map` names, so that does not change it.*

Mode and threshold are not arguments — **`scripts/bundle-size-budgets.txt` is
the single source of truth**, and this page's table below is a mirror of it
for a human reading the wiki. If the two ever disagree, the `.txt` file is
right and this page is stale; re-read it rather than trusting the table below.
That split used to not exist: the threshold was a third command-line argument,
copied by hand into six `package.json` build scripts, one `ci.yml` step and
eight deploy-job steps — fifteen copies of the same number, silently
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
  `dist/server` file by file, since `no_bundle: true` ships each chunk as its
  own module. It counts every file except the adapter's top-level
  `wrangler.json` and real source maps, which is more than wrangler uploads
  (only files its module rules match), never less. A `*.map` is left out only
  when the chunk it is named after sits beside it and it parses as a source
  map (a JSON object with a numeric `version`, a `sources` array and a
  `mappings` string); any other file named `*.map` is measured, so a name
  alone cannot hide bytes. The real source maps are summed apart and printed
  on a line of their own (`<app> dist/server source maps: <n> bytes gzip
  across <m> files`), for the 3 MiB check above. That check runs through `bun`, which every caller
  already has. Both modes refuse a symlink in the directory they measure,
  since wrangler and Pages ship the file a link points at and `find -type f`
  would skip it. It separately refuses a source map under the sibling
  `dist/client`, which is served publicly as Static Assets: a `*.map` file or an
  inline `sourceMappingURL=data:` map. See [[cire-development]] for why
  cire/invites' bundle is shaped the way it is (sessions off, SSR-only
  minification, server-only source maps, why `zod` stays).
  It never sizes `dist/client`, the scripts a guest's browser downloads.
  Lazy-loading an island or splitting a client chunk leaves this number where
  it was, except for what the change also takes out of the server build, so a
  client-side saving is not room under this budget. Measure it from
  `dist/client/_astro` and report it as that.
- **`static`** — `cire/host`, `cire/landing`, `cire/vendor`, `musubi/landing`,
  `pulse/landing`. All five are `output: "static"`: no Worker, no `dist/server`,
  no `dist/client` split — they deploy `dist` wholesale to Cloudflare Pages.
  Measures `dist/_astro/*.js` and `dist/_astro/*.css` **only** — an allowlist,
  not a directory sum, because `dist/_astro/fonts/` holds Google Fonts binaries
  fetched at build time (hashed names, moves whenever Google's metadata moves,
  not a repo change) and `dist` holds one HTML file per page (grows with
  ordinary content). Neither belongs in a guard whose job is catching a library
  that shouldn't have shipped. It separately refuses a source map anywhere
  under `dist`, in either form, because Pages serves all of it.

> [!warning] Known blind spot: inline `<style>`/`<script>` in the HTML
> `build.inlineStylesheets: "auto"` is Astro's default and is unset in all
> five static apps, which writes some generated CSS/JS inline into each
> page's HTML instead of into `dist/_astro`. `static` mode's allowlist cannot
> see bytes that never land in the directory it reads. Measured on
> musubi/landing: 5 inline style blocks + 4 inline script blocks in
> `dist/index.html` alone, about 3116 bytes gzip-equivalent — real budget the
> guard cannot see. There are two ways to close this (parse the HTML too, or
> force `inlineStylesheets: "never"` so everything lands in `dist/_astro`
> where the guard already looks); this is a product decision, not something
> fixed in this script.
>
> *Unverified — no command on record. Written into this page 2026-09-07;
> recount the inline `<style>`/`<script>` blocks in
> `musubi/landing/dist/index.html` before acting on the 3116.*

### Where it runs, and why twice

Every app's own `build` script chains the guard on with `&&` (`astro build &&
… guard-bundle-size.sh .`) — that is what runs it on a local build and the
by-hand cire/invites deploy. It ALSO runs as its own step in `ci.yml`'s
`build-test` job (one `--all` step covering every app), in `production-release.yml`
in the `deploy-cire-invites` job and in the `sites` job (one step per site it builds:
`cire/host`, `cire/vendor`, `cire/landing` and `musubi/landing`), and in the
stack jobs in `deploy.yml`, with one step per guarded app each builds: the cire
stack job for `cire/invites`, `cire/host`, `cire/vendor` and `cire/landing`, the
musubi stack job for `musubi/landing`, and the pulse stack job for
`pulse/landing`. `scripts/tests/deploy-workflows.test.ts` holds each stack job to
its list. That is not
redundant: a Turborepo cache replay of `build` replays its logged output
without executing the script, so the chained invocation never runs on a cache
hit — the explicit workflow step is what still checks the artifact that IS on
disk in that case. Both invocations matter; neither one alone covers both paths.

No workflow deploys `musubi/landing` or `pulse/landing` to production; on dev,
the musubi and pulse stack jobs build and guard them as above.

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
the guard's warning regardless of how large or small the app's own baseline is:

| App | Mode | Measured | Threshold |
|---|---|---:|---:|
| cire/invites | worker | 190660 B | 200900 B *(re-baselined, englishstreetventures/osn#1765 — see below)* |
| cire/host | static | 337953 B | 349653 B *(re-baselined, englishstreetventures/osn#1803 — see below)* |
| cire/vendor | static | 77305 B | 81644 B |
| cire/landing | static | 40725 B | 52425 B *(re-baselined down when `three` left; see below)* |
| musubi/landing | static | 15206 B | 26865 B |
| pulse/landing | static | 16683 B | 28366 B |

*Measured 2026-09-06 — clean `bun run build` at the worktree root with no
`PUBLIC_*` vars set, then `scripts/guard-bundle-size.sh --all`, which prints
each app's gzip total. Each row now mirrors its `# measured` comment in
`scripts/bundle-size-budgets.txt`, which moves with the threshold: the raises
below carry their own measurements, and cire/vendor's and cire/landing's moved
with the changes that file's comment names. That file is still the one the
guard reads; this table only mirrors it.*

`cire/landing` carries no animation or 3D library: its hero seal is CSS and
its motion is CSS transitions. Its threshold follows the build down whenever a
dependency leaves the package, so the headroom stays smaller than the mistake
the guard exists to catch rather than banking the gap.

*Measured 2026-10-29 — `bun run --cwd cire/landing build`, which ends with
`guard-bundle-size.sh .` printing `cire/landing dist/_astro gzip total: 40725
bytes across 6 files`.*

### `cire/host` went **up** on a change that made the first load smaller

Worth recording, because it is the one way this guard's number can move in the
opposite direction to the thing anyone cares about. The guard sums gzip across
every file in `dist/_astro`, so **splitting a chunk cannot reduce it and usually
raises it**: each chunk is compressed on its own, losing the shared dictionary,
and carries its own boilerplate.

`englishstreetventures/osn#1026` made a locked module unreachable rather than merely
upsold, and took the vendors module's three panels out of the first load on the
same argument the registry was already split on. Measured both ways, clean, one
build at a time:

| Vendors panels | `dist/_astro` gzip total | Files |
|---|---:|---:|
| eager (before) | 222524 B | 39 |
| three chunks (after) | 226917 B | 45 |

**+4393 B shipped, ~10.7 KB off the first load** — `VendorsView` 3676 B,
`DirectoryBrowseView` 4121 B and `EnquiriesView` 2961 B left `OrganiserApp`'s
chunk. Overview is the page every organiser lands on and most never open
vendors at all, so the trade is worth taking, but the guard cannot see it: it is
a total-bytes guard, and this was a first-load change.

*Measured 2026-09-14 — `rm -rf cire/host/dist && bun run --cwd cire/host build`
on `feat/locked-module-nav`, reading the total the guard itself prints; the
eager figure from the same build with the three `lazy()` calls replaced by
static imports.*

Headroom stays ~11.7 KB, so the guard is no less sensitive than before. A later raise, for englishstreetventures/osn#1086, measured the portal at
**237946 B** on `main` — the `# measured` comment in the budgets file had fallen
behind at 231255 — and at **240953 B** with fifteen `lucide-solid` icons and
Overview's own SVG in the module and command-palette rows, **+3007 B** across
the same 50 files.

*Measured 2026-09-23 — `rm -rf cire/host/dist && bun run --cwd cire/host build`,
before and after, on `chore/module-icons`, reading the total the guard prints.*

The plus-one controls (englishstreetventures/osn#1238) raised it again. By then the
portal had grown to **252496 B** against the 252653 B threshold, 157 B of
headroom, and the Households tab's switches, household buttons, removal dialog
and `plus-one-permission.ts` came to **256259 B**, **+3763 B**. Built on
Kobalte's switch the same change measured 257162 B, which is why `@shared/ui`'s
`Switch` is a native checkbox.

*Measured 2026-09-27 — `rm -rf cire/host/dist && bun run --cwd cire/host build`
on `feat/cire-plus-one-host-ui`, and the same build with `GuestTable.tsx` and
`ModuleShell.tsx` taken from its parent `feat/cire-plus-one-api`, reading the
total the guard prints.*

Equal wedding owners and the wedding soft delete (englishstreetventures/osn#1304)
raised it again. `main` measured **265496 B** against the 267959 B threshold,
2463 B of headroom. The owner rows and step-down in the hosts panel, the
delete dialog in Settings and the "Recently deleted" list with Restore came to
**268459 B**, **+2963 B**, with no new dependency.

*Measured 2026-10-01 — `rm -rf cire/host/dist && bunx --bun astro build` in
`cire/host`, then `scripts/guard-bundle-size.sh .`, on
`claude/trusting-dijkstra-1eji1a` and on `origin/main`, reading the total the
guard prints.*

The seating chart (englishstreetventures/osn#479) raised it again, on the same
trade as the vendors split. `main` measured **279974 B** across 54 files, 185 B
under the 280159 B threshold. With the Seating module, loaded on demand like the
registry, it came to **288927 B** across 61 files: **+8953 B**. Loading it
eagerly instead put `OrganiserApp`'s chunk at **79585 B** against **63737 B**
on demand: Seating is a Gold module, and its view, the sortable package's drop
zones and the menu it shares with other on-demand panels would otherwise land on
every organiser's first load, about 15.8 KB of it. The threshold moved to
measured + ~11.7 KB, **300627 B**. No dependency was added.

*Measured 2026-10-21 — `bun run --cwd cire/host build`, which ends with
`../../scripts/guard-bundle-size.sh .`, on `feat/cire-seating` rebased onto
`main` 0619a7dfd and on a clean checkout of 0619a7dfd. The chunk sizes are from
2026-10-20, on the branch before that rebase, with `ModuleShell`'s `lazy()` for
`SeatingView` replaced by a static import; `gzip -c <chunk> | wc -c`.*

The run sheet (englishstreetventures/osn#1396) raised it again. `main` measured
**303580 B** across 61 files, already 2953 B over the 300627 B threshold. The
run sheet view, the run-time editor on each checklist row, their stores and the
schedule change's linked-task choice came to **319202 B** across 69 files:
**+15622 B**, no dependency added. The view loads on demand, like the seating
chart: eager, the total was 315844 B across 63 files and `OrganiserApp`'s chunk
86191 B; on demand the chunk is 75505 B and the view's own 4647 B. Most of the
chunk's drop moved into chunks the first load still fetches — what the view
shares with the checklist, such as the holders' faces and their tooltip — so
the first load fell by **1380 B** (173833 B to 172453 B, `OrganiserApp` and
every chunk it imports statically). The threshold moved to measured + ~11.7 KB,
**330902 B**.

*Measured 2026-10-21 — `rm -rf cire/host/dist && bunx --bun astro build` in
`cire/host`, then `scripts/guard-bundle-size.sh .`, on
`feat/cire-run-sheet-view` and on a checkout of `origin/main` da80019c; the
eager figures from the same build with `RunSheetView`'s two `lazy()` imports
replaced by static ones. Chunk sizes `gzip -nc <chunk> | wc -c`; the first load
sums that over `OrganiserApp`'s chunk and every chunk it imports statically.
fonts.google.com was refused in that session, so every build, `main`'s
included, carried no font files; the guard reads only `dist/_astro/*.js` and
`*.css`.*

The Guests stuck stack and design pass (englishstreetventures/osn#1803) raised it
again. `main` measured **323615 B** across 69 files, still under the 330902 B
threshold but 4413 B past the 319202 B it was set from. The view bar every
module with sub-tabs draws, the stuck layers on the three Guests tabs, their
narrow layouts, the status marks, the event and reply chips, the icon-only
controls and their one tooltip panel, the household list's one "⋯" menu, the
editor's one popover and the RSVP reply key came to **337953 B** across 70
files: **+14338 B**, no dependency added. The eager graph reaches the same
Kobalte modules as `main` (dialog, menu, popover, popper, tooltip); the growth
is the views' own code, about thirty `lucide-solid` icons and the stylesheet.
The views stay eager, as on `main`, so the first load grew with them:
`OrganiserApp`'s chunk 76927 B to **85990 B**, the first load 153896 B to
**165420 B**. The threshold moved to measured + ~11.7 KB, **349653 B**.

*Measured 2026-10-28 — `rm -rf cire/host/dist && bun run --cwd cire/host build`
on `feat/cire-host-guests-sticky-stack` rebased onto `origin/main` 5f42aafa1 and
on a fresh checkout of 5f42aafa1, reading the total the guard prints. Chunk and first-load sizes are
gzip level 9 with no timestamp, summed over `OrganiserApp`'s chunk and every
chunk it imports statically; the Kobalte modules read from the `use…Context`
names in that set of files.*

### `cire/invites` re-baselined after the zod override

The zod security override (englishstreetventures/osn#1744) grew the guest Worker
from **176733 B** to **190660 B**, past the 188433 B threshold. The threshold
moved to measured + 10240 B, **200900 B**, about 10 KB of headroom, by owner
decision on englishstreetventures/osn#1765. That headroom is below the 21261 B
cost of a motion-class library, so one such mistake still trips the warning.

*Measured 2026-10-26 — `rm -rf cire/invites/dist && bun run --cwd cire/invites
build` on `origin/main` at `9eeced131`, then
`scripts/guard-bundle-size.sh cire/invites`.*

### `cire/invites` went up for the household member step

The household member step (englishstreetventures/osn#1325) — "Who are you?" in the
claim panel, the member-bound account-link box, "Answered by" in the RSVP
sheet, and `household-member.ts` — took the guest Worker from **174402 B** on
`main`'s source to **176733 B**, **+2331 B** across the same 38 files, past the
175000 B threshold, which had 598 B of headroom left. The threshold moved to
measured + ~11.7 KB, **188433 B**. No dependency was added; the bytes are the
feature's own code.

*Measured 2026-10-01 — `rm -rf cire/invites/dist && bun run --cwd cire/invites
build` on `feat/cire-household-member`, and the same build with
`cire/invites/src` and `shared/rp-auth/src` taken from `origin/main`, reading
the total the guard prints.*

The threshold is in `scripts/`, which `.github/CODEOWNERS` puts under a human owner
— a raise like this one is reviewed rather than waved through, which is the
right place for the judgement about whether the trade was worth it.

**Re-baselining** after an intentional change: build (clean, alone — two builds
running at once in one checkout interleave their chunks and the guard then
reads a number that is not real), read the printed total, and edit **only**
`scripts/bundle-size-budgets.txt`'s row for that app, to that total plus
~11.7 KB. Nothing else names a threshold — not the app's `package.json`, not
`ci.yml`, `deploy.yml` or `production-release.yml` — so there is nowhere else to update. Mirror the new
number into the table above so this page stays honest.

## `scripts/check-astro-test-routes.ts` — the `src/pages` check

Astro routes every file under `src/pages` into a live page, except one whose
name — or an ancestor directory's name, anywhere between `src/pages` and the
file — starts with `_`. A `*.test.ts`/`*.spec.ts` left un-prefixed there is
therefore built and deployed as a real route, which is exactly how
cire/invites picked up 119 KB gzip of vitest. This check walks all six apps'
`src/pages` looking for that shape.

A name fails when it contains `.test.` or `.spec.`, or the word `fixture` in
any case (`fixtures.ts`, `invite.fixture.ts`, `InviteFixture.ts`), and has no
`_` prefix on it or an ancestor. Directory names are checked the same way,
because every file under an un-prefixed `fixtures/` is routed whatever it is
called; a failing directory is reported once. A real page whose name holds
the word — a sports `fixtures.astro`, say — has to be renamed, since a `_`
prefix would take it off the site. Any un-prefixed symlink fails too, because
Astro follows it and routes whatever it points at.

A `_` prefix satisfies this check alone. The next step in the same job,
[check-tests-outside-src.ts](../../scripts/check-tests-outside-src.ts), refuses
any test or spec file and any symlink under a workspace's `src/`, prefixed or
not ([[testing-patterns#Directory Layout]]). So this check's message sends a
test or spec file to the package's `tests/` and asks for a symlink to be
replaced; only a fixture or a matching directory is told it may take the prefix.

It needs no build and no per-app baseline — a plain directory walk — so it runs
in the fast `lint` job in `ci.yml`, not `build-test`.

## `scripts/guard-d1-migration-cost.ts` — the D1 rebuild-cost guard

Same shape, different number: what a **job** spends against a **quota**, rather
than how big an artefact is.

The cire dev deploy crossed a hard ceiling by growing. Every
`ALTER TABLE ... DROP COLUMN` added to the migration chain made each from-zero
rebuild a little dearer, and on 2026-09-09 thirteen merges spent 104,091 D1 rows
written against a free-tier limit of 100,000 a day account-wide
(englishstreetventures/osn#979). No commit was wrong; no version of the job failed a test.
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
57-file chain squashed by englishstreetventures/osn#984 measures 269 schema writes here, and
its rebuild cost **8,007 D1 rows written** in total — but that total covers
drop, replay *and* seed, so it bounds the chain only once the seed is taken off,
and the seed's cost is the part not known precisely.
<!-- 8,007 is unverified here: taken from [[free-tier-limits]] and the englishstreetventures/osn#979 investigation, not re-derived -->

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
| `cire/db/migrations` | **96** | **192** | 2,592 → 5,184 rows | ~38 now, ~19 at the line |

*Measured 2026-10-02 — `bun run scripts/guard-d1-migration-cost.ts --all`.*

The left two columns are exact; the right two move with the constant. The
chain is one baseline file, one `CREATE` per table and per index, and the line
is its doubling. For scale, the archived chain it replaces —
`cire/db/migrations-archive`, all 81 files — replays at 351 schema writes,
about 9,477 rows, roughly 10 replays a day.

*Measured 2026-10-02 — `bun -e 'import { measureChain } from "./scripts/guard-d1-migration-cost.ts"; console.log(measureChain("cire/db/migrations-archive"))'`.*

To see the guard fail, lower the row in the budgets file below 2,592 and run
it. When the chain reaches the line, squash it into a fresh baseline again —
`cire/db/README.md` has the method — rather than raise the line.

**Note the arithmetic on the first 57 archived files does not reproduce 8,007.** At 27
it prices at 7,265 and the seed floor is 2,063, which sums past the reported
total — which is another way of saying the true constant is nearer the bottom
of the band than the top, and that the guard is deliberately charging more than
a rebuild probably costs.

### Why the headroom is a doubling, not a hair

The rule further up this page — headroom smaller than the smallest mistake —
assumes a baseline that is not supposed to move. A migration chain is supposed
to grow, and the mistake here is not one bad migration: nothing in the chain
that went over the ceiling was wrong. So the line is drawn at a **doubling** of
the squashed baseline, 96 schema writes — which is the smallest step that
materially changes the answer to "how many rebuilds a day can we afford".
A budget tight enough to trip on one ordinary feature migration —
`0057_registry` was 15 schema writes on its own, `0058_gift_summary_and_stripe_state`
12 — would be raised on sight every few pull requests, which is the failure the
second rule names. The doubling is in the exact unit, so it holds wherever in
the 22–27 band the constant really sits.

The other half of that: **this guard has a remedy the bundle guards do not.**
Squashing the chain into a fresh baseline puts the number back down instead of
moving the line up: the archived chain's 351 schema writes rebuild as a
96-write baseline. Reach for that before raising the budget.

### Where it runs

One step in `ci.yml`'s `script-tests` job. That job does no `bun install` on
purpose, and the script imports `bun:sqlite` and Node built-ins and nothing
else, so it belongs there rather than in `build-test`. Its own tests
(`scripts/tests/guard-d1-migration-cost.test.ts` for the measurement,
`.cli.test.ts` for exit codes and messages) run in the same job under
`bun run test:scripts`, and one of them re-asserts the committed budget against
the committed chain — so a migration that busts it fails the tests as well as
the guard step.

## `scripts/guard-lint-warnings.sh` — the lint-warning-count guard

Same shape again, a fourth time: `oxlintrc.json`'s categories put every
non-`correctness` finding at `warn`, so `bun run lint` exits 0 whatever the
warning count is — the CI step at `ci.yml`'s `lint` job proved only that no
error-level rule fired. Over one recent epic the count drifted 1020 → 1035 →
1037 → 1061 with no CI step noticing, and the only way to know was to read
the number by hand on every branch (englishstreetventures/osn#1008). Some of the rules
sitting at `warn` are repo-specific and exist because the mistake they catch
actually happened — `house/no-tracker-ref-in-comment`,
`house/no-non-subscribing-store-read` — and with nothing enforcing the total
they are advisory notes nobody reads.

```
scripts/guard-lint-warnings.sh                  # push to main: count <= ceiling
scripts/guard-lint-warnings.sh --base HEAD^1    # pull request: also no more than the base
scripts/guard-lint-warnings.sh --count          # release.yml: print the count
scripts/guard-lint-warnings.sh --lower-to <n>   # release.yml: lower the ceiling to <n>
```

**The ceiling** lives in `scripts/lint-warning-ceiling.txt` — one integer,
alone on the first non-comment line; nothing else names it. A count above it
fails. A count below it passes and the file is left alone: a branch that
removes warnings never edits it, so two such branches merge in either order
with no conflict on that line. `release.yml` lowers the number on `main`
after the merge.

### Two checks, so the ceiling can lag without letting anything in

| Check | Runs | Fails when |
|---|---|---|
| Absolute | every run | the count is above the ceiling |
| Against the base, `--base <rev>` | pull-request CI, with `HEAD^1` | the tree has more warnings than `<rev>`, beyond any raise of the ceiling the branch makes |

The absolute check alone would leave slack. Between a merge that removes
warnings and the release commit that lowers the file, the ceiling sits above
`main`'s count, and a branch whose CI ran in that gap could add warnings up
to the difference. `main`'s required checks are not strict, so a green check
from that gap stays green. The check against the base closes the gap: CI
tests the merge commit, and `HEAD^1` is the `main` it was merged with, so
every branch is held to "no more warnings than the `main` it lands on". That
is this page's second rule for this guard: zero headroom, measured against
the base rather than against a file. A stale green check stays valid as well,
because a branch's effect on the count adds onto whatever `main` holds later.

The base is measured with its own toolchain. The guard writes the base
commit's tree out through a temporary index (the working tree, the real index
and the worktree list are untouched), runs `bun install --frozen-lockfile
--ignore-scripts` there, and lints it with that tree's own oxlint, plugins and
`oxlintrc.json`. A branch that bumps oxlint or a lint plugin is therefore
compared old tools against new, and warnings the bump adds count as warnings
the branch adds. A failure names the rules that rose against the base and the
one ceiling value that would pass.

*Measured 2026-10-15 — `bash scripts/guard-lint-warnings.sh --base HEAD` on a
warm local bun cache: 879 against 879 in 15.6 s, where the plain
`bash scripts/guard-lint-warnings.sh` takes 3 s.*

### How the ceiling moves

- **Down, on `main` only.** On each merge, `release.yml`'s `lint-count` job
  counts the warnings (`--count`) with a read-only token, no stored
  credentials and no install scripts, so oxlint and its plugins never run
  inside the `release` job, which holds `RELEASE_TOKEN`. That job checks the
  count is a plain number of at most nine digits, runs `--lower-to <count>`,
  and `scripts/release-commit.sh` commits the new value line in the same
  commit as the version bumps — `chore: version packages, lower the
  lint-warning ceiling`, or `chore: lower the lint-warning ceiling` when the
  merge carried no changeset. `--lower-to` never raises the number and leaves
  the file untouched when it already matches, so a re-run makes no empty
  commit. `lint-count` skips the bot's own commits, which never change the
  count. The split does not stop code in `lint-count` reaching `main`'s
  dependency cache — on a hosted runner any step can reach the runner's own
  token — so the `release` job restores no cache and installs from the
  registry against `bun.lock`.
- **Up, in a pull request, on purpose.** When a branch adds warnings it means
  to keep, the failing guard names one number: set the value line to it and
  put the branch and date in the line's trailing comment. Two raises open at
  once then conflict as text instead of merging to one number. A raise open
  while the bot lowers the line conflicts too; after the rebase, run the guard
  again and take the number it names.
- **Never down in a pull request.** Lowering by hand puts every such branch
  back on the one line that conflicts.

Before pushing, run the check CI runs:

```bash
bash scripts/guard-lint-warnings.sh --base "$(git merge-base origin/main HEAD)"
```

**If the file and this page ever disagree, the file is right** — the same rule
the bundle table above states for itself.

### Counting method

oxlint's human-readable output (what `bun run lint` prints) has no summary
line in the version this repo pins — a clean run ends on the last diagnostic,
nothing after it. `bun run lint`'s own line count is not safe to use as a
proxy either: `bun run <script>` prints its own `$ oxlint -c oxlintrc.json .`
echo line, on **stderr**, so `wc -l` over it counts the diagnostics when the
streams are separate and one more than that whenever anything merges them
(`2>&1`, a CI log, a terminal). A line count that changes with redirection is
not a measurement.

The guard instead runs oxlint directly (bypassing the package.json script
and its echo line) with `--format=json`, which gives one object per
diagnostic with an explicit `"severity": "warning" | "error"` field stamped
by oxlint itself. Filtering on that field is exact regardless of message
wording, file paths, or how the human-readable format is laid out — unlike
`grep -c " warning "`, which the field also protects against a rule's own
message text or a file path containing that word. `scripts/lint-warning-count.ts`
does the counting and the per-rule breakdown; `scripts/guard-lint-warnings.sh`
owns running the real oxlint, reading the ceiling file, and the pass/fail
decision.

*Measured 2026-09-11 — `bun run lint | tail` ends on the last diagnostic line
with nothing after it, and `bun run lint | grep -c "Found \|Finished in "`
returns 0: this pinned oxlint prints no summary line to grep for at all. The
JSON count and the human-readable line count were cross-checked against each
other, not just asserted: `oxlint -c oxlintrc.json . --format=json` filtered
to `severity: "warning"` reports 1061, `bun run lint 2>/dev/null | wc -l`
reports the same 1061, and `bun run lint 2>&1 | wc -l` reports 1062 — the
diagnostic count plus the one `$ oxlint ...` echo line `bun run` writes to
stderr.*

### Where it runs

Its own step in `ci.yml`'s `lint` job, after the existing `bun run lint`
step and before `Format check` — deliberately separate from that step so "a
rule errored" (Lint fails) and "the warning count moved" (this guard fails)
read as two different failures rather than one step failing for either
reason. On a pull request the step runs `--base HEAD^1`, which is why the job
checks out with `fetch-depth: 2`: the merge commit arrives with both parents.
On a push to `main` it runs the absolute check alone. `release.yml` runs
`--count` and `--lower-to` as above.

Three test files, for the three things that can go wrong independently:

- `scripts/tests/lint-warning-count.test.ts` (+ `.cli.test.ts`) — pure
  counting logic, run in `script-tests` like everything else under
  `scripts/tests/` (no `bun install`, since counting from a fixture JSON
  report needs no oxlint invocation at all).
- `scripts/tests/guard-lint-warnings.test.sh` — the shell script end to end,
  against small fixture projects and git repositories with their own
  `oxlintrc.json`, but run with the REAL oxlint binary from this checkout's
  `node_modules` (`LINT_WARNING_OXLINT_BIN`). It covers every mode: two
  branches that each remove a warning merging in either order, a branch that
  adds one, the lagging-ceiling case the absolute check alone lets through,
  the first parent of a real merge commit, a branch that turns a rule on, and
  a base installed from its own lockfile and linted with its own oxlint. That
  real binary, and the cases that install oxlint into a fixture, are why it
  runs as its own step in the `lint` job, after `bun install` —
  `script-tests` does none, on purpose (see that job's own comment in
  `ci.yml`). Those installs can reach the registry, so on a pull request the
  step runs the suite only when the guard, the counter, the test,
  `package.json`, `bun.lock` or `.bun-version` changed; it runs on every push
  to `main`.
- `scripts/tests/release-commit.test.sh` — the release job's commit step,
  `scripts/release-commit.sh`, in throwaway repositories with a bare remote:
  what it stages, which message it picks, that it commits nothing when
  nothing it owns changed, and that a push behind the remote fails. It needs
  only git, so it runs in `script-tests`. The job wiring around it —
  `lint-count`'s skip, `needs` and the count it hands over — runs only on
  `main`.

> [!warning] What the two checks do not catch
> - **Branches that interact.** Each branch is measured against its own
>   base. Two branches that are each fine alone can still raise the count
>   together, through a rule that reads more than one file. `main`'s own CI
>   then fails the absolute check, and while `main` is over its ceiling every
>   pull request fails it too, until one removes the warnings or raises the
>   ceiling.
> - **A ceiling that stays high.** The file sits above `main`'s count until a
>   Release run lowers it. A run that loses a push race (`! [rejected] main ->
>   main (fetch first)`) or fails at `bun run version` lowers nothing; the
>   next run measures again and catches up. Pull requests are held against
>   their base meanwhile, so the lag loosens only the absolute check on
>   `main`. The release job starts only after `lint-count` finishes,
>   which lengthens the time in which it can lose that race; a lost race
>   delays the version bump and the lowering to the next run, and loses
>   neither.
> - **A stacked branch** is measured against its parent branch, whose
>   vendored anti-slop tree this job does not verify; the parent's own CI
>   did, and the job holds a read-only token.

## Related

- [[free-tier-limits]] — the D1 ceilings this guard is measured against
- [[dev-environment]] — what the nightly cire dev rebuild does and costs
- [[cire-development]] — why cire/invites' bundle is shaped the way it is
  (sessions off, SSR minification, why `zod` stays)
- [[frontend-patterns]] — general Astro/Solid patterns
- [[review-findings]] — how the review findings these guards answer are
  tagged and filed
