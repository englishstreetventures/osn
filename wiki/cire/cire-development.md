---
title: Cire development guide
description: Cire's own build conventions — backend patterns, the test tiers, and the commands that differ from the platform defaults
tags: [app, weddings, cire, conventions, development]
status: active
packages:
  - "@cire/invites"
  - "@cire/host"
  - "@cire/vendor"
  - "@cire/api"
  - "@cire/db"
  - "@cire/build-tools"
related:
  - "[[cire]]"
  - "[[cire-auth]]"
  - "[[backend-patterns]]"
  - "[[frontend-patterns]]"
  - "[[testing-patterns]]"
  - "[[browser-tests]]"
  - "[[d1-read-replication]]"
  - "[[commands]]"
  - "[[bundle-size-guards]]"
  - "[[cire-registry]]"
last-reviewed: 2026-10-09
---

# Cire development guide

What is true of cire and not of the rest of the monorepo. Everything else — branch
strategy, changesets, commit signing, hooks, the issue workflow, the wiki rules —
comes from the root `AGENTS.md` and the platform pages, which are authoritative.

> **This page is the per-product pattern.** A product with enough of its own build
> conventions to be worth writing down gets `wiki/<product>/<product>-development.md`,
> and its overview page links to it. Cire is the only one so far; pulse, zap and
> social still fit inside the platform pages. Put a fact here only when it is
> genuinely cire-only — if it applies to any other Solid or Workers package, it
> belongs in [[frontend-patterns]], [[backend-patterns]] or [[testing-patterns]]
> instead, where the person who needs it will actually find it.

Start at [[cire]] for what cire *is*, and [[cire-auth]] for the two-system auth
contract every route sits behind.

## Backend — Elysia on Workers, Effect in the service layer

The platform shape is in [[backend-patterns]]. Cire's departures:

- **`createApp` uses `aot: false`.** Elysia's ahead-of-time compilation builds
  handlers with `new Function`, which Cloudflare Workers forbids. This is not a
  tuning knob — the Worker fails to boot without it.
- **POST routes pass a sentinel `parse` hook** (`{ parse: () => ({}) }`) and read
  `request.json()` by hand, so malformed JSON degrades to the schema's own 400
  rather than a framework parse error.
- **Routes live in `cire/api/src/routes/`**, one route factory per domain (claim,
  rsvp, organiser, import), composed by `createApp` in `src/app.ts`. Handlers
  delegate to `cire/api/src/services/` and hold no logic.
- **Services return `Effect.Effect<A, E>`**; route handlers unwrap with
  `runCire` / `runCireSync`, never bare `Effect.runPromise` — the wrappers install
  the redacting logger ([[cire-workerd]]).
- **Errors are tagged classes** extending `Data.TaggedError`. Nothing in the
  service layer throws.
- **Tell one constraint failure from another by `driverErrorText(e)`**
  (`cire/api/src/db/index.ts`), never `String(e)`. On D1, drizzle wraps a failed
  single statement in `DrizzleQueryError`, whose message names only the
  statement; the database's reason (`D1_ERROR: UNIQUE constraint failed: …`)
  sits on its `cause`. bun:sqlite and a failed `batch()` put it on the error
  itself, so a sniffer reading `String(e)` passes every route test and misses
  every conflict in production.
- **D1 access is Drizzle only** — no raw SQL string construction.
- **The Drizzle handle is built over the session-routing shim**, never over
  `env.DB` directly, and each Worker invocation opens exactly one D1 session at
  the entry point — see [[d1-read-replication]].
- **Effect is backend and DB only.** Never import it in `cire/invites`,
  `cire/host` or `cire/vendor`.
- **Cloudflare bindings are typed from `wrangler types`** output
  (`worker-configuration.d.ts`); regenerate after any schema or binding change.

### Middleware

Elysia plugins in `cire/api/src/middleware/`, all scoped `derive` + `onBeforeHandle`:

| File | Gate |
|---|---|
| `auth.ts` | `sessionAuth` — the guest claim-code cookie |
| `osn-auth.ts` | `osnAuth` — organiser JWT, via the shared Elysia adapter |
| `wedding-owner.ts` | any owner (the `manage` capability) — codes, settings, billing, the payout account, the CSV exports, adding, changing or removing any seat, delete. `weddingOwnerIncludingDeleted()` is the same check for the restore route alone, the only organiser route that reaches a soft-deleted wedding |
| `wedding-editor.ts` | owner or `editor` — module writes, the RSVP-by date, marking a household's code sent |
| `wedding-member.ts` | reads + invite preview — every role carrying the `member` capability (`editor`, `viewer`; **not** `helper`) |
| `wedding-run-sheet.ts` | the day-of run sheet — every role including `helper`. Standalone: mount it INSTEAD OF `wedding-member.ts`, never after it |
| `wedding-role.ts` | not a gate — the policy every role gate asks. Exhaustive over the role enum, so a new role fails `check` until decided |
| `rate-limit.ts`, `turnstile.ts` | abuse gates |

Pick the gate from the roles matrix in [[cire-auth]], not by guessing from the
route name. Never add a role check inside a route handler: the roles live in
`wedding-role.ts` so that adding one to the column is a compile error at every
place that decides, and a check written in a handler is invisible to that.

### Soft-deleted weddings

A wedding with `weddings.deleted_at` set must be unreachable from every guest,
vendor and co-host path. The four gates get this for free from
`hostsService.authorize()`. Anything else that starts from a slug, a claim
code, a guest session, a wedding id, or a row that belongs to a wedding — a
public route, a vendor route, a cron like the claim hand-off
(`claimReviewService.sweep`), a mail, a service fan-out — must carry the
predicate from `cire/api/src/db/live-wedding.ts` in the statement it already
runs:
`weddingIsLive` when the query reads `weddings`, `weddingIdIsLive(column)` when
it holds only an id (it renders the column through `outerColumn()`, so the
correlated `EXISTS` binds to the outer row). Answer a deleted wedding exactly as
an unknown one — never say it was deleted.

`tests/routes/soft-deleted-wedding.test.ts` walks every mounted route: a new
route outside `/api/organiser/weddings/:weddingId` fails it until it is listed
as reaching a wedding (and then must refuse a deleted one, with a live control)
or as not wedding-scoped, with a reason. It cannot see crons, webhooks or
service code; those need their own test against a deleted wedding. Stripe's
webhooks deliberately settle into a deleted wedding — see [[cire-auth]].

Mount new routes that need the widened app — the lifecycle and upgrade routes —
past the `AnyElysia` widening in `app.ts`: the organiser chain is at
TypeScript's instantiation-depth limit, and one more `.use()` there fails
`check` with TS2589.

### CSV exports

Every organiser CSV export (`createOrganiserExportRoutes` in
`cire/api/src/routes/organiser-weddings.ts`) is owner-only, rate-limited per
user, and built with `serialiseCsv` (`cire/api/src/lib/csv.ts`). A new one
also needs a **row ceiling enforced in the read**, not after it: order in SQL
and `LIMIT` at the ceiling plus one, then cut and log a warning when that extra
row arrives. Workers Free allows 10 ms of CPU, and a ceiling applied to rows
already read, sorted and built bounds the file but not the Worker. A display
order that is not the stored key's text order goes into the `ORDER BY` with
`displayRank` (`cire/api/src/lib/display-rank.ts`). `giftsCsv`
(`services/gift-export.ts`) and `budgetCsv`/`tasksCsv`
(`services/planning-export.ts`) are the patterns, and their tests read the
statements back to pin the row count each read returns.

## Tests

Platform conventions are in [[testing-patterns]]; the real-Chromium tier is in
[[browser-tests]]. Cire specifics:

- Test files live in `tests/` at the package root, mirroring `src/` — never
  beside their source. `cire/api/src/services/import.ts` pairs with
  `cire/api/tests/services/import.test.ts`, and test-only support code sits
  there too (`cire/api/tests/test-helpers/`, `cire/host/tests/test-support/`).
  The Miniflare-backed D1 tier is cire's alone: `cire/api/tests/db/`, run on its
  own with `bun run --cwd cire/api test:d1`. Unlike the vitest packages, which
  exclude that tier by path, `@cire/api` runs on `bun test` and so picks it up in
  the package's ordinary `test` script as well — expect workerd to boot there.
- **Exercising the upgrade checkout locally** needs TWO `stripe listen`
  forwarders, because there are two endpoints: `--forward-connect-to` for gift
  events (which happen on a couple's connected account) and `--forward-to` for
  the platform's own (an upgrade, where cire is the merchant). One `stripe
  listen` prints ONE signing secret for everything it forwards, so locally
  `STRIPE_WEBHOOK_SECRET` and `STRIPE_PLATFORM_WEBHOOK_SECRET` carry the same
  value; deployed tiers have two dashboard endpoints and two different secrets.
  The full command is in `wiki/cire/cire-upgrades.md`.
- **Integration tests run against a local D1 via `wrangler dev` — do not mock the
  database.**
- **`*.ssr.test.tsx` renders an island through Solid's server build**, the way
  the guest site's Worker does before hydration (`@cire/invites` only, its `ssr`
  Vitest project: Node environment, `solidPlugin({ ssr: true })`). Use it for
  anything the island does during the server render, above all a request: the
  `unit` project resolves `solid-js` to the browser build and cannot see one. It
  runs in `bun run --cwd cire/invites test` beside `unit`. Why it matters:
  [[frontend-patterns#Server-rendered islands]].
- **`*.browser.test.tsx` runs in real Chromium**, not jsdom, for anything needing
  computed CSS, layout, paint or stacking order, sticky behaviour, or media
  emulation. Opt-in, with its own CI step. `@cire/host` has a browser tier too
  (added 2026-08-06): its ink tokens are translucent and it ships two ramps, so
  what a token measures as authored and what it measures as painted are different
  numbers. jsdom parses no stylesheet and reports zeroed rects — a class-contract
  assertion in the fast tier and a measurement in the browser tier are
  complements, not duplicates.
- The animation and layout bug classes that make the browser tier necessary are
  written up in [[frontend-patterns]] § Rendering and animation gotchas.
- **Cire does not yet use the platform `it.effect` + `createTestLayer()` idiom.**
  Aligning it is an open issue in `englishstventures/osn`.

## Type-check configs

Two cire packages check their shipped source under a narrower config than their
tests, so the compiler rejects what the runtime lacks. Each package's `check`
script runs both configs, and the test config sits at `tests/tsconfig.json` so
the editor finds it for test files (see [[testing-patterns#Rules]]).

| Package | `tsconfig.json` (shipped source) | `tests/tsconfig.json` |
|---|---|---|
| `@cire/api` | The Worker: Workers types only, `lib` ES2023. Leaves out `src/local.ts` and `src/db/setup.ts`, the two files that only run under Bun | Adds `bun-types`; includes the tests and those two files |
| `@cire/invites` | `lib` ES2022 + DOM, set in the file rather than inherited, which the browser floor in the root `.browserslistrc` implements (see [[frontend-patterns#Supported browsers]]) | `lib` ES2023, for `toSorted` and `toReversed` in tests |

What this does and does not catch:

- A `Bun.*` call or a `bun:*` import in `cire/api` Worker source fails `check`.
  `process` and the Node globals do not: `@cloudflare/workers-types` declares
  `process` as `any`, and `@elysiajs/cors` pulls in `@types/node` through
  `undici-types`. So a `process.env` read at module load — empty on workerd at
  deploy-time evaluation, see [[backend-patterns]] — is still a review rule, not a
  compiler one.
- `node:crypto` imports type-check and run (`nodejs_compat`), but `Buffer` is
  typed by `@cloudflare/workers-types` here, where `toString` takes no
  encoding: `buf.toString("hex")` in Worker source, or in a shared file the
  Worker imports, fails `check` with TS2554. Build hex from the bytes instead
  (`generateRecoveryCode` in `shared/crypto/src/recovery.ts` does).
- An ES2023 method such as `toSorted` in `cire/invites/src` (a `.ts`, `.tsx` or
  `.astro` file) fails `check`. The same call in a workspace package the guest site
  imports (`@cire/theme`, `@cire/invite-designs`, `@cire/dietary`, `@shared/legal`,
  `@shared/design-tokens`) does not: those packages check at ES2023 because the
  Worker uses them too, and `astro check` reports only the files in its own
  project. Astro also builds the client bundle at `esnext`, so nothing lowers
  newer syntax for old browsers either.
- In the editor, `cire/api/src/local.ts` and `src/db/setup.ts` belong to neither
  package config and fall back to the repo-root `tsconfig.json`. `check` is still
  right for them.

## Commands

Run from the OSN repo root. General commands are in [[commands]]; dev servers
answer on portless hostnames rather than ports ([[devloop-urls]]).

```bash
# Dev — cire API + guest + organiser, plus @osn/api (organiser sign-in needs the issuer)
bun run dev:cire
bun run --cwd cire/invites dev       # guest site only    → https://invite.cire.localhost
bun run --cwd cire/host dev          # organiser portal   → https://host.cire.localhost
bun run --cwd cire/api dev           # API only (Bun.serve entry; wrangler via dev:wrangler)

# Test
bun run --cwd cire/api test
bun run --cwd cire/invites test:browser   # real-Chromium tier
bun run --cwd cire/host test:browser
bun run test:browser                      # every package with a browser tier (turbo)

# Database — wrangler.toml lives in cire/api
bun run --cwd cire/db db:migrate:local    # checks the ledger, then applies
bun run --cwd cire/db db:reset            # wipe the local D1, migrate, seed
cd cire/api && bunx wrangler types
```

Apply cire migrations through the `cire/db` scripts, never a bare
`wrangler d1 migrations apply`. `0001_initial.sql` is a baseline standing for
the archived chain in `cire/db/migrations-archive/`, and
`scripts/cire-db-migrate.ts` refuses a database that stopped part-way through
that chain, where wrangler would skip the rest without a word. Why, and how to
squash the chain again: `cire/db/README.md`.

Local sign-in also needs an `oauth_clients` row in the local OSN D1 and
`CIRE_OIDC_CLIENT_SECRET` in `cire/api/.dev.vars`. Without them `/api/auth/oidc/*`
answers 503 and the rest of cire works as normal.

Local mail goes to the in-memory recorder. To read it in an inbox instead, run
the Resend emulator and set `RESEND_API_KEY` and `RESEND_API_URL` in
`cire/api/.env` (Bun) or `cire/api/.dev.vars` (`wrangler dev`): [[email#Local emulation]].

### Adding a column

Generating a migration here is `db:generate`, not `db:migrate` — cire is the one
`*/db` package where `db:migrate:local|dev|prod` *applies* a migration to a tier
rather than emitting one:

```bash
bun run --cwd cire/db db:generate --name rsvp_dietary_presets
```

Pass `--name`. Without it drizzle-kit invents one, and the journal entry's `tag`
is the emitted filename — renaming the file by hand afterwards fails the first
assertion in `cire/api/tests/db/ddl-lockstep.test.ts`.

**A boolean column with a default needs one hand edit.** drizzle-kit writes
`integer(..., { mode: "boolean" }).default(true)` into the migration as
`DEFAULT true`. SQLite accepts it, but `PRAGMA table_info` then reads the
default back as the text `true`, while the lockstep test renders Drizzle's
boolean default as `1`. Change it to `DEFAULT 1` (or `DEFAULT 0`) in the
generated SQL and use the same literal in `setup.ts`; leave the snapshot as
drizzle-kit wrote it. `0063_invite_section_visibility.sql` is the example.

**A cire column has three DDL surfaces, not two.** The migration and
`cire/db/src/schema.ts` are the two an agent reaches for; the third is the test
DDL in `cire/api/src/db/setup.ts`, which the whole `@cire/api` suite boots
against. Miss it and `bun test cire/api/tests/` fails in the lockstep test with
the column's own name, after every other gate has passed. Full contract for the
mirror is in [[cire-platform-plan]] §Code map.

**Dropping a column is `ALTER TABLE … DROP COLUMN`, never a copy-and-swap.**
Check what `db:generate` wrote before keeping it: a `__new_<table>` rebuild drops
the table, and D1 enforces foreign keys, so the drop cascades into every child
table. SQLite refuses to drop an indexed column, so `DROP INDEX` comes first,
and each statement needs its own `--> statement-breakpoint`, because
`d1-integration.test.ts` and D1's `prepare` take one statement at a time. A data
step that has to run before the drop goes at the top of the same file.
`0076_wedding_owners.sql` is the example, and `migration-0076.test.ts` is the
shape of its test: seed rows before the migration, then prove nothing cascaded.

**A field the guest site reads is optional there.** `deploy-cire-invites` has no
`needs:` edge on `deploy-cire-api` in `deploy.yml`, so the site can reach
production before the API that serves a new field. `isValidClaimResponse`
(`cire/invites/src/components/utils.ts`) is read as "no session" by both its
callers when it returns `false`, so a field it requires sends every signed-in
household back to the code form for that window. Give the field `?` in the type
(`cire/invites/src/components/types.ts`), check its type in the guard only when
it is present, and let the reader supply a default that fails closed — as the two
dietary fields on `RsvpSummary` do. If the page also writes the field back, an
API older than the column accepts the write and drops the field, so a value
entered in that window is not stored.

### Deploying by hand

CI does this on merge ([[production-deploy]]). By hand:

```bash
cd cire/api && bunx wrangler deploy --env production
```

**Never a bare `wrangler deploy`** — the config blocks it, deliberately.

The **guest site is a Worker, not Pages.** The adapter emits `dist/server` +
`dist/client` and a generated `dist/server/wrangler.json` extending
`cire/invites/wrangler.jsonc`; CI strips the unsupported `legacy_env` field first
(see `deploy.yml`).

```bash
bun run --cwd cire/invites build
cd cire/invites && bunx wrangler deploy --config dist/server/wrangler.json
```

## Organiser API paths

Every organiser-portal call to `/api/organiser/weddings/<id>/…` builds its path
with `weddingPath(weddingId, rest)` from `cire/host/src/lib/api.ts`, wrapped in
`apiUrl(...)` (not a helper that calls `apiUrl` itself, so a test's `apiUrl`
override still applies). It percent-encodes the id, so an id holding `/`, `?` or
`#` stays inside its own segment. Encoding leaves `.` and `..` alone and the URL
parser resolves them as dot segments, so where a wedding id is read from a URL —
the dashboard hash (`dashboard-route.ts`) and the upgrade return query
(`upgrade-return.ts`) — `isDotSegment` refuses it. Ids further along the path
(an item, a task, a payment) are encoded at the call site with
`encodeURIComponent`. `tests/lib/wedding-path.contract.test.ts` fails on any
hand-built `/api/organiser/weddings/${…}` outside `api.ts`.

## Portal security headers

The organiser portal (`@cire/host`) and the vendor portal (`@cire/vendor`) are
static Astro builds on Cloudflare Pages. Every response header they send comes
from `public/_headers`, which Pages applies to every path. `astro dev` does
not read that file, so the devloop runs with no CSP at all.

**The committed file is the production policy.** Its `connect-src`, `img-src`,
`report-uri` and `Reporting-Endpoints` name `https://api.cireweddings.com` and
nothing else. After `astro build`, an Astro integration rewrites the copy in
`dist/`: every production cire-api origin becomes the origin of the
`PUBLIC_CIRE_API_URL` the bundle was built with. So:

| Build | The policy in `dist/_headers` names |
|---|---|
| Production (`deploy.yml` sets `https://api.cireweddings.com`) | The committed file, byte for byte |
| Dev (`deploy.yml` sets `https://api.dev.cireweddings.com`) | The dev API and the dev API's CSP report collector |
| Local, env unset | `http://localhost:8787`, for `wrangler pages dev dist` |

All three cire Astro apps share that integration: `tierHeaders` in
[`cire/build-tools/src/tier-headers.ts`](../../cire/build-tools/src/tier-headers.ts),
imported as `@cire/build-tools/tier-headers`. It holds the rewrite, the URL
checks and the bundle check, and its tests cover both kinds of build. Each
app's `src/lib/tier-headers.ts` holds only that app's part: the env chain it
reads and which build output must name the API. The package is build-only, so
only an app's `astro.config.mjs` (through that file) imports it; never import
it from app code, since it reads the filesystem.

The integration reads the env from Vite's resolved config, the same object that
fills `import.meta.env.PUBLIC_*` in the bundle. A portal resolves it through
`resolveApiUrl` in `src/lib/api-origin.ts`, the same chain `src/lib/osn.ts`
uses. It fails the build in these cases, so a mismatch surfaces in CI rather
than as a blocked API on a deployed tier:

- `dist/` holds no `_headers`, or it no longer names the production origin
- `PUBLIC_CIRE_API_URL` does not parse as a URL, or is neither https nor http
  on a loopback host (`localhost`, `*.localhost`, `127.0.0.1`). An empty value
  counts.
- Its host is not a plain DNS name, so writing it would add a wildcard or a
  directive to the policy
- No `.js` or `.mjs` file in `dist/` contains the origin the header now names

So write only the production origin in `public/_headers`, never a dev or
loopback one; `tests/lib/headers.test.ts` in each portal fails on either.

**Both portals enforce their policy.** Each file's `/*` rule sends one
`Content-Security-Policy`. The browser blocks whatever it does not allow and
reports each block to cire-api's collector (`POST /api/csp-report`). Neither
sends a `Content-Security-Policy-Report-Only` header: every directive is
enforced and reports already, so one would file each violation twice. The two
policies match except for `img-src`:

| Portal | Enforced `img-src` |
|---|---|
| `@cire/host` | `'self' data: blob:`, cire-api |
| `@cire/vendor` | `'self' data:`, cire-api |

Neither lists any other https origin, so injected markup cannot load an image
from a host it chose. The organiser portal needs `blob:` because it reads every
registry picture through `authFetch` into an object URL, the shop link picker's
candidates included: cire-api fetches and re-encodes each one (see
[[cire-registry]], "Thumbnails"), so the browser never loads a shop's host.
`tests/lib/headers.test.ts` pins the whole policy and fails if a report-only
header comes back.

A profile avatar can come from any https host, and both portals block and
report it until englishstventures/osn#1207 lists the avatar host. Both avatar
components show the account's initial when the image fails to load.

The guest site (`cire/invites`) is an SSR Worker, so it carries its policy in
two places, and both name the API of the build. The middleware in
`src/lib/security-headers.ts` builds the CSP for every Worker-rendered page from
the origin of `PUBLIC_API_URL`, read through `resolveApiUrl` in
`src/lib/api-origin.ts`, the same chain `src/lib/invite.ts` uses.
`public/_headers` covers the static assets and the prerendered legal pages, and
the shared integration rewrites its copy in `dist/client/` the way it does the
portals'. The guest site's `src/lib/tier-headers.ts` points the bundle check at
the server bundle (`bundle: "server"`), because the pages read the API URL on
the server and hand it to the islands as a prop. The
committed file names only the production API and no loopback origin:

| Run | The guest-site policy names |
|---|---|
| Production build | The committed file, byte for byte |
| Dev build | The dev API and its collector |
| Local build, env unset | `http://localhost:8787` |
| `astro dev` (portless or not) | The middleware's policy for the devloop's `PUBLIC_API_URL`; no `_headers` applies |

### Checking a policy change

`astro dev` applies no `_headers`, so check a policy change in two places:

1. **Locally, before the pull request.** Build the portal, serve `dist/` with
   `wrangler pages dev dist`, which applies `_headers`, and load the pages with
   DevTools open. The console names every blocked load. Without a local
   cire-api only the signed-out pages render. A local cire-api logs these
   reports with `site: "other"`, because `wrangler pages dev` serves on its own
   port, which `WEB_ORIGIN` does not list.
2. **On the dev tier, after the merge deploys it.** Sign in through Cloudflare
   Access, then walk:
   - `@cire/host`: sign-in, the invite builder, image cropping, the registry's
     shop link picker and a saved registry thumbnail, the CSV import and
     export, the invite preview window, and the Stripe Connect and upgrade
     buttons as far as their redirect.
   - `@cire/vendor`: sign-in, the claim link, the enquiry list, the listing
     editor and the organisation picker.

   Watch the dev collector while you walk: `bunx wrangler tail --env dev
   --search "csp violation report"` from `cire/api/`, or Workers Logs for
   `cire-api-dev`. Each line carries the directive, the blocked origin, the
   document's origin and path, the site and the disposition.

The walk passes when no line names anything but an avatar origin under
`img-src`; every line has `disposition: "enforce"`, since neither portal sends
a report-only policy. The log is harder to read than it looks:

- `site` is `invites`, `host` or `vendor` when the document's origin is that
  entry of cire-api's `WEB_ORIGIN`, and `other` for anything else: a Pages
  `*.pages.dev` alias, or a blank document such as the invite preview window
  before it loads (its `documentOrigin` is empty).
- `disposition` is `unknown` when the browser left the field out. `site` still
  tells the modes apart: the guest site reports only, and the portals enforce.
- A line records what a report claims. The collector cannot tell a browser
  from a script, and anyone can POST a report naming a cire origin and
  `enforce`, so confirm a block in DevTools before changing a policy.
- Chrome queues `report-to` reports and sends them in batches, so a report
  arrives some time after the load. Wait a minute or two before calling a
  step clean.
- The collector drops reports past 60 a minute from one IP address and still
  answers 204. Walk at a normal pace. From one request it logs at most 20
  reports, then one `csp report batch truncated` line with the number dropped.
- The `cire.csp.report` counter is keyed by directive, site and disposition,
  never by blocked origin, and records nothing on workerd until metric export
  is wired ([[cire-workerd]]). Read the logs.

Two kinds of report come from the dev tier only, and neither is a policy gap: a
Cloudflare Web Analytics beacon (`script-src`, `static.cloudflareinsights.com`)
if the dev Pages project injects one, and `script-src-elem` reports for
same-origin chunks once the Access session expires.

Hold production until the walk passes. A merge deploys the dev tier at once,
and each portal's production job waits for approval in one concurrency group,
where a later run replaces a pending one. So hold every production run that
deploys the portal, whatever pull request it names, and revert on a failed
walk.

## Guest-site SSR bundle size

Tracker #619 generalised this guard out of cire/invites: it is now
`scripts/guard-bundle-size.sh` (repo root, `worker` mode for this app), shared
with a `static`-mode measurement for the five non-SSR Astro apps. The
cross-app mechanism — where it runs, why it runs twice, every app's current
threshold — lives in [[bundle-size-guards]]. What stays here is what is
genuinely cire/invites-only: WHY its bundle is shaped the way it is.

In `worker` mode the script sums the gzip size of each file under
`cire/invites/dist/server` on its own, because `no_bundle: true` ships each
chunk as its own module. It leaves out only the adapter's top-level
`wrangler.json` and real source maps — a `.map` beside the chunk it is named
after that parses as a source map. Any other `.map`-named file is counted, so
the total can run above what wrangler uploads but never below it. It also
fails if any `.map` file turns up under `dist/client`, which is served
publicly as Static Assets — see the source-map warning below.

`cire/invites/package.json`'s `build` script chains it on
(`… && ../../scripts/guard-bundle-size.sh .`), so it fires wherever the build
actually executes: the by-hand deploy above, and any local build. `ci.yml` and
both `deploy.yml` jobs also invoke it as their own step ([[bundle-size-guards]]
has the reason — a Turborepo cache replay of `build` never runs the chained
script). The mode and threshold are no longer arguments anywhere — every
caller looks its app up by name in `scripts/bundle-size-budgets.txt`, the one
place a re-baseline touches. See that file's own comment for the exact steps.

The headroom is deliberately smaller than the mistake the guard exists to
catch, and that is the part worth getting right. `motion` costs **21261 bytes
gzip in the minified build** — the size of its own already-minified client
vendor chunk, `dist/client/_astro/animate.*.js`, and the same figure you get by
rebuilding with `stubMotionForSsr()` removed. A threshold set to "measured plus
one motion" would put a fresh library of exactly that class *under* the line,
which is how the first version of this number went wrong: it carried 47657
bytes, motion's cost back when the build was unminified. The arithmetic is
spelled out in the comment above `threshold=` so the next reader can check it
without rebuilding.

Three tracker follow-ups (#618, #616, #617) to the original size audit
(#287) cut the bundle from 285 KB to 163 KB gzip:

- **Sessions off (#618).** Astro's session config accepts `session: false`
  (`astro/dist/core/session/config.js`), and `@astrojs/cloudflare`'s
  KV-binding auto-provisioning is gated on that same literal
  (`@astrojs/cloudflare/dist/index.js`, `if (session !== false && ...)`), so
  turning sessions off entirely — rather than pinning the in-memory driver —
  drops the session runtime and `unstorage` from `dist/server` with no KV
  binding required. Safe here because the guest site never reads or writes
  `Astro.session`.
- **SSR minification (#616).** `vite: { build: { minify: true } }` in
  `astro.config.mjs` does nothing for the server build: Astro's
  `createViteBuildConfig` (`astro/dist/core/build/vite-build-config.js`)
  spreads the user's `vite.build` and then hard-sets `minify: false`
  afterward for build-performance reasons, and separately replaces the `ssr`
  environment's whole `build` key, dropping any environment-scoped
  `minify` too. The fix is a small inline Astro integration hooking
  `astro:build:setup`, which Astro runs once (`target: "server"`) after that
  config exists, and whose `updateConfig` merges on top of it — the `prerender`
  and `ssr` environments inherit the resulting top-level `minify: true`; the
  `client` environment doesn't, because its own `minify` is set independently,
  so the client bundle is unaffected. The minifier under this Astro (Vite 8 /
  rolldown-vite) is OXC — pass `minify: true`, not `"esbuild"`.
- **Source maps, server-side only.** Minifying the server build means a
  production Worker exception no longer names a real source line, so this ships
  with `sourcemap: true` set **through the same `astro:build:setup` hook** as
  `minify`, plus `upload_source_maps: true` in `cire/invites/wrangler.jsonc` —
  the adapter never sets that key itself, so it has to come from the checked-in
  config the generated `dist/server/wrangler.json` extends. Both CI rewrite
  steps that touch that generated file (`deploy.yml`, dev and prod) only delete
  `legacy_env` and set `name`/`routes`, so the key survives into the deployed
  config untouched.

  > [!warning] Never set `sourcemap` as a plain `vite.build` value here.
  > Unlike `minify`, it is not overridden — it reaches the top level *and* the
  > client environment reads it
  > (`astro/dist/core/build/vite-build-config.js:135`), so the client build
  > emits `dist/client/_astro/*.js.map` too. `dist/client` is this Worker's
  > Static Assets directory (the adapter writes
  > `"assets": { "directory": "../client" }` into the generated wrangler
  > config) and Cloudflare serves everything in it verbatim, so those maps
  > publish the guest site's unminified source at `/_astro/<chunk>.js.map` to
  > anyone who asks. The plain form was written that way first and caught in
  > review; `guard-bundle-size.sh` now fails the build if any `.map` file appears
  > under `dist/client`.
- **`zod` stays (#617).** Traced to Astro's own actions request handler
  (`actions/handler.js` → `actions/runtime/server.js`, top-level
  `import * as z from "zod/v4/core"`), which `core/routing/handler.js` calls
  on every non-prerendered request whether or not the app defines any
  actions (`src/actions` doesn't exist here). There's no app-level config to
  skip that code path, so unlike `motion` (see the SSR-stub comment in
  `astro.config.mjs`) this is not stubbed — it's a real, reachable Astro core
  dependency, not dead weight from an unreachable path.

## Related

- [[cire]] — what cire is, its packages, data model and deployment
- [[cire-auth]] — the two-system auth contract and the role matrix
- [[cire-workerd]] — what cire's observability does differently on workerd
- [[cire-platform-plan]] — where the product is going
- [[frontend-patterns]] — the Solid/Motion/Tailwind gotchas cire found the hard way
