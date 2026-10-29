---
title: Testing Patterns
description: Test conventions, patterns, and examples for the OSN monorepo
tags: [convention, testing]
related:
  - "[[backend-patterns]]"
  - "[[schema-layers]]"
  - "[[commands]]"
  - "[[bundle-size-guards]]"
  - "[[devloop-urls]]"
  - "[[browser-tests]]"
  - "[[infrastructure-as-code]]"
  - "[[realtime]]"
last-reviewed: 2026-10-29
---

# Testing Patterns

## What to test, and when

Three rules decide what kind of test a change gets. They come before every pattern on this page.

1. **End-to-end tests first, and ideally only.** A complex feature is proved by an E2E test that drives the real stack the way a user or caller does: browser, API, database. Reach for nothing else unless the E2E test cannot reach the behaviour. Code only an E2E flow covers gets its branch list in `NEW-FEAT.md` too: each branch the code takes and the flow step that reaches it, before the code exists.
2. **Every E2E test ends by producing an artifact.** It writes something a reviewer can check without rerunning the suite, and that comes out the same on every run: a Playwright trace, screenshots of the final state, or a JSON record of the requests and results. It runs against seeded data and a fixed clock, so a second run gives the same artifact. Name where the artifact lands in the PR test plan. The suite that does this, and how to add a flow to it, is [[#The end-to-end suite]].
3. **Isolated tests are written failure-modes first.** When a system must be tested on its own (a parser, a crypto routine, a rate-limit window, a state machine an E2E test cannot steer into every state), first write down every way it can fail. Put that list in `NEW-FEAT.md`, before any code exists. Write one test per entry, then the code that makes them pass. A test that maps to no listed failure does not get written. The list includes code the change does not touch but now reaches: when a client starts sending a field, or a write starts filling a column, every existing branch on that value was dead before and is live now, and mutation testing on the changed lines never mutates it. A gift-list change that sent `itemId` for the first time made the payment-page reuse lookup's `item_id` match decide where money went, and only a test review found it untested.

**Never write unit tests after the code.** A unit test written to cover code that already works describes what the code does, not what it must do. It goes green on the first run and stays green through the bugs that matter. Those tests are the low-signal kind this repo has deleted: constants asserted against themselves, mock echoes, "renders without crashing", snapshots of static markup, framework behaviour, types the compiler already checks.

The bar for keeping any non-E2E test: **name the real bug it catches that no E2E test would.** No name, no test. One exception: a test that checks a refusal or a redaction (an authorisation gate, a permission table, a rate limit, a CSP, an input rejection, log redaction) stays unless a named, existing test checks the same refusal. "An E2E test could catch it" is not enough; one has to exist. [[#Assertions that cannot fail]] lists the shapes that fail that bar most often.

## The end-to-end suite

`tools/e2e` (`@tools/e2e`) is where E2E tests live. `bun run test:e2e` boots the real stack, runs every flow in Chromium, and writes the artifact. `bun run test:e2e:repro` runs it twice and fails unless both runs wrote the same `results.json` byte for byte. CI runs the repro on every pull request (the `E2E` job) and uploads `e2e-artifacts/`.

### What one run does

1. Refuses to start if any of its ports is taken, and names the port. It never reuses a server it did not start. Stop your `bun run dev` first. A refused run leaves the previous run's artifacts where they are. The ports are fixed for the whole machine, so two worktrees cannot run the suite at once: when another worktree's run holds them, `lsof -nP -iTCP:4000 -sTCP:LISTEN` names its process, and `lsof -p <pid>` its directory. Wait for that run to finish rather than stopping it, and start once the ports have stayed free for a minute or so, since a repro frees them for a moment between its two runs.
2. Clears `e2e-artifacts/`, so nothing from an earlier run survives.
3. Checks that the shared clock reaches a Bun child and a Node child: `Date.now()`, `new Date()` and `Date()` each.
4. Builds fresh SQLite files from each package's `applySchema` and seeds fixed rows: Pulse and the cire organiser portal are registered with osn-api as first-party OIDC clients. cire-api seeds its own file at boot (`CIRE_LOCAL_DB_PATH`).
5. Starts a stand-in for the Resend API (port 4590), then every app at once except pulse-api. pulse-api registers its service key with osn-api at boot, so it starts once osn-api answers, and counts as ready once its key is in osn-api's database.
6. Runs Playwright, serially and with no retries.
7. Stops every process group, the Playwright runner's included, whether the run passed, failed or was interrupted. A `SIGINT` or `SIGTERM` sent to the launcher alone stops them too.

| App | Port | Started as |
|---|---|---|
| osn-api | 4000 | `bun --no-env-file --preload src/clock.mjs src/local.ts` |
| pulse-api | 3001 | same |
| cire-api | 8787 | same |
| Musubi | 1422 | `bun run dev:app` |
| Pulse web | 1420 | `bun run dev:app` |
| cire invites | 4321 | `bun run dev:app --ignore-lock` |
| cire host (the organiser portal) | 4322 | `bun run dev:app --ignore-lock` |
| cire landing | 4323 | `bun run dev:app --ignore-lock` |

cire landing and cire host reach the internet as they start: their Astro font pipelines fetch Google Fonts (`fonts` in each package's `astro.config.mjs`) and cache them under the package's `.astro/`. With no network each logs `No data found for font family …` and serves pages in fallback faces, so the stack still boots. The portal runs under `astro dev`, which serves no Content Security Policy (the build writes it into `dist/_headers`), so the browser tier keeps the CSP checks.

*Measured 2026-10-20 — `astro dev` for `@cire/landing` with `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9`: `/privacy` answered 200 after 4.2 s.*

*Measured 2026-10-20 — `astro dev` for `@cire/host` with the same two variables, `PORT=4322`, in a sandbox whose egress proxy refused `fonts.google.com`: `/login` answered 200 after 8.9 s, its log saying `No data found for font family Schibsted Grotesk`.*

The ports are the `PORTLESS=0` ones from `DEV_APPS` in `@shared/dev-urls`, and `tools/e2e/tests/config.test.ts` keeps the two lists equal. Children get an explicit environment, not your shell's: `PATH`, `HOME` and a few proxy and certificate variables, plus every sibling origin set by name. The APIs also start with `--no-env-file`, so neither a `.env` file nor your shell's `REDIS_URL`, `OSN_ENV` or Turnstile key reaches them. The frontends still read their own `.env*` files, as Vite and Astro always do. Every variable the suite relies on there (each API origin, the Turnstile site keys) is set in their environment, and that beats a `.env` value.

**The clock.** Every server and every browser page starts at `2026-10-01T00:00:00Z` and then ticks in real time. The APIs load `tools/e2e/src/clock.mjs` with `--preload`. Vite and Astro load it through `NODE_OPTIONS`. Each page gets `page.clock.install`. The date is fixed so that seeded deadlines and "must be in the future" checks resolve the same way whatever the real date is. Time still moves so that debounces and timers in the UI still fire. Each flow checks that the rows it wrote carry a timestamp on the suite clock, so a server that missed the preload fails on the day it breaks, not on the day a seeded deadline passes.

**A deadline the browser can pass.** cire-api's sample wedding carries the RSVP deadline `CIRE_RSVP_DEADLINE` (`2099-01-01`, from `tools/e2e/src/config.ts`), which `cire/api/src/local.ts` reads as `CIRE_E2E_RSVP_DEADLINE`. It is far past the suite clock, so the server takes replies on every run. A flow that needs the closed invite moves only its own page past it, with `page.clock.setSystemTime(Date.parse(CIRE_RSVP_CLOSED_ISO))` and a reload, as `cire-rsvp-after-deadline.flow.ts` does; the invite decides "closed" from the browser's clock. What the server refuses past a deadline is proven in cire-api's own tests, not here.

**A gift list behind the claim code.** The stack starts cire-api with `CIRE_E2E_REGISTRY=1`, which `cire/api/src/local.ts` reads to add a second wedding, `gift-wedding`, on Gold with a published list and a cash fund, one household of one and the wedding's host preview household (`seedE2eGiftList` in `cire/api/src/db/setup.ts`; the values the flows check are written out again as `CIRE_GIFT_LIST` in `tools/e2e/src/config.ts`). The couple's settings take money, and the stack runs cire-api with a placeholder Stripe key and no Connect webhook secret — a deployment that could open a payment page but never record the gift — so `cire-registry-claimed` reads the fund and those settings from the database, checks that neither the money form nor the fund reaches the guest, and reads `logs/cireApi.log` for the one warning cire-api logs only in that setup, so the checks cannot quietly turn into a test of a stack with no key. The placeholder reaches no Stripe API: no flow calls a route that would use it. No flow pays: the stack has no stand-in for Stripe, so a gift to a fund is proven in cire-api's route tests (a stand-in is englishstreetventures/osn#1627). It is a wedding of its own so the gift band a published list puts on the invite never enters the other cire flows. `cire-registry-locked.flow.ts` proves a browser without a claim receives none of the list, and `cire-registry-claimed.flow.ts` proves the household's code opens it; the second checks visible every gift title, the headline and the message the first checks absent, and reads the cash fund's name and words from the database, since no guest is offered the fund on this stack, so a seed that drifts from the config fails a flow instead of passing one on nothing. `cire-registry-preview.flow.ts` opens the invitation at the preview code, as the organiser's **Preview invite** does, and proves the preview reads the list, its note leaves money out, every Reserve control is disabled, and a reservation sent anyway is refused `403`. Whether a guest downloads the band's code at all is checked by module path (`GIFT_LIST_MODULES` and `guestSitePaths` in `tools/e2e/tests/support/fixtures.ts`; `astro dev` serves each source module as its own request): `cire-registry-claimed` checks the Gold wedding's invitation requests the band and its display helpers and never the client that claims and gives, and `cire-rsvp-after-deadline`, whose household is on the Ivory sample wedding, checks a second tab on its session requests none of the three. That tab is read at the end of the flow, after the steps between, because no page state marks that a download the list read's answer set off has had time to start.

**The guests' claim budget is spent.** cire-api allows five claims a minute per client address (`defaultClaimLimiter` in `cire/api/src/app.ts`), counted in one fixed window per address, and five flows claim a code from the suite's own address: `cire-member-step`, `cire-registry-claimed`, `cire-rsvp`, `cire-rsvp-after-deadline` and `cire-rsvp-partial-after-deadline`. They usually run inside one minute, so a sixth claim, or a wrong code typed anywhere in the run, is answered `429` and fails a flow whose own steps look fine, on a slow machine sooner than a fast one. A flow claims by pressing "Open Invitation" or by opening the invitation at a `code=` link, which claims on load. `tools/e2e/tests/flows.test.ts` counts both and fails above five, so the commit that adds a sixth goes red under `bun test` rather than on some CI runs. A new cire flow that needs a household reuses a claiming flow's journey instead of adding a claim.

**An organiser, signed in.** cire-host signs in through cire-api's OIDC routes, and osn-api is the provider. The seed registers cire as a first-party client (`CIRE_OIDC` in `config.ts`, `seedOsn` in `src/seed.ts`), and the stack gives cire-api its id, secret, issuer and API origin, which `cire/api/src/local.ts` builds into the client config. The stack also starts osn-api with `DEV_LOGIN_SECRET`, which mounts `GET /dev/login` (`osn/api/src/routes/auth/dev-login.ts`, local and dev tiers only). That route signs in as the fixed dev principal, whose profile owns cire's sample wedding, and its `DEV_LOGIN_RETURN_ORIGINS` is the host's origin. A flow opens the form at `/dev/login?return_to=<host>/login?returnTo=<hash route>`, types the secret and submits it, waits for the login page's `GET /api/auth/session`, then presses "Continue with musubi". With a session and a first-party client, osn-api issues the code straight back to cire-api, so Musubi's `/authorize` page never loads. `cire-event-details.flow.ts` does this: the organiser edits an event in the drawer (its details, run of show, getting-there notes and guest policy), saves, reverts a second save, round-trips the events sheet through the spreadsheet door, reads the event back in the Events list, and previews the invitation; it then allows Eli a plus-one and opens Eli's invitation to see the policy that household is shown. It edits Kitchen Tea and Eli's household, which no other flow reads.

**Organiser flows on their own weddings.** The checklist, run-sheet, money-gift and seating flows sign in with `signInToCireHost(flow, page)` (`tools/e2e/tests/support/fixtures.ts`) instead. It posts the secret to `/dev/login/form` with the page's own request client, so the cookie lands in the browser's jar, then makes the sign-in a host makes from the portal's `/login`: "Continue with musubi", cire-api's `/api/auth/oidc/start`, osn-api's `/authorize` with no screen, and cire-api's callback, which sets `cire_org_session`. The portal then settles on `/#/weddings`. The fixture checks that Musubi's `/authorize` page never loads, that the cookie is HttpOnly, and that the dev profile, `usr_dev_bootstrap_owner`, holds one more `organiser_sessions` row. The stack starts cire-api with `CIRE_E2E_ORGANISER=1`, which adds eight Gold weddings (`seedE2eOrganiser` in `cire/api/src/db/setup.ts`; the ids are written out again as `CIRE_ORGANISER` in `tools/e2e/src/config.ts`). That profile owns seven: one dated 2099-06-20 with an empty checklist (`cire-checklist-starter`, which on the same sign-in then collapses the module rail, reloads to find it still collapsed, and opens and closes the locked Vendors card from it), one with an open task, an editor and a viewer (`cire-checklist-holders`), one with a helper (`cire-helper-scope`'s scope steps), one whose day, 2026-10-01 in Sydney, has events with runs of show and tasks linked to them (`cire-helper-scope`'s run-sheet steps, which hold the page clock at `CLOCK_T0` plus five minutes so a task twenty minutes away reads "Coming up" on every run), one whose settings take money with a single cash fund (`cire-registry-money`, which checks the portal says this stack cannot take a money gift), one with a single household, of a guest with no email address and a guest with her own (`cire-seating`'s guest-email steps, which share its sign-in and run before the seating steps, so its screenshot is the seating chart), and one with a reception whose one seating plan seats three guests and an after party with no plan (`cire-seating`). On the eighth it is a helper who sees their own tasks, so the same sign-in reads the run sheet as such a helper. The local cire-api resolves no OSN names, so co-hosts show, and are found, by profile id. `cire-registry-money` then signs the dev account out everywhere else through osn-api (`POST /token`, then `POST /sessions/revoke-all-other`, each with Musubi's `Origin`), polls cire-api's `GET /api/auth/session` until the cookie the browser holds signs nobody in, finds no `organiser_sessions` row left for the dev profile, sees the gift list read with that cookie answer 401, and opens the portal again to land on `/login`: osn-api reaches cire-api's `POST /internal/revoke-organiser-sessions` with the `CIRE_INTERNAL_REVOKE_SECRET` the stack gives both ([[sessions#Sign out everywhere else reaches cire]]). Those steps share that flow's sign-in, and come last in it because they end it; a later flow signs in afresh. It polls over HTTP rather than reading cire's database, because cire-api is writing the revoke while it waits. A sign-in, through the fixture or a flow's own `/dev/login?…` link, spends two of cire-api's OIDC redirect legs (15 a minute per address), one `/dev/login` (10 a minute) and one osn-api `/authorize` (20 a minute, which the Pulse flow's two sign-ins share), so `flows.test.ts` counts both kinds and fails above six sign-ins in the run (six today: twelve of the fifteen redirect legs a minute, so a new organiser flow joins one that already signs in, or the budget is raised with the limits it rests on).

**The organiser claims from its own address.** A flow that previews calls `claimFromOrganiserAddress(context)` (`tools/e2e/tests/support/fixtures.ts`), which sends that context's claims with `cf-connecting-ip: ORGANISER_ADDRESS` (TEST-NET-1, from `config.ts`), as an organiser on their own network would. The route stays for the rest of the flow: while any route is installed Playwright pauses every request in the context, and removing it while the page still loads strands the request paused at that moment, so a module import the claim's reveal waits on never settles. The stack starts cire-api with `CIRE_E2E_CLIENT_ADDRESS=1`, the one case where the local server keeps a client address the request sends (`localClientAddress` in `cire/api/src/lib/local-client-address.ts`); any other local cire-api replaces it with the socket peer. Those claims count in the organiser's window, also at most five (three today: one in `cire-registry-preview` and two in `cire-event-details`, the preview household and Eli's), and such a flow may claim only through a `code=` link: a press in a second, unrouted context would spend the guests' window while being counted in the organiser's. A second test in `flows.test.ts` checks the stack sets the flag and `local.ts` reads it.

**A stand-in for cire's push hub.** For each wedding it shows, the portal opens a socket to cire-api's `/realtime/<topic>` ([[realtime]]), and the stack's cire-api has no hub: its Bun entry answers `/realtime/*` with 404. Left alone, every subscription would fail, retry on the client's jittered backoff (six attempts, up to 31 seconds of waiting, from `Math.random`) and then post `POST /api/realtime/fallback`, so a dashboard open long enough would put that beacon in one run's `results.json` and not the next. The `flow` fixture stands in for the hub in every context it records (`standInForCireHub` in `tools/e2e/tests/support/fixtures.ts`): Playwright's `routeWebSocket` takes each socket to cire-api's `/realtime/`, opens it, answers `ping` with `pong` as `TopicHub` does, and sends no signal, so no subscription gives up. Every other socket, Vite's included, opens on the network as before. The two words and the ping interval are written out for Node as `REALTIME_KEEPALIVE` in `tools/e2e/src/config.ts`. `cire-helper-scope` checks that its co-hosts page's socket reached the stand-in, and that the page holds one socket for its wedding both once it opens and after the scope and role changes, so a portal that moves or reopens its socket fails on every run, not the repro on some. `cire-checklist-starter` moves its page clock on one ping interval (`page.clock.runFor`) after its checklist steps and checks that the stand-in received the ping and that the page's socket received the pong (counted in the page by an init script), so a ping word or interval that drifts from `@shared/realtime`'s, or a stand-in that stops answering, fails there; nothing that page runs in that interval calls the API. It then hides the page by shadowing `document.visibilityState`, jumps the clock two ping intervals with `page.clock.fastForward`, shows the page again, and checks that the socket reopened once and the wedding list was read once, both counted in the page by a second init script. The jump fires each due timer once: the ping, then the close the hidden tab scheduled. `runFor` could tick the ping twice with the first unanswered, which the client counts as a lost socket, and that sends a re-read of its own. Its module-rail steps come after both, because their reload starts a new document, which counts its pongs and reads afresh. No flow sees a push signal until englishstreetventures/osn#1653 boots cire-api with its real hub. Keep a portal flow to one page per context: a tab the browser reports hidden for two ping intervals (50 seconds) closes its socket and reopens it when shown, and the re-read that follows would land in some runs only.

### Reading the artifact

```
e2e-artifacts/
  results.json                     flows, steps, API requests, assertions: the reproducible part
  screenshots/<flow>.png           each flow's final state
  traces/<file>-<flow>/trace.zip   bunx playwright show-trace <path>, or trace.playwright.dev
  logs/<app>.log                   each server's output, for when a flow fails
  state/*.db                       the databases as the run left them
```

`results.json` lists one record per flow, sorted by name. Each record has:

- `status`: the runner's own result. A flow that dies before it writes a record still appears, with empty lists.
- `steps`: the flow's named steps, in order.
- `requests`: one line per distinct API call, as `METHOD app /path status`. The list is sorted.
- `assertions`: each named check, with `expected`, `actual` and `pass`.

Requests are kept only for osn-api, pulse-api and cire-api. Query strings are dropped, because they carry OIDC `state`, nonces and PKCE values. Generated ids in a path become `:id`. The list is a set, because how many parallel fetches a page makes depends on timing, while which calls it makes does not. Nothing time-shaped is recorded: no timestamps, durations or retry counts. If `results.json` changes between two runs, a flow is recording something nondeterministic. Fix the recording; do not rerun until it matches. Only `results.json` is byte-stable. Traces and screenshots are not.

### Adding a flow

1. Create `tools/e2e/tests/flows/<product>-<what>.flow.ts`. Playwright collects only `*.flow.ts`. The test title is the flow's name in `results.json`, and the screenshot and trace are named after it.
2. Import `test` and `expect` from `../support/fixtures`, and take the `flow` fixture.
3. Wrap each user-visible action in `flow.step("…", …)`. Record every outcome a reviewer should see with `flow.check(name, expected, actual)`, which also asserts. Check the database row, not only the UI: `queryOne(DB_FILES.<db>, sql, …)` reads a stack database read-only. Join on seeded or fixed values, never on a generated id.
4. For a second user, create a context with `browser.newContext()` and open pages with `flow.newPage(context)`, so they get the suite clock and their requests are recorded. Point `flow.finalPage` at the page whose end state the screenshot should show.
5. To create an OSN account, register through the UI when registration is what the flow tests (`otpFor(email)` reads the one-time code, and `mailFor(email, until)` waits until a message matching `until` has reached the address, then returns every message sent to it so far, to check a subject or body). Otherwise call `registerThroughApi(flow, context.request, person)`. A flow on the cire organiser portal signs in with `signInToCireHost(flow, page)` instead, as the dev profile that owns the seeded organiser weddings. Fixed people and values go in `tools/e2e/src/config.ts`.
6. Wait on state only: `expect(locator)`, `expect(page).toHaveURL`, `page.waitForResponse`. `tools/e2e/tests/flows.test.ts` fails on `waitForTimeout`, `setTimeout`, `networkidle` or `.only` in a flow. Arm a `waitForResponse` before the action that fires the request, and match the whole URL: `…/registry` is a prefix of `…/registry/mine`, and both fire on one mount. A field in a server-rendered island exists before the island hydrates, and text filled into it then never reaches the form, so its submit button stays disabled. A flow that waited for the consent prompt on that page has already waited long enough; otherwise fill inside `expect(async () => …).toPass({ timeout })` until the button enables, as `cire-registry-claimed.flow.ts` does.
7. A step that ends on a server-rendered element leaves the page's islands still hydrating, and they keep running into the next step: `page.goto` replaces the page only when the next document answers. An island that reads a cookie or storage on mount, as the guest site's session restore reads `cire_claimed`, then sees whatever the next step set and sends requests the record keeps in one run and not the next, which the next step's `waitForResponse` can also take for its own. Before a step changes cookies or storage, leave the page with `page.goto("about:blank")`, as `cire-registry-locked.flow.ts` does before its return visit.
8. Run `bun run test:e2e:repro` and confirm the two runs match.

A new app in the stack goes in `appSpecs()` in `tools/e2e/src/stack.ts`, with its port in `config.ts`.

### What it cannot see

Every app is served from `localhost`. Cookies ignore the port, so the suite proves that a cross-origin `fetch` carries `credentials: "include"`: without it the browser drops `Set-Cookie` and the flow's cookie checks fail. The Musubi flow also clears the client's cached account and reloads, so the session can only come back through the cookie on `POST /token`, and then clears the cookie too and checks the reload is signed out. It cannot prove anything about how a cookie is scoped between real hosts. Locally there is no `Secure`, no `__Host-` prefix, and no `OSN_COOKIE_DOMAIN` marker. The browser tier ([[browser-tests]]) and the deploy checks own those.

The Musubi flow reports conditional mediation as unavailable. The virtual authenticator answers an autofill passkey request on its own, which a person never does, so leaving it on would race the "@handle → Continue" path the flow drives.

## Directory Layout

Test files live in `tests/` at the package root and mirror the `src/` structure. **Every**
package, without exception, `cire/*`, the three landing sites and `scripts/` included.
CI's `Lint & Format` job runs
[check-tests-outside-src.ts](../../scripts/check-tests-outside-src.ts), which fails on any
file under a workspace's `src/` whose name holds `.test.`, `.spec.`, `_test.` or `_spec.`,
`_`-prefixed or not, and on any symlink there. It reads names only, so it cannot see a test
helper. Keep test-only support code (mocks, fixtures, request harnesses) under `tests/`
too, never in `src/`:

```
pulse/api/
  tests/
    helpers/db.ts                  # createTestLayer() -- shared test utility
    services/events.test.ts        # Effect service tests
    routes/events.test.ts          # HTTP integration tests
osn/api/
  tests/
    helpers/db.ts                  # createTestLayer() for osn/db (accounts, profiles, passkeys, sessions)
    services/auth.test.ts          # Effect service tests
    routes/auth.test.ts            # HTTP integration tests
pulse/db/
  tests/
    schema.test.ts                 # Schema smoke tests
cire/api/
  tests/
    test-helpers.ts                # appRequest() -- Elysia request harness
    test-helpers/osn-token.ts      # makeOsnTestAuth()
    test-helpers/organiser-session.ts  # seedOrganiserSession()
    routes/rsvp.test.ts            # HTTP integration tests
    db/d1-integration.test.ts      # Miniflare tier -- see The D1 integration lane
cire/host/
  tests/
    test-support/mocks.ts          # shared Solid mocks for the organiser portal
    components/Overview.test.tsx   # unit tier (happy-dom)
    components/ImportPanel.browser.test.tsx  # browser tier (real Chromium)
scripts/
  tests/
    check-astro-fonts.test.ts      # scripts/ is not a workspace; `bun test ./scripts/`
    changeset-required.test.sh     # shell tests too
tools/e2e/
  tests/
    flows/cire-rsvp.flow.ts        # E2E flow (Playwright, *.flow.ts only)
    support/fixtures.ts            # the `flow` fixture, OTP and DB readers
    ports.test.ts                  # the harness's own failure modes (bun test)
shared/ui/
  tests/
    test-support/browser-commands.ts # Vitest browser commands (emulateMedia)
    ui/otp-input.test.tsx            # unit tier (happy-dom) -- DOM shape and class lists
    modal.browser.test.tsx           # browser tier (real Chromium) -- top layer, focus trap, ::backdrop
osn/auth-ui/
  tests/
    SignIn.test.tsx                 # passkey-only sign-in view
    Register.test.tsx               # registration view
    RecoveryLoginForm.test.tsx      # lost-passkey recovery flow
    StepUpDialog.test.tsx           # sudo-token ceremony for sensitive actions
    SessionsView.test.tsx           # session list / revoke
    PasskeysView.test.tsx           # passkey management
```

### Tests that read files outside their package

turbo caches a package's `test` on the package's own files. A test that also reads files elsewhere in the repository — another package's source, a workflow, `bun.lock` — needs those files as inputs, or it serves a stale green; but naming them on `test` reruns the whole suite whenever any of them changes. Put such tests in a vitest project of their own and run it as the root `test:repo` task: the package's `turbo.json` names the outside files as `test:repo` inputs and makes `test` depend on `test:repo`. A package with no `test:repo` script runs nothing for it. Two packages do this today: `@shared/infra` ([[infrastructure-as-code#Testing]]) and `@cire/landing` ([[cire-landing#Tests]]).

## Service Test Pattern

Service tests use `it.effect` from `@effect/vitest` with an isolated DB per test via `Effect.provide(createTestLayer())`.

```typescript
// Service tests: it.effect from @effect/vitest, isolated DB per test
import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { createTestLayer } from "../helpers/db";

it.effect("creates event with evt_ prefix", () =>
  Effect.gen(function* () {
    const event = yield* createEvent({ title: "Test", startTime: "2030-06-01T10:00:00.000Z" });
    expect(event.id).toMatch(/^evt_/);
  }).pipe(Effect.provide(createTestLayer()))
);
```

### Error Assertion Pattern

Use `Effect.flip` to promote errors to the success channel for assertion:

```typescript
// Error assertions: use Effect.flip to promote errors to success channel
it.effect("fails with EventNotFound", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(getEvent("nonexistent"));
    expect(error._tag).toBe("EventNotFound");
  }).pipe(Effect.provide(createTestLayer()))
);
```

### Reading the error out of an `Exit` (Effect v4)

`Effect.flip` is the first choice because it needs no unwrapping. When a test
holds an `Exit` instead — from `runPromiseExit`, or a helper that returns one —
read the error with `Cause.findErrorOption`. v4's `Cause` is a flat list of
reasons, so there is no `Fail` node to match on and the v3 form does not
type-check:

```typescript
// v3: exit.cause._tag === "Fail" && exit.cause.error instanceof VendorNotInWedding
expect(
  Option.getOrUndefined(Cause.findErrorOption(exit.cause)) instanceof VendorNotInWedding,
).toBe(true);
```

`findErrorOption` returns `None` for a **defect**, so this refuses one exactly
as the `_tag === "Fail"` check did — a test that should be catching a typed
failure does not quietly start passing on a crash.

Three more v4 facts that decide whether an assertion is real:

- **`Effect.runPromise` rejects with `Cause.squash(cause)`**, which for a typed
  failure is the error instance itself. v3 wrapped it in a `FiberFailure` whose
  prototype was not the error class, so tests written then may assert
  `instanceof` is `false`. Under v4 it is `true`.
- **`Either` is `Result`**, and its tags are `"Success"`/`"Failure"`, not
  `"Right"`/`"Left"`. `expect(x._tag).toBe("Right")` compiles fine against
  `toBe`'s `any` and simply never matches, so it fails as a puzzling assertion
  rather than a type error.
- **`@effect/vitest`'s `assertFailure` changed meaning**: in v3 it asserted on
  an `Exit`, in v4 it asserts a `Result.Failure`, and the v3 behaviour moved to
  `assertExitFailure`. This repo uses neither, so nothing here is exposed — but
  a helper added from a v3 example would be asserting something else.

## Route Test Pattern

Route tests use plain vitest with a fresh app per test via `beforeEach`:

```typescript
// Route tests: plain vitest, fresh app per test via beforeEach
import { describe, it, expect, beforeEach } from "vitest";
import { createEventsRoutes } from "../../src/routes/events";

describe("events routes", () => {
  let app: ReturnType<typeof createEventsRoutes>;
  beforeEach(() => { app = createEventsRoutes(createTestLayer()); });

  it("GET /events -> 200", async () => {
    const res = await app.handle(new Request("http://localhost/events"));
    expect(res.status).toBe(200);
  });
});
```

## Rules

- **All tests use in-memory SQLite** -- no file DB, no migrations needed. Each test gets a fresh database via `createTestLayer()`.

- **Service tests: `it.effect` + `Effect.provide(createTestLayer())` per test.** Every test gets full isolation. Never share state between tests.

- **Route tests: `createXxxRoutes(createTestLayer())` in `beforeEach`.** Full isolation per test. The route factory accepts an optional `dbLayer` param for injection; the default is `DbLive`.

- **A cire route test that calls a rate-limited route passes its own limiter to `createApp`.** The limiters `createApp` defaults to (`defaultExportLimiter`, `defaultGiftExportLimiter` and their siblings in `cire/api/src/app.ts`) are module-level, so every test file in one `bun test` process spends the same per-user buckets. A file that downloads `seating.csv` a few times once pushed `tests/routes/organiser-changes.test.ts` past the export limit, 429 instead of 200, only in the full run. Build the app with `createApp(db, { exportLimiter: createRateLimiter({ maxRequests: 1_000, windowMs: 60_000 }) })`, and a `giftExportLimiter` as well for a file that downloads `gifts.csv`, as `tests/routes/organiser-weddings.test.ts` does; a test of the limit itself passes a small one.

- **OSN auth routes use `createAuthRoutes(authConfig, dbLayer?)`.** The `authConfig` parameter is required (no global default). `dbLayer` defaults to `DbLive`.

- **Use `bunx --bun vitest`** (not plain `vitest`) when you call Vitest yourself -- the flag is required for `bun:sqlite` module access. A package's own `test` and `test:run` scripts already carry the flags its tests need: most of those that run Vitest say `bunx --bun vitest`, and the few whose tests never load `bun:sqlite` call plain `vitest`.

- **Use future dates for test events.** For example, `2030-06-01T10:00:00.000Z`. The default `listEvents` implementation filters out past events, so tests with past dates will produce confusing empty results.

- **Never hand-write a DDL mirror.** Test databases are built from the live Drizzle schema via `applySchema()` (`@osn/db/testing`, `@pulse/db/testing`, `@zap/db/testing`) — never a `CREATE TABLE` string in a helper or a test file. A hand-written mirror makes constraint tests tautological: they assert the `UNIQUE` the author typed a few lines above, not the one the schema declares, so dropping `.unique()` from `src/schema` leaves them green. See [[#Schema-derived test databases]].

- **A test must fail for the reason it is named.** Before landing a test that asserts a side effect (a row written, a notice sent), break the code path and confirm the test goes red. `expect(true).toBe(true)` after an action asserts nothing. Ways that check is passed by a test which still cannot fail — a timestamp tie, a `waitFor`ed absence, a red-proof that ate its own fix, a route the app never mounted, a hand-written input where the driver's output belongs, and a helper that supplies the thing under test — are in [[#Assertions that cannot fail]].

- **Wait on the event, never on a fixed sleep.** A test that sleeps 10 ms for a forked fiber fails whenever a loaded CI runner takes longer. Have the forked effect resolve a `Promise.withResolvers()` promise and await that; if the work never runs, the test fails on Vitest's timeout ("is a no-op reference outside a request" in `osn/api/tests/lib/background.test.ts`).

- **Freeze the clock before the first read when asserting whole seconds.** Code that stamps a deadline in unix seconds, followed by a test that reads the real clock again to move time forward, gives a different answer whenever a second boundary falls between the two reads. Call `vi.useFakeTimers({ toFake: ["Date"] })` and `vi.setSystemTime(base)` before the code under test first reads the clock, then move by whole seconds ("a rotation late in the window" in `osn/api/tests/services/recovery-session.test.ts`). Fake only `Date`: faking every timer stalls Effect's scheduler.

- **Every Solid Vitest config names `shared/test-config/no-jest-dom.ts` in `setupFiles`.** `vite-plugin-solid` prepends `@testing-library/jest-dom/vitest` to `setupFiles` for every run, and only two things stop it — one of your own `setupFiles` paths matching the regex `/jest-dom/` (`getJestDomExport` in the plugin's `dist/esm/index.mjs`), or a browser-mode project, which it skips because Vitest's browser assertions carry the matchers already. That file is a marker whose whole job is to match the regex. It exports nothing and must stay that way; a package that wants real shared setup adds a second entry of its own. Since 2026-08 all 13 configs that import the plugin carry it, and `bun run check:jest-dom-markers` (the `Scripts` CI job) fails the build if one loses it. The guard is per **file**, not per project: `cire/host`'s browser project has no `setupFiles` and still takes the injection, which is harmless there because that package imports the matchers in eighteen files anyway.

- **When tests need a wider type surface than the shipped source, give them `tests/tsconfig.json`.** It extends `../tsconfig.json`, widens what the tests need (`bun-types`, a later `lib`), and the package's `typecheck` script runs it, with `bun check`, after the main config. The package's own `tsconfig.json` then covers only shipped source, so the compiler rejects what the runtime lacks. Name it `tests/tsconfig.json`, not `tsconfig.test.json` beside the main one: the editor looks for a file named `tsconfig.json` in the nearest ancestor directory, so a sibling config leaves test files on the repo-root `tsconfig.json`, which has no JSX or DOM settings. `cire/api`, `cire/invites`, `cire/dietary`, `cire/theme`, `shared/color`, `shared/db-utils`, `shared/design-tokens` and `shared/ui` use it — [[cire-development#Type-check configs]].

- **Import the matchers where you assert with them, and declare the dependency only there.** A test that uses `toHaveAttribute` or `toBeInTheDocument` writes `import "@testing-library/jest-dom/vitest";` at the top of the file, and its package lists `@testing-library/jest-dom` in `devDependencies`. Three packages do — `cire/host`, `cire/vendor` and `pulse/web`. Ten others declared it while importing no matcher and were pruned. Bun's install layout is not hoisted, so an undeclared dependency is unresolvable rather than quietly satisfied: the failure is a red `Cannot find module`, not a green suite. `tsconfig.json` already has the test files in `include`, so the matcher types resolve across a package from any one import. `tools/lab` is the deliberate exception — it leaves the plugin out entirely, so nothing injects and it needs no marker; the guard matches the import statement rather than the plugin's name so its comment about the plugin does not trip it.

- **Check the Bun version before you believe a failure that names no code you touched.** CI installs the Bun that `.bun-version` pins, so a different local Bun can fail a test on its own wording or behaviour while CI stays green. Compare `bun --version` with `.bun-version` first; a `SessionStart` hook runs [check-bun-version.sh](../../scripts/check-bun-version.sh), which warns at the start of every session when they differ. To rerun under the pin without changing the installed Bun, put that version's binary first on `PATH`. Most CLI tests under `scripts/tests/` start their child `bun` by name, so a binary run by its path alone leaves those children on the installed one; the few that start `process.execPath` follow whichever Bun runs the suite.

## Assertions that cannot fail

[[#Rules]] says a test must fail for the reason it is named. This is the
catalogue of how that goes wrong here. Every entry below was found by
deliberately breaking the code and watching the test stay green — never by
reading it. One epic produced four such tests and four destroyed fixes from
these three causes alone.

### Tautological tests

A tautological test passes whatever the code under test does, because it checks the test against itself. Do not write one; `review-tests` reports each as an untested export. The shapes:

- asserting what a mock or fixture was just told to return, with none of our code in between;
- computing the expected value by calling the function under test, or copying its formula;
- asserting a hand-written mirror — a `CREATE TABLE` string, a list typed out beside the constant it claims to check (see [[#Rules]] on DDL mirrors);
- an assertion that cannot be false: `expect(true)`, `toBeDefined()` on a value just built, a snapshot of a mock;
- asserting only that a mock was called, not what the call did.

The check is the same as for the entries below: break the line the test names, and it must go red. For cire code, [[#Mutation testing]] does the breaking for you.

### `created_at` is unix seconds, so rows written together tie

Four separate false greens in one epic, all the same shape.

A helper picked "the newest row" by sorting `created_at`. Two credentials
enrolled in the same second tied, so the test read the *parent's* value and
asserted it against the child — and an implementation that did the wrong thing
passed the one test written to catch it. Elsewhere every fixture was backdated,
so `<` and `<=` agreed on every row and a boundary went untested until a
same-second case was added.

Two rules follow:

- **Order by something exact.** Where a decision comes down to which row is
  newer, break the tie on an id the code already returns, not on the timestamp.
  A test that seeds two rows and expects a particular one to win must make the
  ordering explicit rather than hope the clock separates them.
- **Pass one `Date`, not two `new Date()` calls.** A tie test that calls
  `new Date()` twice is hoping both land in the same second. Build the value
  once and hand it to both seeds.

And where a comparison could flip — `<` against `<=` — seed the exact-equal
case. That is the only row on which the two operators disagree.

### `waitFor` calls its callback synchronously on the first attempt

`@testing-library/dom` runs the callback once, immediately, before yielding. So
this passes before anything has rendered:

```ts
// Green whether or not the guard exists.
await waitFor(() => expect(screen.queryByRole("button", { name: X })).toBeNull());
```

`toBeNull()` is already true on an empty document, `waitFor` resolves on the
spot, and a resource that would have rendered the button never gets a tick to
settle. Wrapping a racy absence check in `waitFor` is the same bug with more
ceremony — two such assertions were confirmed green 5/5 and 3/3 runs against a
deliberately reintroduced bug.

**Mount the case under test beside one that does render the thing**, wait for
that sibling to paint, then assert the absence. The wait then turns on a
condition that starts out false, so it has to observe a real render:

```ts
// The admitting twin is what makes the wait mean something.
renderAdmitting();
renderRefusing();
await vi.waitFor(() => expect(screen.getByRole("button", { name: X })).toBeVisible());
expect(screen.queryAllByRole("button", { name: X })).toHaveLength(1);
```

Under faked timers use `vi.waitFor`, not testing-library's — the latter schedules
against the `setTimeout` the fake clock has replaced.

### The seed and the failure result are the same value

A value that starts at its fallback, and whose failure path leaves it there,
cannot be tested by reading it. `createInviteRetry`
(`cire/invites/src/components/invite-retry.ts`) starts at `fallback()` and
writes nothing on a non-OK response, a thrown fetch or an unparseable body, which
is the point of it — a failed retry keeps what is painted. So this is green
whether the failure paths exist, rebuild the fallback instead, or map the
response anyway:

```ts
// The value already equals the fallback before the fetch settles.
expect(data()).toEqual(fallback);
```

Four things together make it able to fail, and all four are needed:

- **Wait for the handler to finish.** Stub the response so its body settles in
  microtasks (a plain object with `ok` and a `json` that returns a resolved
  promise), then wait one macrotask. Without the wait the read happens before
  the fetch has resolved.
- **Pair it with a success twin** that uses the same wait and asserts the value
  *changed*. That is what proves the wait is long enough to see a write at all.
- **Compare identity against one sentinel** (`toBe`, on a module-level object),
  not shape. `toEqual` cannot tell the painted value from a lookalike a failure
  path rebuilt.
- **Assert the mapper was not called.** A spy on `select` asserted
  `not.toHaveBeenCalled()` is the only thing separating a non-OK response from a
  successful one whose mapping happened to return the same value.

A sentinel cannot catch a failure path that calls `fallback()` again, because
the sentinel fallback returns itself. A call site's fallback builds a fresh
object on every call, so give one test a fallback that does the same and count
the runs of an effect that reads the value: a second run means a failed retry
handed every consumer a new object for the same data.

The same shape appears one layer up, in a component seeded from a prop: a test
whose stubbed response is `JSON.stringify(initial)` — the object it passed in —
asserts nothing about whether the component reads the response at all. Give the
response a **different** value and assert the new one wins and the old is gone.
Three of five planned tests and both design packs' headers were caught by this
in one branch.

### An out-of-type fixture that fails the comparison anyway

Feeding garbage to a clamp only tests the clamp if the garbage would otherwise
be visible. `clampNum` in the invite headers drops a non-number to a default,
and the panel it feeds renders only when the value is `> 0`:

```ts
// Green with the clamp, and green with the clamp deleted: "abc" > 0 is false,
// so nothing renders either way.
heroDisplay: { titleBackdrop: { opacity: "abc", blur: 0 } }
```

A **numeric string** is the fixture that can fail — `"60"` renders a 60% panel
if the guard is removed and nothing while it stands. The rule generalises: an
invalid fixture has to be one the broken code would treat as valid, or the test
passes for the wrong reason. Where the value under test is only observable
alongside another (here, a blur that is emitted only when the opacity is
non-zero), the other one has to be valid too.

### Commit before you red-proof

Breaking a guard to watch a test go red is the only way to know the test works.
Restoring with `git checkout -- <path>` while the work is **uncommitted**
restores `origin/main`, not the work — silently deleting the fix being proved.

Four people hit this in one epic. One noticed only because a test count changed;
another only because an unrelated test failed. Nothing announces it.

Commit first, then break, then `git checkout --` restores the commit. If the
change genuinely cannot be committed yet, copy the file aside and restore from
the copy. A read-only reviewer should mutate a copy of the whole worktree
instead — `cp -Rc` is a cheap clone on APFS — which also means an interrupted
review costs nothing.

### `document.activeElement` is `<body>` when nothing has focus

A test that a focus move landed asserted
`document.activeElement?.contains(notice)`. With the move deleted, focus stayed
on `<body>`, which contains the whole page, so the test stayed green. Assert the
element itself — `expect(document.activeElement).toBe(target)` — or at least
that it is not `document.body` before any `contains` check.
`cire/host/tests/components/HostsPanel.test.tsx` ("moves focus to the offer…")
shows the form.

### A route the app never mounted

A test POSTed to `/api/stripe/platform-webhook` on an app that did not mount it, and asserted the response was not 403. An Elysia `onBeforeHandle` hook never runs for a path the router does not match, so an unmatched POST returns 404 with or without the exemption under test. The assertion passed on the 404.
*Instead:* mount a stub route at the real path on a bare origin guard, as `cire/api/tests/lib/origin-guard.test.ts` does, so the hook is reached.

### Hand-written input where the driver's output should be

A test passed a literal error string containing an index name to the classifier that reads it. SQLite names the columns in a unique-violation message, never the index, so the production path could never reach the matching branch, and the test was green either way.
*Instead:* drive a real insert against the real index, and assert the message does **not** contain the index name, so the classifier cannot match on it.

### A test helper that supplies the thing under test

`appRequest` in `cire/api/tests/test-helpers.ts` adds an `Origin` header to every request. Any origin-guard test written through it passes whether or not the guard works.
*Instead:* build the request by hand for any test of a header the helper injects.

Each of these was caught the same way: revert the fix and watch the test go red. Two cautions. A revert made by text substitution must be confirmed applied before the result is trusted: `bun fmt` reflows code, so a multi-line pattern captured before formatting can fail to match, and the "mutation" never happens while the test stays green. And restore the fix before committing.

## Mutation testing

Every check in [[#Assertions that cannot fail]] comes down to one question: if
the line this test names were broken, would the test go red? [Stryker](https://stryker-mutator.io/)
answers it mechanically. It makes one small change to the source at a time —
`<` to `<=`, a condition to `true`, a string to `""`, a block emptied — runs the
tests that cover that line, and reports the change as **killed** (a test went
red) or **survived** (every test stayed green). A survivor is a behaviour no
assertion pins, found without anyone having to spot it.

Every `cire/*` package with tests has a `stryker/` directory holding its
Stryker config (`stryker/config.mjs`) and a
`test:mutation` script. Other products do not have it yet.

Outside cire, break the changed lines by hand: a scratch script swaps one line at a time for a broken form, runs the test file that covers it, and restores the file, checking its hash after the last swap. Confirm each swap matched, as [[#Assertions that cannot fail]] warns. It pays even after a failure-modes-first list. For the alchemy D1 import patch (`shared/infra/tests/d1-import.test.ts`), 19 cases, each seen red before the code, still let 8 of 11 hand mutants survive. The list named behaviours, and the survivors were mostly fields copied from one shape into another (`error: init.error` set to `undefined`), plus an error branch whose test reply, carrying no bookmark, also failed the next branch down with the same text.

*Measured 2026-10-26 — 11 one-line mutants of alchemy's patched `src/Cloudflare/D1/ImportDatabase.ts`, each run with `bunx --bun vitest run --project package tests/d1-import.test.ts -t "src copy"` in `shared/infra`*

### When to run it

When you write or change tests for cire source, run it on the lines you
changed, before calling the tests done. `--changed` mutates only the lines the
branch adds or changes under the package's `src/` — committed or not, plus any
untracked source file whole — so no time goes on mutants nobody will read. A
whole file is several hundred mutants (one `@cire/host` file is about ten
minutes); a whole package is hours and is for a baseline, not a branch.

```bash
# The lines this branch changed, against origin/main (on a stacked branch: --base <parent>)
bun run --cwd cire/host test:mutation --changed

# A file, several files, or a line range
bun run --cwd cire/host test:mutation --mutate src/lib/guest-event-draft.ts
bun run --cwd cire/vendor test:mutation --mutate 'src/lib/enquiry-inbox.ts,src/lib/theme.ts:20-48'

# @cire/api: also name the tests that cover the code — it will not start without them
STRYKER_TESTS=tests/lib/money.test.ts bun run --cwd cire/api test:mutation --changed
```

`test:mutation --help` lists the flags: `--changed`, `--base`, `--mutate`,
`--incremental`, `--dry-run` and `--concurrency`. Any other Stryker option goes
after `--` (`test:mutation --changed -- --logLevel debug`).

After adding a test, `--incremental` re-tests only the mutants whose code or
covering tests changed. Use it in the vitest packages only: the command-runner
packages report no coverage, so Stryker would keep every earlier survivor.

**`@cire/api` needs `--concurrency 3 -- --timeoutMS 60000`.** Each mutant runs
every `STRYKER_TESTS` file, and nine at once starve each other past Stryker's
default timeout. A timed-out mutant counts as killed, so such a run reports a
high score that proves nothing: one seating run reported 368 of 461 mutants
timed out and 92.6%, and the same run at three with a 60-second timeout had no
timeouts, 123 survivors and 73.3%. Read the `# timeout` column before the score.
Leave `tests/routes/tier-gate-pairing.test.ts` out of `STRYKER_TESTS`: it
parses the source files, which Stryker has instrumented, and fails the dry run.

*Measured 2026-10-26 — `bun run --cwd cire/api test:mutation --changed` on the
seating plans branch, at the default concurrency and again with the flags above.*

Run a long one in the background: the agent shell's foreground limit is ten
minutes, and an interrupted run only wastes the time already spent. The report
is printed as it finishes and written to `reports/mutation/mutation.html` in
the package (git-ignored).

### What to do with a survivor

Each survivor prints as the file (from the repo root), the line, and the change that survived:

```text
[Survived] EqualityOperator
cire/dietary/src/index.ts:224:7
-     if (labels.length < chosen.size) {
+     if (labels.length <= chosen.size) {
```

1. **Kill it.** Write the test that tells the two versions apart — here, the
   case where `labels.length` equals `chosen.size` — and run again. The new test
   must assert what a caller sees, never the mutated expression itself.
2. **Or name it equivalent.** Some mutants cannot change behaviour (a default
   that is overwritten on every path, a log message's wording). Leave it, and
   say why in the pull request; do not write a test that asserts a string only
   to kill a mutant. A guard is equivalent only while what makes it redundant
   is pinned: a re-entry check behind a button that disables while it runs is
   equivalent only if a test fails when the button stops disabling.
3. **Or name the browser test that kills it.** The `@cire/host` and
   `@cire/invites` runs leave the browser tier out (below), so a mutant a
   `*.browser.test.tsx` already kills still reports as a survivor. Run that
   test against the mutant once, then name it in the pull request beside the
   survivor. Do not copy the browser test into jsdom to raise the score: that is
   a unit test written after the code, and every later change to the component
   then edits both. A jsdom test is the answer only where no browser test
   reaches the behaviour: a path the browser tier's Chromium never takes, such
   as a browser without the popover API.
4. **Or name the E2E step that kills it.** Stryker never runs the E2E suite,
   so code only a flow reaches reports as a survivor or `NoCoverage`. Apply
   the mutant by hand, run that flow alone
   (`bun run test:e2e -- --grep <flow>`), restore the file and check its hash,
   then name the failing `flow.check` in the pull request beside the survivor.
   Do not add a jsdom test for a path the flow already proves.
5. **`NoCoverage` is worse than a survivor.** No test even ran the line.
   In a vitest package, a run that stops with `No tests were executed` is the
   same verdict for a whole file: Stryker runs only the tests that import the
   mutated file, and none does (`cire/landing/src/lib/site.ts`, used only by
   `.astro` pages, is one).

A score is not a target. Chasing 100% buys tests that assert log wording and
class strings; what matters is that no survivor sits on a line your branch
changed without one of the answers above.

### How the runners differ

| Packages | Runner | What it runs per mutant |
|---|---|---|
| `@cire/host`, `@cire/invites`, `@cire/vendor`, `@cire/ui`, `@cire/landing`, `@cire/build-tools`, `@cire/invite-designs` | `@stryker-mutator/vitest-runner` | only the tests that cover the mutated line |
| `@cire/api`, `@cire/db`, `@cire/dietary`, `@cire/theme` | Stryker's `command` runner | the whole command — `bun test`, or `@cire/api`'s `STRYKER_TESTS` |
| `@cire/infra` | Stryker's `command` runner | the whole suite, `bunx --bun vitest run`, under Bun: its tests evaluate the stacks with Bun's platform layer and read SQLite through `bun:sqlite`, which the vitest runner cannot, since it runs tests under Node. Four mutants at a time with a 60-second timeout: one per core starves each run past Stryker's default timeout. The sandbox keeps `musubi/`, whose declaration the cross-stack test imports, and `osn/`, whose `osn/api/wrangler.toml` it reads |

What the configs depend on, and what breaks without it:

- **Stryker runs on Node, not Bun.** Its binary is `#!/usr/bin/env node`, so the
  vitest packages' tests run under Node during a mutation run, not under
  `bunx --bun`. None of them use a `bun:` module today; one that does cannot be
  mutation-tested through the vitest runner.
- **Stryker's instrumenter runs on Babel 8, the Solid toolchain on Babel 7.**
  Both resolve side by side because every Babel range in the lockfile is a
  strict `^7` or `^8`. A root `overrides` entry for `@babel/core` forces one
  version on both and breaks one of them: under `^7` Stryker crashes while
  instrumenting.
- **The vitest runner is patched for Vitest 5**
  (`patches/@stryker-mutator%2Fvitest-runner@10.0.0.patch`). Stryker filters
  the tests to run per mutant by name, and Vitest 5 joins a test's suite chain
  with ` > ` where the runner joins it with a space, so unpatched every mutant
  runs no tests and survives. A run reporting `Ran 0.00 tests per mutant` is
  that failure. Bounded until englishstreetventures/osn#1520 lands.
- **Every vitest config names `@stryker-mutator/vitest-runner` in `plugins`.**
  Bun's isolated install hides the runner from Stryker's plugin discovery, which
  fails with "Cannot find TestRunner plugin".
- **Stryker runs from the repo root, not the package.** It copies its working
  directory into a sandbox (`.stryker-tmp-cire-<pkg>/` at the root) and mutates
  the copy, so the working tree is never touched. Run from the package, the copy
  would hold that package alone, and every path a test reaches outside it with
  — `../../shared/test-config/no-jest-dom.ts`, a contract test reading
  `../../../api/src`, a seed test running `../../../../scripts` — would resolve
  to nothing. [`tools/stryker`](../../tools/stryker/src/app.ts), which
  every `test:mutation` script calls, runs Stryker from the root with the
  package's config and rewrites `--mutate` paths from package-relative to
  root-relative. The options every config shares — what to mutate, what the
  sandbox leaves out, where the report goes — are in
  [`tools/stryker/src/options.mjs`](../../tools/stryker/src/options.mjs).
  Stryker does not read `.gitignore`, so that file's `ignorePatterns` keeps
  local secret files (`.env*`, `.dev.vars*`, keys) out of the copy. Do not switch a config to `inPlace`: it writes
  `// @ts-nocheck` into every source and test file for the length of the run,
  and leaves the mutated source behind if the run is killed.
- **Each vitest package runs `stryker/vitest.config.ts`**, which is its
  `vitest.config.ts` with `root` pinned back to the package — Vitest otherwise
  takes the root from Stryker's working directory.
- **`@cire/host`'s and `@cire/invites`' configs also drop the `browser`
  project**, because the vitest runner starts every project and a Chromium per
  mutant is not affordable. A
  mutant only the browser tier can kill reports as a survivor.
- **`@cire/host`'s script sets `TZ=Australia/Sydney`.** The vitest runner forces
  the `threads` pool, where a project's `env: { TZ }` cannot take effect, and the
  zone-dependent tests then fail the dry run.
- **`@cire/api` needs `STRYKER_TESTS`.** The full suite takes over a minute and
  boots workerd; the command runner would run it once per mutant, several at a
  time. Keep `tests/db/` out of it: a Miniflare test that times out is counted as
  a kill.
- **A Solid component's `ref` is a named function or a variable, never an
  arrow written in the JSX.** The instrumenter wraps every arrow in a condition
  that picks the mutant or the original, and Solid compiles a component's `ref`
  expression as written, so a wrapped one is never called. The dry run then
  fails on whatever the `ref` set up, though the plain suite passes.
  `SeatingView`'s print-sheet portal takes `ref={markPrintSheet}` for this.

## Kobalte overlays and the tests after them

The Kobalte menus, dialogs and popovers behind `@shared/ui` (see
[[component-library]]) mark everything outside themselves `aria-hidden` while
open and clear it when they close. Both writes run from a zero-delay
`setTimeout` that then requests an animation frame. Under happy-dom they can
still be queued when the test that opened the overlay ends, and land in a later,
unrelated test. `<body>` then carries `aria-hidden="true"`, and every
`getByRole` in that test fails with "There are no accessible roles". Whether a
test fails depends on where it sits in the file, so it shows up when someone
adds or moves a test, far from the overlay that caused it.

A suite that opens an overlay lets both writes run before the next test starts:

```ts
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => requestAnimationFrame(resolve));
});
```

`cire/host/tests/components/OrganiserApp.test.tsx` does this for its
profile-menu tests. Prove a fix like this with `--sequence.shuffle` under
several seeds, not with one green run in file order. Without the drain, that
suite failed in file order and under two of three seeds.

*Measured 2026-10-02 — drain removed, in `cire/host`: `bunx --bun vitest run --project unit tests/components/OrganiserApp.test.tsx --sequence.shuffle --sequence.seed=<1|7|42>`; seeds 1 and 7 failed, 42 passed*

## Schema-derived test databases

Every DB package exports an emitter that builds `CREATE TABLE`/`CREATE INDEX` from the live Drizzle schema:

```typescript
import { applySchema } from "@osn/db/testing"; // or @pulse/db, @zap/db

const sqlite = new Database(":memory:");
applySchema(sqlite);
```

Adding a column is then a one-file change in `src/schema/`. The emitter carries column-level `.unique()` (via `col.isUnique`), partial-index `WHERE` clauses, and foreign-key `ON DELETE`/`ON UPDATE` actions — all three were silently dropped before 2026-08, so tests ran on a shape production D1 rejects. The emitted array is memoised and frozen: the schema is a static module import, so reflecting it per test database was pure recomputation.

`osn/db/tests/ddl-lockstep.test.ts` diffs a normalised structural snapshot of the emitted schema against the full `osn/db/drizzle/*.sql` migration chain. It compares columns, types, defaults, nullability, indexes (**including column order within an index** — SQLite serves only a leading prefix), partial predicates, foreign keys and their referential actions, and pins CHECK/trigger/view sets as empty. It fails when a migration lands without a schema change, when a schema change lands without a migration, when the emitter loses a constraint, or when the migrations directory holds anything wrangler would not apply (a folder, a `meta/` journal) — the chain is replayed through `scripts/migration-files.ts`, in wrangler's order. `zap/db` has the same test; `cire/api/tests/db/ddl-lockstep.test.ts` covers cire's three-way mirror.

**If you extend one emitter, extend all three** — they are copies, and all three (`osn/db`, `pulse/db`, `zap/db`) now carry the lockstep test.

Writing pulse's found that a `user_id` → `profile_id` rename had reached `src/schema` without ever reaching migration `0000`, and three `events` columns existed with no migration at all — so `wrangler d1 migrations apply pulse-db` against a fresh D1 would have failed. Every Pulse test builds from `applySchema()`, so nothing exercised the chain until this test did.

When you write one of these, prove it can fail. Mutate the emitter — drop a constraint, reverse an index's columns — and confirm the test goes red. The first version of the osn test passed with every foreign key removed and with composite index columns reversed.

## Shared test harnesses

Reach for these before hand-rolling setup:

| Harness | Use for |
|---|---|
| `@shared/crypto/testing` → `makeAccessTokenSigner()` | ES256 OSN access tokens (`aud: "osn-access"`, 5-minute `exp` matching production). Returns `{ privateKey, publicKey, sign(profileId, claims?) }`; `claims` covers `email`, `audience`, `expiresIn`, `issuer`, `kid` for negative tests. Used by the pulse, zap and cire route suites. |
| `cire/api/tests/test-helpers/osn-token.ts` → `makeOsnTestAuth()` | The cire-shaped `{ key, sign }` adapter over the above. `sign(profileId, claims?)` takes the same claims, so a cire suite reaches the expired, foreign-issuer and wrong-audience reject paths. |
| `cire/api/tests/test-helpers/organiser-session.ts` → `seedOrganiserSession()` | A live `cire_org_session` token for a profile, minted by `organiserSessionService.create`, the function the OIDC callback calls. Send it as a `Cookie` with no bearer to test that an organiser route reads the cookie. |
| `cire/api/tests/test-helpers.ts` → `appRequest()` | Elysia requests with `cf-connecting-ip` + `Origin` pre-injected. |
| `cire/host/tests/test-support/mocks.ts` | The `@shared/rp-auth/solid` + `@shared/toast` + `lib/api` mock trio, their spies, and `resetOrganiserMocks()`. |
| `pulse/web/tests/helpers/toast.ts` → `toastMock()` | Same idea for the Pulse app. |
| `cire/invites/tests/test-support/consent.ts` → `seedConsentForTest()` / `resetConsentForTest()` | A returning guest's consent cookie, written with the app's own record encoder under the http name `cire_consent` (an https origin reads only `__Host-cire_consent`, so it ignores the seed), and a reset that deletes both consent cookie names and returns the store to before hydration. For any `cire/invites` suite that renders a consent-gated component on the default http origin. See [[cire-consent]]. |
| `cire/api/tests/test-helpers/metrics-harness.ts` → `counterValue()` | Reading a counter back in a `@cire/api` test. See [[#Asserting a metric]]. |

Call `makeAccessTokenSigner()` once per suite in `beforeAll` — there is no reason to re-key per test.

`vi.mock` is hoisted per module, so registration stays in the test file; only the factory body is shared. Use the dynamic-import form so the factory never reads an uninitialised binding:

```typescript
vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});
import { authFetchMock, redirectSpy, resetOrganiserMocks } from "../test-support/mocks";

afterEach(() => {
  cleanup();
  resetOrganiserMocks(); // the spies are module singletons — reset every one
});
```

Because the spies are shared, a `describe` block that forgets a reset inherits call counts from the block above it. Always call `resetOrganiserMocks()` rather than hand-listing the spies you happen to remember.

A suite that genuinely needs a different shape (an extra `useAuth` field, its own `redirectToLogin` spy) keeps its own local mock. These harnesses cover the common case; they are not a mandate.

A local mock of `lib/api` still spreads the real module and overrides only the exports it controls:

```typescript
vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    apiUrl: (path: string) => `https://api.test${path}`,
    redirectToLogin: redirectToLoginMock, // from vi.hoisted
  };
});
```

Never return an object that lists a few exports. The next export added to `lib/api` is then missing from the mock, and the failure does not point at the mock: Vitest throws `No "<name>" export is defined on the mock` when the component calls it, the component's own `try`/`catch` turns that into a load-error banner, and the test fails on a missing row. An override replaces that one export only; the real module's own functions still call each other, so the real `allAuthFirst` uses the real `isAuthExpired` whatever the mock overrides. The same factory works in the browser tier ([[browser-tests#Rendering]]).

## Asserting a metric

A metric test that does not install a meter provider asserts nothing.

`createCounter` (`shared/observability/src/metrics/factory.ts`) resolves its
meter through OpenTelemetry's **global** provider, and with none installed that
is the API's NoOp meter — which accepts every call and records nothing. So a
test written against it passes with the `metric*()` call deleted from the route,
which is the one failure a metric test exists to catch.

> [!warning] The instrument is cached on first use
> `createCounter` builds its instrument on the first `.inc()` and keeps it in a
> closure. A provider installed after that point is never consulted again for
> that counter. `bun test` runs every file in one process, so "first use" is
> process-wide: one earlier file's `.inc()` freezes the NoOp instrument in for
> every file after it.

`@cire/api` solves that with a **preload**, not an import — its `test` script is
`bun test --preload ./tests/test-helpers/metrics-harness.ts`, and a preload runs
before any test file. To run a few files, pass them through the script —
`bun run --cwd cire/api test tests/routes/invite.test.ts tests/services/invite-image-transform.test.ts`
— never a bare `bun test` with more than one file: that skips the preload, and a
metric test that runs after a route test reads zero and fails. The harness installs an in-memory `MeterProvider` backed by
an on-demand `MetricReader`, and exports one function:

```typescript
import { counterValue } from "../test-helpers/metrics-harness";
import { CIRE_METRICS } from "../../src/metrics";

const before = await counterValue(CIRE_METRICS.rsvpBlocked, { reason: "dietary_consent" });
await post(body, cookie);
expect(await counterValue(CIRE_METRICS.rsvpBlocked, { reason: "dietary_consent" })).toBe(
  before + 1,
);
```

Three rules come with it:

- **Read a delta, never an absolute.** The reader is cumulative and the provider
  outlives every file in the run, so a counter carries whatever earlier tests
  added. Read before, act, read after, assert the difference.
- **`attrs` is the whole attribute set**, not a subset — a data point is keyed by
  all of its attributes, and a partial match finds nothing.
- **`counterValue` throws** when the installed provider is not the harness's,
  rather than answering `0`. Without that the failure reads "expected 1,
  received 0" with nothing to say the harness never ran.

Running one file directly (`bun test tests/routes/rsvp.test.ts`) works without
the preload, because a file that reads a counter imports the harness and the
instruments are not built until the first `.inc()`. The preload is what makes the
**whole-suite** run safe.

Two things deliberately avoided, both for the same one-process reason:

- **`mock.module`** is global, so a mock of `../../src/metrics` in one file leaks
  into every file that runs after it.
- **`PeriodicExportingMetricReader`** would attach an interval to every run and
  make collection timing the test's problem. `MetricReader.collect()` is public,
  so a subclass with two inert hooks gives an on-demand read and no timer.

Constructing a raw OTel provider is allowed here because it is test code under
`tests/`. Source may still only reach instruments through
`@shared/observability/metrics` — see [[overview]].

`@osn/api`, `@pulse/api` and `@zap/api` have the same blind spot and no harness
yet; their metric suites today assert only that a call does not throw.

## The D1 integration lane

Each API package has a `tests/d1/d1-integration.test.ts` (cire's is `tests/db/d1-integration.test.ts`) that runs against a real workerd-backed D1 via Miniflare. They are the only coverage of the **asynchronous** D1 driver that dev/staging/prod actually use, as opposed to the synchronous `bun:sqlite` every other suite runs on. `shared/realtime` joins this lane too, though its `tests/d1/hub.test.ts` covers `TopicHub` on workerd rather than D1 — the hibernation API it exercises exists only in the runtime, so it needs the same Miniflare tier for the same reason.

How the fast tier avoids these files differs by runner, and the difference is worth knowing before you read a CI log:

| Package | Fast-tier runner | Does `bun run test` load the D1/Miniflare file? |
|---|---|---|
| `osn/api`, `pulse/api`, `zap/api`, `shared/realtime` | vitest | **No** — the configs `exclude: ["tests/d1/**"]`. Vitest cannot load these files at all: they import `bun:test`. |
| `cire/api` | bare `bun test` | **Yes.** `bun test` discovers recursively and takes no exclude, so the Miniflare suite runs twice per CI run — once inside `@cire/api#test`, once under `test:d1`. A workerd failure reddens cire's fast tier too, and a workerd timeout can stop it outright: see [[#Miniflare in cire's fast tier]]. `tests/db/migrate-wrapper.test.ts`, which runs real wrangler, skips unless `CIRE_D1_TIER=1`, which only `test:d1` sets. |

See [[realtime]] for what `hub.test.ts` covers.

```bash
bun run test:d1            # every D1/Miniflare package, serially
bun run --cwd zap/api test:d1
```

Run serially. Concurrent Miniflare workerd instances contend and fail spuriously, which is why the root script pins `--concurrency=1`. Both `ci.yml` and `deploy.yml` run this lane; before 2026-08 neither did, and zap's test sat failing on a stale fixture for as long as it took someone to run it by hand.

### Miniflare in cire's fast tier

`@cire/api#test` boots workerd in more files than the D1 suite: `tests/index.test.ts`, `tests/db/d1-session.test.ts`, `tests/db/query-error.test.ts` and `tests/services/r2-reconcile.test.ts` as well. Two things about them are easy to miss.

- **Proxied reads block.** `mf.getD1Database()` and `mf.getR2Bucket()` return proxies. A property read on a proxied object, such as a listed R2 object's `key` or `uploaded`, or a D1 statement's `prepare` and `bind`, is a synchronous round trip to workerd: Miniflare makes it with `Atomics.wait` on the test's main thread. A test that makes thousands of them takes a second on a laptop and tens of seconds when CI runs every package's tests at once.
- **A timeout is worse than a failure.** When a Miniflare-backed test outlives its budget, bun kills the file's workerd (the log says `killed 1 dangling process`), and the next proxied read waits forever. `bun test` never exits, and the CI job runs until its own timeout cancels it. Where the next read does return, it fails instead, and so does every later test in the file: osn/api's D1 file shows `The socket connection was closed unexpectedly` and `Attempted to use poisoned stub` after one timeout.

So keep bulk reads and writes inside workerd. Give Miniflare a small Worker script that does the work against its own binding and answers with plain JSON, as [r2-reconcile.test.ts](../../cire/api/tests/services/r2-reconcile.test.ts) does. Give every Miniflare-backed test a budget well above its time in a cold run of the whole suite. A change to `bun.lock` makes every turbo task miss its cache, so the next CI run is that cold run.

The R2 walk test read a thousand listed objects through the proxy and took 28–36 s against its 30 s budget in a cold run.

*Measured 2026-10-07 — `bun run test` on ubuntu-latest with no turbo cache, n=3*

### Seeding a Miniflare test

Keeping bulk work inside workerd holds for every Miniflare-backed file, not only cire's fast tier.

- **D1: send drizzle's SQL to the Worker.** Build the rows with drizzle as usual and call `toSQL()` on each insert: it returns the statement's text and its parameters already mapped to driver values. The file's Worker runs the list as one `env.DB.batch(...)` against its own binding, in order and all or nothing. `seedInWorkerd` in [osn/api's d1-integration.test.ts](../../osn/api/tests/d1/d1-integration.test.ts) does this. One row per statement keeps each under D1's 100 bound parameters ([[d1-limits]]). A test whose subject is drizzle's D1 write path still writes through `mf.getD1Database()`, since that path is what it proves.
- **Keep each request short.** After one request keeps workerd busy for about ten seconds, the next request bun's fetch sends over the same keep-alive connection fails with `TypeError: The socket connection was closed unexpectedly`. A request that only waits that long does not do it. A seed that writes everything in one request is quick on an idle machine and crosses that line on a busy one, so send it in slices: [r2-reconcile.test.ts](../../cire/api/tests/services/r2-reconcile.test.ts) writes 100 keys per request.
- **Set the budget once per file.** `setDefaultTimeout(ms)` from `bun:test`, called at the top of a file, gives every test and hook in that file the budget and reaches no other file in the same run. A third argument on each `it` does the same per test, as cire's D1 file does with `MF_TIMEOUT_MS`, but bun fmt then re-indents every test body that takes one.

The osn co-member fan-out test seeded 1,522 rows with about 3,000 proxied `prepare` and `bind` calls and took 4.7 s of its 5 s budget on an idle machine. Seeded in one request, it takes 0.5 s idle and under 1 s with every core busy.

*Measured 2026-10-21 — `bun test tests/d1/d1-integration.test.ts --reporter=junit` in `osn/api`, 4-core cloud container, idle and beside four `while :; do :; done` loops; n=1 before, n=5 after*

One request writing 7,000 R2 objects (13–18 s) broke the request after it 4 times in 4. The same objects in 100-key requests did not, and neither did one request that slept for 16 s.

*Measured 2026-10-21 — scratch Miniflare probe in `cire/api/tests`, 4-core cloud container, idle, n=4 each*

### D1's error shape in a bun test

On both drivers drizzle wraps a failed single statement in `DrizzleQueryError`, whose message is `Failed query: <statement>`. What sits on its `cause` differs:

| Driver | Error chain, outermost first |
|---|---|
| bun:sqlite | `DrizzleQueryError` → the database's error |
| D1, one statement | `DrizzleQueryError` → `D1_ERROR: <reason>` → the database's error |
| D1, `batch()` | `D1_ERROR: <reason>` → the database's error (no `DrizzleQueryError`) |

*Measured 2026-10-21 — scratch probe in `cire/api/tests`: one unique conflict on Miniflare D1 and on bun:sqlite, each error's `cause` chain printed*

Code that reads the reason from `String(e)` misses it on every driver, and code that reads a fixed depth of `cause` can pass on bun:sqlite and miss on D1. That is why cire reads it through `driverErrorText`, which walks the whole chain ([[cire-development]]).

Two helpers in [cire/api/tests/test-helpers.ts](../../cire/api/tests/test-helpers.ts) let a bun:sqlite test reach those paths without Miniflare:

- `failLikeD1(db)` gives every statement `db` runs from then on D1's one-statement chain when it fails: it puts the database's error inside a `D1_ERROR: <reason>` error, which drizzle then wraps. That covers the statements the bun:sqlite fallback of `commitBatch` runs one at a time too, though a real D1 `batch()` failure is not wrapped.
- `beforeStatement(db, pattern, write)` runs `write` once, just before `db` prepares the first statement matching `pattern`. That stands in for another request's write landing between this request's read and its own write: the race a unique index exists to settle. The hook is spent before `write` runs, so `write` may insert into the same table. It hands each statement on to the `query` the client had when it went in, so after `failLikeD1` both apply.

The route tests for the upgrade checkout and the vendor directory's add use both; the account link's uses `failLikeD1`. The D1 lane still proves the real wording: `tests/db/d1-integration.test.ts` "unique conflicts over D1" drives each conflict on Miniflare.

## Testing an oxlint rule

`tools/oxlint/house` holds the repo's own oxlint rules. Its tests lint fixtures
instead of calling a function, and its `test` script is `bun test`, not vitest:
like every package whose `test` script is `bun test`, run them with
`bun run --cwd tools/oxlint/house test`, not `test:run`.

`@oxlint/plugins` ships no `RuleTester` — the package is four files and exports
`definePlugin`, `defineRule` and `eslintCompatPlugin`, nothing else. So a rule
test writes its fixtures to a temp directory along with a config that enables
that one rule, runs the real `oxlint` binary over them, and asserts on the JSON:

```jsonc
{
  "diagnostics": [
    {
      "message": "…",
      "code": "house(no-in-operator-key-guard)",
      "severity": "error",
      "filename": "/abs/path/bad.ts",
      "labels": [{ "span": { "offset": 118, "length": 12, "line": 4, "column": 9 } }]
    }
  ]
}
```

Four things about that output are worth knowing before you write assertions:

- **`code` is `plugin(rule)`**, not `plugin/rule` — the config key and the
  diagnostic code are spelled differently.
- **`filename` is absolute**, so match on the basename.
- **oxlint exits non-zero when it finds anything.** Read stdout and ignore the
  exit code; treating it as failure makes every red fixture look like a crashed
  run.
- **The plugin `specifier` in the temp config must be an absolute path.** The
  `cwd` may be the temp directory: `@oxlint/plugins` resolves from the plugin
  file's own location, not the config's.

Turning the whole `correctness` category off in that config (`"categories":
{"correctness": "off"}`, `"plugins": []`) is what keeps a fixture's other
problems out of the result, so the assertion is about the rule under test.

Fixtures earn their place by pinning a decision. `no-in-operator-key-guard`
matches the parameter a type predicate narrows, not the literal
`is keyof typeof MAP` syntax, so it carries a fixture for the aliased form the
repo actually contains — and negative fixtures for `#brand in value` and for a
string-literal discriminant, both of which are also `in` inside a predicate and
both of which must stay silent.

The rule itself is wired into `oxlintrc.json` as a second `jsPlugins` entry, so
`bun run lint` runs it over the whole repo like any published rule.

## Testing a script that runs another program

A `scripts/*.ts` file with an `import.meta.main` block that spawns a program
(wrangler, drizzle-kit, `gh`) has two halves. The pure half is tested by
importing it. The CLI half decides what reaches the program and what the
script exits with, and it needs a program to talk to, but not the real one.
Left untested, it is where a change that ignores a refusal or swallows an exit
code passes a suite that covers only the pure half.

- Copy the script byte for byte into a temporary tree shaped like the
  repository, so its `import.meta.dir`-relative paths resolve inside the tree.
  Symlink in anything it only reads.
- Put a stand-in where the script looks for the program, for example
  `cire/api/node_modules/.bin/wrangler`: a bash script that appends its working
  directory and arguments to a log, then prints and exits with whatever files
  the test wrote. `kill -9 $$` in the stand-in gives a signal exit.
- Run the copy with `process.execPath run`, then assert on the exit code,
  stderr and the log — including that a refused case never logged the call it
  must not make.
- Each test builds its own tree, so `describe.concurrent` is safe. On macOS,
  `realpathSync` the temporary root: `/var` links to `/private/var`, and the
  stand-in reports the real path.

Nothing in the script points it at the stand-in — no flag, no environment
variable — so the code under test is the code CI runs.
[cire-db-migrate.cli.test.ts](../../scripts/tests/cire-db-migrate.cli.test.ts)
is the worked example. A run against the real program that needs a database
belongs in the D1 integration lane above.

A stand-in proves what reaches the program, never how the program takes it.
After changing a flag or a variable the script passes, run the real program
once: a stand-in that logs `wrangler dev --env-file <a path that does not
exist>` passes every test, and the real Wrangler refuses to start
(`node: <path>: not found`).

## Reading TypeScript from a test

TypeScript 7 exports no in-process compiler API: `import ts from "typescript"` gives only `{ version }`. A test that parses source or reads a tsconfig uses the client API, which talks to the native compiler in a child process, and which client works depends on the runtime the test runs under:

| Client | Under `bun test` | Under Vitest (Node) |
|---|---|---|
| `typescript/async` (`await api.createSourceFile(…)`) | Works | Works |
| `typescript/sync` (`api.readConfigFile(…)`) | Throws at `new API()`: it needs Node's child-process stream handles | Works |

Create one `API` per file and close it in `afterAll`: each instance is a process. AST guards come from `typescript/ast/is` (`isCallExpression`, `isStringLiteralLikeNode`), and a node walks with `node.forEachChild(visit)`. To ask which files a program loads, run `node_modules/.bin/tsc -p <dir> --listFilesOnly` (add `--runExternalCode` for an Astro site). `cire/api/tests/routes/tier-gate-pairing.test.ts` (async, under Bun) and `cire/invites/tests/browser-floor.test.ts` (sync, under Vitest) are the two shapes.

## Running Tests

```bash
# All tests
bun run test

# Package-specific (run once)
bun run --cwd pulse/api test:run
bun run --cwd osn/api test:run
bun run --cwd osn/client test:run
bun run --cwd osn/auth-ui test:run
bun run --cwd shared/ui test:run          # unit project only
bun run --cwd pulse/db test:run
bun run --cwd zap/api test:run
bun run --cwd zap/db test:run

# Watch mode
bun run --cwd pulse/api test

# The browser tier, per package
bun run --cwd shared/ui test:browser

# The end-to-end suite (boots the stack; stop `bun run dev` first)
bun run test:e2e
bun run test:e2e:repro                     # twice, results.json compared byte for byte

# Mutation testing, cire only, scoped to the lines this branch changed
bun run --cwd cire/host test:mutation --changed
```

`@shared/ui` runs the two-project split — `unit` and `browser` — that
`@cire/host`, `@musubi/social` and `@pulse/web` also run, so its `test` and
`test:run` scripts name `--project unit` and the Chromium tier is the separate
`test:browser` script. `@osn/auth-ui` has one plain config and therefore no
`test:browser` to run.

## Related

- [[backend-patterns]] -- service and route layer architecture
- [[schema-layers]] -- Elysia TypeBox vs Effect Schema
- [[commands]] -- full CLI reference
- [[devloop-urls]] -- the fixed ports the E2E suite boots on
