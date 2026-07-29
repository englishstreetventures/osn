# @osn/social

## 0.8.0

### Minor Changes

- 0d00266: Mobile UX overhaul — the app was desktop-only (fixed 240px rail at every
  viewport width, ~135px of content on a phone). Now responsive at a single
  `md` (768px) breakpoint, per the audit + plan in
  `wiki/apps/social-mobile-ux.md`:

  - **Shell** — below `md` the rail is replaced by a fixed bottom tab bar
    (`MobileNav`, four destinations, 20px icons) and a top bar
    (`MobileTopBar`: wordmark, theme toggle, account control). Nav items are
    shared via `components/nav.tsx`; the account dropdown and auth/switcher
    dialogs are extracted (`AccountMenu`, `AuthDialogs`,
    `ProfileSwitcherDialog`). Only the active shell mounts — `Layout` gates on
    a synchronously-initialised `md` matchMedia signal, so one shell chunk is
    fetched, one shell hydrates, and exactly one auth-dialog surface exists at
    any width (P-W1/P-I1/P-I2 + S-L1 from the prep-pr reviews). `/` now
    highlights Connections in both shells; nav icons are `aria-hidden`
    (C-L1). The bare `/authorize` route keeps no shell.
  - **Viewport** — `h-dvh` everywhere (`h-screen` gone), `viewport-fit=cover`
    - `pt-safe`/`pb-safe`/`px-safe`/`pb-nav` utilities, paired `theme-color`
      metas kept in sync with the resolved theme.
  - **Dialogs** — `ResponsiveDialogContent` renders every app dialog as a
    full-width bottom sheet below `md` (`rounded-t-card`,
    `max-h-[85dvh] overflow-y-auto`, `pb-safe`); the shared centered card at
    `md+`. `@osn/ui` primitives untouched.
  - **Touch** — form controls render 16px below 768px (kills iOS focus
    auto-zoom; documented type-scale exception), row actions bump `h-7 →
max-md:h-10`, tabs get `max-md:min-h-11` + `overflow-x-auto`, rows gain
    `active:` feedback, `touch-action: manipulation`, page padding
    `px-4 py-6 md:px-8 md:py-8`, toasts top-center on mobile.
  - **Guardrails** — `DESIGN.md` gains a Responsive layout section locking the
    breakpoint policy; new tests for `MobileNav`/`isNavActive`,
    `MobileTopBar`, `ProfileSwitcherDialog` (success/failure/no-op switch
    paths), `AuthDialogs` (close-on-session invariant),
    `ResponsiveDialogContent` (sheet-class contract) and the `theme-color`
    meta sync; verified headless-Chromium at 320/390/768/1280 widths with
    zero horizontal overflow in both themes.

## 0.7.3

### Patch Changes

- 0c7dc46: Support `prompt=create` — let a relying party open the consent screen on its
  sign-up half.

  "Initiating User Registration via OpenID Connect 1.0". A relying party sends
  `prompt=create` when it knows the visitor has no account yet; the provider then
  leads with registration rather than sign-in, and the new user lands back on the
  app signed in, inside the same OIDC transaction.

  **`@osn/api`.** `prepareAuthorization` checks `create` before every other branch
  — a signed-in visitor who clicked "create an account" meant it — and parks the
  request with the same `requireAuthAfter = now` that `prompt=login` uses, so the
  decision only accepts a session created after the request arrived. Registration
  ends in an enrolled passkey and an adopted session, which satisfies that. The
  pre-existing rule that `none` may not be combined with another value already
  rejects `none`+`create`, so the branch is unreachable in silent mode.

  **`@osn/social`.** `AuthorizeSignIn` now holds both halves of "who are you" and
  swaps between them: a "No account yet? Create one" link under sign-in, and
  Cancel back from registration. It opens on registration when the server says
  `reason=create`. Without that second half a relying party's "Create account"
  button was a dead end — the screen only ever offered a passkey ceremony to
  someone who had no passkey. `reason` is advisory copy; the server re-derives
  every requirement at decision time, so a tampered value widens nothing.

  **`@shared/rp-auth`.** `signInUrl` takes an options bag, and `startCreateAccount`
  is the same journey opened on the sign-up screen. Only `create` is ever passed
  through.

## 0.7.2

### Patch Changes

- 1ec7ef5: fix(social): send a Turnstile token from the musubi.social ceremonies

  Sign-in and registration on `musubi.social` failed with `400 turnstile_failed`.
  osn-api has held `TURNSTILE_SECRET_KEY` since #160, so `/register/begin` and the
  identifier-bound `/login/passkey/begin` fail closed unless the caller sends a
  token — and `@osn/social` was sending none.

  Both halves of the gate were individually correct; the pairing was severed when
  the form moved. Before the identity migration the only surface running the OSN
  ceremonies was cire/organiser, whose Astro build read `PUBLIC_TURNSTILE_SITEKEY`.
  The move to `musubi.social` (#321) relocated those ceremonies to `@osn/social`
  and the organiser's OIDC swap (#322) removed its ceremony forms entirely, but the
  `deploy-osn-social` job passed only `VITE_OSN_ISSUER_URL` and neither `Sidebar`
  nor `AuthorizeSignIn` passed a `turnstileSiteKey` — so no widget rendered and no
  token was sent.

  - `src/lib/auth.ts` exports `TURNSTILE_SITEKEY` from `VITE_TURNSTILE_SITEKEY`,
    normalising blank (an unset Actions variable expands to `""`) to `undefined` so
    `turnstileEnabled()` sees one shape.
  - Threaded into all three ceremony call sites: the sidebar's `SignIn` and
    `Register` dialogs, and the `/authorize` consent screen's sign-in island.
  - `deploy.yml`'s `deploy-osn-social` job passes
    `VITE_TURNSTILE_SITEKEY: ${{ vars.PUBLIC_TURNSTILE_SITEKEY }}` — the same
    widget and repo Variable as the cire builds; the prefix differs only because
    Vite exposes `VITE_*` where Astro exposes `PUBLIC_*`.
  - `vite-env.d.ts` now types both build vars.

  Guarded by `tests/components/turnstile-wiring.test.tsx`, which fails if any
  ceremony call site drops the prop.

  No dashboard step is needed: `musubi.social` is already on the widget's Domains
  list, and it is now the only hostname that builds this app.

  The `deploy-osn-social` job additionally fails fast when the variable is empty,
  so a missing repo Variable breaks the deploy instead of silently shipping a build
  that cannot sign anyone in. The wiring test proves the prop is threaded; only
  this check proves a real value reached it.

  Also removes `deploy-osn-social-preview.yml`. A `*.pages.dev` preview can
  complete neither a passkey ceremony nor an OIDC round-trip — the RP ID is
  `musubi.social` and the `__Host-` session and binding cookies are host-bound to
  `id.musubi.social` — so it could only ever be looked at, while spending a
  prod-scoped Cloudflare token on every branch push (the open S-M
  `preview-ci-prod-token` finding). Review social changes locally with
  `bun run dev:osn`.

  Note: this removes only the workflow. The `osn-social-preview` Pages project and
  its last deployment still exist in the Cloudflare account and are now orphaned —
  delete them in the dashboard (or `wrangler pages project delete
osn-social-preview`).

## 0.7.1

### Patch Changes

- 2b7a7f1: Support relying parties that sign people in through the OSN OIDC issuer.

  - `@shared/rp-auth` (new): the browser half of a relying party — `signInUrl`,
    `startSignIn`, `fetchSession`, `signOut`, `createAuthFetch`, `readAuthError`,
    `clearAuthError`, `isAuthExpired` and `AuthExpiredError`, plus an
    `AuthProvider`/`useAuth` pair on the `/solid` sub-path. Every request carries
    `credentials: "include"`, because the RP holds its own session cookie and the
    browser never sees an OSN token.
  - `@shared/osn-auth-client`: new `verifyIdToken` — signature over the issuer's
    JWKS, `iss`/`aud`/`exp`/`nonce` checks, and the claims a relying party reads.
  - `@shared/crypto`: `timingSafeEqual` moved here from `@osn/api`, so both sides
    of a code exchange can compare secrets without one importing the other.
  - `@osn/api`: ID tokens for first-party clients now carry an `osn_profile_id`
    claim holding the real `usr_*` profile id, so a first-party app can address a
    person by the same id the ARC routes use instead of the pairwise `sub`. The
    internal profile-organisations route returns full organisation summaries
    (`organisations`) rather than bare `organisationIds` — the public
    `/organisations` projection still has no id, which is why the caller needs
    this one.
  - `@osn/social`: the settings page reads and writes the URL fragment, so other
    apps can deep-link to `/settings#security`. Passkeys are bound to this
    origin's RP ID and can only be managed here.

## 0.7.0

### Minor Changes

- 79b19e1: Move OSN identity to its own domain: osn-api on `id.musubi.social`, `@osn/social` on the
  `musubi.social` apex, WebAuthn RP ID `musubi.social`.

  Identity was living on `cireweddings.com`, a domain that belongs to one product. It now
  has a registrable domain of its own, which is what lets any later surface — cire, pulse,
  zap — sign in through the same issuer without borrowing another product's name.

  **`@osn/social` deploys to Cloudflare Pages.** `deploy.yml` gains a `deploy-osn-social`
  job publishing the app to the `osn-social` project, served at the apex. The apex is the
  right home rather than a subdomain: the RP ID is the registrable domain, so ceremonies
  run legally on `musubi.social` itself _and_ on every `*.musubi.social` surface added later.
  `__Host-osn_session` and the per-request `__Host-osn_oar_<12hex>` binding cookie are
  host-bound and `SameSite=Lax`, and apex → `id.musubi.social` is same-site, so they ride
  along on the consent screen's credentialed fetches. Feature-branch previews go to a
  separate `osn-social-preview` project — the preview workflow deploys to a project's
  production branch, so aimed at `osn-social` it would put unreviewed branch code on a
  live hostname.

  **osn-api production vars.** `OSN_RP_ID = musubi.social`, `OSN_ISSUER_URL =
https://id.musubi.social`, `OSN_ORIGIN = https://musubi.social`, `OSN_AUTHORIZE_UI_URL =
https://musubi.social/authorize` (unset, the provider falls back to `/authorize` on the
  first `OSN_ORIGIN` entry — right today by accident, so it stays explicit), plus a
  `custom_domain` route on `id.musubi.social`. `OSN_CORS_ORIGIN` keeps the three cire
  origins: these are two different lists, and CORS governs bearer-token calls, which
  still work cross-site. `OSN_ORIGIN` governs WebAuthn ceremonies, which do not.
  `OSN_EMAIL_FROM` stays `hello@cireweddings.com` — the only verified Resend sender, and
  moving it would fail closed and take OTP step-up with it.

  **Consumers repointed** at the new issuer: cire-api (`[env.production]` and
  `[env.preview]`, which shares production identity by design), zap-api, the cire
  organiser and guest build-time `PUBLIC_OSN_ISSUER_URL`, `@osn/social`'s
  `VITE_OSN_ISSUER_URL`, and the guest site's CSP `connect-src`.

  **Two costs, both accepted, both breaking.** Changing the RP ID invalidates every
  passkey enrolled under `cireweddings.com` — the private half is bound to the RP ID
  inside the authenticator, and no server-side change rebinds it. Recovery codes were
  minted for both production accounts first, and are the only way back in: recovery-code
  login → OTP step-up (`purpose: passkey_register`) → enroll → regenerate codes. And cire
  sign-in — organiser, vendor, guest linking — is down until those frontends move to the
  OIDC redirect flow, because a `cireweddings.com` origin can neither run a `musubi.social`
  ceremony nor replay a now-cross-site session cookie. Bearer-token verification is
  unaffected.

  The two dashboard steps neither wrangler nor CI can do — the apex on the `osn-social` Pages
  project, and `musubi.social` on the Turnstile widget's domain list — were done by hand on
  2026-07-27. Reasoning and cutover order in `wiki/runbooks/musubi-identity-migration.md`.

## 0.6.0

### Minor Changes

- 40100ad: OIDC consent screen. `@osn/client` gains `createAuthorizeClient` — two credentialed calls (`getContext`, `submitDecision`) against the parked authorize request, with an `AuthorizeError` that says whether the request is dead or whether signing in again fixes it. `@osn/social` gains the `/authorize` page it drives: client card, humanised scopes, profile picker when there is a real choice, and a `login_required` loop that holds the user's answer, re-authenticates and replays it against the same request id — but only after checking that the same account came back; a different sign-in drops the held answer and says so. `prompt=login` puts the ceremony before the decision, and a failed context read (a 429, a dropped connection) offers a retry instead of an endless spinner.

  The page runs on a bare layout with no navigation out of the flow, and ships `frame-ancestors 'none'` so a consent screen can never be framed. Bare routes also run outside `AuthProvider`: mounting it bootstraps a session, which rotates the refresh token, and lists profiles the consent screen never reads. The provider now sits inside the sign-in island, which loads only when a ceremony is needed.

### Patch Changes

- Updated dependencies [40100ad]
  - @osn/client@2.7.0
  - @osn/ui@1.6.1

## 0.5.0

### Minor Changes

- 0953024: Wire recovery codes into the settings UI, and fix the generate call that could never succeed.

  `generateRecoveryCodes` in `@osn/client` posted an empty body and no step-up token, so `POST /recovery/generate` answered 403 `step_up_required` every time. It now forwards the token, and `RecoveryCodesView` runs the passkey/OTP ceremony that mints it — the same `StepUpDialog` flow `PasskeysView` uses.

  Binds the generate gate to a purpose (S-M1). `POST /recovery/generate` now requires a step-up token minted with `purpose: "recovery_generate"`, so a token from another ceremony — an email change, a passkey delete — cannot be replayed against the one action that destroys an account's whole existing set. `StepUpDialog` gained a `purpose` prop and `@osn/client` forwards it through both `/complete` routes; a purposeless token is refused, with no legacy fallback.

  Adds `GET /recovery/status`, which reports how many codes an account has left and when the set was minted. It carries counts only, never a code, so it needs no step-up — gating it would be circular, since the answer is what tells a user whether starting a ceremony is worth it. The view leads with it, and says outright when an account has no codes at all.

  `RecoveryCodesView` is now mounted in Settings → Security in `@osn/social` (it previously rendered nowhere).

### Patch Changes

- Updated dependencies [0953024]
  - @osn/client@2.6.0
  - @osn/ui@1.6.0

## 0.4.0

### Minor Changes

- 97a5f23: Redesign the app UI on an SF Pro + grey-ink system.

  New locked design system (recorded in `osn/social/DESIGN.md`): SF Pro via the
  system stack (regular/medium, -0.15px tracking), a four-size type scale
  (12/13/14/24, exposed as `text-meta/body/title/display`), a three-grey ink
  hierarchy (#292929 / #5D5D5D / #9E9E9E, red kept for destructive only), two
  corner radii (8px controls/nav, 16px card surfaces) plus pill CTAs, and icons
  at 14px (nav) / 20px (content). Scoped to `@osn/social` — the shared `@osn/ui`
  primitives are untouched (their `base:` zero-specificity variant lets the app
  override at call sites), so cire and pulse are unaffected.

## 0.3.14

### Patch Changes

- f951187: Astro 7 + vite 8 migration: `astro ^6.4.6 → ^7.1.1`, `@astrojs/solid-js ^6.0.1 → ^7.0.1` (all astro sites), `@astrojs/cloudflare ^13.7.0 → ^14.1.3` (guest site). Clears the three astro XSS advisories (GHSA-4g3v-8h47-v7g6, GHSA-f48w-9m4c-m7f5, GHSA-7pw4-f3q4-r2p2). Root `vite` override raised `^7.3.5 → ^8.0.13` (astro 7 requires vite 8) with workspace devDeps restored to `^8.0.13`, and the `esbuild` override floor raised `^0.25.0 → ^0.27.0`. `compressHTML: true` pinned in all astro configs to preserve Astro 6 whitespace output.
- Updated dependencies [f951187]
  - @osn/ui@1.5.2

## 0.3.13

### Patch Changes

- Updated dependencies [e01206c]
  - @osn/client@2.5.1
  - @osn/ui@1.5.1

## 0.3.12

### Patch Changes

- Updated dependencies [6b14961]
  - @osn/client@2.5.0
  - @osn/ui@1.5.0

## 0.3.11

### Patch Changes

- Updated dependencies [f62784d]
  - @osn/client@2.4.0
  - @osn/ui@1.4.6

## 0.3.10

### Patch Changes

- Updated dependencies [368e3e8]
  - @osn/client@2.3.4
  - @osn/ui@1.4.5

## 0.3.9

### Patch Changes

- Updated dependencies [f4b9c6b]
  - @osn/client@2.3.3
  - @osn/ui@1.4.4

## 0.3.8

### Patch Changes

- Updated dependencies [0a297de]
  - @osn/client@2.3.2
  - @osn/ui@1.4.3

## 0.3.7

### Patch Changes

- Updated dependencies [c981dee]
  - @osn/ui@1.4.2

## 0.3.6

### Patch Changes

- Updated dependencies [1dd9f6d]
  - @osn/client@2.3.1
  - @osn/ui@1.4.1

## 0.3.5

### Patch Changes

- Updated dependencies [47c83a6]
  - @osn/ui@1.4.0

## 0.3.4

### Patch Changes

- Updated dependencies [d81383d]
  - @osn/ui@1.3.0
  - @osn/client@2.3.0

## 0.3.3

### Patch Changes

- 04e0bf2: Audit + align cross-workspace dependency ranges and adopt TypeScript 6.0.

  - Resolve declared-range drift: `solid-js` → `^1.9.13` and `vitest` → `^4.1.8`
    everywhere they were behind; `@osn/landing` switched from pinned
    `astro@6.1.10` / `@astrojs/solid-js@6.0.1` to the caret ranges (`^6.4.2` /
    `^6.0.1`) used by the cire Astro apps.
  - Bump `typescript` `^5.9.3` → `^6.0.3` across the repo. The shared tsconfig was
    already TS 6.0-clean (`strict: true`, `target` ≥ ES2015, ESNext modules, no
    removed flags), so no `ignoreDeprecations` shim was needed. Three call sites
    surfaced by the stricter compiler were fixed:
    - `@osn/social`: added the missing `src/vite-env.d.ts`
      (`/// <reference types="vite/client" />`) so side-effect CSS imports type
      again (TS2882).
    - `@pulse/api`: dropped the now-deprecated `baseUrl` from `tsconfig.json`
      (the `#db` / `#routes` `paths` are already tsconfig-relative; TS5101).
    - `@pulse/api`: annotated `createClient`'s return type as
      `Treaty.Create<App>` to satisfy the tightened declaration-portability check
      (TS2883).

- Updated dependencies [8aeddf1]
- Updated dependencies [04e0bf2]
  - @osn/ui@1.2.0
  - @osn/client@2.2.1

## 0.3.2

### Patch Changes

- Updated dependencies [c3cca40]
  - @osn/client@2.2.0
  - @osn/ui@1.1.2

## 0.3.1

### Patch Changes

- 073238d: Migrate close friends from OSN core to Pulse.

  Close friends is now a Pulse-scoped feature, not an OSN core feature. Each OSN
  app can implement its own close-friends-style list against the OSN connection
  graph; OSN core retains only `connections` and `blocks`.

  What it does in Pulse:

  - **Feed boost.** Events organised by a close friend surface higher in
    `listEvents` (stable partition: chronological order preserved within each
    bucket; not applied for anonymous viewers).
  - **Hosting affordance.** The existing RSVP avatar ring — driven by an
    attendee having marked the viewer as a close friend — is preserved end-to-end,
    now backed by the local `pulse_close_friends` table.
  - **Management UI.** New `/close-friends` page in `@pulse/app` (linked from the
    header avatar dropdown).

  Surface changes:

  - New: `pulse_close_friends` table in `@pulse/db`; Effect service + four CRUD
    routes (`GET/POST/DELETE /close-friends/...`) in `@pulse/api`; metrics
    `pulse.close_friends.{added,removed,listed,list.size,batch.size}`.
  - Removed: OSN-core `close_friends` table, services, routes (user-facing
    `/graph/close-friends/*` and internal `/graph/internal/close-friends*`),
    graph close-friend SDK methods on `@osn/client`, the close-friends tab in
    `@osn/social` ConnectionsPage, the `withGraphCloseFriendOp` metric helper,
    and the `GraphCloseFriendAction` observability attribute.
  - Connection projection now includes `id` so cross-DB references (Pulse adding
    by profile id) work without duplicating handle→id resolution.

  Pre-launch: the OSN `close_friends` table is dropped outright; seed data
  updated. No migration path or backwards-compatibility shims.

- Updated dependencies [073238d]
  - @osn/client@2.1.1
  - @osn/ui@1.1.1

## 0.3.0

### Minor Changes

- 1d68593: Let users add additional biometrics (passkeys) after registration. Registration already required enrolling a first passkey; Settings now exposes a Security tab with an "Add passkey" button that runs the step-up-gated WebAuthn registration ceremony, plus the existing list / rename / delete surface. `PasskeysClient` gains `registerBegin` / `registerComplete` so the Settings surface can call `/passkey/register/begin` + `/complete` directly.

### Patch Changes

- Updated dependencies [1d68593]
  - @osn/client@2.1.0
  - @osn/ui@1.1.0

## 0.2.11

### Patch Changes

- 31957b4: Fix oxlint warnings: hoist helpers that don't capture parent scope, replace `Array#sort()` with `Array#toSorted()` in tests, parallelise independent session evictions, route pulse-api boot error through the observability layer, and de-shadow `token` in `OrgDetailPage`.
- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).
- 31957b4: In-range minor bumps:

  - `effect` 3.19.19 → 3.21.2 (11 workspaces)
  - `elysia` 1.2.0 → 1.4.28 + `@elysiajs/eden` 1.2.0 → 1.4.9
  - `@simplewebauthn/server` 13.1.1 → 13.3.0
  - `ioredis` 5.6.0 → 5.10.1
  - `happy-dom` 20.8.4 → 20.9.0
  - `better-sqlite3` 12.5.0 → 12.9.0 (SQLite 3.51.1 → 3.53.0)
  - OpenTelemetry stable cluster 2.0.0 → 2.7.0 (`resources`, `sdk-metrics`, `sdk-trace-base`, `sdk-trace-node`) — note: `OTEL_RESOURCE_ATTRIBUTES` parsing tightened in 2.6.0 (the entire env var is dropped on any invalid entry; whitespace must be percent-encoded). Audit deployment configs.
  - `@opentelemetry/semantic-conventions` 1.34.0 → 1.40.0
  - Root tooling: `turbo` 2.9.6, `oxlint` 1.61.0, `lefthook` 2.1.6, `@changesets/cli` 2.31.0

- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
  - @osn/client@2.0.1
  - @osn/ui@1.0.1

## 0.2.10

### Patch Changes

- 6387b98: Passkey-primary login (M-PK). WebAuthn (passkey or security key) is the only primary login factor. OTP and magic-link primary login, and the `enrollmentToken` JWT machinery, have been removed. Registration is WebAuthn-gated and first-credential enrollment is mandatory; `deletePasskey` refuses unconditionally if it would leave zero credentials. The "Lost your passkey?" path (recovery codes) is the single escape hatch.

  Hardenings from the security review: **S-H1** step-up gate on `/passkey/register/*` when the account already has ≥1 passkey + `security_events{passkey_register}` audit row + best-effort email notification + server-derived session token (no user-supplied body field). **S-H2** options/verifier `userVerification` alignment (`required` on both sides; rejects UP-only U2F). **S-M1** `/login/passkey/begin` returns a uniform synthetic response for unknown identifiers, closing the enumeration oracle. **S-M2** access tokens carry `aud: "osn-access"` and `verifyAccessToken` asserts it.

  **Breaking — @osn/api**

  - Removed routes: `POST /login/otp/begin`, `POST /login/otp/complete`, `POST /login/magic/begin`, `POST /login/magic/verify`.
  - Removed service methods: `beginOtp`, `completeOtpDirect`, `beginMagic`, `verifyMagicDirect`, `issueEnrollmentToken`, `verifyEnrollmentToken`.
  - `/passkey/register/{begin,complete}` now authenticates via the normal access token; enrollment tokens are gone.
  - `/passkey/register/begin` accepts an optional `step_up_token` body field or `X-Step-Up-Token` header; **required** when the account already has ≥1 passkey (S-H1).
  - `/passkey/register/complete` body no longer accepts `session_token`; the server derives it from the HttpOnly cookie (S-H1).
  - `/register/complete` response drops `enrollment_token`.
  - `/login/passkey/begin` now returns `200 { options }` in all cases (including unknown identifier) — previously 400 on unknown (S-M1).
  - Access tokens carry `aud: "osn-access"` (S-M2).
  - `AuthConfig` drops `magicLinkBaseUrl` / `magicTtl`; adds `passkeyRegisterAllowedAmr` (default `["webauthn", "otp"]`). `AuthRateLimiters` drops `otpBegin`, `otpComplete`, `magicBegin`.
  - `SecurityEventKind` union adds `"passkey_register"`.
  - `deletePasskey` refuses to drop below 1 passkey regardless of recovery-code state.
  - WebAuthn registration options use `residentKey: "preferred"` + `userVerification: "required"`; both login paths use `userVerification: "required"` to match the verifier (S-H2).

  **Breaking — @osn/client**

  - `LoginClient` now only exposes `passkeyBegin` / `passkeyComplete`. `otpBegin`, `otpComplete`, `magicBegin`, `magicVerify` removed.
  - `CompleteRegistrationResult` no longer contains `enrollmentToken`.
  - `RegistrationClient.passkeyRegisterBegin` / `passkeyRegisterComplete` take `accessToken` instead of `enrollmentToken`.
  - `RegistrationClient.passkeyRegisterBegin` additionally accepts an optional `stepUpToken` — required when adding a passkey to an account that already has one (S-H1). The bootstrap first-passkey flow from `completeRegistration` still works without it.

  **Breaking — @osn/ui**

  - `<SignIn>` now requires a `recoveryClient: RecoveryClient` prop. The component is WebAuthn-only; it renders an informational screen when WebAuthn is unsupported, and exposes a "Lost your passkey?" link into `<RecoveryLoginForm>`.
  - `<Register>` is WebAuthn-gated. No flow path exists without WebAuthn support, and the "Skip for now" button is gone.
  - `<MagicLinkHandler>` deleted.

  **@shared/observability (minor)**

  - `AuthMethod` narrowed to `"passkey" | "recovery_code" | "refresh"`.
  - `AuthRateLimitedEndpoint` dropped `otp_begin`, `otp_complete`, `magic_begin`.

  **@pulse/app / @osn/social (patch)**

  - Pass a `recoveryClient` into `<SignIn>`; `<MagicLinkHandler>` removed from the root layout.

- Updated dependencies [6387b98]
  - @osn/client@2.0.0
  - @osn/ui@1.0.0

## 0.2.9

### Patch Changes

- Updated dependencies [b1d5980]
  - @osn/client@1.1.0
  - @osn/ui@0.11.0

## 0.2.8

### Patch Changes

- c04163d: Remove legacy OAuth authorization-code / PKCE flow.

  The first-party `/login/*` endpoints (Session + PublicProfile returned inline)
  are now the only sign-in surface. The following are gone:

  - Server routes `GET /authorize`, `POST /token` `grant_type=authorization_code`,
    `POST /passkey/login/{begin,complete}`, `POST /otp/{begin,complete}`,
    `POST /magic/begin`, `GET /magic/verify`
  - Service methods `exchangeCode`, `issueCode`, `completePasskeyLogin`,
    `completeOtp`, `verifyMagic`, `validateRedirectUri`; `AuthConfig.allowedRedirectUris`
  - Client API `OsnAuthService.startLogin` / `handleCallback`, module `@osn/client/pkce`,
    errors `AuthorizationError`, `TokenExchangeError`, `StateMismatchError`;
    `OsnAuthConfig.clientId`
  - Solid context methods `login` / `handleCallback`
  - `<CallbackHandler />` components in `@pulse/app` and `@osn/social`
  - Helper files `osn/api/src/lib/html.ts`, `osn/api/src/lib/crypto.ts`
  - Rate-limiter slot `magicVerify` and `AuthRateLimitedEndpoint` variant `magic_verify`

  OIDC discovery now reports `grant_types_supported: ["refresh_token"]` only.
  Magic-link emails point at `/login/magic/verify` (consumed client-side by
  `MagicLinkHandler`).

- Updated dependencies [c04163d]
  - @osn/client@1.0.0
  - @osn/ui@0.10.1

## 0.2.7

### Patch Changes

- Updated dependencies [811eda4]
  - @osn/client@0.10.0
  - @osn/ui@0.10.0

## 0.2.6

### Patch Changes

- dc8c384: Auth phase 5a: step-up (sudo) ceremonies, session introspection/revocation, and email change.

  **New features**

  - **Step-up (sudo) tokens** — short-lived (5 min) ES256 JWTs with `aud: "osn-step-up"` minted by a passkey or OTP ceremony, required by sensitive endpoints. Replay-guarded via `jti` tracking. Routes: `POST /step-up/{passkey,otp}/{begin,complete}`.
  - **Session introspection + revocation** — `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/revoke-all-other`. Each session now carries a coarse UA label (e.g. "Firefox on macOS"), an HMAC-peppered IP hash, and a `last_used_at` timestamp. Revocation handles are the first 16 hex chars of the session SHA-256.
  - **Email change** — `POST /account/email/{begin,complete}`, step-up-gated. Hard cap of 2 changes per trailing 7 days. Atomic with session invalidation so a partial failure can never leave a stale-email session alive. Audit rows persist in the new `email_changes` table.

  **Breaking changes**

  - `/recovery/generate` now requires a step-up token (`X-Step-Up-Token` header or `step_up_token` body param) with `webauthn` or `otp` amr. The old "1 per day" rate limit is replaced by a per-hour throttle; the step-up gate is the real defence.
  - `Session` no longer carries `refreshToken` — the refresh token is HttpOnly-cookie-only after C3. `AccountSession` drops `refreshToken` and adds `hasSession: boolean`. Any stored client session state will fail schema validation and be silently cleared (users will re-login).
  - `POST /logout` no longer accepts `refresh_token` in the body — cookie-only.

  **Observability**

  - New metrics: `osn.auth.step_up.{issued,verified}`, `osn.auth.session.operations`, `osn.auth.account.email_change.{attempts,duration}`.
  - New `SecurityInvalidationTrigger` enum members: `session_revoke`, `session_revoke_all`.
  - New redaction deny-list entries: `stepUpToken`, `ipHash`, `uaLabel` (both spellings).

  Migration `0005_sessions_metadata_and_email_change.sql` adds `sessions.ua_label`, `sessions.ip_hash`, `sessions.last_used_at`, and the new `email_changes` table.

- Updated dependencies [dc8c384]
  - @osn/client@0.9.0
  - @osn/ui@0.9.0

## 0.2.5

### Patch Changes

- Updated dependencies [9459f5e]
  - @osn/client@0.8.0
  - @osn/ui@0.8.0

## 0.2.4

### Patch Changes

- Updated dependencies [2d5cce9]
  - @osn/client@0.7.0
  - @osn/ui@0.7.4

## 0.2.3

### Patch Changes

- Updated dependencies [2a7eb82]
  - @osn/client@0.6.0
  - @osn/ui@0.7.3

## 0.2.2

### Patch Changes

- Updated dependencies [ac6a86c]
  - @osn/client@0.5.1
  - @osn/ui@0.7.2

## 0.2.1

### Patch Changes

- 6d0eb83: Ask for confirmation before removing a friend to prevent accidental removals.

## 0.2.0

### Minor Changes

- e2e010e: Add `@osn/social` app — identity and social graph management UI. Add
  `recommendations` service and route to `@osn/core`. Add `graph` and
  `organisations` client modules with Solid `GraphProvider` and `OrgProvider`.
  Fix dropdown menu not opening by wrapping `DropdownMenuLabel` in
  `DropdownMenuGroup` (required by Kobalte).

### Patch Changes

- Updated dependencies [e2e010e]
  - @osn/client@0.5.0
  - @osn/ui@0.7.1
