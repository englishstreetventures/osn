---
title: Turnstile bot protection
tags: [systems, security, cloudflare, bot-protection]
status: shipped-inert
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
  - "@cire/api"
  - "@cire/web"
  - "@cire/organiser"
finding-ids: []
last-reviewed: 2026-06-19
---

# Turnstile bot protection

Cloudflare Turnstile gates the project's public, abusable form submissions —
account registration, passkey login, and the cire guest claim / RSVP flows —
behind a privacy-preserving CAPTCHA alternative. Shipped in **#154**; the design
is deliberately **key-optional + fail-closed** so it could merge and deploy
**inert** (no widget, no behaviour change) ahead of creating the dashboard
widget.

## What it protects

| Surface | Endpoint(s) | Backend |
|---|---|---|
| OSN registration | `POST /register/begin` | `@osn/api` (`turnstileGate("register_begin", …)`) |
| OSN passkey login | `POST /login/passkey/begin` | `@osn/api` |
| cire guest claim | `POST /api/claim` | `@cire/api` (`turnstileGate(verifier, "claim", …)`) |
| cire RSVP | `POST /api/rsvp` | `@cire/api` |

Frontends: cire/web guest forms, cire/organiser SignIn + Register (via `@osn/ui`).
The organiser SignIn/Register run the OSN ceremonies, so the osn-api gates above
are what enforce them server-side.

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
  slow/degraded Cloudflare therefore degrades to "reject", never "hang".
- **5s timeout** (`AbortSignal.timeout(5_000)`, S-L2) so a hung `siteverify`
  can't tie up the Worker isolate.
- **Secret never logged, never echoed.** The thrown cause is deliberately not
  surfaced from `siteverify` (it could embed the request body, which contains the
  secret). Only the boolean outcome + Cloudflare's machine-readable
  `error-codes` (no PII) reach logs/spans.
- Outbound goes through `instrumentedFetch` so the call appears on the trace
  tree; the token + secret are **not** annotated onto the span.

`remoteip` is the caller's `cf-connecting-ip` (passed to `siteverify` for
Cloudflare's own risk scoring when present), the same trusted IP the rate
limiter keys on — see [[rate-limiting]].

## Configuration

| Var | Where | Kind | Effect |
|---|---|---|---|
| `TURNSTILE_SECRET_KEY` | osn-api + cire-api Worker secret (`wrangler secret put`) | Secret, key-optional | Server half. Set ⇒ gates require + verify a token (fail-closed). Unset ⇒ gates skipped. |
| `PUBLIC_TURNSTILE_SITEKEY` | cire/web + cire/organiser build var (`import.meta.env`, statically inlined) | Public sitekey, key-optional | Client half. Set ⇒ the widget renders + a token rides in the submit body. Unset/blank ⇒ no widget, no token sent. |

**Same widget for both backends.** One sitekey + one secret; the widget's
domains cover `cireweddings.com` (guest) and `app.cireweddings.com` (organiser),
and osn-api lives on `id.cireweddings.com`.

> **Widget allowed-hostnames must include every form origin.** Turnstile only
> issues a token on a hostname listed in the widget's **Domains** (Cloudflare
> dashboard → Turnstile → widget). If `app.cireweddings.com` is missing, the
> organiser widget fires `error-callback` (Cloudflare error `110200`), never
> calls back with a token, and the gated form's submit stays disabled — the
> `@osn/ui` widget surfaces this as "Couldn't load the verification challenge",
> not a silent hang. Add **`cireweddings.com`, `app.cireweddings.com`,
> `id.cireweddings.com`** to the widget's domain list.

## Client widget: single-use tokens must be reset after each submit

A Turnstile token is **single-use**: once a backend has siteverified it, the
same value is rejected `timeout-or-duplicate` forever. Cloudflare only
auto-refreshes a token on its **~300s expiry**, *not* when it is consumed by a
form submit. So a frontend that re-submits a form (a retried sign-in, a "resend
code") **must explicitly reset the widget** to mint a fresh token — otherwise it
replays the redeemed token and the server fail-closes it.

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

The integration is inert in production today (no secret set). To turn it on,
follow [[production-deploy]] §3.4. The **load-bearing rule**: roll out
**secret-first is wrong here** — because each backend *requires* a token the
moment its secret is present, you must ensure the **sitekey reaches the
frontend** (so the widget renders and sends a token) **before** the secret lands
on the Worker. Ship the sitekey while the secret is absent → harmless (widget
renders, server ignores). Ship the secret while the sitekey is absent → the
server requires a token the UI never sends and **every gated form 400/403s**.

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
