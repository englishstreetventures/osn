---
title: Authorize UI (OIDC consent screen)
description: Spec for the interaction surface behind /authorize — sign-in handoff, profile picker, consent, and the login_required retry loop
tags: [app, identity, oidc, spec]
status: planned
packages:
  - "@osn/social"
related:
  - "[[oidc-provider]]"
  - "[[social]]"
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[sessions]]"
last-reviewed: 2026-07-24
---

# Authorize UI — the OIDC consent screen

The one page the OIDC provider still lacks. Everything behind it already
exists and is hardened: `/authorize` parks the request and redirects here;
this page reads it back, walks the user through sign-in / profile choice /
consent, posts the decision, and navigates to wherever the provider says.
This spec is written so the page can be built without re-deriving any
server contract — every rule below is enforced server-side already and has
test coverage in `osn/api/tests/routes/oidc.test.ts`.

## Where it lives

- **Route:** `/authorize` in `@osn/social` (the identity-domain web app).
  In production the app must be served under the same registrable domain as
  osn-api (`*.cireweddings.com` today) — the session cookie and the
  per-request binding cookie are both host-bound to `id.cireweddings.com`
  and flow on same-site fetches with `credentials: "include"`.
- **Config:** set `OSN_AUTHORIZE_UI_URL` on osn-api once the page deploys
  (`[env.production].vars`); until then the provider falls back to
  `/authorize` on the first `OSN_ORIGIN`.
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
| Existing sign-in surface (`/passkey/login/*`, registration, recovery) | When `signedIn` is false or a fresh login is demanded | Reuse the `@osn/ui` `<SignIn>`/`<Register>` components; no new auth UI. |

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

1. Route + loading/expired/signed-out states wired to `<SignIn>` (the
   components exist in `@osn/ui`; this is assembly).
2. Consent card + scope humanisation + decision POST + redirect.
3. Profile picker (only sequenced last because single-profile accounts —
   the common case — never see it; states 1–2 alone ship a working flow).
4. Set `OSN_AUTHORIZE_UI_URL` in prod vars; smoke: full authorize →
   consent → token round-trip against a self-registered client
   (`POST /oidc/clients` makes this testable without an operator).

## Open questions (decide at build time, none block starting)

- Whether denying should also offer "use a different account" (sign out +
  restart) — nice-to-have, not in the first cut.
- Localisation — the scope descriptions are the only user-facing strings
  with security weight; keep them in one map.
- Whether `reason=consent` with an existing narrower grant should show a
  "you already allow X; this adds Y" diff — the server merges scopes on
  live grants, so the diff is computable from `linkedProfileId` +
  context scopes later; first cut shows the full requested list.
