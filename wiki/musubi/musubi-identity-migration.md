---
title: Migrating OSN identity to musubi.social
description: Cutover plan for moving osn-api from id.cireweddings.com to id.musubi.social and making musubi.social the full OSN identity home
tags: [runbook, identity, migration, oidc, webauthn]
status: cutover-done
related:
  - "[[production-deploy]]"
  - "[[oidc-provider]]"
  - "[[authorize-ui]]"
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[sessions]]"
  - "[[social]]"
  - "[[recovery-codes]]"
  - "[[cire-auth]]"
last-reviewed: 2026-09-10
---

# Migrating OSN identity to musubi.social

Moving osn-api from `id.cireweddings.com` to `id.musubi.social`, with
`musubi.social` becoming the full OSN identity home: issuer, sign-in UI, and
consent screen. This is the "dedicated OSN domain" that
`[[production-deploy]]` has carried as deferred since the first prod deploy.

> **The move shipped on 2026-07-27, ahead of PR C, on purpose.** The end state
> is live: `osn-api` on `id.musubi.social`, `@musubi/social` on the **`musubi.social`
> apex**, `OSN_RP_ID = musubi.social`. What the plan below calls step 6 / PR C —
> converting cire to the OIDC redirect flow — was **not** done first. The cost
> was accepted knowingly and is stated plainly here so nobody reads a broken
> flow as a bug:
>
> - **Every passkey enrolled under `cireweddings.com` is dead.** Both prod
>   accounts have recovery-code sets (minted 2026-07-26, step 2) and those are
>   the only way back in.
> - **cire sign-in went down** — organiser, vendor, and the guest account-linking
>   island. All three ran their own WebAuthn ceremony from a cireweddings.com
>   origin, which is now a different registrable domain from the RP ID.
>   **Restored on 2026-07-27 by step 6 below**: all three now redirect to
>   `id.musubi.social/authorize` and cire-api exchanges the code server-side.
> - Bearer-token verification is untouched. cire-api and zap-api verify against
>   the new JWKS URL and nothing about `aud`/signature checking changed.
>
> **Step 6 has landed.** It went from "a step ahead of the flip" to the critical
> path the moment the RP ID moved, and it is now done — see [[cire-auth]] for
> the flow and [[oidc-provider]] for the client registration.

**This is not a hostname swap.** The two dependencies below were the reason.
They are kept as written because they explain the shape of what broke.

## Why it cannot be config-only

### Blocker 1 — the authorize UI ✅ cleared 2026-07-26

The consent screen is built and deployed: `/authorize` in `@musubi/social`, see
`[[authorize-ui]]`. The paragraphs below stay because they explain why this
ordering is not optional.

This matters because of WebAuthn scoping. A passkey ceremony may only run on
an origin that is same-site with the RP ID. Once `OSN_RP_ID` becomes
`musubi.social`, the cire origins (`host.`, `vendor.`, `invite.cireweddings.com`)
**can no longer run ceremonies at all** — they are a different registrable
domain. Their replacement is the OIDC redirect flow, which needs the very
page that does not exist.

Flip the RP ID before that page ships and cire has neither mechanism: direct
ceremonies are illegal, and the redirect flow dead-ends.

### Blocker 2 — `@musubi/social` is not deployed ✅ cleared 2026-07-26

`deploy.yml` carries a `deploy-osn-social` job publishing the `osn-social`
Pages project. It was written against `me.cireweddings.com` and **never served
that hostname**: the 2026-07-27 decision to go straight to musubi.social landed
before the Pages custom domain was attached, so the job now targets the
**`musubi.social` apex** with
`OSN_AUTHORIZE_UI_URL = https://musubi.social/authorize`. Feature-branch previews
lived in a separate `osn-social-preview` project so a push to a branch could never
overwrite what a live hostname serves; that workflow was **removed** on
2026-07-27, since a `*.pages.dev` preview can run neither a passkey ceremony nor
an OIDC round-trip (see [[social]]).

`[[authorize-ui]]` requires it be served under the **same registrable domain
as osn-api**, because the session cookie and the per-request OIDC binding
cookie are host-bound and only flow on same-site fetches with
`credentials: "include"`. The apex `musubi.social` is same-site with
`id.musubi.social`, so that holds. It is also why the apex, not `id.musubi.social`,
is the RP ID: the apex covers itself **and** every future `*.musubi.social`
surface, whereas an RP ID of `id.musubi.social` would forbid a ceremony on the
apex — the one place a ceremony now runs.

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
`id.musubi.social`. An account whose only credential is a passkey, with no
recovery codes, is permanently locked out the moment the RP ID flips —
every step-up route requires an existing access token, and the only
unauthenticated door is `POST /login/recovery/complete`.

Recovery-code login is RP-ID-independent (identifier + code, no WebAuthn),
which is exactly why it survives the flip.

**A passkey cannot be migrated to a new RP ID.** The `passkeys` table holds
only the public half; the private key lives in the authenticator and is bound
to the RP ID at creation. Nothing written to D1 re-points an existing
credential — after the flip both rows are dead weight and both users enroll
fresh. Enrolment requires an authenticated session, hence the bridge.

Confirmed prod inventory (2026-07-25) — the whole blast radius was two
credentials on two accounts. Both were dead the moment the RP ID flipped on
2026-07-27:

| Account | Passkey | Last used | Codes at flip |
|---|---|---|---|
| `owner@example.com` | `pk_000000000001` | 2026-07-23 | ✅ minted 2026-07-26 |
| `second-account@example.com` | `pk_000000000002` | 2026-07-19 | ✅ minted 2026-07-26 |

Small enough that re-enrolment is a chore rather than a migration. The codes
were minted first, which is the only reason the flip was survivable — the
inventory read `0` on both rows two days earlier.

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

> [!important] Do not add a fifth step deleting the old passkey rows
> Re-checked against the credential-provenance cooldown, which ships with
> `englishstventures/osn#952`. This sequence still works exactly as written, and it is
> worth being explicit about why, because the cooldown changes what the
> credential from step 3 is allowed to do.
>
> The passkey enrolled at step 3 is registered under an **`otp`** step-up, so
> `passkeys.provenance_amr` stamps it `otp`. For 72 hours it therefore cannot
> delete a passkey older than itself, and cannot change the account email.
> Step 1 also stamps `accounts.last_recovered_at`, which blocks the email change
> independently for the same window. Neither affects steps 1–4.
>
> **The dead pre-cutover rows need no deletion.** An RP-ID flip does not migrate
> a credential — the private half is bound to the old RP ID inside the
> authenticator — so those rows are inert: no authenticator can assert them, and
> `excludeCredentials` is the only place they still have an effect. Leaving them
> costs nothing.
>
> If an operator wants them gone anyway, there are two ways and the second is
> better:
>
> - Wait out the 72 hours from step 3, then delete them with a step-up asserting
>   the new passkey.
> - Better, when the flip is still ahead: enrol the replacement **before**
>   changing `OSN_RP_ID`, while the original passkey can still be asserted. The
>   registration then runs under a `webauthn` step-up, the new credential
>   inherits the original's standing, and it can remove the old rows the moment
>   the flip lands. This also removes the recovery-code round trip entirely.
>
> What does **not** work is asserting the step-3 passkey to delete the old rows
> straight away. It fails with a step-up refusal, not a permissions error, and
> that is the rule working rather than a bug. See
> [[step-up#Credential provenance]].

> `OSN_PAIRWISE_SALT` must be set on `osn-api-production` for **any** of this
> to work. The boot check is fail-closed, so without it every route 503s
> regardless of which domain it answers on. See `[[production-deploy]]`.

## Config inventory

Everything that named the issuer. All of it shipped on 2026-07-27 unless the
row says otherwise. `staging` and `dev` keep their current values — the whole
ladder did not move.

| Where | Key | Before → now |
|---|---|---|
| `osn/api/wrangler.toml` `[env.production.vars]` | `OSN_RP_ID` | `cireweddings.com` → **`musubi.social`** |
| ″ | `OSN_ISSUER_URL` | `https://id.cireweddings.com` → **`https://id.musubi.social`** |
| ″ | `OSN_ORIGIN` | four cire origins → **`https://musubi.social`** alone. The cire entries were removed, not kept: a ceremony from a different registrable domain is illegal whatever the list says, and leaving them would hide that. |
| ″ | `OSN_CORS_ORIGIN` | **kept the cire origins**, added `https://musubi.social`. Different list, different job — CORS governs bearer-token calls, which still work cross-site. |
| ″ | `OSN_AUTHORIZE_UI_URL` | → **`https://musubi.social/authorize`**. Stays explicit: unset it resolves against the *first* `OSN_ORIGIN` entry, which is right today by accident and breaks silently if that list is ever reordered. |
| ″ | `OSN_EMAIL_FROM` | **unchanged — `hello@cireweddings.com`.** See the Resend note below; moving it would fail closed and take OTP with it. |
| ″ `[[env.production.routes]]` | `pattern` | `id.cireweddings.com` → **`id.musubi.social`**, `custom_domain = true` |
| `cire/api/wrangler.toml` | `OSN_JWKS_URL`, `OSN_ISSUER_URL` | both, in `[env.production]` **and** the then-current `[env.preview]` — the preview tier shared prod identity by design. That env went away with the tier on 2026-07-27 |
| `zap/api/wrangler.toml` | `OSN_JWKS_URL`, `OSN_API_URL` | both |
| **`cire-api-production` Worker secret** | `OSN_API_URL` | `https://id.cireweddings.com` → **`https://id.musubi.social`**. **Missed on the day**, caught 2026-07-27 — see the note below |
| `.github/workflows/deploy.yml` | `PUBLIC_OSN_ISSUER_URL` | three occurrences — then **deleted** the same day by the OIDC swap. The cire frontends no longer call the issuer at all: sign-in is a top-level redirect to cire-api, which runs the code exchange server-side. Two of the three became `PUBLIC_OSN_ACCOUNT_URL=https://musubi.social` (organiser, vendor — "manage your account" links); the guest build lost its issuer var outright. See [[cire-auth]]. |
| `.github/workflows/deploy-cire-preview.yml` | `PUBLIC_OSN_ISSUER_URL` | two occurrences — same story, same day: one became `PUBLIC_OSN_ACCOUNT_URL`, one went away. **File deleted 2026-07-27**, the preview tier is gone |
| `.github/workflows/deploy.yml` | `VITE_OSN_ISSUER_URL` (`deploy-osn-social`) | one occurrence |
| `.github/workflows/deploy-osn-social-preview.yml` | `VITE_OSN_ISSUER_URL` | one occurrence — **file deleted 2026-07-27**, the preview is gone |
| `cire/invites/src/lib/security-headers.ts` | `osnIssuer` + CSP `connect-src` | hardcoded — must track the issuer |

> **A secret named the issuer too, and grepping the repo could not see it.**
> `cire-api` reads the osn-api origin from `OSN_API_URL`, which is a **Worker
> secret**, not a var in `wrangler.toml`. Sweeping the files found
> `OSN_JWKS_URL` and `OSN_ISSUER_URL` and flipped them; the secret stayed on
> `https://id.cireweddings.com`, a host that stopped answering the moment the
> route moved. Every ARC call from cire-api to osn-api then failed at the
> transport layer — adding a co-host by handle returned 502 behind the
> organiser portal's generic "Could not add that host", account linking broke,
> and the host list quietly fell back to raw `usr_*` ids (that resolver is
> fail-soft). Fixed the same day by re-setting the secret and redeploying;
> `wrangler secret put` alone does not cycle warm isolates.
>
> Next time, list the secrets as well as the files:
> `bunx wrangler secret list --env production` in each service, and read the
> values out of `osn-prod-secrets.env`. A deploy-time preflight that fails when
> a required secret is absent or points at an unreachable host is open as an
> issue in `englishstventures/osn`.

Out-of-band, not in the repo:

- **Zone.** ✅ `musubi.social` is in the same Cloudflare account, so
  `custom_domain = true` auto-provisions DNS + edge cert for `id.musubi.social`.
  If the zone carries a wildcard record it does not interfere — a wildcard only
  answers names with no record of their own.
- **Pages custom domain.** ✅ 2026-07-27 — the **apex `musubi.social`** is
  attached to the `osn-social` Pages project. A Pages custom domain is a
  dashboard setting, not a wrangler route, so the deploy job could not create
  it. On `osn-social.pages.dev` the `__Host-` cookies would not reach the app
  and a ceremony would be illegal.
- **Turnstile.** ✅ 2026-07-27 — `musubi.social` is on the widget's domain list.
  `id.musubi.social` is not on it and does not need to be: only hostnames that
  render a form do, and osn-api serves JSON. The wrangler API token has no
  `challenge-widgets.write` scope, so this was a dashboard step.
  **The domain list was only half the job, and the other half was missed.**
  osn-api's `TURNSTILE_SECRET_KEY` has been set since #160, so the gate is live,
  not inert. Before this migration the sitekey reached the ceremony forms through
  the **cire/host** Astro build; moving the ceremonies to `@musubi/social`
  (and stripping them from organiser in the OIDC swap) left the osn-social build
  with no sitekey and its `SignIn`/`Register` with no `turnstileSiteKey` prop —
  so every sign-in on the new apex returned `400 turnstile_failed` until
  `VITE_TURNSTILE_SITEKEY` was wired through. See `[[turnstile]]`.
- **Resend — deliberately not blocking.** The account has only
  `cireweddings.com` verified, so `OSN_EMAIL_FROM` **stayed** on
  `hello@cireweddings.com`. Moving it before verifying a musubi.social sender
  would fail closed and take OTP step-up with it — and OTP is exactly the step
  that turns a recovery-code login back into a passkey. Verify the sender
  first, then move the var, in that order.

## Cutover order

1. ✅ Set `OSN_PAIRWISE_SALT` on `osn-api-production`. Prerequisite for every
   later step; also ended the outage it was causing.
2. ✅ Mint recovery codes for every account that must survive (above).
   2026-07-26 — both accounts.
3. ✅ `musubi.social` is in the Cloudflare account. Resend sender **not** verified,
   and `OSN_EMAIL_FROM` stayed on cireweddings.com because of it.
4. ✅ Build the `/authorize` page in `@musubi/social` per `[[authorize-ui]]`
   (2026-07-26).
5. ✅ Add an osn-social Pages job to `deploy.yml` (2026-07-26). Written for
   `me.cireweddings.com`, retargeted to the **`musubi.social` apex** before it ever
   served a hostname.
6. ✅ Registered cire as a first-party OIDC client (`cid_cire`, seeded by hand
   in prod D1 — see `[[production-deploy]]` §3.5) and converted organiser,
   vendor and web from direct `@osn/client` ceremonies to the redirect flow
   (2026-07-27). cire-api runs the exchange and mints its own session cookie;
   no cire browser holds an OSN token. See `[[cire-auth]]`.
7. ✅ Flipped the osn-api vars + route on 2026-07-27, and the downstream
   verifiers (cire-api, zap-api) with them. The apex is attached to the
   `osn-social` Pages project and `musubi.social` is on the Turnstile widget,
   both done the same day.
8. ⬜ Re-enroll passkeys under the new RP ID; regenerate recovery codes. The
   dead pre-cutover rows stay — see the callout under **Credential bridge** for
   why, and for what to do if they must go.
   Unblocked once the merge deploy publishes the app to the apex and
   `https://id.musubi.social/health` answers 200.

### Steps 6 and 7 were deliberately reordered

The original plan below split the move into four PRs — A, B, C, D — so that
"does the OIDC flow work at all" could be debugged separately from "does it
work on a new domain". **That is not what happened.** D shipped before C, as an
explicit call, accepting that cire sign-in goes down in the gap. The reasoning
stands and is left intact, because it is also the description of what the gap
costs:

- **A — the consent screen.** Done: `/authorize` in `@musubi/social`.
- **B — deploy `@musubi/social`.** Done 2026-07-26. The plan was to serve it from
  `me.cireweddings.com` — a host under the **then-current** registrable domain,
  where the binding and session cookies already worked — and prove the
  authorize → consent → token round-trip before moving anything. In the event
  the hostname was never attached and B merged into D.
- **C — convert cire to the redirect flow.** ✅ Done 2026-07-27, after D rather
  than before it. cire is a registered OIDC client and organiser, vendor and web
  are off direct `@osn/client` passkey ceremonies. This is the change that
  removes cire's dependence on the RP ID — a future identity-domain move cannot
  take cire's sign-in with it.
- **D — the move itself.** ✅ Shipped 2026-07-27: vars, route, RP ID, and the
  osn-social Pages target.

Ordering C before D would have made D reversible in the sense that mattered:
after C, cire never runs a WebAuthn ceremony of its own, so changing the RP ID
could not take cire's sign-in with it. Shipping D first is exactly why cire's
sign-in went with it. The trade was worth making here because cire has no live
users yet and the identity domain wanted settling before it acquired any — but
that is the condition the trade rests on, and it will not hold twice.

## Rollback

**Step 7 has shipped, so rollback is no longer free.** Reverting `OSN_RP_ID` to
`cireweddings.com` does restore the old passkeys — credentials are never deleted
server-side, only made unusable under a different RP ID — but it kills any
passkey enrolled under `musubi.social` since the flip, and it puts the issuer back
on a hostname the deployed frontends no longer name. A revert is therefore the
whole branch, not one var.

Keep the recovery-code sets from step 2 until re-enrolment is confirmed on
`musubi.social`. They are the only credential that spans both RP IDs.

`OSN_PAIRWISE_SALT` is the one thing that must **never** be rotated in a
rollback — it is the HMAC key behind every pairwise `sub`. See
`[[oidc-provider]]`.
