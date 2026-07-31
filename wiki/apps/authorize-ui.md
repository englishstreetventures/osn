---
title: Authorize UI (OIDC consent screen)
description: Spec for the interaction surface behind /authorize — sign-in handoff, profile picker, consent, and the login_required retry loop
tags: [app, identity, oidc, spec]
status: active
packages:
  - "@osn/social"
related:
  - "[[oidc-provider]]"
  - "[[social]]"
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[sessions]]"
  - "[[musubi-identity-migration]]"
last-reviewed: 2026-07-30
---

# Authorize UI — the OIDC consent screen

`/authorize` parks the request and redirects here; this page reads it back,
walks the user through sign-in / profile choice / consent, posts the
decision, and navigates to wherever the provider says. Every rule below is
enforced server-side as well, with test coverage in
`osn/api/tests/routes/oidc.test.ts`.

**Built 2026-07-26.** The page lives at `osn/social/src/pages/AuthorizePage.tsx`
and talks to the provider through `createAuthorizeClient` in
`osn/client/src/authorize.ts`. Tests: `osn/social/tests/components/AuthorizePage.test.tsx`
and `osn/client/tests/authorize.test.ts`.

**Deployed 2026-07-26**, on `me.cireweddings.com` at first. **Moved to the
`musubi.social` apex 2026-07-27** with the rest of identity — see
[[musubi-identity-migration]]. `@osn/social` has a Pages job in `deploy.yml`;
`OSN_AUTHORIZE_UI_URL` points at it.

## Where it lives

- **Route:** `/authorize` in `@osn/social` (the identity-domain web app),
  served at `https://musubi.social/authorize`.
  In production the app must be served under the same registrable domain as
  osn-api (`musubi.social`) — the session cookie and the per-request binding
  cookie are both host-bound to `id.musubi.social` and flow on same-site fetches
  with `credentials: "include"`. The apex is therefore in `OSN_CORS_ORIGIN`
  (every call it makes is cross-origin) and in `OSN_ORIGIN` (it runs the
  passkey ceremony). It is also the WebAuthn RP ID, which is what makes that
  ceremony legal at all.
- **Config:** `OSN_AUTHORIZE_UI_URL` on osn-api
  (`[env.production].vars`). Unset, the provider falls back to `/authorize`
  on the **first** `OSN_ORIGIN`. That happens to be the right host now, but
  the fallback silently follows list order, so this one is set explicitly.
- The page is a plain top-level document — never an iframe (the provider's
  cookies are `SameSite=Lax`, and framing a consent screen is clickjacking
  bait; ship `frame-ancestors 'none'` in the page's CSP).

## What arrives in the URL

`?request=oar_<12hex>&reason=login|select_account|consent`

That is all. The OAuth parameters (client, scopes, redirect URI, state)
are parked server-side; the page cannot see or alter them — a tampered
address bar cannot widen what the user approves. `reason` is a rendering
hint only; the server re-derives every requirement at decision time, so
the page may treat it as advisory.

The browser also already holds the **binding cookie** for this request id
(`__Host-osn_oar_<12hex>`, HttpOnly, 600 s) — set by the `/authorize`
redirect that brought the user here. The page never reads or writes it;
it just must make all API calls same-origin with credentials so it rides
along. If the user opens the link in a *different* browser, every call
404s — render the "start over at the app you came from" state.

## API contract

| Call | When | Notes |
|---|---|---|
| `GET /authorize/context?request=<id>` | On load, and again after any sign-in | Returns `{ client: { clientId, name, logoUrl, firstParty }, scopes: string[], signedIn: boolean, profiles: PublicProfile[], linkedProfileId: string \| null }`. 404 ⇒ expired (10 min TTL), consumed, or wrong browser. |
| `POST /authorize/decision` `{ requestId, profileId, approved }` | On Approve / Deny | Success ⇒ `{ redirectTo }` — assign `window.location`. The request id is single-use on success either way. |
| Existing sign-in surface (`/passkey/login/*`, registration, recovery) | When `signedIn` is false or a fresh login is demanded | Reuse the `@osn/ui` `<SignIn>`/`<Register>` components; no new auth UI. `AuthorizeSignIn` holds both and swaps between them — a "No account yet? Create one" link under sign-in, and Cancel back from registration. Without that second half, a relying party's "Create account" button would land on a screen demanding a passkey the visitor has not got. |

### Decision error handling — exhaustive

| Response | Meaning | UI behaviour |
|---|---|---|
| `400 { error: "login_required" }` | The flow demands a session **created after the request was parked** (`prompt=login`, or `max_age` exceeded — including ageing out while sitting on this screen). The parked request is **still alive**. | Show "Please sign in again to continue", run the sign-in ceremony, then POST the **same** requestId again. Do not restart the flow. |
| `400 { error: "invalid_request", error_description: "Unknown or expired request" }` | Expired (10 min), already consumed, or this browser doesn't hold the binding cookie. Deliberately indistinguishable. | Terminal: "This sign-in request has expired — go back to <app> and try again." No retry button. |
| `401 { error: "unauthorized" }` | No session cookie at all. | Same as `login_required` but the sign-in is a first sign-in, not a re-auth. |
| `400 { error: "invalid_client" }` | Client disabled mid-flow. | Terminal error naming no client details beyond what context already showed. |
| `429` | Rate limited. | Generic "try again in a minute". |

## Screen states

1. **Loading** — fetch context. 404 ⇒ *Expired* state.
2. **Signed out** (`signedIn: false`, or arrived with `reason=login`) —
   render the client card (name + logo + "wants to access your OSN
   account") above the standard `<SignIn>` component, with a register
   link. On success, re-fetch context and continue. A sign-in performed
   here creates a fresh session, which by construction satisfies
   `requireAuthAfter` — the retry loop needs no special casing.
3. **Profile picker** (`reason=select_account`, or multiple profiles and
   no `linkedProfileId`) — one card per profile (avatar, display name,
   handle). Default selection: `linkedProfileId` if present (this client
   already knows that profile — switching is allowed but changes the
   pairwise `sub` the client sees; say so in a caption), else the default
   profile.
4. **Consent** — the heart of the page:
   - Client identity: `name`, `logoUrl` (render as `<img src>` ONLY —
     never interpolate into markup; treat the URL as untrusted even
     though registration now pins it to https).
   - Scope list, humanised: `openid` → "Confirm who you are",
     `profile` → "See your profile (name, handle, picture)", `email` →
     "See your email address" with the explicit warning that email is
     account-level and shared across apps (the one claim pairwise
     subjects cannot protect).
   - The chosen profile (from state 3, collapsed to a switcher row).
   - Buttons: **Approve** (primary) / **Cancel** (secondary). Cancel
     POSTs `approved: false` — the relying party gets `access_denied`;
     it must NOT just close the tab, or the request lingers for its TTL.
5. **Redirecting** — after either decision, assign `redirectTo`. Show
   nothing clickable; the decision cannot be re-posted (single-use).
6. **Expired / wrong browser** — terminal, with the app's name if context
   was ever loaded, else generic.

First-party clients normally never reach this page (the provider
short-circuits consent), so state 4's copy can assume a third party.

## Rules the page must not break

- **Never render OAuth parameters from its own URL** — it has none, keep
  it that way. Anything the page displays comes from `/authorize/context`.
- **Same-origin, credentialed fetches only** — the session and binding
  cookies are the security model.
- **`redirectTo` is opaque** — assign it verbatim. It was validated
  against the client's registered URIs server-side; the page must not
  "helpfully" parse or rewrite it.
- **No local persistence** of anything from context (no localStorage) —
  the request id in the URL plus server state is the entire session.
- **A denial is a decision** — Cancel must POST, not abandon.

## Build order (estimate: one focused PR)

1. ~~Route + loading/expired/signed-out states wired to `<SignIn>`~~ — done.
2. ~~Consent card + scope humanisation + decision POST + redirect~~ — done.
3. ~~Profile picker~~ — done. It only leads when there is a real choice:
   two or more profiles, and either `reason=select_account` or the client
   has never seen any of them. Single-profile accounts never see it.
4. ~~Set `OSN_AUTHORIZE_UI_URL` in prod vars~~ — done 2026-07-26, along
   with the `deploy-osn-social` Pages job; re-pointed at
   `https://musubi.social/authorize` on 2026-07-27. Smoke check still open: full
   authorize → consent → token round-trip against a self-registered client
   (`POST /oidc/clients` makes this testable without an operator). It needs
   the apex `musubi.social` attached to the `osn-social` Pages project in the
   dashboard first — see [[production-deploy]] §5.4 and
   [[musubi-identity-migration]].

### What the build settled

- The page is served on a bare layout — no sidebar, nothing to click but
  the decision itself — via a route allow-list in `osn/social/src/App.tsx`.
- `invalid_client` arrives from the decision route as **401**, not 400
  (`set.status = oidc.code === "invalid_client" ? 401 : 400`). The client
  branches on the `error` code, never the status.
- `login_required` and `unauthorized` hold the user's answer, re-run
  `<SignIn>`, refetch context and replay the answer against the **same**
  request id. Only `invalid_request` and `invalid_client` are terminal.
- The replay is **reconciled first**. A re-authentication can land on a
  different account, so the page compares the profile set before and after:
  same set, replay the held answer; different set, drop it, clear the chosen
  profile and say so. Otherwise one person's "Allow" could be spent by
  whoever signed in second.
- `reason=login` (the server's `prompt=login` / `max_age` path) puts the
  ceremony **before** the decision, even when the browser already has a
  session. The page tracks whether the ceremony happened *here*; a session
  the relying party has already rejected is not enough to show Allow.
- `reason=create` (the server's `prompt=create` path) behaves exactly the
  same way — a session created before the request was parked will not do —
  and additionally opens `AuthorizeSignIn` on its **registration** half
  instead of its sign-in one. That is the whole of the difference: one flow,
  a different first screen. The value is advisory copy; tampering with it
  widens nothing, because the server re-derives every requirement when the
  decision arrives.
- A failed context read that is not terminal — a 429, a dropped connection —
  gets its own screen with the message and a retry, not an endless spinner.
- The page runs **outside `AuthProvider`**. Mounting it calls `POST /token`,
  which *rotates* the refresh session, and then lists profiles the page never
  reads: `GET /authorize/context` already carries the session state and the
  profiles. `<SignIn>` needs the provider, so the provider moved into
  `AuthorizeSignIn`, a `lazy()` island that loads only when a ceremony is
  actually required. The signed-in path — the common one — touches neither.
- A logo URL from the client record is untrusted input: it is rendered as
  an `<img src>` through `safeAvatarUrl` with `referrerpolicy="no-referrer"`
  and nowhere else.
- `osn/social/public/_headers` carries `frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: strict-origin-when-cross-origin`.
- **The READ has a deadline; the WRITE deliberately does not** (AZ-P-I2 +
  S-M1, 2026-07-30). `getContext` runs under a default 10 s ceiling
  (`DEFAULT_AUTHORIZE_TIMEOUT_MS`, overridable via `timeoutMs`, `0` to opt
  out) and carries the page's abort signal, which fires on unmount. That is
  what makes the retry screen above reachable — a screen that only helps once
  the promise settles is no help at all if the promise never does. A timeout
  **or a transport failure** arrives as a retryable `AuthorizeError` with code
  `unknown`, which is what the error table has always claimed; before this a
  transport failure escaped as a raw `TypeError`. A caller's own abort is
  re-thrown untouched — an unmount is not an error state to render.

  **`submitDecision` gets neither by default, and this is load-bearing.**
  Aborting a fetch does not un-send it, and that call is the state-changing
  one: the server consumes the parked request, records the consent row and
  mints the code. A client deadline firing while the server commits would
  surface a *retryable* error over a grant that actually happened — Allow and
  Cancel become clickable again, the next click hits a consumed request and
  renders "this sign-in request has expired", and a live consent sits in
  Settings → Connected apps the user believes they cancelled. Reads are safe
  to abandon; writes are not. A caller may still pass its own `signal` and
  accept that trade.

  The deadline spans the **body read**, not just the handshake. `fetch`
  settles when response headers arrive, so clearing the timer there would let
  a server that flushes headers and then stalls mid-body hang for the
  browser's own multi-minute timeout — reintroducing the exact spinner this
  bounds. Composition is hand-rolled rather than `AbortSignal.any` +
  `AbortSignal.timeout`, so the timer can be cleared when a call settles and
  older mobile browsers still reach the screen.
- **The page announces its own transitions** (A-L1, 2026-07-30). `<Switch>`
  swaps the whole screen without moving focus, so a screen reader heard
  nothing when the page flipped to "Taking you back…" or to a terminal
  state. An `aria-live="polite"` region carries a short label per screen.
  Two details are load-bearing: the region is **always mounted** (a live
  region added to the DOM in the same tick as its text is not reliably
  announced), and the `error` screen is deliberately excluded, because its
  message already carries `role="alert"` and announcing both reads the
  failure twice. The element is an `<output>` — its implicit `role="status"`
  carries `aria-live="polite"` and is the semantic element for a value the
  page computes rather than one the user typed.
- **The issuer origin is preconnected** (AZ-P-I1, 2026-07-30). `/authorize`
  is a cold cross-origin landing: the browser arrives from the relying party
  with no warm connection, so `GET /authorize/context` paid DNS + TCP + TLS
  before a byte moved. An `issuerPreconnect()` plugin in
  `osn/social/vite.config.ts` emits `<link rel="preconnect" crossorigin>`
  built from the **resolved** config's `VITE_OSN_ISSUER_URL` — resolved, not
  `process.env`, so it sees exactly what the app's `import.meta.env` will,
  `.env` files included. `crossorigin` is required, since the context read is
  `credentials: "include"`. The value is **`use-credentials`**, not a bare
  `crossorigin` — an empty value means *anonymous* mode, and the
  connection-pool key includes the credentials flag, so an anonymous
  preconnect is not the socket the context read reuses: it opens a second
  idle TLS connection and the handshake is paid anyway, which is strictly
  worse than shipping no tag. A missing or malformed URL emits no tag rather
  than a dead one. Pinned by `osn/social/tests/issuer-preconnect.test.ts`.

## Open questions (decide at build time, none block starting)

- Whether denying should also offer "use a different account" (sign out +
  restart) — nice-to-have, not in the first cut.
- Localisation — the scope descriptions are the only user-facing strings
  with security weight; keep them in one map.
- Whether `reason=consent` with an existing narrower grant should show a
  "you already allow X; this adds Y" diff — the server merges scopes on
  live grants, so the diff is computable from `linkedProfileId` +
  context scopes later; first cut shows the full requested list.
