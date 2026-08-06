# @osn/social

## 0.11.3

### Patch Changes

- 25ee66c: Remove the Tauri desktop/mobile shell from Pulse. `@pulse/app` stays exactly where it is, keeps its package name, and stays a browser SPA — Pulse is going native in Swift instead, and no Tauri build ever shipped.

  Deleted `pulse/app/src-tauri/` outright (Rust crate, `gen/apple/` Xcode project, capabilities, build guard scripts) along with the `@tauri-apps/*` dependencies, the `tauri://localhost` CORS/origin-guard allowance in `@osn/api` and `@pulse/api`, and the `@tauri-apps/plugin-opener` usage in `MapPreview.tsx` / `AddToCalendarButton.tsx` (replaced with plain browser APIs). `@osn/client`'s `session-fetch.ts` keeps its `setSessionFetch`/`sessionFetch` seam — only the Tauri-specific doc comments referencing it were dropped.

  Dev ports (1420 for `@pulse/app`, 1422 for `@osn/social`) and `strictPort` are untouched; `@osn/social`'s dev server drops its `TAURI_DEV_HOST` host/HMR override and its `src-tauri` watch-ignore, which changes nothing about the shipped build. CI, docs, and wiki pages updated to match; historical changelog entries are left as-is.

- Updated dependencies [25ee66c]
  - @osn/client@2.12.2
  - @osn/ui@1.7.8

## 0.11.2

### Patch Changes

- d5443a0: Fix registration leaving the browser with no session, which sent a
  `prompt=create` sign-in back to the create-account screen.

  `@osn/client`'s registration calls ran on `fetch`'s default `same-origin`
  credentials mode. The issuer is a different origin from every app that calls it
  (`musubi.social` → `id.musubi.social`), and a cross-origin fetch in that mode
  does not process the response's `Set-Cookie` at all — so the browser silently
  discarded the refresh cookie that `POST /register/complete` sets. That cookie is
  the only place the refresh token exists (the body carries the access token and
  nothing else), so a brand-new account finished registration holding an in-memory
  access token and no session: a reload signed it straight back out, and a relying
  party's `prompt=create` journey landed back on the consent screen's sign-up
  panel, because `/authorize/context` still reported a signed-out browser. Adds
  `credentials: "include"`, which every other cookie-setting route in the package
  (`login`, `recovery`, `/token`) already sent, and pins it with a test.

  `AuthorizePage` also stops leading with sign-up on re-entry. `reason=create`
  stays in the URL after the account exists, so anything that returns the user to
  the sign-in screen — a `login_required` replay, a refused decision — reopened
  "Create your OSN account" at someone who had just made one. `initialMode` is now
  gated on whether a ceremony has already happened on the page.

- Updated dependencies [d5443a0]
  - @osn/client@2.12.1
  - @osn/ui@1.7.7

## 0.11.1

### Patch Changes

- Updated dependencies [73c3c89]
  - @osn/client@2.12.0
  - @osn/ui@1.7.6

## 0.11.0

### Minor Changes

- dea594b: Rank OSN search on social proximity and name tokens, not text alone

  `GET /recommendations/search` now follows the tiering Facebook's typeahead
  describes — retrieve the caller's own graph first, then the global index, then
  score the whole candidate set before slicing.

  - **New retrieval pass over the caller's own edges.** An index seek on the
    connection indexes joined to `users`, capped at 50 rows. It is a recall
    guarantee, not a duplicate: every global pass is `ORDER BY handle LIMIT
overfetch`, so a common prefix filled the window with whoever sorted
    alphabetically first and a connection could be missed entirely regardless of
    ranking. Organisation search gained the same pass over the caller's own
    memberships.
  - **Ranking is text score + proximity score**, summed, computed before the page
    is sliced rather than after. Connections, then pending requests, then
    co-members of an organisation the caller belongs to, outrank strangers on the
    same text tier. Friends-of-friends is deliberately excluded: nothing exposes
    another profile's connection list, so ordering by mutuals would be the same
    graph-inference oracle that keeps `mutualCount` out of the payload.
  - **Name-token prefix is now its own tier**, above handle infix. `"smith"` used
    to score `"Roberta Smith"` as a name infix — indistinguishable from
    `"Blacksmith Ltd"` and ranked below `@blacksmith`.
  - **Multi-word queries work.** Tokens are matched independently, so
    `"Smith, John"` and `"smi joh"` both find `John Smith`, and the tokens are
    rejoined to spell the handle they imply, so `"john smith"` seeks `@johnsmith`
    on the index instead of skipping the seek on account of the space.
  - **The minimum query length is 1**, down from 2. What a character reaches still
    widens in steps: 1 searches only the caller's own connections and
    organisations, 2 unlocks the global handle seek, 3 unlocks name matching.
  - The three post-retrieval probes (blocks, connection state, shared
    organisations) now run concurrently, so the request has one fewer sequential
    database step than before despite the added signal.

  `@shared/db-utils/search` gains `tokeniseQuery`, `joinTokens`,
  `tokenContentLength` and `tokensPrefixName`. The tokeniser keeps every LIKE
  metacharacter (`%`, `_`, `\`) inside the token, because `escapeLike` can only
  neutralise a character that survives tokenisation — treating `%` as a separator
  would turn `"a%b"` into `a` + `b` and convert the one wildcard the escape exists
  to defuse back into a wildcard. Ordinary punctuation still splits, so
  `"Smith, John"` tokenises the way a person reads it.

  Two findings from the pre-merge security review, both introduced and fixed on
  this branch:

  - **S-M1** — the length gates compared the raw phrase, while the SQL they gate
    is built from the tokens. Since tokenisation drops separators, `"a."` reached
    a one-character global handle seek and `"a a"` a one-character global infix
    scan, bypassing the scope rule the 1-character floor depends on. The prefix
    pass now gates on the handle prefix actually bound into the range, and the
    infix pass on the longest token — an `AND` of `LIKE` patterns is only as
    selective as its most selective conjunct.
  - **S-M2** — token count was unbounded. `q`'s 64-character cap admits 32
    single-character tokens, each emitting its own ANDed pair of `LIKE`
    predicates: 64 evaluations per scanned row on a conjunction that matches
    nothing, so `LIMIT` never short-circuits the scan. Capped at
    `MAX_QUERY_TOKENS = 6`.

  The infix gate is **script-aware** (`hasScanworthyToken`). A minimum-length
  gate is a proxy for a minimum-selectivity gate, and character count is only a
  good proxy inside one alphabet: two Han characters pick a name out of a very
  large space where two Latin letters barely narrow anything. Tokens in Han,
  Hiragana, Katakana or Hangul therefore clear the gate at two characters. This
  was a regression the token-length fix above introduced — `"日本 太郎"` is a
  complete name whose every token is two characters, and a flat three-character
  rule made it unsearchable.

  No change to the response shape of either search surface.

### Patch Changes

- Updated dependencies [dea594b]
  - @osn/client@2.11.1
  - @osn/ui@1.7.5

## 0.10.0

### Minor Changes

- 94ab93e: Contact suggestions and a shell search bar in OSN Social. Search is reachable
  from anywhere — a live combobox in the desktop rail and a `/search` page behind
  a new Search tab in the mobile bottom bar — and Discover's suggestion cards now
  say why each person is being suggested.

  - `@osn/api`: new `GET /recommendations/search?q=&limit=&orgLimit=` —
    autocomplete over people **and** organisations, both sections in one round
    trip. One endpoint rather than two because this is typeahead: one request per
    keystroke means one abort to cancel, one rate-limit budget to reason about,
    and no torn state where the people half of a result set is newer than the
    organisation half. People match on handle and display name, two-phase by
    design: pass 1 is an index **seek** over a half-open handle range, and the
    unanchored `%q%` pass over handle + display name runs only when that
    under-fills the page _and_ the query is at least three characters. The range
    is deliberate — `handle LIKE 'q%'` does **not** use the index, because
    SQLite's LIKE-prefix optimisation needs a collation matching LIKE's case
    sensitivity and both handle indexes are BINARY with `case_sensitive_like`
    off, so it plans as `SCAN … USING INDEX`. The two forms are exactly
    equivalent here (handles are lowercase and `^[a-z0-9_]+$`), so this is a pure
    planner win. Queries are normalised (trim, strip `@`, lowercase) and
    LIKE-escaped so an underscore in a handle matches literally; anything under
    two characters returns an empty list rather than a 4xx. Self, tombstoned
    accounts and profiles blocked in either direction are excluded. Each result
    carries the caller's own connection state (`none` / `pending_sent` /
    `pending_received` / `connected`), batched in one query for the whole page —
    the same fact `GET /graph/connections/:handle` already reports per handle, so
    no new disclosure. Deliberately no mutual counts: search takes an arbitrary
    handle, and answering "how many mutuals" for arbitrary handles is a
    graph-inference oracle.
  - `@osn/api`: organisation results follow the same two-phase shape and share
    the ranking function, but carry no exclusions — organisations are public, and
    the caller's own are _more_ relevant in a search box, so they come back
    flagged `isMember: true` and render a badge instead of a CTA. Results are
    addressed by **handle**, not the internal `org_*` id: `GET
/organisations/:handle` resolves by handle and the public `orgProjection`
    omits the id. Chasing that down also turned up a pre-existing bug —
    `OrganisationsPage` linked `/organisations/${org.id}` against that same
    id-less projection, so every organisation row navigated to
    `/organisations/undefined`. Fixed in passing.
  - `@osn/api`: `suggestConnections` gains organisation co-members as a second
    signal, so an account with no connections yet has something to act on — FOF
    alone returns nothing until the first connection is accepted. Suggestions now
    carry a `reason` (`mutual_connections` | `shared_organisation`) naming the
    strongest signal plus the shared organisation as card context, and rank by
    mutual count, then shared-organisation count, then profile id for stable
    ties. Two fixes fell out of the rework: an edge in _any_ state now excludes a
    candidate (a pending request used to keep the person in Discover behind a
    Connect button that could only fail with "Connection already exists"), and
    the hydrate step joins `accounts` so a profile mid-erasure is never
    suggested.
  - `@osn/api`: the recommendations route factory now takes a
    `RecommendationRateLimiters` pair instead of a single backend —
    `createRedisRecommendationRateLimiters` supplies `recs:read` at 20/user/min
    for the fan-out and `recs:search` at 60/user/min for typeahead, which fires
    once per debounced keystroke and would otherwise 429 a user mid-word. Both
    stay per-user and fail-closed.
  - `@osn/client`: `createRecommendationClient` gains `search`, returning people
    and organisations together and taking an `AbortSignal` so a caller can cancel
    a superseded keystroke; `Suggestion` gains `reason` and `sharedOrganisation`.
  - `@osn/social`: search now lives in the shell rather than on one page.
    `GlobalSearch` is an ARIA combobox in the desktop rail — arrow keys move
    `aria-activedescendant` across both sections without leaving the field, Enter
    acts on the active row (Connect / Accept for a person, navigate for an
    organisation), Escape closes. The new `/search` page groups results under
    section headings and is the mobile shell's **Search tab**: the bottom bar is
    the thumb-reachable surface, where a header field is not. `NAV_ITEMS` gained
    a `mobileOnly` flag so the rail — which has the live field — doesn't also
    carry the link, and Discover's icon moved from a magnifier to a person-plus
    so the tab bar doesn't show two magnifiers. Both surfaces share one
    `createSearchController` (debounce, abort, optimistic status), so a row's
    state flips locally on success rather than refetching and reordering the list
    under the cursor — and a failed request renders an error instead of spinning
    forever, since Solid's `resource.latest` rethrows in the error state unless
    the error is read first. The two surfaces run different ARIA patterns on
    purpose: the rail is a combobox whose options carry no operable descendants
    (a listbox option is flattened to its accessible name, so a nested button is
    unreachable to assistive tech), while the page is a plain list with real
    buttons. Discover is now suggestions-only, its cards rendering the
    reason line ("3 mutual connections" / "Also in Acme Inc").

### Patch Changes

- Updated dependencies [94ab93e]
  - @osn/client@2.11.0
  - @osn/ui@1.7.4

## 0.9.3

### Patch Changes

- Updated dependencies [60c58c0]
  - @osn/client@2.10.0
  - @osn/ui@1.7.3

## 0.9.2

### Patch Changes

- 46a301d: Backlog sweep — seven tracked findings closed, no behaviour changes beyond
  each item's own scope.

  **AZ-P-I2 — the authorize client had no deadline.** `createAuthorizeClient`'s
  two `fetch` calls carried neither timeout nor `AbortSignal`, so a stalled
  issuer left the consent screen on its spinner until the browser gave up; the
  retry screen only helps once the promise settles. Both calls now take an
  optional `signal` and run under a default 10s ceiling
  (`DEFAULT_AUTHORIZE_TIMEOUT_MS`, overridable via `timeoutMs`). A timeout or
  transport failure surfaces as a retryable `AuthorizeError` — previously a
  transport failure escaped as a raw `TypeError`, contradicting the documented
  error contract — while a caller's own abort is re-thrown untouched.
  `AuthorizePage` aborts its in-flight context read on unmount.

  **AZ-P-I1 — no `preconnect` to the issuer.** `/authorize` is a cold
  cross-origin landing, so `GET /authorize/context` paid DNS + TCP + TLS before
  it could start. A Vite plugin emits `<link rel="preconnect" crossorigin>` from
  the resolved `VITE_OSN_ISSUER_URL`; a missing or malformed value emits no tag
  rather than a dead one.

  **A-L1 — the consent screen announced nothing.** `<Switch>` swapped the whole
  screen without moving focus, so a screen reader was told nothing when the page
  flipped to "Taking you back…" or to a terminal state. An always-mounted polite
  live region announces each transition; the error screen is left to its
  existing `role="alert"` rather than announced twice.

  **`isAuthExpiredError()` exported from `@osn/client`.** Effect's `FiberFailure`
  wrapping defeats `instanceof AuthExpiredError`, so consumers were
  string-matching the printout by hand. The predicate now ships next to the error
  class and can no longer drift from it.

  **S-L4 — recipient email in the dev OTP log.** `logDevOtp` interpolated the
  address into a free-text message, which the key-based redaction deny-list in
  `@shared/observability` cannot see — the `OSN_ENV` gate was the only thing
  between an OTP recipient and the log sink. The address is dropped; the
  `purpose` + code stay.

  **S-L30 — `createInternalGraphRoutes` had no `loggerLayer`.** Every sibling
  route factory merges the observability layer into its fallback runtime; this
  one did not, so anything it logged off the shared runtime went to Effect's
  default logger, unredacted.

  **S-L2 (series) — RRULE expansion bounds.** An `UNTIL` before `dtstart` parsed
  as valid grammar and silently produced a series with zero instances; it is now
  rejected when the caller knows `dtstart`. `expandRRule` returns immediately on
  an empty window — a routine input, since `extend_window` passes a
  now-plus-90-days horizon — and its safety valve drops from 10,000 iterations
  (~70k `Date` allocations) to `MAX_SERIES_INSTANCES`, which provably cannot
  truncate a legitimate expansion.

  **Recovery-codes loading skeleton.** The generate button was disabled until the
  first `GET /recovery/status` read settled, under a blank gap — indistinguishable
  from a broken button on a slow link. A skeleton holds the status line's height
  and the button reads "Checking…" while it waits.

  ***

  **Corrections from the prep-pr reviews, applied in-branch.**

  **S-M1 (security)** — the deadline and the page's unmount abort originally
  covered `submitDecision` as well. That call is state-changing: it consumes the
  parked request, records the consent row and mints the code. Aborting a fetch
  does not un-send it, so a timeout firing mid-commit surfaced a _retryable_
  error over a grant that had actually happened — Allow/Cancel became clickable
  again, the next click hit a consumed request and rendered "this sign-in request
  has expired", and a live consent sat in Connected apps the user believed they
  had cancelled. The write now carries no default deadline and no unmount signal;
  only the idempotent read does.

  **P-W1 / S-L3 / T-S1 (performance + security)** — the timer was cleared when
  `fetch` resolved, i.e. at response _headers_. A server that flushed headers and
  then stalled mid-body escaped the deadline entirely, which is the exact
  indefinite spinner the feature exists to bound. The body read moved inside the
  guarded window.

  **P-W2 / S-L1 (performance + security)** — the preconnect shipped
  `crossorigin=""`, which is _anonymous_ mode. The connection-pool key includes
  the credentials flag, so an anonymous preconnect is not reused by the
  `credentials: "include"` context read: it opened a second idle TLS connection
  and the handshake was paid anyway — strictly worse than emitting no tag. Now
  `use-credentials`.

  **S-L2 (security)** — both `isAuthExpiredError` and cire's `isAuthExpired`
  matched the tag anywhere in the error printout, so an error whose message
  echoed a server-supplied code could decide to sign a user out. Both matches are
  now anchored to the tag heading the string, which is the shape Effect actually
  renders.

  **P-I1 (performance)** — the new recovery-codes skeleton keyed on raw
  `status.loading`, so the refetch after `acknowledge()` withdrew an
  already-known count from the screen. Gated on the cold read only.

  **P-I3 (performance)** — removed an unreachable branch in the money formatter's
  cache lookup.

  Test coverage added for each of the above, plus the gaps the test review named:
  the preconnect plugin, the `aria-live` region, the unmount abort, `logDevOtp`'s
  redaction, the `loggerLayer` fallback path, `timeoutMs: 0`, and the tightest
  legal RRULE walk.

- Updated dependencies [46a301d]
  - @osn/client@2.9.0
  - @osn/ui@1.7.2

## 0.9.1

### Patch Changes

- 8226487: Refresh dependencies across the monorepo (routine maintenance audit).

  Security-relevant: `@simplewebauthn/server` 13.3.0 → 13.3.2 closes
  GHSA-6hxq-p678-4hr2 (CVSS v4 Low 2.0), where a maliciously-crafted attestation
  `x5c` could present a self-signed "root certificate" rather than chaining to an
  RP-specified trust anchor. Reached through `verifyRegistrationResponse()` on the
  passkey registration path. Exposure was nil rather than merely limited: we
  configure no trust anchors anywhere, so `validateCertificatePath` short-circuits
  on `trustAnchorsPEM.length === 0` and no chain decision was ever made — in
  13.3.0 as much as in 13.3.2. Tracked as S-L102, which also records why
  `attestationType: "none"` is _not_ the control here.

  `jose` moves 6.2.3 → 6.2.4 only, which is a docs update plus an `exportJWK`
  refactor that drops `undefined`-valued properties. That change is inert for us:
  `exportKeyToJwk` immediately `JSON.stringify`s its result, and `thumbprintKid`
  feeds RFC 7638 canonicalisation over `kty`/`crv`/`x`/`y`, so existing `kid`s and
  stored JWKs are byte-identical. The JOSE input-validation hardening (Base64URL
  alphabet, UTF-8 in headers and claims, truncated ASN.1 key data, duplicate
  `crit`) is in **6.2.5**, which this branch does _not_ take — it published
  2026-07-29 and is inside the 3-day quarantine. That upgrade is tracked
  separately and matters, since `jose` sits under both ARC S2S tokens and the
  5-minute `osn-access` JWTs.

  `effect` 3.21.2 → 3.22.0 (deprecates `Graph.neighborsDirected`, unused here),
  with `@effect/vitest` 0.29 → 0.30 and `@effect/opentelemetry` 0.63 → 0.64
  following its `^3.22.0` peer. `@effect/platform` is now an explicit
  `@shared/observability` dependency at `^0.97.0`: it was previously auto-installed
  at 0.94.5 purely to satisfy `@effect/opentelemetry`'s peer and did not actually
  meet it.

  `oxlint` 1.70 → 1.76 makes `vitest/expect-expect` effective inside `it.effect`
  bodies for the first time — the rule was already configured with
  `additionalTestBlockFunctions`, but earlier versions never walked those blocks.
  Ten `@osn/api` tests (of 644) were relying on "the Effect didn't fail" as their
  only assertion; each now asserts the behaviour its name claims, with no change
  to what is under test.

  The `@opentelemetry/*` SDK packages are held at `~2.9.0` rather than moved to
  2.10.0. The exporters and `sdk-logs` cannot follow yet — 0.221.0 is inside the
  14-day minor window — and the 0.220.0 exporters pin `core`/`resources`/
  `sdk-metrics`/`sdk-trace` to exactly 2.9.0, so taking only the SDK half splits
  the tree across two lines and links 2.10.0 packages against `core@2.9.0`. The
  tilde is deliberate: `^2.9.0` still admits 2.10.0. The whole line moves together
  once the exporters are eligible (2026-08-04).

  The root `esbuild` override rises `^0.27.0` → `^0.28.1`, closing
  GHSA-g7r4-m6w7-qqqr. The override had inverted from protective to harmful:
  wrangler 4.114 pins `esbuild 0.28.1` — the fixed version — and the `^0.27.0`
  floor was clamping the whole tree back down to the vulnerable 0.27.7. astro
  already declares `^0.28.0`, so `^0.28.1` now agrees with both consumers instead
  of fighting either. `bun audit` reports no vulnerabilities.

  `oxfmt` 0.44 → 0.59 spans four breaking formatter changes, but produces no
  output change here: the `fmt` script already excludes CSS, astro and markdown,
  and the `sort_imports` reclassification of subpath imports matches nothing in
  the tree. `bun run fmt` is a no-op on the current sources and `fmt:check` is
  clean. 0.60/0.61 stay out until they clear the 14-day minor window.

  Everything else is a patch/minor bugfix bump with no migration steps.

- Updated dependencies [8226487]
  - @osn/client@2.8.1
  - @osn/ui@1.7.1

## 0.9.0

### Minor Changes

- 55a8ea8: Security + UX hardening across the auth stack (review of PRs #315–#324).

  **Identity / OIDC provider (`@osn/api`, `@osn/db`)**

  - Pairwise-`sub` isolation: a self-serve OIDC client's sector is now its
    server-generated `client_id`, not the first redirect-URI host (attacker-chosen
    and unverified), so colluding clients can no longer share a sector to correlate
    the same user across apps.
  - `auth_time` survives silent session rotation: sessions gain an immutable
    `authenticated_at` (new column, copied forward on every refresh), so a relying
    party's `max_age`/`prompt=login` reflects the real passkey ceremony instead of
    the last background token refresh.
  - Consent-screen anti-impersonation: client names are NFKC-normalised, reject
    bidi/zero-width/control characters, and are blocked when they fold to a
    confusable skeleton of a first-party app name (Musubi, OSN, Pulse, Zap, Cire).
  - Step-up tokens are bound to their ceremony purpose at every gate (passkey
    register/delete, email change, security-event ack), closing cross-ceremony
    replay of a still-unconsumed token.
  - Destructive passkey routes fail closed (409) on a presented-but-stale session
    binding instead of degrading to an account-wide session wipe (S-M2).
  - Minor OIDC hardening: generic token-endpoint errors (no internal cause on the
    wire), RFC 9207 `iss` on authorization responses, required browser-binding on
    every parked request (S-L4), a total-rows cap on client registration, and a
    branded HTML error page for pre-validation `/authorize` failures.

  **Client + UI (`@osn/client`, `@osn/ui`, `@osn/social`)**

  - New OIDC connections SDK; Settings → "Connected apps" now lists and revokes
    real connections (GDPR Art. 7(3)) instead of a hardcoded list.
  - The security-events banner is mounted (recovery-code generate/consume events
    now reach the user in-app), and the consent screen surfaces a verifiable
    identity signal (verified-app badge / third-party redirect host).
  - Consent UX: a `login_required` re-auth loop is capped, the profile picker gets
    a decline path, and a trailing-slash `/authorize/` no longer escapes the bare
    layout. CSP tightened (object-src/base-uri/form-action).
  - Recovery codes are guarded against silent loss on navigation after the old set
    is revoked; the rotation warning uses the component-library dialog; the
    step-up dialog explains why re-auth is needed; a failed passkey ceremony maps
    to an actionable recovery message.

### Patch Changes

- Updated dependencies [55a8ea8]
  - @osn/client@2.8.0
  - @osn/ui@1.7.0

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
