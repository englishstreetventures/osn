---
title: Production Access Control Matrix (SOC 2 CC6)
tags: [compliance, soc2, access-control]
related:
  - "[[cire-run-sheet]]"
  - "[[index]]"
  - "[[soc2]]"
  - "[[arc-tokens]]"
  - "[[identity-model]]"
  - "[[oidc-provider]]"
  - "[[cire-auth]]"
  - "[[cire]]"
  - "[[cire-vendors]]"
  - "[[subprocessors]]"
  - "[[infrastructure-as-code]]"
  - "[[realtime]]"
last-reviewed: 2026-11-12
---

# Production Access Control Matrix (SOC 2 CC6)

SOC 2 CC6 demands a documented, reviewed, least-privilege access posture.
This is the matrix.

## End-user authentication (in-product)

Already strong; documented elsewhere.

| Surface | Mechanism | Page |
|---|---|---|
| Account login | Passkey-primary (WebAuthn `userVerification: "required"`) | [[passkey-primary]] |
| API access | ES256 access tokens, 5 min TTL, JWKS-verified. Carries `osn_sid`, a one-way per-profile binding to the session it was minted from, so a cookieless caller can still name its own session on the paths that revoke all the others. An access token outlives its session by up to 5 min; in that window it can mint no step-up token, access token, session, authenticator-app factor or relying-party client secret: step-up, a profile switch, a cross-device approval, authenticator-app enrolment and client registration each need a live, unrestricted, unexpired session of the account, and a switch's new token is bound to it. Passkey enrolment checks the caller's session through its own lookup, which admits the restricted recovery session | [[identity-model]], [[sessions]] |
| Sensitive ops | Step-up tokens (`aud: "osn-step-up"`, single-use JTI). Every step-up route, begin and Resend included, serves only a caller holding a live, unrestricted, unexpired session of the account, so none is minted, and no owner's challenge, link or daily allowance spent, from a session that has ended. Email change takes the same check at begin, Resend and complete, as well as a fresh step-up token | [[step-up]], [[sessions]] |
| Recovery | 64-bit single-use codes (Copenhagen Book M2). A new set is generated only for a caller holding a live, unrestricted, unexpired session of the account, as well as a fresh step-up token | [[recovery-codes]], [[sessions]] |
| Parked sign-in request (OIDC consent screen) | **Per-request binding cookie** — `__Host-osn_oar_…`, a 256-bit secret set by `GET /authorize` when it parks a request, SHA-256 at rest in the parked entry, compared in constant time; HttpOnly, `SameSite=Lax`, 600 s. On its own it gates reading the parked request (`GET /authorize/context`) and refusing it (`POST /authorize/decline`, which ends the request and sends the app `access_denied`). It never gates approval on its own: `POST /authorize/decision` also requires a session | [[oidc-provider]] |
| Service-to-service | ARC tokens (ES256, scoped, kid-pinned, revocable, scope-validated on cache hit). **Scope reach can widen without the scope name changing — review the routes a scope gates, not just the grant list.** Current `graph:read` reach for `@cire/api`: handle-to-profile resolution, **the either-way block check** (`either-blocked`, asked before an owner seats a co-host), batch profile displays, **global handle prefix search filtered by a requester's blocks**, and **viewer-scoped connection search**; no scope was minted for any of them. Two carry a caller invariant osn-api cannot enforce — connection search's `profileId` and handle search's `requesterId` must each be the calling service's own authenticated end user, never a client-supplied value — see [[cire-auth]]. | [[arc-tokens]] |
| Org admin (Zap M3) | Role-gated `org_agents.role = "admin"` | [[zap]] |
| Cire organiser | OSN access token (`aud: "osn-access"`) verified via `@shared/osn-auth-client`, then per-wedding **role authz**, read from the caller's `wedding_hosts` seat — four tiers: `weddingOwner()` (any owner — a wedding may have several, all equal and never fewer than one: code management, billing, connecting the registry payout account — once a wedding has an account, only the owner who connected it (`registry_settings.stripe_connected_by_osn_profile_id`) may open its onboarding links, every other owner gets 403 `stripe_connector_only` and sees its status, and an account with no connector on record is no owner's; the status refresh stays open to every owner; an owner may give a wedding with no account the account they connected on another wedding they still own (`POST /registry/stripe/reuse`, which takes a wedding id and never an account id), only where every owner of the first is an owner of the second, and is refused one 404 for every source they may not use — the CSV exports, delete, and **all of host management** — adding a seat at any role, changing a role, setting a helper's run-sheet scope (`own`/`full`) or removing a seat, another owner's included; an editor is refused 403 `forbidden`), `weddingEditor()` (owner or `editor` co-host: module writes — import, invite, locations — and marking a household's code sent; viewers get 403 `read_only_role`) — including `PUT /settings`, which the middleware alone cannot decide: the settings body is owner-only EXCEPT the RSVP-by deadline (`rsvpDeadline` + `rsvpDeadlineTimezone`), so the handler applies a **field-level owner check** on top of the gate and refuses a non-owner patch carrying any other key with 403 `owner_only_fields` (logged + counted on `cire.wedding.settings.owner_only_refused`; the allow-list is derived from the request schema's own field list, so a new setting is owner-only by default). Every settings write records its author in `weddings.updated_by_osn_profile_id` (migration 0056) — the panel has two principal classes now, so a change to a guest-facing control is attributable. A deadline may not be set in the PAST by anyone, owner included: a backdated date locks the invite for every guest the instant it lands (400 `rsvp_deadline_in_past`), `weddingMember()` (any role incl. `viewer`: reads + invite preview), and `weddingRunSheet()` (owner, editor, viewer and `helper`: the day-of run sheet; a helper's rows are narrowed on the server to their own scope, `own` or `full`, by `runSheetVisibleTo`, and every other gate refuses a helper with the same `forbidden` a stranger gets). The realtime push socket, `GET /realtime/:topic` ([[realtime]]), admits on the run-sheet tier's capability (`LISTEN_CAPABILITY`), so every seat may listen, a helper at either scope; it sits behind a per-IP limit and a per-organiser limit of 30 a minute each and a daily ceiling of 300 subscribes per organiser, and a removal, a leave and a wedding delete close the member's sockets (1008). A signal names the wedding and a kind, never a row; every re-read goes through the gates above. Roles live in `wedding_hosts.role` (`owner`/`editor`/`viewer`/`helper`), checked per-request from the DB (demotion is immediate, never embedded in the JWT). **Only an owner may create a seat, change a role, set a helper's run-sheet scope or revoke a seat.** Seats are capped per wedding, owners counted, so no owner's list can truncate below the real count, and `wedding_hosts.added_by_osn_profile_id` is surfaced in the panel so a seat another owner created is visible as such. | [[cire-auth]] |
| Cire organiser-session revoke (osn-api to cire-api) | Shared bearer secret `CIRE_INTERNAL_REVOKE_SECRET`, at least 32 characters, compared in constant time; one value per tier held by osn-api and cire-api only. Provisioned on dev as the `dev` Environment secret of that name, which both stacks upload, and on production by `wrangler secret put` on both Workers, with no Environment copy; rotated on both together, and removed by deleting it from both, which turns the route off (503). It can end any organiser's cire sessions and reads nothing | [[cire-auth]] |
| Service key registration and the coordination probe (`POST /graph/internal/register-service`, `DELETE /graph/internal/service-keys/:keyId`, `GET /health/coordination`) | Shared bearer secret `INTERNAL_SERVICE_SECRET`, one value per tier. Held by osn-api and zap-api, with which a service registers or revokes its ARC public key at osn-api; and by the osn-api smoke-check steps of `deploy.yml` (dev) and `production-release.yml` (production), which send it on every deploy as the bearer for `GET /health/coordination` on the Worker's public host. That probe writes, reads and removes one random coordination-store entry and reads nothing else, but a deploy job that holds the secret for it could also register a service key. On dev, provisioned as the `dev` Environment secret of that name, which the stacks upload and the smoke-check step reads; on production, set on each Worker with `wrangler secret put` and kept in the `production` Environment for the smoke-check step alone; rotated on both Workers together | [[arc-tokens]], [[coordination-store]] |
| Cire guest | **Guest-session credential class** — family claim code (`families.public_id`) → opaque 256-bit `cire_session` (SHA-256 at rest), family-scoped, gates `/api/rsvp` only. Never an OSN account. | [[cire-auth]] |
| Cire vendor (sole-trader) | **Vendor principal class** — OSN account holder + organization membership (per `org:read` ARC scope grant). `vendorOrgMember()` middleware gate (fail-closed: missing/failed check → 403, never bypass) protects `/api/vendor/*` listing writes and claim consumption. Scope `org:read` requested by cire-api, granted by osn-api's ARC allowlist; resolved at claim/consume time via ARC verification of the requestor's org membership. | [[cire-auth]] |
| Cire organiser address lookup | **ARC scope `account:email-read`** — gates `POST /internal/accounts/emails` on osn-api and nothing else. Deliberately not folded into `graph:read`: an email address is the one field the graph routes never return, so the grant can be withdrawn on its own without taking co-host autocomplete down with it. Sole intended holder: `@cire/api`, which stores no address of its own and has three callers: the retention sweep, which has to reach a couple whose gift detail it is about to delete, the daily RSVP digest, which mails a wedding's owners and editor co-hosts ([[cire-rsvp-changes]]), and the owner notices, which mail a wedding's owners when one is removed or demoted or the wedding is deleted ([[cire-auth]]). All three look up only profiles that hold, or in the request being answered held, a seat on a wedding cire holds; the owner notice looks up the owner just removed, and only when their seat is a day old or was created by someone other than the remover. Returns account email addresses, capped at 100 profile ids per call, as an omit-list — an unknown id, a soft-deleted account and an address-less account are indistinguishable, so the route is not an existence oracle. **Known limitation:** `PERMITTED_SCOPES` in `graph-internal.ts` is one flat allowlist governing what `/graph/internal/register-service` will grant to any service, so nothing on the registration side binds this scope to cire-api. The restriction is enforced at the point of use instead — the handler checks the signature-verified `iss` against `cire-api` and 401s anything else. Making the registration allowlist per-service is the outstanding fix. | [[arc-tokens]], [[retention]] |

## Production console access (the SOC 2 gap)

The matrix that needs to exist, by environment + system + role.

| System | Role | Granted to | MFA required? | Granted via | Reviewed |
|---|---|---|---|---|---|
| GitHub `englishstreetventures` org | Owner | <named human> | ✓ Hardware key | Per-PR review | Quarterly |
| GitHub `englishstreetventures` org | Maintainer | <named humans> | ✓ Hardware key | Per-PR review | Quarterly |
| GitHub `englishstreetventures` org | Read | <named humans> | ✓ Any TOTP / WebAuthn | Manual | Quarterly |
| Production database | Read-write (operator) | <named humans> | ✓ Via Tailscale + WebAuthn | Manual + audit log | Quarterly |
| Production database | Read-only (debugging) | <named humans> | ✓ | Same | Quarterly |
| Grafana Cloud | Admin | <named humans> | ✓ | Manual | Quarterly |
| Grafana Cloud | Editor | <named humans> | ✓ | Manual | Quarterly |
| Grafana Cloud | Viewer | <named humans> | ✓ | Manual | Quarterly |
| Cloudflare | Super admin | <named humans> | ✓ | Manual | Quarterly |
| Cloudflare | Domain admin | <named humans> | ✓ | Manual | Quarterly |
| Cire Cloudflare D1 (guest DB) | Read-write (operator) | <named humans> | ✓ Via Cloudflare dashboard / Wrangler + WebAuthn | Manual + audit log | Quarterly |
| Cire Cloudflare R2 (`cire-sheets`, raw guest CSVs) | Read-write (operator) | <named humans> | ✓ | Manual + audit log | Quarterly |
| Domain registrar | Owner | <named humans> | ✓ | Manual | Annual |
| Stripe platform Dashboard (cire gift registry — first live use once the PR #760/#762 keys are set; Pulse ticketing later). Dashboard access reaches every couple's connected-account view and the API/webhook secrets below | Admin | <named humans> | ✓ | Manual | Quarterly |
| Email provider (Resend today; Cloudflare Email Service is the legacy fallback) | Admin | <named humans> | ✓ | Manual | Quarterly |

This page is the template; the matrix with named humans lives in
a private successor under `wiki/compliance/access-matrix/<YYYY>-<Q>.md`
on a quarterly cadence and is **never committed publicly**. The public
template gives auditors the structure; the private quarterly file gives
them the evidence.

## Worker secrets — Stripe (`cire-api-production`)

Two Cloudflare Workers secrets gate the cire gift-payment surface.
`cire-api-dev`, in the dev account, holds both, and a third,
`STRIPE_PLATFORM_WEBHOOK_SECRET`, the signing secret of the platform webhook
endpoint ([[stripe-webhooks]]); the cire stack uploads all three from the `dev`
Environment on every dev deploy.
`cire-api-production` holds **none of the three**, so the code (PR #760,
stacked PR #762) ships inert there; setting either of the two below on
production is gated by the paperwork checklist in [[subprocessors]]
§"Stripe Connect (cire) — the paperwork gate". They are secrets, never
`[vars]`: the API key can move money, and the signing secret is the only
thing that stops anyone else's webhook body being believed.

*Measured 2026-10-16 — `env CLOUDFLARE_ACCOUNT_ID=<production account id>
bun run --cwd shared/infra secrets:check-live -- --tier production` reports
cire-api production holding exactly its names in
`shared/infra/src/secrets/inventory.ts`: none of the three Stripe names.*

| Secret | What it gates | Provisioned | Rotation |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | Unset ⇒ the organiser Connect routes are **not mounted** (no payment surface, not a broken one). Guests are offered money gifts only with this key **and** `STRIPE_WEBHOOK_SECRET`. The portal reads that from `takesPayments` on `GET /registry`: without both, the Money-gifts panel says money gifts aren't available on this site, and with no key the Connect button answers 404 as a toast. Set ⇒ account creation, onboarding links, live account reads — calls that act on the platform's Stripe account — and, where upgrades are sold, platform Checkout Sessions for a plan tier and **automatic refunds of them** (`POST /v1/refunds`): from the platform webhook, and from the daily cron's upgrade reconciliation, which runs wherever the key is set. A restricted key needs Checkout Sessions: write, PaymentIntents: read, Charges: read and Refunds: write ([[stripe-webhooks]]). Refunds use this one key; a separate platform-only key is an open owner question. | First add the name to cire-api's production row in `shared/infra/src/secrets/inventory.ts`, in a pull request, so the release expects it ([[infrastructure-as-code#Secrets]]). Then `bunx wrangler secret put STRIPE_SECRET_KEY --env production` from `cire/api`; no `production` Environment copy, since no stack uploads a production secret and every deploy keeps the live one ([[production-deploy#5.9 Setting a production secret 🔑]], which also says when a warm isolate sees it). Requires Cloudflare access per the matrix above + Stripe Dashboard access to mint the key. Live key on production only; the dev value (`STRIPE_SECRET_KEY` in the `dev` Environment, uploaded by the cire stack) must be a test-mode key, and the cire stack refuses to deploy one that does not start `sk_test_` or `rk_test_` ([[infrastructure-as-code#GitHub Environment secrets]]). | Roll the key in the Stripe Dashboard (Developers, then API keys) with an expiry window, `wrangler secret put` the new value, let a release deploy cire-api ([[production-deploy#5.9 Setting a production secret 🔑]]), let the old key expire. Immediate revocation (suspected compromise): roll with no window — the Worker 502s Stripe calls until the new value is deployed, which is the correct failure. |
| `STRIPE_WEBHOOK_SECRET` | Unset or blank ⇒ `POST /api/stripe/webhook` **does not exist**. Nothing else authenticates that endpoint — the signature IS the authentication — so without a signing secret it must not be reachable. Guests are then offered no money gift either, since nothing would record one, and a Worker holding `STRIPE_SECRET_KEY` logs `money gifts disabled: …` when it builds the app. | Same path: inventory row first, then `wrangler secret put`. The value comes from the Dashboard webhook endpoint (created in checklist step 6). | **Zero-downtime by design, worth writing down:** when a secret is rolled in the Dashboard with an overlap window, Stripe signs each delivery with BOTH secrets, and the verifier (`cire/api/src/services/stripe.ts`) checks every `v1` digest in the header against its one configured secret — so deliveries verify throughout, whichever value the Worker holds. Sequence: roll in the Dashboard with an overlap window → `wrangler secret put` the new value → a release deploys cire-api → old secret expires. |

## Deploy credentials and secret copies

What the Alchemy deploys hold besides the live Workers' own secrets: copies
of Worker secrets, and the credentials that reach them. The secret
inventory, the state store and each tier's credentials are described in
[[infrastructure-as-code]].

| Credential or copy | What it holds, and who can read it | Provisioned | Revoked or removed |
|---|---|---|---|
| GitHub Environment secrets, `dev` and `production` | `dev` holds every dev Worker secret value the secret inventory names, under the same name, and the dev deploy uploads each from there; it also holds `ASTRO_KEY` and the Access service token (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`). `production` holds no Worker secret for a stack to upload: the production stacks upload none, and each value lives on its Worker. It keeps `INTERNAL_SERVICE_SECRET`, which osn-api's production smoke check sends, and the TOTP key values `set-osn-api-secret.yml` reads, beside the account pair. Readable by any job that runs in that Environment. Both Environments admit only `main`, and a `production` job waits for its required reviewer. | By the owner, with `gh secret set` | `gh secret delete`, and rotate the value at its source: deleting the copy leaves the live value as it was. Deleting a dev Worker secret's copy fails the next dev deploy of its stack before upload |
| Cloudflare CI tokens | `CLOUDFLARE_API_TOKEN` (`production` Environment) is an account API token on the production account, owned by the account rather than any person, and reaches only that account; the owner grants it Secrets Store Edit before bootstrapping the production state store. In `production-release.yml` every deploy runs in an Alchemy job (`alchemy-plan`, `stack-<stack>-production`), and no job deploys a Pages project; in those jobs only the steps that check the token or the state store, read deployments, custom domains or the adopted resources' live state, plan, migrate, deploy or smoke-check hold it, and none of those jobs restores a dependency cache that a job holding no secret could have written. The dev account has three credentials, each a `dev` Environment secret that reaches only the dev account: `CLOUDFLARE_DEV_ACCOUNT_ID`, the deploy token `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN` (read by `deploy.yml`'s stack jobs and `alchemy-state.yml`), and the read-only `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY` (read by the free-tier alert's dev job). Every CI job that runs Alchemy — each stack job of `deploy.yml`, both tier steps of `alchemy-state.yml`, and `production-release.yml`'s `alchemy-plan` and `stack-<stack>-production` — first checks that its token reaches exactly the account its `CLOUDFLARE_ACCOUNT_ID` names, and, on dev, that it acts on the dev zone and no production zone, and stops otherwise (`token:check`, [[infrastructure-as-code#Accounts]]). The stacks and their package scripts do not run that check, so a person running Alchemy by hand runs `bun run --cwd shared/infra token:check -- --tier <tier>` first. The `dev` Environment holds neither `CLOUDFLARE_ACCOUNT_ID` nor `CLOUDFLARE_API_TOKEN_DEV`, the two names that point at the production account; `secrets:check-github -- --tier dev`, run by hand, fails when it holds either ([[dev-environment#The production account holds no dev tier]]). `CLOUDFLARE_API_TOKEN_READONLY` is a repository-level secret, readable by any job, with read-only rights on the production account (`REPOSITORY_CREDENTIALS` in `shared/infra/src/accounts.ts`). The dev deploy token's grants are in [[dev-environment]]; the production token's are set in the Cloudflare dashboard and recorded nowhere else. | By the owner in the Cloudflare dashboard, then `gh secret set` into its Environment, or into the repository for the read-only token | Any token: roll it in the dashboard and set the new value. Deleting a GitHub secret leaves its token valid, so revoke the token in its account's dashboard as well |
| `CLOUDFLARE_PAGES_DNS_TOKEN` | Retired. It held Pages Edit on the production account and DNS Edit on `cireweddings.com` and `musubi.social`, to move a site's custom domain between its Pages project and its Worker. No workflow reads it (`RETIRED_CREDENTIALS` in `shared/infra/src/accounts.ts`), and `secrets:check-github` refuses it in either Environment, so the check fails on `production` until the secret is deleted. | Nobody | Revoke it in the Cloudflare dashboard, then `gh secret delete CLOUDFLARE_PAGES_DNS_TOKEN --env production`, the day this row lands; then remove this row |
| `production-records` Environment | A GitHub Environment with no required reviewer and deployment branches `main` only, holding no secret. Its jobs (`record-<surface>` in `production-release.yml`, one per surface a production stack deploys, API Workers and sites) run unapproved, after the stack job deployed, kept every secret, and that surface's smoke check passed, check nothing out, and each leaves the Deployment record the release planner reads as the commit that surface runs. The planner counts a record only when its success status links a job of that surface's record-job name that succeeded at the record's commit, in a `production-release.yml` run on `main` in this repository (`scripts/release-plan.ts`), so a forged record can at most make a later release ship the surface again | By the owner: **Settings → Environments → New environment**, no reviewer, deployment branches `main` only | Delete the Environment; the planner then finds no record for those surfaces, and the next release ships them again |
| Alchemy state store bearer token and encryption key (`AlchemyStateStoreToken`, `AlchemyStateStoreEncryptionKey`) | One pair per Cloudflare account, in that account's Secrets Store. Any token on the account with Workers Scripts Edit and Secrets Store Read can read the bearer token, through a temporary edge-preview Worker. | Created by the state store's bootstrap run: dev's before the first dev deploy, production's later | Only by `alchemy state teardown --backend cloudflare`, which no committed command runs and `scripts/check-alchemy-usage.ts` refuses. **Neither can be rotated in place**: Alchemy generates each value once, when the store is created, and keeps it for the store's life: deploying the store creates each secret only when it is absent and never updates or deletes one (`src/StateStore/Deploy.ts` and `src/StateStore/Token.ts` in `@alchemy.run/cloudflare@2.0.0-beta.85`). A leaked bearer token therefore means replacing the store — teardown deletes its Worker, its state and both secrets; a new bootstrap; each stack redeployed with `--adopt` — and rotating every Worker secret its state held. The runbook is [[infrastructure-as-code#Replacing a state store]]. A leaver who ran Alchemy against the store on their own machine without `CI=true`, or with `CI=true` while holding the older cache, or who deployed or upgraded the store with `state:bootstrap` on `2.0.0-beta.84` or earlier, is one cause |
| Local caches of a state store's URL and bearer token (`~/.alchemy/profiles/<profile>/state-stores/cloudflare.json`, and the older `~/.alchemy/credentials/<profile>/cloudflare-state-store.json`) | A plain-text copy of the bearer token, with the store's URL and the account id, in the home directory of anyone who ran Alchemy against the store on their own machine without `CI=true`, or who ran it with `CI=true` while holding only the older file (`src/StateStore/State.ts:460-463` and `640-643` in `@alchemy.run/cloudflare@2.0.0-beta.85` write it only outside CI; the file is mode `0600`). Every committed Alchemy script sets `CI=true`, so none writes a token into it, even one that deploys or upgrades the store. But any run, `CI=true` included, copies an existing older file into the newer one when the newer is absent (`src/StateStore/CredentialsFile.ts:100-124`). Alchemy releases before `2.0.0-beta.84` wrote the older path; later ones copy it into the newer file and never delete it. Whoever can read either file can read every secret value in that account's state. A CI run on a fresh runner holds no older file and writes neither, and the runner is discarded after the job. | Written by the first such run on that machine | Delete both files. That removes these copies only; the token stays valid until the store is replaced |
| Copies of every deployed Worker secret inside Alchemy state | Alchemy writes each `Redacted` prop's value into state (`src/State/StateEncoding.ts:90-94` in `alchemy@2.0.0-beta.85`). Readable by anyone who holds that account's store bearer token, so by any token on the account with Workers Scripts Edit and Secrets Store Read. The dev account's state holds every dev Worker secret; production's holds none, since the production stacks upload no secret. | Written by each Alchemy deploy of a Worker | Only with that resource's state |

## Access lifecycle

### Granting

Pre-conditions to meet before we grant any production access:

1. Documented role per the matrix above (no "founder gets everything by default").
2. WebAuthn / hardware key enrolled on the system.
3. Acknowledged the security policy + this page (signature recorded).
4. PR opened modifying the quarterly matrix file.

### Reviewing

Quarterly cadence, calendar-driven:

1. Pull each system's user list.
2. Diff against last quarter's matrix.
3. Confirm each user still requires the access (manager attestation).
4. Revoke unused (>90 d) accounts unless attested.
5. Commit the new quarterly matrix file.
6. Note exceptions in `wiki/compliance/access-reviews/<YYYY>-<Q>.md` (public — the review record, not the contents).

### Revoking

Triggers:

1. Departure (immediate; same-day SLA).
2. Role change reducing scope (within 7 days).
3. Inactivity >90 d unless attested.
4. Suspected compromise (immediate; rotate keys).

Revocation checklist per leaver:

- [ ] GitHub org member removed
- [ ] All personal access tokens / OAuth apps revoked
- [ ] Cloudflare account removed
- [ ] Ran `state:check` or `state:bootstrap` on their own machine against either account? Treat that account's state store bearer token as leaked: replace the store and rotate the Worker secrets its state holds ([[infrastructure-as-code#Replacing a state store]]). Removing them from Cloudflare does not revoke it: the store checks the bearer token, not account membership
- [ ] Grafana Cloud user removed
- [ ] Database direct-access credential rotated (everyone, not just leaver)
- [ ] SSH keys removed from any bastion
- [ ] Tailscale node removed
- [ ] Slack / comms removed
- [ ] WebAuthn / step-up tokens for any in-product admin role revoked
- [ ] Calendar review: any `wiki/compliance/access-matrix/...` updates needed before next quarter

## Internal admin actions on user data

When an operator queries or modifies production user data, the action
must be:

1. **Necessary** — for support, security, or legal reasons; not curiosity.
2. **Logged** — to a tamper-evident audit log (planned: `admin_actions` table with append-only constraint + Grafana log mirror).
3. **Attributable** — keyed to the operator's account, not a shared service account.
4. **Reviewable** — quarterly sample by a second reviewer.

This is informal today; the `admin_actions` table is on the backlog.

## Service-account hygiene (ARC)

ARC tokens are S2S only; no human ever holds one. Rotation is automatic
(see [[arc-tokens]]). Per service account:

- One private key ever in use; rotated every 24 h with overlap window.
- Public keys distributed via JWKS or `service_account_keys` table.
- `allowedScopes` enforced at issuer + verifier sides.
- Revocation via `evictPublicKeyCacheEntry(kid)` is immediate.

## Cire access expectations

Cire's guest DB (Cloudflare D1) and `cire-sheets` R2 bucket hold guest PII
including special-category dietary free-text (see [[data-map]]). They are a
**separate** data store from `osn/db`, so operator access is a distinct
grant in the matrix above. Expectations:

- **No standing access.** Operators query cire D1 / R2 only for support,
  security, or a manual DSAR (cire has no DSAR endpoint yet — see [[dsar]]);
  each access is necessary, logged, attributable, and reviewable per
  "Internal admin actions on user data" above.
- **Guest claim codes are credentials.** `families.public_id` is treated as
  a secret (redacted in logs), not a public identifier — do not paste
  codes into tickets or logs.
- **The wedding owner is not an operator.** Organiser access to their own
  wedding is in-product authz (OSN JWT → the `weddingOwner()` /
  `weddingEditor()` / `weddingMember()` role gates), not console access; it
  grants no visibility into other weddings.
- **Co-host roles are least-privilege in-product grants.** Only a wedding's
  owners may seat other OSN accounts (`wedding_hosts.role`: another `owner`, an
  `editor` for module writes, a `viewer` for read-only, or a `helper`, refused
  every gate on the guest data and given only the day's run sheet, behind
  `weddingRunSheet()` and Gold — `GET …/run-sheet`, narrowed on the server to
  their scope ([[cire-run-sheet]])), change a role or
  revoke someone else's seat; any co-host, a `helper` included, may give up
  their own (`DELETE /hosts/me`, which takes no profile id and so reaches no
  other seat), and an unknown/corrupted stored role degrades to `helper`, the
  narrowest, never upward. A helper's reach within their role is a second grant,
  and an owner's alone: `wedding_hosts.run_sheet_scope` is `own`, the tasks they
  hold, unless an owner widens it to `full`, every task and who is doing each one,
  behind a confirmation (`PUT …/hosts/:osnProfileId/run-sheet-scope`). Every new
  helper starts at `own`, and any role change other than helper to helper resets
  it to `own` in the same statement, so a widened helper moved away and back
  does not come back widened. See [[cire-auth#The run-sheet scope]]. Two controls
  bound who holds access: seats are capped per wedding below the list's read
  ceiling, so an owner's view of who holds access can never silently truncate;
  and each row records `added_by_osn_profile_id`, surfaced in the panel, so an
  owner can see which seats they did not create. **Residual, and accepted rather
  than solved:** a new seat is live immediately and the owner is not notified.
  See the roles capability matrix in [[cire-auth]].
- **Vendor claims are confirmed by an operator, never by the claim link.**
  A cire organiser chooses the address a directory claim link goes to, so a
  redeemed link only records a pending claim (`directory_vendors.review_*`).
  An operator confirms or rejects it with
  `scripts/cire-vendor-claim-review.ts`, a dry run until `--apply`, which
  writes to the production cire D1 under the operator's own Cloudflare login
  (the "Cire Cloudflare D1" grant above) and reads the claimant's
  organisation from the OSN D1. Each confirm or reject is an admin action on
  user data: record it per "Internal admin actions on user data" above.
  Procedure and checks: [[cire-vendors#Operator review of claims]].

## Project changes required

1. **Quarterly access matrix** — first cycle: 2026-Q3 (also in [[soc2]]).
2. **Quarterly access review** — first cycle: 2026-Q3.
3. **`admin_actions` audit log** — append-only constraint + Grafana mirror.
4. **GitHub org hardening** — required hardware-key MFA, signed commits, branch
   protection, codeowners on prod paths. **Partly done (2026-08-30):**
   `.github/CODEOWNERS` now names an owner for the paths that decide whether a
   guard runs at all — `/.github/`, `scripts/`, `bunfig.toml` and
   `package.json` (all three unanchored, so a `scripts/` directory, a
   `bunfig.toml` or a workspace manifest matches at any depth),
   `/oxlintrc.json`, `/lefthook.yml`, `/.gitleaks.toml`, `/bun.lock`, `/.bun-version` and
   `/tools/oxlint/**`. Branch
   protection is ruleset `13921406` on `englishstreetventures/osn` (active: pull request
   required, linear history, no deletion, no force-push, `CI` and
   `Require changeset`, `Migration history` and `Secret scan` as required status checks).
   **Secret scanning:** the `Secret scan` job runs the scanner and reads the
   policy from `origin/main`, so a pull request cannot switch its own scan off by
   editing those files. It can still edit the workflow file that runs the job; the
   same ruleset gap below leaves that to a reviewer.
   **Still open, and the honest state of the control:** that ruleset sets
   `required_approving_review_count: 0` and `require_code_owner_review: false`,
   because there is one maintainer and a review requirement nobody else can
   satisfy would only block every merge. So CODEOWNERS routes a review request
   today; it does not gate a merge. Also still open: the five production
   topology files (`cire/api/wrangler.toml`, `osn/api/wrangler.toml`,
   `pulse/api/wrangler.toml`, `zap/api/wrangler.toml`,
   `cire/invites/wrangler.jsonc`) are owned by the same patterns but under the
   same un-enforced review; required hardware-key MFA and required signed
   commits are org-level settings and are not set. Both of those, and turning
   code-owner review back on, land when a second maintainer does.
5. **Tailscale or equivalent bastion** — for direct DB access; no public DB endpoint (decision: bastion vs read-replica vs CLI proxy).
6. **Departure runbook** — checklist above formalised.
