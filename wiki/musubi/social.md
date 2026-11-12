---
title: Social
description: Musubi app — identity and social-graph management UI
tags: [app, identity, social-graph]
status: active
packages:
  - "@musubi/social"
related:
  - "[[osn-core]]"
  - "[[authorize-ui]]"
  - "[[social-mobile-ux]]"
  - "[[oidc-provider]]"
  - "[[production-deploy]]"
  - "[[musubi-identity-migration]]"
  - "[[social-graph]]"
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[rate-limiting]]"
last-reviewed: 2026-11-11
---

# Social

`@musubi/social` is a SolidJS web app for managing your Musubi identity and social graph. It is the first app dedicated to the cross-app identity layer — separate from Pulse (events) and Zap (messaging), which keep their own domain UI.

## Architecture

```
@musubi/social (SolidJS + Vite, port 1422)
  ├── SolidJS frontend (src/)
  ├── Consumes @osn/client, @shared/ui and @osn/auth-ui
  └── Talks to @osn/api (port 4000) directly over REST
```

The app ships as a web build only.

## Pages

| Route | Component | Purpose |
|---|---|---|
| `/` + `/connections` | `ConnectionsPage` | All connections, pending requests, close friends, blocks (tabbed) |
| `/search` | `SearchPage` | People + organisations search (`GET /recommendations/search`), grouped under section headings, with real action buttons. The mobile shell's Search tab; reachable at any width |
| `/discover` | `DiscoverPage` | Contact suggestions (`GET /recommendations/connections`) — mutual connections and shared organisations, each card saying which. See [[social-graph]] |
| `/organisations` | `OrganisationsPage` | Orgs the user owns or belongs to; create new |
| `/organisations/:handle` | `OrgDetailPage` | Org detail + member management, addressed by handle like every organisation route. Any signed-in profile sees the organisation; only members see its roster (the API answers anyone else `403`, and the page says so). A handle with no organisation shows "Organisation not found." |
| `/settings` | `SettingsPage` | Profile / Account / **Security** (passkeys — add, rename, delete — then the authenticator app, then recovery codes; each change step-up gated) / Connected apps tabs. Which tab opens comes from the URL fragment (`/settings#security`), read off the router's location — so a deep link from another origin, Back/Forward, a tab click and an in-app link to a tab all behave the same. The Security tab is lazy-loaded (`SecuritySection` chunk). The WebAuthn wrappers each view uses are in [[#Where the WebAuthn runtime ships]]. |
| `/authorize` | `AuthorizePage` | The OIDC consent screen — another app asking to sign the user in with their Musubi account. Lazy-loaded, and the one route on a **bare layout**: no sidebar, nothing to click but the decision. Full contract in [[authorize-ui]]. |

`BARE_ROUTES` in `src/App.tsx` is the allow-list that strips the sidebar. Add
a route there only when leaving the flow would be a security problem.

The app has two shells split at the `md` (768 px) breakpoint: the 240 px
left rail on desktop, and a bottom-tab-bar + top-bar shell on mobile
(`MobileNav` / `MobileTopBar`, nav items shared via `nav.tsx`; dialogs render
as bottom sheets through `ResponsiveDialogContent`). Each shell is a lazy
chunk; until it lands, `Layout` draws a frame of the same box
(`ShellFrame.tsx`), so the page does not move. The sign-in, create-account and
profile-switcher dialogs are mounted once above the shell switch
(`ShellDialogs.tsx`, which loads all three as one lazy chunk,
`ShellDialogSet.tsx`), and the shell waits for that chunk too, so no Sign in
button shows before its dialog can open; a later load that succeeds mounts
them. A signed-out page's own Sign in (`SignedOutNote`) reads
`useShellDialogs().ready()` and stays `invisible` until the dialogs have
mounted, so it holds its place and offers no dialog that cannot open. Every app dialog gives focus back to the control that opened it
(`ResponsiveDialogContent`). Each page in the shell (every route but
`/authorize`) names the browser tab after its `h1` through `usePageTitle`
(`src/lib/page-title.ts`).
The mobile UX audit and the design rules the responsive work follows live in
[[social-mobile-ux]] and `DESIGN.md` §Responsive layout.

## Account-health banners

Two banners sit above the page on every non-bare route once a session exists,
mounted from `AccountBanners` in `src/App.tsx` rather than from any one page.

| Banner | Shows when | Source |
|---|---|---|
| Security events | The account has an unacknowledged `security_events` row | `@osn/auth-ui/SecurityEventsBanner`, wired by `src/components/SecurityEventsBannerMount.tsx` |
| Recovery-code prompt | `GET /recovery/status` returns `generatedAt: null` — the account has never generated a set | `src/components/RecoveryCodesPrompt.tsx`, app-local |

**Only one shows at a time, and security events win.** An unacknowledged event
describes something that already happened to the account and costs a step-up
ceremony to clear, so it stays until the user deals with it; a recovery-code
offer is housekeeping. The prompt waits for a *settled* count from the events
banner rather than an empty one, so it never appears for an instant and then
gives way to an event that was still in flight. Coexistence would be ordinary
rather than rare: most of the kinds in `SecurityEventKind`
(`shared/observability/src/metrics/attrs.ts`) — adding a passkey, enrolling an
authenticator, signing in from a second device — sit happily on an account with
no recovery codes.

> [!warning] The banners are behind a session check **and** a `lazy()`, in that order
> They reach `@simplewebauthn/browser` through the step-up ceremony. `lazy()`
> calls its import thunk on first render and `Show` reads its children only when
> the condition holds, so a signed-out visitor fetches none of it and
> `/authorize` — which renders the bare layout and never reaches this code —
> pays nothing. Putting the stack in an eagerly-evaluated prop, a `fallback`
> among them, would fetch it for everyone and show nothing for it.
> `musubi/social/tests/webauthn-chunks.test.ts` pins the gate's static imports
> to an allowlist for that reason.

The prompt's dismissal is a `localStorage` key per profile id,
`musubi:recovery-codes-prompt-dismissed:<profileId>`. Per profile rather than
per account because no account id ever reaches the client — the access token
carries `sub`, `email`, `handle` and `displayName` and nothing else. The account
email is the only account-wide identifier available, and a key built from it
would leave one person's address in storage for the next person on a shared
device. A dismissed prompt makes no request at all.

Nothing caches "this account has codes". `generatedAt` looks monotonic and is
not: scheduling an account deletion erases every recovery code, and cancelling
inside the grace window restores the account without re-minting them, so a live
account can go from a timestamp back to `null`. See [[recovery-codes]].

`AccountBanners` wraps the pair in an `ErrorBoundary` that renders nothing. Both
banners read endpoints limited to 30 requests a minute **per IP**, a Solid
resource rethrows its fetch error on read, and shell code has no page-sized
blast radius: one 429 on a shared address would otherwise blank every route.

Each route renders inside `PageErrorBoundary` (`src/components/PageErrorBoundary.tsx`),
below the banners, so a page that throws while it renders shows "This page
didn't load." with Try again in the content column, and the rail, the tab bar
and the banners stay drawn. It resets on its own when the path changes, never
shows the error's text, and imports nothing from `@osn/client`: it is in the
entry chunk `/authorize` downloads too.

Above the banners, `ShellNotices` (`src/components/ShellNotices.tsx`, loaded
with the shell, never on `/authorize`) says two things about the session
itself: "You've been signed out." with Sign in when the session ends (see
[[#Auth]]), and "Your profiles didn't load." with Try again when the account's
profile list fails. `AuthProvider` keeps the last list it had when a list
fails, so the shell drawn from it stays drawn, and exposes the failure as
`profilesError` and the retry as `refetchProfiles` (`osn/client/README.md`).
How each looks: `musubi/social/DESIGN.md` §Empty states and failed loads and
§Auth surfaces.

## Search surfaces — two ARIA patterns, deliberately

The rail (`GlobalSearch`) and the page (`SearchPage`) render the same results under different accessibility contracts, because the two patterns are mutually exclusive:

- **Rail = combobox + listbox.** Activation runs through virtual focus (`aria-activedescendant` + Enter), and an ARIA listbox option may not contain operable descendants — assistive tech flattens an option to its accessible name, so a nested button or link is announced as text and cannot be triggered. So the option **is** the target (click or Enter), the Connect/Accept text is a non-interactive label, and each option carries an `aria-label` naming what activating it does ("Alice A, @alice, accept connection request"). An option cannot take focus, so the results panel cancels `mousedown`: a press keeps focus in the field, the field's `focusout` does not close the panel, and the click lands on the option. A press outside the panel still blurs the field and closes it.
- **Page = plain list.** No virtual focus, no listbox constraint, so it keeps real `<Button>`s and a real `<A>` per row.

`PersonAction`'s `interactive` prop is what switches between them. Changing one surface to match the other is almost always wrong — check which pattern you're in first.

## Client surface

Pages talk to `@osn/api` via three Promise clients from `@osn/client`, built in `src/lib/api.ts` with the page runtime's `authFetch` (`src/lib/auth.ts`, `osnAuth`):

- `createGraphClient` — connections, pending requests, close friends, blocks (`osn/client/src/graph.ts`)
- `createOrgClient` — org CRUD and membership (`osn/client/src/organisations.ts`). Every method returns its route's success body as sent, and addresses an organisation and a member by handle. `osn/client/tests/organisations-contract.test.ts` holds the client to `shared/openapi/osn.json`: each call reaches a route the spec has, with query keys and a body it accepts, and `OrgSummary` and `OrgMember` name the fields the routes answer with. It runs as the package's `test:repo` project, which turbo reruns when the spec changes
- `createRecommendationClient` — contact suggestions + search (`osn/client/src/recommendations.ts`). `search` returns people and organisations together and takes an `AbortSignal` because it backs typeahead: the caller aborts the in-flight request when the query changes, so a slow early keystroke can't land after a fast later one.

All three share the same hardening: `authGet/authPost/authPatch/authDelete` with `safeJson` wrapping (no `SyntaxError` leakage), capped error strings, and per-module typed error classes. The helpers live once in `osn/client/src/auth-fetch.ts`, which every REST client in the package builds its errors with except `authorize.ts` (the consent screen, with its own timeout and error codes); `service.ts` reads bodies through `response-body.ts`, below. Each of these three modules calls `createAuthFetchers(ErrorCtor, authFetch)` and gets back the set bound to its own error class. Every REST client's error class extends `OsnApiError` and carries the response's HTTP `status` (`0` when no response arrived) and the server's `error` `code`, and a success whose body is not JSON throws rather than resolving `null`. A rejection of `authFetch` about the session (`AuthExpiredError`, `TokenRefreshError`, `ActiveProfileResetError`, `StorageError`), or the caller's own abort, reaches the caller unchanged; any other rejection becomes the client's error at status `0`. `ProfileManagementError`, which `OsnAuthService`'s profile calls fail with, is an Effect tagged error, not an `OsnApiError`: it carries `status` and `code` as optional fields, and neither when the call failed before any request or when a success body failed to decode. `OrgDetailPage` reads `OrgClientError`'s `status` to tell a missing organisation (`404`) and a roster a non-member may not read (`403`) from any other failure. `auth-fetch.ts` and `response-body.ts` are internal: `index.ts` exports neither. Their requests say `credentials: "same-origin"`: `authFetch` defaults to `"include"`, and these routes read no cookie, so the session cookie stays off them.

Each client calls `createAuthFetchers` **inside** its `create*Client` factory, not at module scope. This is load-bearing for bundle size, not style. A top-level call is a statement a bundler cannot drop, so it pinned all three modules into the entry chunk of every app importing the barrel — `musubi/social` paid about 0.9 KB gzipped on first paint. A `/* @__PURE__ */` annotation does **not** rescue it: neither esbuild nor rolldown will remove a declarator whose binding is a destructuring pattern. Keep the call inside the factory.

Two more module boundaries in `@osn/client` exist for the same reason, since rolldown splits chunks by module. `OsnApiError`, the base every REST client's error extends, lives in `api-error.ts`, which imports nothing: in `errors.ts`, beside the Effect tagged errors, it would pull Effect into every client module and split a new shared chunk onto first paint (about 1.5 KB gzipped). `safeJson` and `errorCode` live in `response-body.ts`, so `service.ts`, which every app loads at start, reads a response body without pulling the rest of `auth-fetch.ts` into the entry chunk.

*Measured 2026-11-07 — `bunx --bun vite build` in `musubi/social`, gzip of the entry chunk plus every chunk it imports statically: 49,903 bytes with no `OsnApiError`; 51,952 with it in `errors.ts` and `safeJson` in `auth-fetch.ts`; 50,441 with `api-error.ts` alone; 50,059 with both modules.*

*Re-measured 2026-11-07 — the same build, with `main` at `98a302733`; the entry chunk imports no other chunk, and Node's `zlib.gzipSync` at its default level gives 50,405 bytes with `osn/client` and `osn/auth-ui` checked out from `98a302733` (no `OsnApiError`) and 50,589 with both modules.*

The two delete shapes are deliberately different and must not be merged. `graph.ts` uses `authDelete`, which parses and returns the JSON body; `organisations.ts` uses `authDeleteVoid`, which reads the body only on the error path. Both sets of routes answer `200` with `{ ok: true }` — the difference is that `OrgClient` declares `deleteOrg` and `removeMember` as `Promise<void>`, so that client discards the body rather than there being no body to read.

## Dev

```bash
bun run dev:social             # starts @musubi/social + @osn/api together
bun run --cwd musubi/social dev   # social only (:1422)
```

Environment variables (all prefixed `VITE_`):

- `VITE_OSN_ISSUER_URL` — defaults to `http://localhost:4000`
- `VITE_OSN_CLIENT_ID` — defaults to `social`

## Deployment

Served at the apex **`https://musubi.social`**. The `sites` job in
`.github/workflows/production-release.yml` builds it, and the musubi stack deploys that
build to the **`osn-social`** Worker, which is `worker` in
`shared/infra/src/production-sites.ts` and serves the apex since release 42817386650
(2026-11-10); the `osn-social` Pages project it moved from is deleted
([[production-deploy]] §5.7). `record-osn-social` records each production
deploy whose smoke check passed. On dev the musubi stack serves it as the
`osn-social-dev` Worker, with static assets, on `musubi.<DEV_DOMAIN>`: `deploy.yml`'s
musubi stack job builds and deploys it on every merge to `main` that touches it,
and `deploy-osn-social-dev` records the deploy once its smoke check passes. The
Worker serves deep links through its single-page not-found handling, not the
`_redirects` file Pages reads ([[infrastructure-as-code#Sites]]). See
[[production-deploy]] and [[dev-environment]].

The Worker signs people in only on the apex: the session cookie is host-only on
`id.musubi.social`, and osn-api's CORS and WebAuthn accept only `https://musubi.social`,
an origin, not the server behind it ([[infrastructure-as-code#Production sites]]). Its
smoke check asks static paths alone:
`/`, a deep link, and `/.well-known/apple-app-site-association`, which must come back
as `application/json`. That file sits in a dot-directory, so the release's build
artifact keeps hidden files; without it iOS stops offering the app's passkeys on the
site's host.

The host is not cosmetic, on two counts.

**Cookies.** `@musubi/social` serves `/authorize`, the OIDC consent screen, and
that page only works under the **same registrable domain as osn-api**: the
`__Host-osn_session` cookie and the per-request binding cookie
`__Host-osn_oar_<12hex>` are host-bound to `id.musubi.social` and `SameSite=Lax`,
so they ride along on credentialed fetches from `musubi.social` but not from a
`*.pages.dev` host. The apex is therefore in both osn-api allowlists —
`OSN_ORIGIN` (it runs passkey ceremonies) and `OSN_CORS_ORIGIN` (every call it
makes is cross-origin). See [[authorize-ui]] and [[oidc-provider]].

**The RP ID.** `OSN_RP_ID` is the registrable apex `musubi.social`, so this app is
the one surface that can run a WebAuthn ceremony — a ceremony is only legal on
an origin same-site with the RP ID. Putting the app on `id.musubi.social` instead
would have barred the apex from ever running one. The apex also covers every
future `*.musubi.social` surface with a single credential.

- `VITE_OSN_ISSUER_URL` is baked in **at build time** (`https://id.musubi.social`
  in the release's `sites` job). Unset, the bundle dials `http://localhost:4000` and the
  deployed app calls the visitor's own machine.
- `public/_redirects` rewrites every path to `index.html` (200) so client-side
  routes deep-link on Pages (the Worker serves them through its single-page fallback); `public/_headers` ships the framing denial, and the build
  adds the script and connection rules to it ([[#Response headers]]).
- The musubi stack attached the apex to the Worker on deploy, once the owner had taken
  it off the Pages project — see [[production-deploy]] §5.4.
- **No feature-branch preview.** `deploy-osn-social-preview.yml` (project
  `osn-social-preview`) was removed on 2026-07-27. A `*.pages.dev` preview could
  never sign anyone in — the RP ID is `musubi.social` and the `__Host-` session
  and OIDC binding cookies are host-bound to `id.musubi.social` — so it could
  only be looked at, while still spending a prod-scoped Cloudflare token on every
  branch push (the open S-M `preview-ci-prod-token` finding). Review social
  changes locally with `bun run dev:osn`. If one is ever reinstated it must
  target its own project, never `osn-social`, whose production deployment serves
  a live hostname.

The move from `id.cireweddings.com` happened 2026-07-27 — see
[[musubi-identity-migration]].

## Auth

Uses `AuthProvider` from `@osn/client/solid` with the standard OSN passkey-primary login model — see [[passkey-primary]]. `src/lib/auth.ts` builds the page's one auth runtime, `osnAuth`; both providers (the shell's and the consent screen's sign-in island) take it, and every authenticated client in `src/lib/authClients.ts` and `src/lib/api.ts` is built with its `authFetch`, so no component holds or sends a token. Access tokens live only in the page's memory, and storage holds no token at all ([[identity-model#Client Storage Model]]); the refresh token lives in an HttpOnly cookie, and a reload gets its token from it. `authFetch` renews the token before it expires and on a 401, and a refused renewal signs the page out — see [[sessions#Renewal in the browser]]. The page says so: the runtime tells `onSessionChange` listeners the session `ended`, and `ShellNotices` shows "You've been signed out." with a Sign in button that opens the sign-in dialog — once, however many requests failed, and cleared by the next session. Another tab's sign-out, or a sign-in to another account there, ends this tab's session the same way, so every other open tab says it too. A log out from this tab, and a cold load with no session, show nothing. The notice opens the sign-in dialog through `useShellDialogs()` (`src/components/ShellDialogs.tsx`), the one the shell's own buttons open. Resources key on the `session()` object, which a renewal does not replace, so a renewal refetches nothing. A "Lost your passkey?" link routes to the recovery-code login form.

### Where the WebAuthn runtime ships

`@osn/auth-ui`'s `SignIn` and `Register` import `startAuthentication` and
`startRegistration` from `@simplewebauthn/browser` themselves, and
`RecoveryLoginForm` imports `browserSupportsWebAuthn`. The views that run a
ceremony for a signed-in account (`StepUpDialog` and the views that open it),
and `RecoveryLoginForm`'s passkey enrolment, take a runner from the host
instead. This app passes three:

| Module | Ceremony | Reached from |
|---|---|---|
| `src/lib/webauthn-ceremony.ts` | assertion (step-up) | `SecurityEventsBannerMount`, `SecuritySection` |
| `src/lib/webauthn-registration.ts` | attestation (passkey enrolment) | `SecuritySection`, and the deferred wrapper below when its ceremony runs |
| `src/lib/webauthn-registration-deferred.ts` | attestation, importing `webauthn-registration.ts` only when the ceremony runs | `AuthDialogs`, `AuthorizeSignIn` (passed to `SignIn` for recovery enrolment) |

They are two modules, not one, because `SecurityEventsBannerMount` mounts on
every route a signed-in user opens (see [[#Account-health banners]]) while
`SecuritySection` loads only on the Security tab. A single module would drag
the enrolment code into the banner's chunk, and it would now do so for every
signed-in visitor rather than only the ones who opened Settings.

The source split alone does not hold through the bundler. `@simplewebauthn/browser`
exports both methods through one barrel (`esm/index.js`) and ships no
`"sideEffects": false`, so Rollup keeps that barrel — and therefore both methods
— alive in any chunk naming either one. `musubi/social/vite.config.ts` fixes both
halves: a build-only plugin marks the barrel `moduleSideEffects: false` (its body
is nothing but `export *` lines), and `manualChunks` puts each method file in its
own named chunk. A production build then emits `webauthn-authentication` and
`webauthn-registration` separately, and neither is in the entry bundle's eager
set.

## Response headers

`musubi/social/public/_headers` is served on every path, by Pages and by the
musubi stack's Worker alike: `frame-ancestors 'none'` plus
`X-Frame-Options: DENY` (a consent screen must never be framed),
`X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin`.

The build appends two directives to the Content-Security-Policy in `dist/_headers`
(`contentSecurityPolicy` in `musubi/social/vite.config.ts`), because both depend on
the build:

| Directive | Sources |
|---|---|
| `script-src` | `'self'`; a `sha256-` hash of each inline script in the built `index.html` (the theme script); `https://challenges.cloudflare.com` when the build carries `VITE_TURNSTILE_SITEKEY` |
| `connect-src` | `'self'` and the issuer origin from `VITE_OSN_ISSUER_URL` (`http://localhost:4000` when unset, as `src/lib/auth.ts` reads it) |

No `'unsafe-inline'`, no `'unsafe-eval'` and no `default-src`, so styles, images,
frames and navigation are as before: the policy limits where script comes from
and where `fetch`, XHR, WebSocket and `sendBeacon` go, and an injected script
can still send data off the page through an image, a frame or a navigation. An edit to either inline script changes its hash with
it. The build fails on an issuer URL that is not http(s), whose host is not a
plain DNS name, or that is plain http off this machine; on a bundle with no
script that calls the issuer the policy names; and on a committed `_headers`
that already sets `script-src` or `connect-src`. `tests/csp.test.ts` builds the
committed files for production and checks the whole policy; the E2E stack
serves the build with its headers, and every Musubi flow checks that no page
logged a refusal ([[testing-patterns#What one run does]]).

## Rate limits

Per-user limiters on the two recommendations endpoints, both fail-closed — 20 req/min for the suggestion fan-out, 60 req/min for search (typeahead fires once per debounced keystroke). A deployed osn-api runs them on its native `RL_USER_*` bindings; the budgets are `OSN_RATE_LIMITS` in `osn/api/src/routes/auth/limiters.ts`. See [[rate-limiting]].

## Testing

`musubi/social/tests/` covers the sidebar mount path under `AuthContext` + `MemoryRouter` using `@solidjs/testing-library` + `happy-dom`. The tests do not assert the full open-and-click interaction for the Kobalte dropdown: Kobalte's trigger relies on pointer-capture behaviour that happy-dom does not reproduce.

`tests/lib/search.test.ts` drives `createSearchController` directly, covering three properties no component test can reach: it searches only while enabled (signed in) and never handles a token, the previous page stays on screen while the next loads, and disposal aborts the in-flight request.

`tests/components/GlobalSearch.test.tsx` drives the rail combobox on fake timers: the debounce collapses a burst of keystrokes into one request, a query that normalises to nothing never leaves the browser, arrow keys move `aria-activedescendant` across both sections without moving focus, Enter activates the row, a failed search renders an error instead of spinning, and a failed connect does not flip the row to "Requested". One test asserts the ARIA invariant directly — **no option contains an operable control**. A pointer click is tested in Chromium instead (`tests/components/GlobalSearch.browser.test.tsx`), because happy-dom's synthetic click skips the press and the focus change that decide whether it lands: clicking an organisation opens it, clicking a person connects once and leaves focus in the field, and a click outside still closes the results.

`tests/App.browser.test.tsx` renders `Layout` signed out in Chromium: the page column and the wordmark stay put while the rail's chunk and the top bar's chunk land, an open sign-in dialog survives the 768px switch with what was typed in it, the sheet is as wide as a phone and the card 384px on desktop, and focus goes back to the shell's own Sign in button when the dialog closes, on either side of a switch; at 320px the signed-out top bar fits its three 40px controls. `tests/App.signed-in.browser.test.tsx` opens the profile switcher from the rail's account menu, crosses to 390 with it open, and closes it onto the top bar's trigger. `tests/App.load-failure.browser.test.tsx`, `App.dialogs-load-failure.browser.test.tsx` and `App.phone-load-failure.browser.test.tsx` each fail one chunk at the network — the rail's, the shell dialogs', the phone shell's — and check that the frame stays with the reload line while the page still renders; the dialogs' one also checks that a page's signed-out note holds its Sign in back until the dialogs load, then shows it once, outside the note's live region. `tests/components/SecurityStepUp.browser.test.tsx` opens Settings' Security tab, starts Add passkey and the step-up's emailed-code step: at 320px the row of code boxes is the card's whole column and no button runs past the card; at 1440px the row keeps the step-up's 16px padding. It shoots both widths in light and dark into `e2e-artifacts/musubi-settings/`. `tests/components/SearchPage.test.tsx` covers the grouped page, and `tests/components/DiscoverPage.test.tsx` the suggestion cards' reason line.

`tests/components/AuthorizePage.test.tsx` drives the consent screen the same way, with the authorize client mocked and `location.assign` stubbed: a malformed request id never reaches the API, a 404 is terminal, the decision carries the chosen profile, `login_required` keeps the request alive, and `invalid_client` ends the flow naming the app.

The shell's notices and page boundary have no component test: the end-to-end
flow `tools/e2e/tests/flows/musubi-passkey.flow.ts` reaches each branch in
Chromium. It fails the profile list and reloads (the shell stays, "Your
profiles didn't load.", Try again lists once more), fails the connections list
(the boundary's line inside the shell, the nav leaves it, Try again recovers),
and checks the signed-out notice appears once after a refused renewal, opens
sign-in, and stays away on a cold load with no session. Each notice's ink is
read against its contract token at 390 and 1440 px in both schemes and shot
into `e2e-artifacts/screenshots/musubi-surfaces/` (`musubiNotice` in
`tests/support/musubi-surfaces.ts`).

The same flow reads the shared parts the forms draw, on steps it already takes
and with no sign-in of its own: the create-account dialog's plain `Field`
labels and the date of birth's hint, the sign-in dialog's label and its
standalone "Lost your passkey?" link, Continue busy while
`/login/passkey/begin` is held (focus kept, the orb drawn, shot under reduced
motion), `/authorize`'s "Create one" inside its sentence, Discover's "Search
for someone" inside its empty note, the authenticator setup's span labels, and
the contact address on `/privacy` and `/terms`, an inline link in the legal
prose. It holds Register's three calls, the step-up's begin, the
authenticator's confirm and a revoke of Pulse on Connected apps (authorised
through the API first, so no page load is added), reading
each button busy with Cancel disabled beside it, and Revoke 40px tall at
390px. `musubi-org-detail` reads the create-organisation dialog's plain labels
and the handle's hint, and holds the create's `POST`, the rename's `PATCH` and
a connection request from Discover and from `/search` long enough to read
Create ("Creating…"), Save ("Saving…") and each Connect ("Sending…") busy, not
disabled, with focus kept (`busyButtonHeld`), each Connect 40px tall at 390px.
`/search`'s Accept is read only in `SearchPage.test.tsx`: no flow receives a
request. The rules they hold are in
[DESIGN.md](../../musubi/social/DESIGN.md) §Links, §Busy buttons and §Form
fields.

Both flows also read what Musubi's contract block maps onto the shared
overlays and titles (§Typography, §Borders and §Motion there).
`musubi-passkey` opens the account menu from the rail at 1440 px and from the
top bar at 390 px and reads its separator as a 1px `--ui-hairline` fill with
no border, in both schemes; it holds the first frame of that menu, of the
profile switcher (a sheet at 390 px) and of the create-account dialog's email
popover, and the half-way frame of each closing, and finds no transform. It
reads the switcher's title and the add-a-profile card's `CardTitle` against a
`text-title font-medium` probe, and the authenticator setup's first code box
("Code from the app Digit 1") at the probe's size at the flow's own width and
at 768 px, and at 16px at 390 px.
`musubi-org-detail` holds the create-organisation dialog's first frame and
reads the create and edit dialogs' titles the same way. Shots go to
`e2e-artifacts/screenshots/musubi-surfaces/` as `account-menu`,
`profile-switcher` and `profile-onboarding`, in both schemes. Pulse's menus,
which keep the contract's scale, are held by `pulse-event-rsvp`
(`pulse/DESIGN.md` §Motion).
