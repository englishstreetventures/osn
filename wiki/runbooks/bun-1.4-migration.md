---
title: Bun 1.4 migration
description: What Bun 1.4 is worth using here, what was adopted, and what turned out to be impossible — everything deploys to workerd, so the surface is tooling.
tags: [runbook, bun, tooling, migration, ci]
severity: low
status: in-progress
related:
  - "[[monorepo-structure]]"
  - "[[dev-environment]]"
  - "[[devloop-urls]]"
  - "[[commands]]"
last-reviewed: 2026-08-21
---

# Bun 1.4 migration

The runtime bump landed on its own — the portless devloop (#745) needed
`process.execve` and pinned `1.4.0` on the way past. This page is what came of
going through the release notes afterwards: what was adopted, what was tried and
does not work, and what is left. Release notes: <https://bun.com/blog/bun-v1.4>.

Two recommendations written here before anyone ran them were wrong. Both are
kept below, marked, with what actually happened — a runbook that quietly edits
out its bad advice teaches nobody why it was bad.

## The constraint that shapes everything

Every deployed package runs on **workerd**, not Bun:

| Runtime | Packages |
| --- | --- |
| workerd (Workers) | `osn/api`, `pulse/api`, `zap/api`, `cire/api`, `cire/invites` |
| Pages / static build | `*/landing`, `pulse/web`, `cire/host`, `osn/social`, `cire/vendor` |
| Bun | scripts, seeds, `bun test` suites, `shared/dev-urls`, CI, local dev |

So none of Bun 1.4's headline runtime APIs — `Bun.serve` static routes, HTTP/3,
`Bun.Image` at request time, `Bun.cron` — can ship in app code. Cloudflare
already provides the equivalents (Images binding, Cron Triggers, its own
server). Bun is our package manager, script runtime, test runner for three
packages, and CI driver. **That is the whole adoption surface.** Anything
proposed outside it is wrong by construction.

The wins are real but they are tooling wins: faster installs, fewer bespoke
shell scripts, real parsers instead of greps. Nothing below can take production
down — the blast radius stops at a developer's machine or a CI runner.

---

## Done

### Phase 0 — bun-types onto the 1.4 runtime

`.bun-version` and `packageManager` moved to `1.4.0` with #745. `bun-types` did
not, and the reason is worth keeping: `^1.3.14` already permits 1.4.x, and **bun
does not re-resolve a range the lockfile already satisfies**. So the runtime
moved, the types stayed at 1.3.14, and nothing complained. Widening the caret
would have changed nothing; `bun update bun-types --latest` is what moves it.

That needed a `minimumReleaseAge` exception — 1.4.0 was published the same day,
inside the three-day window. An earlier draft of this page said to wait it out
rather than add an exclude. The exception was taken instead, on the grounds that
`bun-types` is the mildest possible case: types only, no runtime code,
devDependency, never bundled into a Worker. The entry in `bunfig.toml` carries
its own drop-trigger — **remove `bun-types` from `minimumReleaseAgeExcludes`
after 2026-08-23**, or it silently exempts every future release.

### Phase 1a — the two shell-outs onto `$`

`scripts/todo-to-issues/backfill-project.ts` and `cire/db/seed/assets.ts` both
hand-rolled what `$` does. Both now use it.

**The trap, which cost the most time here:** a `ShellError`'s `.message` is
exactly `"Failed with exit code 1"`. stderr is on `.stderr` and never reaches
the message. `backfill-project.ts` classifies failures by matching stderr
substrings — `alreadyOnBoard()`, `rateLimited()` — so letting `$` throw its own
error makes both return `false`: a "content already exists" stops being the
no-op it is and aborts the backfill, and a rate limit stops being a resumable
pause. Silent, and only visible on a run against a board that already has items.
The wrapper therefore uses `.nothrow()` and rebuilds the message, and two tests
pin the shape.

### Phase 3 (part) — `Bun.TOML` for the D1 guard

`scripts/check-d1-database-id.sh` was three greps, each matching a
`database_id` line. `scripts/check-d1-database-id.ts` parses instead, which
catches two shapes the greps could not:

- **A named environment with no `[[d1_databases]]` block at all.**
  `cire/api/wrangler.toml` records in its own comment that named environments do
  NOT inherit the top-level block. Delete it from `[env.production]` and every
  `database_id` in the file is still valid while production has no database. A
  grep for a line that is not there cannot fire.
- **A `database_id` that is neither placeholder nor empty but not an id** — a
  database *name* pasted into the wrong field satisfied all three greps.

The bash version advertised "grep only, no bun". That is traded away for the
real parse, and it costs nothing: both callers in `deploy.yml` run `bun install`
first.

### Two CI bugs found on the way

- **The tests under `scripts/` ran nowhere.** `scripts/` is not a workspace, so
  `turbo test` never reached it, and `test:migration` was declared in the root
  `package.json` and called by no workflow. Renamed `test:scripts`, and the
  Scripts job runs it — which matters more now the D1 guard's tests gate a
  deploy.
- **Both turbo caches were frozen.** They were keyed on `bun.lock`, and
  `actions/cache` will not overwrite an existing key. Each was written once and
  then never again: later runs restored that first snapshot, missed on
  everything changed since, and saved nothing back — a cache reporting a hit
  while being useless. Now keyed on the commit with a prefix restore-key, so they
  follow the branch. The Chromium cache stays on `bun.lock`, where the browser
  version really is a function of the lockfile and an exact hit has nothing new
  to write.

---

## Does not work — do not retry

### `Bun.Image` cannot replace the seed's PNG encoder

This page previously said `Bun.Image` would delete the ~80 lines of hand-rolled
PNG encoding in `cire/db/seed/assets.ts` (CRC32 table, IHDR/IDAT/IEND framing,
filter-0 scanlines). **It cannot.** `Bun.Image` only ever decodes an already
encoded image:

```
Image() input must be a path string, data: URL, ArrayBuffer, TypedArray or Blob
Image: unrecognised format (expected JPEG, PNG, WebP, GIF, BMP, TIFF, HEIC or AVIF)
```

There is no raw-pixel entry point — `fromRaw`, `fromPixels`, `create` and `from`
are all undefined, and unlike Sharp there is no `{ raw: { width, height,
channels } }` option. SVG is rejected too, both as bytes and as a data URL, so
generating an SVG and rasterising it is not a way round.

The seed *generates* its pixels from a gradient function. It has no encoded
bytes to hand `Bun.Image`, and producing them is precisely the job of the
encoder being replaced. The encoder stays.

What `Bun.Image` could still do here is transcode the encoder's PNG to WebP for
smaller objects. Not worth doing: eight placeholder images, written by hand once
per bucket, into a dev bucket. Size is not a problem anyone has.

This also leaves Phase 0's zlib-ng question open rather than closing it by
deleting the code. `deflateSync(raw, { level: 9 })` may emit different bytes
under zlib-ng, and the seed's docstring promises re-runs overwrite
"byte-for-byte". Nothing in CI would notice — the seed is manual.

### `Bun.JSONC` has nothing to check

An earlier draft paired the TOML guard with a JSONC one for
`cire/invites/wrangler.jsonc`. That file has no `d1_databases` and no
`database_id`: cire/invites has no D1 binding at all. There is no assertion to
make. Dropped.

---

## Still to do

### The dev-db guard is the better `Bun.TOML` target

`scripts/cire-dev-db-guard.sh` hand-rolls a TOML *block* parser in awk to pull
`[env.dev]`'s `database_name` and `database_id` out of the same
`cire/api/wrangler.toml`. It is the higher-stakes of the two by a distance: it
fronts an unattended `db:reset:dev` that drops every table, and its failure mode
is *passing*. Its own comments record that it has already failed open once, from
exactly the asymmetry a real parser removes — extraction stripped quotes while
the comparison expected them, so a single-quoted production id passed clean.

Parsing it properly deletes most of what the shell is doing. Do this before
converting it to `$`, or instead of it. It needs care and its 203 lines of bash
tests need porting, which is why it is not in the same change as the rest.

### `$` house rules

Write these into `[[commands]]` when the next script is converted:

- Interpolate **values**, never command fragments. `$` escapes an interpolated
  value so it stays one argument.
- **Escaping is not validation.** A value beginning with `-` is still read as a
  *flag* by the program being run, fully escaped. Validate the shape before it
  reaches `$` — a UUID regex for a `database_id`, `^@?[a-z0-9@/._-]+$` for a
  package name — and put `--` before the first interpolated positional where the
  command supports it. This matters for the scripts fed PR-author input:
  `changeset-required.sh` takes changed file paths, `validate-changesets.sh`
  parses package names out of frontmatter the author wrote.
- Non-zero exit throws. Use `.nothrow()` where a failure is an expected branch,
  then **branch on the specific exit code you expect** — `grep` returning 1 means
  "no match", but 2 or more means the grep itself broke. Treat anything else as
  fatal. `.nothrow()` on a whole pipeline while reading only stdout is how a
  guard fails open.
- A `ShellError`'s message does not contain stderr. If anything downstream reads
  the message, build it yourself (see `backfill-project.ts`).

### Scripts still on bash

12 remain under `scripts/`, plus `scripts/todo-to-issues/labels.sh` — 14 before
the D1 guard moved. The ones with real logic and bespoke `.test.sh` harnesses are
the candidates, because converting them folds 393 lines of hand-written bash
assertion into `bun test`:

| Script | Lines (+test) |
| --- | --- |
| `validate-changesets.sh` | 122 + 102 |
| `changeset-required.sh` | 68 + 88 |
| `cire-dev-db-guard.sh` | 120 + 203 |

`cire-db-reset.sh`, `cire-db-seed.sh`, `db-reset.sh`, `ensure-pages-project.sh`
and `labels.sh` are straight command sequences — shorter under `$`, but there is
no correctness argument for moving them.

Leave `scripts/setup.sh` as bash: it is the bootstrap and runs on a machine that
may have nothing.

**Not a `$` target: `shared/dev-urls/src/cli.ts`.** It shells out, so it looks
like one. It hands the process over with `process.execve` instead of supervising
a child, on purpose — the dev server inherits the pid, so portless and turbo
signal it directly and its exit status is the kernel's. `$` supervises.
Converting it would undo the thing the file exists to do. Its `spawn` fallback
(Windows, `DEV_ENV_NO_EXECVE=1`) forwards SIGINT/SIGTERM/SIGHUP by hand for the
same reason, and is not a candidate either.

### Package manager

- **Catalogs.** 34 workspace packages repeat versions of `typescript`, `vitest`,
  `effect`, `hono`, `drizzle-orm`. `bun add --catalog` plus `"catalog:"` puts the
  version in one place. Its own PR — it touches every `package.json`.
- **`bun dedupe --check`** as a CI gate. Run `bun dedupe` by hand first: the
  `bun-types` re-resolve alone pruned an orphaned `rollup` and its 26 platform
  binaries, which is evidence there is more.
- **`bun pm licenses --prod --json`** behind a short allowlist — `wiki/compliance/`
  has no automated licence check today.
- **`bun audit fix --dry-run`** to generate an override rather than hand-writing
  one. One caveat, because it is where the pressure lands: an advisory and its
  patch arrive together, so the proposed upgrade is often inside the
  `minimumReleaseAge` window. **A blocked `audit fix` is the gate working.** Wait
  it out, or pin a transitive override to an already-aged version; add a
  `minimumReleaseAgeExcludes` entry only for a confirmed-exploitable
  high/critical, with a drop-trigger inline, as `fast-uri` has.
- **`linker = "isolated"`** — the global virtual store, claimed 7x faster warm
  installs. `bun install` runs 4 times across `ci.yml` and 23 times across all
  workflows, 16 of them in `deploy.yml`, so the win is bigger than it looks and
  so is the downside: a resolution break there is a failed deploy, not a red PR.
  Isolated linking removes phantom hoisted dependencies, which is stricter and
  therefore what breaks. **Trial it on `build-test` specifically** — that is where
  the three fussy consumers live (vitest's browser provider, playwright, astro) —
  and via the `bun install --linker=isolated` CLI flag, since the `bunfig.toml`
  key is repo-wide and cannot be scoped to one job.

### Test runner

Three packages use `bun test` (`cire/theme`, `cire/db`, `cire/api`); 30 use
vitest, and `shared/typescript-config` has no tests. So this is narrow:

- **`jest.useFakeTimers()` / `setSystemTime()`** in `cire/api`, which is full of
  time-dependent behaviour — token expiry, the refresh-rotation grace window,
  rate-limit windows, the 04:00 sweep. Adopt where a clock seam already exists;
  do not invent new ones for it.
- **`bun test --changed`** on pre-push, beside the existing typecheck and audit.
- **`test({ retry: n })`** only where the flakiness is understood and written
  down. Retrying an unexplained failure hides it.
- **`--isolate`** if `cire/api` ever shows cross-file leakage. Not before.

Not now: `--shard` / `--timings` balance CI across machines, and CI is not
bun-test-bound — the test steps are `turbo test`, `test:d1` and `test:browser`,
and the four `d1-integration.test.ts` files are pinned serial anyway.

### `bun run --parallel`, narrowly

Turbo already schedules `build`, `test`, `check` and `lint`, and a second
scheduler there would fight the first. But two things run in sequence with no
scheduler at all, because they are not turbo tasks: `ci.yml` runs
`openapi:generate` for `pulse/api` and then `osn/api` back to back, and root
`db:reset` chains four `--cwd` invocations with `&&`. `openapi:generate` is also
one of the slow CI steps worth profiling. Either add it to `turbo.json` or run
the pair in parallel.

### `--no-env-file` for CI

An earlier draft of this page said four packages have "committed `.env` files".
**They do not.** `.gitignore` ignores `.env`, and the only tracked env files are
the `.env.example` set plus `pulse/web/.env.development` and
`pulse/web/.env.production` (public URLs, no secrets). So the risk runs one way,
not two: a test reading an env var can pass locally off a gitignored `.env` and
fail in CI, never the reverse, and no secret is exposed.

The recommendation survives in weaker form — declaring CI's environment
explicitly is still right — but `env = false` would change how `pulse/web`
builds, since its two tracked files are loaded by `NODE_ENV`. Check that before
flipping it.

### Profiling

`--cpu-prof-md` and `--heap-prof-md` write a Markdown report rather than a
`.cpuprofile`, so a profile can go straight into a PR. `BUN_CPU_PROFILE=1` does
the same without touching the command line, which is easier to set on a CI step.
Reach for these when a step is slow — `bun run build` and `openapi:generate` are
the candidates — not speculatively.

---

## Not adopting, and why

| Feature | Why not |
| --- | --- |
| `Bun.serve` static routes, HTTP/3 | Everything is served by Workers/Pages |
| `Bun.Image` at request time | `cire/api` uses the Cloudflare Images binding against R2 |
| `Bun.Image` in the seed | No raw-pixel or SVG input — see "Does not work" above |
| `Bun.JSONC` | The one config it was aimed at has nothing to assert |
| `Bun.cron` | Prod schedules are Workers Cron Triggers |
| `--react-compiler`, `Bun.markdown.react()` | No React dependency in the repo |
| `--compile`, `--asset`, bytecode | We ship Workers bundles, not binaries |
| `--no-orphans` | #745 solved the orphaned dev server with the `execve` pid handover; the fallback forwards signals by hand |
| `Bun.Archive`, `Bun.Terminal`, ANSI helpers | No use for them |
| `CompressionStream` / `DecompressionStream` | Web standard; workerd already has it |
| `bun prune --production` | Deploy bundling is wrangler's job |

---

## Order for what is left

1. **The dev-db guard onto `Bun.TOML`** — highest blast radius, and the parse
   deletes more than the `$` conversion would.
2. **Catalogs** — one wide, mechanical PR.
3. **The remaining script conversions**, one or two at a time.
4. **Package-manager gates** — dedupe, licences.
5. **`linker = "isolated"`** trial on `build-test`.
6. **Fake timers** in `cire/api` where a seam exists.
7. **Profiling**, when something is slow.

Catalogs and the script conversions both touch many files; don't run them
concurrently.
