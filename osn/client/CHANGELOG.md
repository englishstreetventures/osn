# @osn/client

## 2.12.0

### Minor Changes

- 73c3c89: Keep the auth session out of `localStorage` on iOS.

  `@osn/client` promotes its in-memory `Storage` layer to a real export,
  `createEphemeralStorage()` (was test-only `createMemoryStorage`), and
  `AuthProvider` (`osn/client/src/solid/context.tsx`) gains an optional `storage`
  prop that defaults to `StorageLive`. `@pulse/app` passes
  `createEphemeralStorage()` on an iOS Tauri webview (`App.tsx`), so no access
  token or account metadata ever reaches `localStorage` there — the session
  still survives a cold start through the Keychain-backed refresh cookie
  (`bootstrapFromCookie`). Browser and desktop Tauri behaviour is unchanged.

  The `isIosWebview()` platform check moves out of `nativeSession.ts` into its
  own module, `pulse/app/src/lib/platform.ts`, so both `nativeSession.ts` and
  `App.tsx` can use it.

## 2.11.1

### Patch Changes

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

## 2.11.0

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

## 2.10.0

### Minor Changes

- 60c58c0: N3 (pulse iOS) — the session cookie cannot survive a Tauri webview, so the
  transport moves into Rust.

  Pulse serves its document from `tauri://localhost`. A custom-scheme document is
  cross-site to every real host, so WebKit refuses to _store_ the session cookie —
  measured on an iOS 26 simulator against `SameSite=Lax`, `SameSite=None` and no
  attribute, checked on the page (`document.cookie` empty, no `Cookie` header on
  the next request), on the wire, and in `WKHTTPCookieStore`, which came back
  empty. That last one matters: it rules out the obvious workaround of injecting
  the cookie from Swift, because the jar itself is unusable, not just the send
  path.

  osn-api reads the refresh token only from that cookie, so on iOS sign-in appears
  to work and the session then dies with the first access token with no way back.

  `@osn/client` gains one seam, `sessionFetch`, used by the five routes that
  establish or consume the cookie (`/login/passkey/complete`, `/register/complete`,
  `/login/recovery/complete`, `/token`, `/logout`). It is plain `fetch` everywhere
  except iOS. Nothing else changes: the retry classification, the backoff and the
  single-flight guards stay in `service.ts`, which is where they are tested — a
  second copy behind a native implementation is how the two drift apart.

  Pulse adds a `pulse-session` Tauri plugin that fills that seam on iOS. Rust holds
  the policy and the Keychain-backed jar; Swift is pure transport over a
  cookie-less `URLSession`. Because a JS-callable "send my credentials" command is
  ambient authority, three things fence it in: the caller supplies a path and never
  a URL, the path must match a five-entry allowlist exactly, and `Set-Cookie` never
  crosses back into JS. The issuer origin comes from `tauri.conf.json` and a bad
  one fails app startup rather than the first sign-in.

  The allowlist is five routes rather than everything because osn-api already falls
  back to the access token's `osn_sid` binding for a native client on every other
  cookie-reading route.

## 2.9.0

### Minor Changes

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

## 2.8.1

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

## 2.8.0

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

## 2.7.0

### Minor Changes

- 40100ad: OIDC consent screen. `@osn/client` gains `createAuthorizeClient` — two credentialed calls (`getContext`, `submitDecision`) against the parked authorize request, with an `AuthorizeError` that says whether the request is dead or whether signing in again fixes it. `@osn/social` gains the `/authorize` page it drives: client card, humanised scopes, profile picker when there is a real choice, and a `login_required` loop that holds the user's answer, re-authenticates and replays it against the same request id — but only after checking that the same account came back; a different sign-in drops the held answer and says so. `prompt=login` puts the ceremony before the decision, and a failed context read (a 429, a dropped connection) offers a retry instead of an endless spinner.

  The page runs on a bare layout with no navigation out of the flow, and ships `frame-ancestors 'none'` so a consent screen can never be framed. Bare routes also run outside `AuthProvider`: mounting it bootstraps a session, which rotates the refresh token, and lists profiles the consent screen never reads. The provider now sits inside the sign-in island, which loads only when a ceremony is needed.

## 2.6.0

### Minor Changes

- 0953024: Wire recovery codes into the settings UI, and fix the generate call that could never succeed.

  `generateRecoveryCodes` in `@osn/client` posted an empty body and no step-up token, so `POST /recovery/generate` answered 403 `step_up_required` every time. It now forwards the token, and `RecoveryCodesView` runs the passkey/OTP ceremony that mints it — the same `StepUpDialog` flow `PasskeysView` uses.

  Binds the generate gate to a purpose (S-M1). `POST /recovery/generate` now requires a step-up token minted with `purpose: "recovery_generate"`, so a token from another ceremony — an email change, a passkey delete — cannot be replayed against the one action that destroys an account's whole existing set. `StepUpDialog` gained a `purpose` prop and `@osn/client` forwards it through both `/complete` routes; a purposeless token is refused, with no legacy fallback.

  Adds `GET /recovery/status`, which reports how many codes an account has left and when the set was minted. It carries counts only, never a code, so it needs no step-up — gating it would be circular, since the answer is what tells a user whether starting a ceremony is worth it. The view leads with it, and says outright when an account has no codes at all.

  `RecoveryCodesView` is now mounted in Settings → Security in `@osn/social` (it previously rendered nowhere).

## 2.5.1

### Patch Changes

- e01206c: fix(auth): stop refresh-token rotation from logging users out on concurrent grants

  Refresh-token rotation revoked the entire session family whenever two grants of the same current token raced — multiple tabs bootstrapping on reload, a cold-start bootstrap racing a 401-refresh, or a retried grant after a lost response. That is a false positive (a replay of an already-rotated token can't reach the CAS branch; only concurrent use of the live token does), and it logged legitimate users out across every device well before the 30-day session TTL.

  Server (`@osn/api`): a 0-rows rotation CAS is now treated as benign concurrency (family preserved, `rotation_race` metric) instead of reuse, and `detectReuse` applies a short `ROTATION_GRACE_MS` (10 s) window — a rotated-out token replayed within the window is benign, outside it is still genuine reuse and still revokes the family. `RotatedSessionStore.check` now returns the rotation timestamp.

  Client (`@osn/client`): the bootstrap and refresh paths share one `/token` single-flight so a bootstrap racing a refresh in one tab fires the grant once.

## 2.5.0

### Minor Changes

- 6b14961: C-H8: COPPA under-13 age gate on registration.

  `POST /register/begin` now requires a `birthdate` (`YYYY-MM-DD`). The
  registration service validates the date format (`BirthdateSchema`) and then
  hard-rejects any registrant under 13 with a new `AgeRestrictionError` →
  HTTP 422 `{ error: "age_restricted", message: "OSN is for users 13 and older" }`
  — **before** any collision probe or OTP dispatch, so OSN never gains "actual
  knowledge" of a child's data. The birthdate is a transient argument and is
  never written to any store or table (no rejected or accepted DOB retained).

  The client SDK's `beginRegistration` gains a required `birthdate` field, and
  `@osn/ui`'s `Register` form adds a date-of-birth input that mirrors the gate
  client-side for immediate feedback (the server remains authoritative). The
  legacy, unrouted `registerProfile` seed helper is intentionally left ungated.

  Also hardens `publicError`: `Effect.runPromise` rejects with a `FiberFailure`
  that stores the tagged error under a symbol-keyed `Cause`, which the previous
  walker never traversed — so every Effect failure silently fell through to the
  default 400. The walker now descends through all own keys (including symbols)
  and skips Effect's internal Cause tags, so tagged errors like
  `AgeRestrictionError` (422) map to their real status.

## 2.4.0

### Minor Changes

- f62784d: Code-quality sweep: lint-config repair + convention fixes monorepo-wide.

  - oxlint config: pin rules that leaked in via an upstream category re-shuffle
    (`no-underscore-dangle` off — Effect `_tag` is idiomatic;
    `unicorn/consistent-function-scoping` off — boot-time factory modules and
    Effect-context DI make it noise; `no-await-in-loop` off in tests), raise
    `jsx-a11y/control-has-associated-label` depth for Solid control-flow
    wrappers. 463 → 21 warnings; the survivors are the deliberate aspirational
    jsx-a11y set.
  - S-M5 (osn): `/account` erasure endpoints now thread `clientIpConfig` +
    socket peer into per-IP rate-limit keying (spoofable XFF no longer picks
    the bucket; unresolved IPs are denied, S-M34 posture) — with route tests.
  - pulse/api + zap/api route factories now build their Effect layer graph once
    per factory via `ManagedRuntime` instead of `Effect.provide(dbLayer)` inside
    every request (convention: `osn/api/src/lib/route-runtime.ts`); dead
    pre-instantiated route-group exports removed.
  - Dead exports removed: `decodeSession` (@osn/client), `getHandleFromToken`
    (@pulse/app).
  - Assorted lint fixes: variable shadowing renames, unused imports, promise
    handling in `TurnstileWidget`, `toSorted` in tests.

## 2.3.4

### Patch Changes

- 368e3e8: Performance audit sweep (versioned packages). No behavioural or security
  changes — fail-closed rate limiting, visibility gates, consent checks,
  single-use guarantees, and tenant scoping are preserved exactly.

  - `@zap/api`: `listChats` is cursor-paginated (default 50, max 100) with a
    composite `(createdAt, id)` keyset cursor (same-second creation bursts are
    never skipped) and caller-scoped cursors (unknown/foreign cursors
    rejected); `getChatMembers` is limit/offset-paginated (default 100, max 500) and skips its redundant existence load when the route has already
    asserted membership; both list responses carry `hasMore` (+ `nextCursor`
    for chats) continuation metadata; `addMember` checks the member cap with
    `COUNT(*)` instead of fetching every member row.
  - `@osn/api`: ceremony-store TTL sweep debounced to once per 30s (hard cap
    still enforced on every set); `beginRegistration`/`registerProfile`
    uniqueness probes collapsed to one round-trip via `UNION ALL` of two
    indexed single-table arms (an `OR` across the users-accounts join defeats
    SQLite's OR-optimization and plans as a full table scan);
    `sendConnectionRequest` reads run concurrently; `consumeRecoveryCode` is a
    single atomic conditional `UPDATE … RETURNING` (also closes the remaining
    check-then-act window); `countActiveRecoveryCodes` is a SQL aggregate that
    no longer fetches `code_hash` values; redundant accounts read moved out of
    the identified passkey-login path; per-call `TextEncoder` allocation and
    per-issuance `process.env` reads hoisted to module scope.
  - `@pulse/api`: status-transition persistence batched to one `UPDATE … WHERE
id IN (…)` per (from → to) group across all five list surfaces (was up to
    500 writes per GET on series instances); `updateSeries`/`cancelSeries`
    collapsed to single race-free `UPDATE … RETURNING`; `listTodayEvents`
    capped at 200 rows; RSVP routes thread the already-loaded event row into
    `listRsvps`/`rsvpCounts`/`latestRsvps`; `createEvent` uses `INSERT …
RETURNING`; `GET /events/:id/ics` sends `Cache-Control: private,
no-cache` + a weak ETag and honours `If-None-Match` (including `*` and
    multi-value lists) with 304 — every reuse revalidates through the
    visibility gate.
  - `@pulse/db`: new `event_rsvps_event_status_idx (event_id, status)`
    composite index; the subsumed single-column `event_rsvps_event_idx` is
    dropped (migration 0008).
  - `@osn/client`: `RegistrationClient.checkHandle` accepts an optional
    `AbortSignal` so debounced callers can cancel stale availability probes.
  - `@osn/ui`: `Register` and `CreateProfileForm` abort the previous in-flight
    handle check before issuing a new one and on unmount.
  - `@pulse/app`: Explore map resize handling is debounced (100 ms), grid
    geometry is memoized per size, and theme detection is a reactive
    `MutationObserver`-driven signal instead of a per-access DOM read.

## 2.3.3

### Patch Changes

- f4b9c6b: Upgrade oxlint to 1.70; satisfy tightened vitest rules — add toThrow messages and fix standalone-expect in test suites

## 2.3.2

### Patch Changes

- 0a297de: Keep the organiser signed in across page reloads via the refresh cookie. On
  reload the cached access token in `localStorage` is almost always expired (5-min
  TTL), so `loadSession` previously reported the user as logged out and bounced
  them to sign-in even though the 30-day HttpOnly refresh cookie was alive. It now
  rehydrates an expired-but-`hasSession` account from the cookie via `POST /token`,
  and the shared cookie grant retries transient failures (network / 429 / 5xx)
  with bounded backoff while still failing fast on a terminal `invalid_grant`.

## 2.3.1

### Patch Changes

- 1dd9f6d: Fix organiser login loop: bootstrap a session from the HttpOnly refresh cookie on cold start.

  After a successful passkey sign-in the organiser dashboard performed a full-page navigation, recreating a fresh `AuthProvider`. On that cold start the client had no stored account, so the session resource resolved `null` and `RequireAuth` bounced back to `/login` — even though the refresh cookie set by `/login/passkey/complete` was alive.

  `OsnAuthService` now exposes `loadSession()`: when no account is stored it replays the cookie against `POST /token` (`grant_type=refresh_token`, `credentials: "include"`) exactly once (single-flighted), reconstructs and persists the account from the token response, and returns the session. If no/expired cookie is present it resolves to `null` (logged out, fail-safe — never throws). The SolidJS session resource now calls `loadSession()` on mount. The authenticated 401-refresh path and its single-flight guard are unchanged.

## 2.3.0

### Minor Changes

- d81383d: Add Cloudflare Turnstile bot protection to the OSN auth surface (key-optional, fail-closed).

  New `@shared/turnstile` package exposes `createTurnstileVerifier(secret?)` — a key-optional, fail-closed siteverify helper. When the `TURNSTILE_SECRET_KEY` secret is **unset** the verifier is `null` and every gate is skipped (flows behave exactly as before — safe to merge before the widget exists). When **set**, it POSTs the token to Cloudflare's managed `siteverify` endpoint via `instrumentedFetch`, passing the caller's `cf-connecting-ip` as `remoteip`, and rejects on any missing / invalid / expired / duplicate (single-use) token or unreachable endpoint. The secret is never logged or returned to the client.

  - **`@osn/api`**: `/register/begin` and `/login/passkey/begin` are gated. The verifier is built once per isolate in `build-deps.ts` from `env.TURNSTILE_SECRET_KEY` and threaded through `createAuthRoutes`; a configured gate fails closed with `400 turnstile_failed`. New bounded metric `osn.auth.turnstile.rejected{endpoint}`.
  - **`@osn/client`**: `RegistrationClient.beginRegistration` and `LoginClient.passkeyBegin` accept an optional `turnstileToken`, sent on the begin call (omitted cleanly when absent — the no-Turnstile call shape is unchanged, and the silent conditional-UI passkey ceremony carries no token).
  - **`@osn/ui`**: new `TurnstileWidget` (Solid) renders Cloudflare's widget only when a `siteKey` prop is provided (lazy-loads `api.js`, `data-action="turnstile-spin-v1"`); `Register` + `SignIn` take an optional `turnstileSiteKey` prop and gate submit on a solved challenge. Omitted ⇒ no widget, no gate.

  The sitekey is public (embedded in client HTML at build time via `PUBLIC_TURNSTILE_SITEKEY`); the secret is a `wrangler secret` on osn-api. Both halves are optional and graceful, mirroring the maps-embed key and `OSN_EMAIL_OPTIONAL` precedents.

## 2.2.1

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

## 2.2.0

### Minor Changes

- c3cca40: Account deletion compliance (C-H2 / GDPR Art. 17).

  Two flows:

  - **Flow A — full OSN account delete.** New `DELETE /account` on osn-api with step-up gate, 7-day soft-delete grace + manual fast-track, ARC fan-out to currently-enrolled apps, hard-delete sweeper.
  - **Flow B — leave Pulse.** New `DELETE /account` on pulse-api with step-up verification round-trip to osn-api. Hosted events flip into a 14-day public cancellation window before hard-delete (audience commitment, independent of the 7-day account grace).

  Schema additions:

  - `osn/db`: `accounts.deleted_at`, `accounts.processing_restricted_at`, new `app_enrollments` (modular-platform opt-in tracking) and `deletion_jobs` (in-flight tombstones with per-bridge `*_done_at`).
  - `pulse/db`: `events.cancelled_at` / `hard_delete_at` / `cancellation_reason`, new `pulse_deletion_jobs`.

  Other surfaces:

  - New step-up token `purpose` claim (`account_delete`, `pulse_app_delete`) — confused-deputy guard for cross-service flows.
  - New osn-api internal endpoints: `/internal/step-up/verify`, `/internal/app-enrollment/{join,leave}`. ARC scopes `step-up:verify`, `app-enrollment:write`, `account:erase` added to the register-service allowlist.
  - Pulse becomes an ARC verifier (in-memory key registry + `/internal/register-service`) and an ARC issuer for the leave-app callback.
  - New observability: `osn.account.deletion.{requested,completed,duration,fanout,fanout_pending_age}`, `osn.account.app_enrollment.{joined,left}`, `pulse.account.deletion.*`, `pulse.events.host_cancelled[.hard_delete]`.
  - New `osn/client` SDK methods: `deleteAccount`, `cancelAccountDeletion`, `getAccountDeletionStatus`.

## 2.1.1

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

## 2.1.0

### Minor Changes

- 1d68593: Let users add additional biometrics (passkeys) after registration. Registration already required enrolling a first passkey; Settings now exposes a Security tab with an "Add passkey" button that runs the step-up-gated WebAuthn registration ceremony, plus the existing list / rename / delete surface. `PasskeysClient` gains `registerBegin` / `registerComplete` so the Settings surface can call `/passkey/register/begin` + `/complete` directly.

## 2.0.1

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

## 2.0.0

### Major Changes

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

## 1.1.0

### Minor Changes

- b1d5980: M-PK: passkey-primary prerequisites — passkey management surface + discoverable-credential login.

  **Features**

  - `GET /passkeys`, `PATCH /passkeys/:id`, `DELETE /passkeys/:id` (step-up gated) — list, rename, remove credentials from Settings.
  - Discoverable-credential / conditional-UI passkey login. `POST /login/passkey/begin` accepts an empty body and returns `{ options, challengeId }`; clients round-trip the challenge ID to `/login/passkey/complete`.
  - `last_used_at` tracking on every assertion + step-up ceremony (60s coalesce).
  - WebAuthn enrolment tightened to `residentKey: "required"` + `userVerification: "required"`.
  - Hard cap of 10 passkeys per account (P-I10), enforced at both `begin` and `complete`.
  - New `SecurityEventKind` `passkey_delete` — audit row + out-of-band notification, same pattern as recovery-code generate/consume.
  - Last-passkey lockout guard: `DELETE /passkeys/:id` refuses the final credential unless recovery codes exist.
  - New `@osn/client` surface `createPasskeysClient`; `@osn/ui/auth/PasskeysView` settings panel.
  - `SignIn` opportunistically invokes `navigator.credentials.get({ mediation: "conditional" })` on mount when supported.

  **Breaking**

  - Removed the legacy unverified `POST /register` HTTP endpoint — use `/register/begin` + `/register/complete`.
  - `LoginClient.passkeyComplete` now takes `{ identifier | challengeId, assertion }` instead of positional args.
  - `AuthMethod` attribute union dropped `"password"` (OSN is passwordless).

  **DB**

  - Migration `0007_passkey_management.sql` adds `label`, `last_used_at`, `aaguid`, `backup_eligible`, `backup_state`, `updated_at` columns to `passkeys` (all nullable).

  **Observability**

  - New span names `auth.passkey.{list,rename,delete}`.
  - New counter `osn.auth.passkey.operations{action, result}`.
  - New histogram `osn.auth.passkey.duration{action, result}`.
  - New counter `osn.auth.passkey.login_discoverable{result}`.
  - `SecurityInvalidationTrigger` extended with `passkey_delete`.
  - Log redaction deny-list adds `attestation`, `passkeyLabel`/`passkey_label`.

## 1.0.0

### Major Changes

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

## 0.10.0

### Minor Changes

- 811eda4: feat(auth): out-of-band security-event audit + notification for recovery-code regeneration (M-PK1b)

  - Adds a `security_events` table and inserts an audit row inside the same transaction that regenerates recovery codes. The row captures the UA label + peppered IP hash of the request that triggered it.
  - Sends a best-effort notification email ("Your OSN recovery codes were regenerated") on success. Email failure is logged and reported via metrics but never rolls back the primary action — the audit row is the signal.
  - Exposes `GET /account/security-events` and `POST /account/security-events/:id/ack` (Bearer-authenticated, rate-limited). The list surface only returns unacknowledged rows; ack is idempotent and scoped to the owning account.
  - Adds a `SecurityEventsBanner` component (`@osn/ui/auth`) plus `createSecurityEventsClient` (`@osn/client`) so the Settings surface can render "was this you?" prompts that keep rendering until dismissed — regardless of whether the confirmation email was delivered.
  - New OTel counters + histogram on `osn.auth.security_event.*` (recorded, notified, acknowledged, notify.duration), all with bounded string-literal attributes.
  - Redaction deny-list now covers `securityEventId` / `security_event_id`.

  Unblocks the Phase 5 passkey-primary migration: a stolen access token + inbox hijack can no longer silently burn the account's recovery codes.

## 0.9.0

### Minor Changes

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

## 0.8.0

### Minor Changes

- 9459f5e: feat(auth): recovery codes (Copenhagen Book M2) + short-lived access tokens

  **Recovery codes (M2)**

  - 10 × 64-bit single-use codes per generation (`xxxx-xxxx-xxxx-xxxx`), SHA-256 hashed at rest in the new `recovery_codes` table.
  - `POST /recovery/generate` (Bearer-auth, 3/hr/IP) returns the raw codes exactly once; regenerating atomically invalidates the prior set.
  - `POST /login/recovery/complete` (5/hr/IP) consumes a code, revokes every session on the account, and establishes a fresh session + cookie.
  - `@shared/crypto` exports `generateRecoveryCodes`, `hashRecoveryCode`, `verifyRecoveryCode`.
  - `@osn/client` exposes `createRecoveryClient`; `@osn/ui` ships `RecoveryCodesView` and `RecoveryLoginForm`.
  - Observability: `osn.auth.recovery.codes_generated`, `osn.auth.recovery.code_consumed{result}`, `osn.auth.recovery.duration`; spans `auth.recovery.{generate,consume}`; redaction deny-list additions for recovery fields.

  **Short-lived access tokens**

  - Default access-token TTL cut from 3600s to 300s (breaking for third-party consumers that cached past `expires_in`).
  - New `OsnAuthService.authFetch(input, init)` (also exposed via the SolidJS `useAuth()` context) silent-refreshes on 401 via the HttpOnly session cookie and retries once; surfaces `AuthExpiredError` when refresh fails.

  **Migration**

  - New Drizzle migration `osn/db/drizzle/0004_add_recovery_codes.sql`.
  - `AuthRateLimiters` gains `recoveryGenerate` and `recoveryComplete` (Redis bundle auto-populated).

  Mitigates prior backlog items: `S-M20` (refresh tokens in localStorage — now paired with a 5-min access-token ceiling) and unblocks M-PK (passkey-primary migration).

## 0.7.0

### Minor Changes

- 2d5cce9: HttpOnly cookie sessions (C3), Origin guard (M1), hash magic/OTP tokens (H2/H3), extract shared auth derive (S-M2)

## 0.6.0

### Minor Changes

- 2a7eb82: feat(auth): refresh token rotation (C2), session invalidation on security events (H1), profile endpoints migrated to access token auth (S-H1)

  - **C2**: Refresh token rotation on every `/token` refresh grant. New `familyId` column on `sessions` table groups all tokens in a chain. Replaying a rotated-out token revokes the entire family.
  - **H1**: `invalidateOtherAccountSessions(accountId, keepSessionHash)` revokes all sessions except the caller's on passkey registration.
  - **S-H1**: `/profiles/list`, `/profiles/switch`, `/profiles/create`, `/profiles/delete`, `/profiles/:id/default` authenticate via `Authorization: Bearer <access_token>` instead of `refresh_token` in body.
  - Observability: 4 new session metrics, 3 new spans, `familyId` added to redaction deny-list.

## 0.5.1

### Patch Changes

- ac6a86c: feat(auth): server-side sessions with revocation (Copenhagen Book C1)

  Replace stateless JWT refresh tokens with opaque server-side session tokens.
  Session tokens use 160-bit entropy, stored as SHA-256 hashes in the new `sessions` table.
  Sliding-window expiry, single-session and account-wide revocation, `POST /logout` endpoint.
  Removes deprecated `User`/`NewUser` type aliases and legacy client session migration.

## 0.5.0

### Minor Changes

- e2e010e: Add `@osn/social` app — identity and social graph management UI. Add
  `recommendations` service and route to `@osn/core`. Add `graph` and
  `organisations` client modules with Solid `GraphProvider` and `OrgProvider`.
  Fix dropdown menu not opening by wrapping `DropdownMenuLabel` in
  `DropdownMenuGroup` (required by Kobalte).

## 0.4.0

### Minor Changes

- fcd8e8f: Multi-account P4: Client SDK profile management — multi-session storage model with per-profile access tokens, profile list/switch/create/delete methods, SolidJS context integration, and legacy session migration.

## 0.3.2

### Patch Changes

- f2fbc2a: Replace valibot with Effect Schema for token response validation, consolidating all non-HTTP-boundary validation on Effect Schema

## 0.3.1

### Patch Changes

- 5520d90: Rename all "user" data structure references to "profile" terminology — User→Profile, PublicUser→PublicProfile, LoginUser→LoginProfile, PulseUser→PulseProfile. Login wire format key renamed from `user` to `profile`. "User" now exclusively means the actual person, never a data structure.

## 0.3.0

### Minor Changes

- f5c1780: feat: add multi-account schema foundation (accounts table, userId → profileId rename)

  Introduces the `accounts` table as the authentication principal (login entity) and renames
  `userId` to `profileId` across all packages to establish the many-profiles-per-account model.

  Key changes:

  - New `accounts` table with `id`, `email`, `maxProfiles`
  - `users` table gains `accountId` (FK → accounts) and `isDefault` fields
  - `passkeys` re-parented from users to accounts (`accountId` FK)
  - All `userId` columns/fields renamed to `profileId` across schemas, services, routes, and tests
  - Seed data expanded: 21 accounts, 23 profiles (including 3 multi-account profiles), 2 orgs
  - Registration flow creates account + first profile atomically

## 0.2.1

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).

## 0.2.0

### Minor Changes

- 97f35e5: Add shared in-app sign-in and registration across the OSN stack.

  **`@osn/core`** — new first-party `/login/*` endpoints that return a
  `Session + PublicUser` directly, mirroring the existing `/register/*`
  flow with no PKCE round-trip:

  - `POST /login/passkey/{begin,complete}`
  - `POST /login/otp/{begin,complete}` (enumeration-safe: `begin` always
    returns `{ sent: true }`)
  - `POST /login/magic/{begin}` + `GET /login/magic/verify?token=…`

  Service layer refactored to extract `verifyPasskeyAssertion`,
  `verifyOtpCode`, and `consumeMagicToken` helpers so the direct-session
  variants (`completePasskeyLoginDirect`, `completeOtpDirect`,
  `verifyMagicDirect`) share verification logic with the existing
  code-issuing variants. The hosted `/authorize` HTML + PKCE path is
  unchanged and remains the third-party OAuth entry point.

  **`@osn/client`** — new `createLoginClient({ issuerUrl })` factory
  mirroring `createRegistrationClient`, with `passkeyBegin/Complete`,
  `otpBegin/Complete`, `magicBegin/Verify` methods. Throws `LoginError`
  on non-2xx. Returned sessions are already parsed via `parseTokenResponse`
  and ready to pass to `AuthProvider.adoptSession`.

  **`@osn/ui`** — new shared SolidJS components under `@osn/ui/auth`:

  - `<Register />` — migrated from `@pulse/app` with a new `client` prop
    so it's decoupled from any specific app's env config.
  - `<SignIn />` — new three-tab sign-in (passkey / OTP / magic) driving
    the new `/login/*` endpoints through an injected `LoginClient`. Auto-
    falls-back to OTP when WebAuthn is unsupported.
  - `<MagicLinkHandler />` — invisible root-level component that exchanges
    a `?token=…` query param for a session and clears the URL.

  Package now pulls in the SolidJS + Vitest + @simplewebauthn/browser
  devDeps it needs to actually host these components.

  **`@pulse/app`** — replaces the old `useAuth().login()` redirect to
  `/authorize` with an in-app `<SignIn />` modal. Imports `<Register>`,
  `<SignIn>`, and `<MagicLinkHandler>` from `@osn/ui/auth/*`; shared
  `RegistrationClient` and `LoginClient` instances live in
  `src/lib/authClients.ts` and are injected as props.

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

## 0.1.0

### Minor Changes

- cf57969: Add an email-verified registration flow end-to-end with passkey enrolment, plus a security redesign that addresses the critical findings raised during review.

  **`@osn/core` — new endpoints + service work**

  - `POST /register/begin` — validates email + handle, normalises email to lowercase, generates an unbiased 6-digit OTP via rejection sampling, stores a pending registration in a bounded (10k cap), swept-on-insert in-memory map, and emails the OTP. Always returns `{ sent: true }` regardless of conflict to remove the user-enumeration oracle (S-M1/S-M26). Refuses to overwrite a non-expired pending entry to prevent griefing of in-progress registrations (S-M2/S-M23).
  - `POST /register/complete` — verifies the OTP using a constant-time comparison (S-M4/S-M25), enforces a 5-attempts-then-wipe brute-force cap (S-H1 partial), inserts the user using the DB unique constraint as the source of truth (no TOCTOU; the pending entry is only deleted after a successful insert — S-H4/S-H10), and returns access + refresh tokens **directly** alongside a single-use enrollment token. The registration code path no longer touches `/token` so it does not depend on the pre-existing PKCE bypass at `/token` (tracked separately as S-H4/S-H9).
  - New `issueEnrollmentToken` / `verifyEnrollmentToken` service helpers — short-lived (5 min) JWTs of `type: "passkey-enroll"`, single-use via an in-memory consumed-jti set with opportunistic sweep.
  - `POST /passkey/register/{begin,complete}` now accept an `Authorization: Bearer <token>` header where the token is either an enrollment token or a normal access token; the token's `sub` is compared against the body `userId` and a mismatch returns `401` (S-C1/S-H5 partial). The legacy unauth'd path is preserved with a deprecation warning so the hosted `/authorize` HTML page still works; removing it is tracked in the security backlog.
  - New `publicError()` route helper maps Effect-tagged errors to opaque public payloads (`invalid_request`, `internal_error`) and logs the underlying cause server-side (S-H5/S-M6/S-M4).
  - Dev-only `console.log` of OTP codes is now gated on `NODE_ENV !== "production"` (S-M3/S-M22).

  **`@osn/client` — RegistrationClient redesign**

  - `createRegistrationClient` exposes `checkHandle`, `beginRegistration`, `completeRegistration`, `passkeyRegisterBegin`, `passkeyRegisterComplete`. **`exchangeAuthCode` is gone** — `completeRegistration` now returns a parsed `Session` ready for `AuthProvider.adoptSession` plus an `enrollmentToken`. Both passkey calls accept the enrollment token and send it as `Authorization: Bearer <token>`.
  - New `OsnAuth.setSession` + Solid `AuthProvider.adoptSession` for installing a session obtained out-of-band by the registration flow.

  **`@osn/pulse` — Register component**

  - Multi-step UI: details (email + handle + display name with debounced live availability check) → 6-digit OTP → optional passkey enrolment → done.
  - `adoptSession` is called immediately after OTP verification, **before** any passkey work — the user is signed in regardless of whether they go on to set up a passkey, so a flaky WebAuthn ceremony or an unsupported environment can no longer leave them stranded.
  - WebAuthn feature-detection via `browserSupportsWebAuthn()`; the passkey step is skipped entirely (and the UI jumps straight to "done") on environments without WebAuthn — currently Tauri's iOS webview, until we ship the native plugin.
  - Imperative skip path replacing the previous `createEffect` (P-I10), inlined `detailsValid` accessor (P-I11), module-scope `RegistrationClient` (P-I12).
  - Wired into `EventList` as a "Create account" button next to "Sign in with OSN".

  **Test coverage** (277 tests total, +58 from the previous PR baseline)

  - Service-level: happy path, lowercase normalisation, no-row-before-verify, ValidationError on bad inputs, enumeration-resistant begin, refuse-to-overwrite pending entry, wrong OTP, no-pending error, single-use replay, brute-force attempt cap, TOCTOU loss against legacy `/register`, enrollment token issue/verify/consume, replay rejection, type-claim discrimination.
  - Route-level: complete shape assertions, enumeration-resistant 200 responses, complete-without-begin, replay attack, reserved handle availability, Authorization gating with valid enrollment token / valid access token / mismatched sub / invalid bearer / legacy unauth'd path, enrollment-token consumption on `/complete`.
  - Client unit tests: URL composition, body shapes, Authorization header propagation, RegistrationError on non-OK, trailing-slash issuerUrl normalisation.
  - Solid `AuthProvider.adoptSession` round-trip test (real provider, harness component, asserts both `useAuth().session()` reactivity and `localStorage` persistence).
  - Pulse Register component test: input sanitisation, debounced availability with stale-result guard, `detailsValid` gating during `checking`, OTP digit-only clamp, immediate `adoptSession` after OTP, happy passkey enrolment with enrollment token propagation, "Skip for now" → done, WebAuthn-unsupported jump-to-done, Cancel.

## 0.0.3

### Patch Changes

- 75f801b: Implement OSN Core auth system.

  - `@osn/core`: new auth implementation — passkey (WebAuthn via @simplewebauthn/server), OTP, and magic-link sign-in flows; PKCE authorization endpoint; JWT-based token issuance and refresh; OIDC discovery; Elysia route factory; sign-in HTML page with three-tab UI; 25 service tests + route integration tests
  - `@osn/osn`: new Bun/Elysia auth server entrypoint at port 4000; imports `@osn/core` routes; dev JWT secret fallback
  - `@osn/db`: schema updated with `users` and `passkeys` tables; migration generated
  - `@osn/client`: `getSession()` now checks `expiresAt` and clears expired sessions; `handleCallback` exposed from `AuthProvider` context
  - `@osn/pulse`: `CallbackHandler` handles OAuth redirect on page load; fix events resource to load without waiting for auth; fix location autocomplete re-triggering search after selection
  - `@osn/api`: HTTP-level route tests for category filter and invalid startTime/endTime

## 0.0.2

### Patch Changes

- 880e762: Add @osn/client package with OAuth 2.0 + PKCE auth core, SolidJS and React adapters. Wire AuthProvider into Pulse.
