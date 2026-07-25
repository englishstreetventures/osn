---
title: Migrating OSN identity to musubi.dev
description: Cutover plan for moving osn-api from id.cireweddings.com to id.musubi.dev and making musubi.dev the full OSN identity home
tags: [runbook, identity, migration, oidc, webauthn]
status: planned
related:
  - "[[production-deploy]]"
  - "[[oidc-provider]]"
  - "[[authorize-ui]]"
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[sessions]]"
  - "[[social]]"
last-reviewed: 2026-07-25
---

# Migrating OSN identity to musubi.dev

Moving osn-api from `id.cireweddings.com` to `id.musubi.dev`, with
`musubi.dev` becoming the full OSN identity home: issuer, sign-in UI, and
consent screen. This is the "dedicated OSN domain" that
`[[production-deploy]]` has carried as deferred since the first prod deploy.

**This is not a hostname swap.** Two hard dependencies must land before the
cutover, or cire loses sign-in entirely. Read the blockers first.

## Why it cannot be config-only

### Blocker 1 — the authorize UI does not exist

`[[authorize-ui]]` is `status: planned`. `/authorize` parks the request and
redirects to a page nobody has built yet, so the OIDC flow does not complete
end to end today.

This matters because of WebAuthn scoping. A passkey ceremony may only run on
an origin that is same-site with the RP ID. Once `OSN_RP_ID` becomes
`musubi.dev`, the cire origins (`host.`, `vendor.`, `invite.cireweddings.com`)
**can no longer run ceremonies at all** — they are a different registrable
domain. Their replacement is the OIDC redirect flow, which needs the very
page that does not exist.

Flip the RP ID before that page ships and cire has neither mechanism: direct
ceremonies are illegal, and the redirect flow dead-ends.

### Blocker 2 — `@osn/social` is not deployed

`deploy.yml` builds Pages projects for `cire-organiser`, `cire-vendor` and
`cire-landing`. There is no osn/social job. The identity-domain web app —
the thing that must serve sign-in and `/authorize` on musubi.dev — exists
only as a dev server on port 1422.

`[[authorize-ui]]` also requires it be served under the **same registrable
domain as osn-api**, because the session cookie and the per-request OIDC
binding cookie are host-bound and only flow on same-site fetches with
`credentials: "include"`. After the move that means it must live on
`musubi.dev`, not on cireweddings.com.

### Why partial moves do not help

Moving only the issuer hostname while keeping `OSN_RP_ID = cireweddings.com`
does not sidestep either blocker. It makes every cire→OSN call cross-site, so
the `SameSite=Lax` `__Host-osn_session` cookie stops being sent and silent
refresh dies at the first 401 (~5 minutes after sign-in). Relaxing to
`SameSite=None` turns it into a third-party cookie: blocked outright by
Safari's ITP, and on Chrome's deprecation path. There is no config-only
ordering that is safe.

## Credential bridge — do this first

Changing `OSN_RP_ID` invalidates **every existing passkey**. Sessions do not
bridge the move either: `__Host-` is exact-domain by prefix, so
`__Host-osn_session` set on `id.cireweddings.com` is not sent to
`id.musubi.dev`. An account whose only credential is a passkey, with no
recovery codes, is permanently locked out the moment the RP ID flips —
every step-up route requires an existing access token, and the only
unauthenticated door is `POST /login/recovery/complete`.

Recovery-code login is RP-ID-independent (identifier + code, no WebAuthn),
which is exactly why it survives the flip.

**Before touching the RP ID, for every account that must survive:**

1. Sign in on the current domain while passkeys still work.
2. `POST /recovery/generate` (step-up gated — see `[[recovery-codes]]`).
   Store the 10 codes offline.

**After cutover, to re-establish a credential:**

1. `POST /login/recovery/complete` — identifier + code. Returns a session.
2. `POST /step-up/otp/begin` → `/step-up/otp/complete` with purpose
   `passkey_register`. OTP is email-based, so it does not need a passkey.
3. Enroll a fresh passkey under the new RP ID.
4. `POST /recovery/generate` again — the consumed set is spent.

> `OSN_PAIRWISE_SALT` must be set on `osn-api-production` for **any** of this
> to work. The boot check is fail-closed, so without it every route 503s
> regardless of which domain it answers on. See `[[production-deploy]]`.

## Config inventory

Everything that names the issuer today. `staging` and `dev` keep their
current values unless the whole ladder moves.

| Where | Key | Now → after |
|---|---|---|
| `osn/api/wrangler.toml` `[env.production.vars]` | `OSN_RP_ID` | `cireweddings.com` → `musubi.dev` |
| ″ | `OSN_ISSUER_URL` | `https://id.cireweddings.com` → `https://id.musubi.dev` |
| ″ | `OSN_ORIGIN` | cire origins → musubi.dev ceremony origins |
| ″ | `OSN_CORS_ORIGIN` | cire origins → musubi.dev surfaces |
| ″ | `OSN_AUTHORIZE_UI_URL` | unset → the deployed `/authorize` page |
| ″ | `OSN_EMAIL_FROM` | `hello@cireweddings.com` → a verified musubi.dev sender |
| ″ `[[env.production.routes]]` | `pattern` | `id.cireweddings.com` → `id.musubi.dev` |
| `cire/api/wrangler.toml` | `OSN_JWKS_URL`, `OSN_ISSUER_URL` | both hosts (staging + production blocks) |
| `zap/api/wrangler.toml` | `OSN_JWKS_URL`, `OSN_API_URL` | both |
| `.github/workflows/deploy.yml` | `PUBLIC_OSN_ISSUER_URL` | three occurrences |
| `.github/workflows/deploy-cire-preview.yml` | `PUBLIC_OSN_ISSUER_URL` | two occurrences |
| `.github/workflows/deploy-osn-social-preview.yml` | `VITE_OSN_ISSUER_URL` | one occurrence |
| `cire/web/src/lib/security-headers.ts` | `osnIssuer` + CSP `connect-src` | hardcoded — must track the issuer |

Out-of-band, not in the repo:

- **Zone.** `musubi.dev` must be in the same Cloudflare account for
  `custom_domain = true` to auto-provision DNS + edge cert.
- **Resend.** Verify `musubi.dev` as a sender domain before moving
  `OSN_EMAIL_FROM`, or OTP and security mail fail closed.
- **Turnstile.** Add the musubi.dev hostnames to the widget's domain list —
  the verifier is fail-closed once a secret is set (`[[turnstile]]`).

## Cutover order

1. Set `OSN_PAIRWISE_SALT` on `osn-api-production`. Prerequisite for every
   later step; also ends the current outage.
2. Mint recovery codes for every account that must survive (above).
3. Add `musubi.dev` to Cloudflare; verify the Resend sender domain.
4. Build the `/authorize` page in `@osn/social` per `[[authorize-ui]]`.
5. Add an osn-social Pages job to `deploy.yml`; deploy to musubi.dev.
6. Register cire as an OIDC client; convert organiser, vendor and web from
   direct `@osn/client` ceremonies to the redirect flow.
7. Flip the osn-api vars + route. Redeploy downstream verifiers so cire-api
   and zap-api pick up the new JWKS URL.
8. Re-enroll passkeys under the new RP ID; regenerate recovery codes.

Steps 4–6 are the real work. Steps 1–3 and 7–8 are mechanical.

## Rollback

Before step 7, rollback is reverting a branch — nothing user-visible has
moved. After step 7 the exposure is the RP ID: reverting it restores the old
passkeys (credentials are not deleted server-side, only unusable under a
different RP ID), but any passkey enrolled under `musubi.dev` in the meantime
stops working. Keep the recovery-code sets from step 2 until re-enrolment is
confirmed on the new domain.

`OSN_PAIRWISE_SALT` is the one thing that must **never** be rotated in a
rollback — it is the HMAC key behind every pairwise `sub`. See
`[[oidc-provider]]`.
