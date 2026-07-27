---
title: Turnstile bot protection
tags: [systems, security, cloudflare, bot-protection]
status: active (osn-api gates live; cire-api gate inert)
related:
  - "[[cire-auth]]"
  - "[[passkey-primary]]"
  - "[[rate-limiting]]"
  - "[[free-tier-limits]]"
  - "[[production-deploy]]"
  - "[[observability/metrics]]"
packages:
  - "@shared/turnstile"
  - "@osn/api"
  - "@osn/social"
  - "@osn/ui"
  - "@cire/api"
  - "@cire/web"
  - "@cire/organiser"
finding-ids: []
last-reviewed: 2026-07-27
---

# Turnstile bot protection

Cloudflare Turnstile gates the project's public, abusable form submissions —
account registration, passkey login, and the cire guest **claim** flow —
behind a privacy-preserving CAPTCHA alternative. Shipped in **#154**; the design
is deliberately **key-optional + fail-closed** so it could merge and deploy
**inert** (no widget, no behaviour change) before anyone created the dashboard
widget.

## What it protects

| Surface | Endpoint(s) | Backend |
|---|---|---|
| OSN registration | `POST /register/begin` | `@osn/api` (`turnstileGate("register_begin", …)`) |
| OSN passkey login | `POST /login/passkey/begin` | `@osn/api` |
| cire guest claim | `POST /api/claim` | `@cire/api` (`turnstileGate(verifier, "claim", …)`) |

**`/api/rsvp` is intentionally NOT gated.** A guest only reaches RSVP after a
successful `/api/claim`, which mints the `cire_session` cookie behind the
Turnstile gate above — so the unauthenticated bot surface is already covered at
claim. A second challenge on every RSVP added friction alone (it put an
interactive widget in the middle of the flow), so `app.ts` wires `createRsvpRoutes(db)` with **no
verifier** and `RsvpModal` renders no widget. The `rsvp.ts` route keeps the
key-optional gate parameter (defaults to a no-op) so it can be re-armed if abuse
ever appears. Removed in the RSVP-friction fix (2026-06-19).

Frontends: cire/web guest claim form, and **`@osn/social`'s SignIn + Register**
(via `@osn/ui`) — the sidebar auth dialogs and the `/authorize` consent screen's
sign-in island. Since the 2026-07-27 OIDC swap, `musubi.social` is the **only**
origin that runs the OSN ceremonies (the RP ID lives on the apex and cire signs
in by redirect), so it is the only frontend that must carry the osn-api sitekey.
cire/organiser and cire/vendor still receive `PUBLIC_TURNSTILE_SITEKEY` in their
builds, but no longer render an OSN ceremony form.

## The shared primitive — `@shared/turnstile`

`createTurnstileVerifier(secret, fetchImpl?)` (`shared/turnstile/src/index.ts`)
is the single chokepoint every backend uses:

- **Secret UNSET / empty / whitespace** → returns `null`. The caller treats a
  `null` verifier as "Turnstile not configured": **no token is expected, no
  `siteverify` call is made**, the flow runs exactly as it did before Turnstile
  existed. This is the inert state and the reason the PR was safe to merge before
  the widget existed.
- **Secret SET** → returns a `TurnstileVerifier` whose `verify(token, remoteip)`
  POSTs to Cloudflare's managed `siteverify` endpoint and **fails closed**: a
  missing, empty, invalid, expired, already-redeemed (single-use), or unreachable
  token all resolve to `{ ok: false }`. The caller MUST reject on `ok: false` —
  there is no path where a configured secret silently lets a request through.

Safety properties baked into the primitive:

- **Never throws.** Network error, abort, malformed JSON → `{ ok: false }`. A
  slow or failing Cloudflare therefore ends in a reject, never a hang.
- **5s timeout** (`AbortSignal.timeout(5_000)`, S-L2) so a hung `siteverify`
  can't tie up the Worker isolate.
- **Secret never logged, never echoed.** The code deliberately drops the thrown
  cause from `siteverify` (it could embed the request body, which contains the
  secret). Only the boolean outcome + Cloudflare's machine-readable
  `error-codes` (no PII) reach logs/spans.
- The outbound call goes through `instrumentedFetch`, so it appears on the trace
  tree. The span carries neither the token nor the secret.

`remoteip` is the caller's `cf-connecting-ip` (passed to `siteverify` for
Cloudflare's own risk scoring when present), the same trusted IP the rate
limiter keys on — see [[rate-limiting]].

## Configuration

| Var | Where | Kind | Effect |
|---|---|---|---|
| `TURNSTILE_SECRET_KEY` | osn-api + cire-api Worker secret (`wrangler secret put`) | Secret, key-optional | Server half. Set ⇒ gates require + verify a token (fail-closed). Unset ⇒ gates skipped. **Set on osn-api-production** since #160; unset on cire-api-production. |
| `PUBLIC_TURNSTILE_SITEKEY` | cire/web + cire/organiser + cire/vendor build var (`import.meta.env`, statically inlined) | Public sitekey, key-optional | Client half for the cire surfaces. |
| `VITE_TURNSTILE_SITEKEY` | `@osn/social` build var (Vite, statically inlined; `src/lib/auth.ts` normalises blank → `undefined`) | Public sitekey, **required in practice** | Client half for the OSN register/login ceremonies. Fed from the same repo Variable `PUBLIC_TURNSTILE_SITEKEY` — one widget, one sitekey; the name differs only because Vite exposes `VITE_*` while Astro exposes `PUBLIC_*`. osn-api's secret **is** set, so leaving this blank breaks sign-in outright. |

**Same widget for both backends.** One sitekey + one secret; the widget's
domains cover `invite.cireweddings.com` (guest), `host.cireweddings.com`
(organiser) and `musubi.social` (identity). osn-api moved to its own zone on
2026-07-27 and now lives on `id.musubi.social`, with the identity app on the
`musubi.social` apex — see [[musubi-identity-migration]].

> **Widget allowed-hostnames must include every form origin.** Turnstile only
> issues a token on a hostname listed in the widget's **Domains** (Cloudflare
> dashboard → Turnstile → widget). If `host.cireweddings.com` is missing, the
> organiser widget fires `error-callback` (Cloudflare error `110200`), never
> calls back with a token, and the gated form's submit stays disabled — the
> `@osn/ui` widget surfaces this as "Couldn't load the verification challenge",
> not a silent hang. The list is a **dashboard step** — the wrangler API token
> has no `challenge-widgets.write` scope, so it cannot be edited from CI.
>
> Only hostnames that **render a form** belong here. `musubi.social` does
> (the `@osn/ui` register + login islands); `id.musubi.social` does not — osn-api
> serves JSON, and the server half siteverifies against Cloudflare rather than
> against the domain list. `musubi.social` was added on 2026-07-27.

## Client widget: single-use tokens must be reset after each submit

A Turnstile token is **single-use**: once a backend has siteverified it, the
same value is rejected `timeout-or-duplicate` forever. Cloudflare only
auto-refreshes a token on its **~300s expiry**, *not* when a form submit consumes
it. So a frontend that re-submits a form (a retried sign-in, a "resend code")
**must reset the widget** to mint a fresh token — otherwise it replays the
redeemed token and the server fail-closes it.

`@osn/ui`'s `TurnstileWidget` exposes this via `onReady({ reset })`: `reset()`
drops the stale token (`onToken(null)`) and calls Cloudflare's `turnstile.reset()`
on the live widget instance (no re-render, no new iframe), and the fresh token
arrives on the existing `onToken` callback. `SignIn` and `Register` call it
immediately after each token-consuming `/begin` call.

**Login-loop regression (fixed):** before this wiring, once the prod sitekey +
secret went live (**#160**), the organiser `SignIn` form replayed its redeemed
token on every retry → `/login/passkey/begin` returned `turnstile_failed` → the
user bounced back to the login screen. Any new client form that gates a backend
call on a Turnstile token MUST reset the widget after the call. The silent
conditional-UI (autofill) passkey ceremony is exempt — it carries no token and
osn-api does not gate it (#163 Bug C).

## Activation (the rollout order matters)

**State today: ACTIVE on osn-api, inert on cire-api.** The widget and the
`PUBLIC_TURNSTILE_SITEKEY` repo Variable exist, and `TURNSTILE_SECRET_KEY` is set
on `osn-api-production` (#160), so the register/login gates bite. The cire-api
secret was deleted on 2026-07-20 after a mismatched value rejected every guest
claim, which reverted the claim gate to a no-op. To (re)activate a backend follow
[[production-deploy]] §3.4.

The **load-bearing rule: never ship the secret first.** Each backend *requires* a
token the moment its secret is present, so the **sitekey must reach the frontend**
— and the widget must render and send a token — **before** the secret lands on the
Worker. Ship the sitekey while the secret is absent → harmless (the widget
renders, the server ignores the token). Ship the secret while the sitekey is
absent → the server requires a token the UI never sends, and **every gated form
400/403s**.

The same rule has a **second edge, and it is the one that actually bit**: the
secret does not have to move for the pairing to break — the *form* can move out
from under it.

> **musubi.social sign-in outage (2026-07-27).** Every typed-identifier sign-in
> and every registration on `musubi.social` failed with `400 turnstile_failed`.
>
> The secret stayed set on osn-api throughout; what changed is which app renders
> the ceremony. Before the migration the only surface calling `/register/begin`
> and the identifier-bound `/login/passkey/begin` was **cire/organiser**, whose
> Astro build read `PUBLIC_TURNSTILE_SITEKEY` — so a token always rode along.
> The musubi.social move (#321) relocated the ceremonies to `@osn/social`, and
> the organiser's OIDC swap (#322) removed its ceremony forms entirely. But the
> `deploy-osn-social` job passed only `VITE_OSN_ISSUER_URL`, and `Sidebar` /
> `AuthorizeSignIn` passed no `turnstileSiteKey` — so no widget rendered, no
> token was sent, and osn-api fail-closed on every gated call. Both halves were
> individually correct; the pairing was severed by relocation.
>
> Fixed by threading `VITE_TURNSTILE_SITEKEY` through the `deploy-osn-social`
> build into all three call sites. Guarded by
> `osn/social/tests/components/turnstile-wiring.test.tsx`, which fails if any
> ceremony call site drops the prop, and by a non-empty check on the variable in
> the deploy job — the test proves the prop is threaded, only the deploy check
> can prove a real value reached it. (The osn-social preview workflow was deleted
> in the same change, so `musubi.social` is the only origin building this app.)
>
> **Rule this leaves behind:** the sitekey/secret pairing is a property of the
> *deployed surface that renders the form*, not of the repo. Whenever an auth
> ceremony moves to a new app or origin, re-check three things together — the
> new app's build var, the props at the call sites, and the widget's Domains
> list — because the server half keeps enforcing silently across the move.

## Observability

- `osn.auth.turnstile.rejected` — counter, bumped on each fail-closed rejection
  on the osn-api gates (bounded `endpoint` attribute).
- `cire.turnstile.rejected{endpoint}` — counter on the cire-api claim/RSVP gates.

No token, secret, or IP is ever placed on a metric attribute (cardinality +
PII rule, [[observability/metrics]]). When the secret is unset the gates short
out before any metric, so a flat `*.turnstile.rejected` is the expected
inert-state signal.

## Relationship to rate limiting

Turnstile and the per-IP rate limiters ([[rate-limiting]]) are **complementary,
not redundant**: the limiter caps request *volume* per IP (and is the
load-bearing throttle for the low-entropy cire claim code — see [[cire-auth]]),
while Turnstile raises the *per-request* cost of automation. Turnstile being
inert today does **not** weaken the claim-code defence, which has always rested
on the native Workers rate-limit binding.

## Related

- [[cire-auth]] — the guest claim/RSVP surfaces Turnstile gates
- [[passkey-primary]] — the register/login ceremonies Turnstile gates
- [[free-tier-limits]] — Turnstile free-tier posture (unlimited siteverify)
- [[production-deploy]] §3.4 — one-time widget creation + secret/sitekey rollout
