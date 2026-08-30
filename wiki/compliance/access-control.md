---
title: Production Access Control Matrix (SOC 2 CC6)
tags: [compliance, soc2, access-control]
related:
  - "[[index]]"
  - "[[soc2]]"
  - "[[arc-tokens]]"
  - "[[identity-model]]"
  - "[[cire-auth]]"
  - "[[cire]]"
last-reviewed: 2026-08-30
---

# Access Control

SOC 2 CC6 demands a documented, reviewed, least-privilege access posture.
This is the matrix.

## End-user authentication (in-product)

Already strong; documented elsewhere.

| Surface | Mechanism | Page |
|---|---|---|
| Account login | Passkey-primary (WebAuthn `userVerification: "required"`) | [[passkey-primary]] |
| API access | ES256 access tokens, 5 min TTL, JWKS-verified. Carries `osn_sid`, a one-way per-profile binding to the session it was minted from, so a cookieless caller can still name its own session on the paths that revoke all the others | [[identity-model]], [[sessions]] |
| Sensitive ops | Step-up tokens (`aud: "osn-step-up"`, single-use JTI) | [[step-up]] |
| Recovery | 64-bit single-use codes (Copenhagen Book M2) | [[recovery-codes]] |
| Service-to-service | ARC tokens (ES256, scoped, kid-pinned, revocable, scope-validated on cache hit). **Scope reach can widen without the scope name changing — review the routes a scope gates, not just the grant list.** Current `graph:read` reach for `@cire/api`: handle→profile resolution, batch profile displays, global handle prefix search, **and viewer-scoped connection search** (added 2026-08-02 for co-host autocomplete; no new scope was minted). The last of these carries a caller invariant osn-api cannot enforce — the `profileId` must be the calling service's own authenticated end user, never a client-supplied value — see [[cire-auth]]. | [[arc-tokens]] |
| Org admin (Zap M3) | Role-gated `org_agents.role = "admin"` | [[zap]] |
| Cire organiser | OSN access token (`aud: "osn-access"`) verified via `@shared/osn-auth-client`, then per-wedding **role authz** — three tiers: `weddingOwner()` (owner: code management, delete, and the SUBTRACTIVE half of host management — removing a co-host, changing a co-host's role), `weddingEditor()` (owner or `editor` co-host: module writes — import, invite, locations — **and ADDING a co-host**; viewers get 403 `read_only_role`) — including `PUT /settings`, which the middleware alone cannot decide: the settings body is owner-only EXCEPT the RSVP-by deadline (`rsvpDeadline` + `rsvpDeadlineTimezone`), so the handler applies a **field-level owner check** on top of the gate and refuses a non-owner patch carrying any other key with 403 `owner_only_fields` (logged + counted on `cire.wedding.settings.owner_only_refused`; the allow-list is derived from the request schema's own field list, so a new setting is owner-only by default). Every settings write records its author in `weddings.updated_by_osn_profile_id` (migration 0056) — the panel has two principal classes now, so a change to a guest-facing control is attributable. A deadline may not be set in the PAST by anyone, owner included: a backdated date locks the invite for every guest the instant it lands (400 `rsvp_deadline_in_past`), `weddingMember()` (any role incl. `viewer`: reads + invite preview). Roles live in `wedding_hosts.role` (`editor`/`viewer`), checked per-request from the DB (demotion is immediate, never embedded in the JWT). **An `editor` may create a seat; only the owner may change a role or revoke one** (2026-08-01) — the grant boundary is additive-versus-subtractive, not owner-versus-co-host. `editor` is the ceiling anyone can grant (the owner is never rowed into `wedding_hosts`), seats are capped per wedding so the owner's list can never truncate below the real count, and `wedding_hosts.added_by_osn_profile_id` is surfaced in the panel so a seat the owner did not create is visible as such. | [[cire-auth]] |
| Cire guest | **Guest-session credential class** — family claim code (`families.public_id`) → opaque 256-bit `cire_session` (SHA-256 at rest), family-scoped, gates `/api/rsvp` only. Never an OSN account. | [[cire-auth]] |
| Cire vendor (sole-trader) | **Vendor principal class** — OSN account holder + organization membership (per `org:read` ARC scope grant). `vendorOrgMember()` middleware gate (fail-closed: missing/failed check → 403, never bypass) protects `/api/vendor/*` listing writes and claim consumption. Scope `org:read` requested by cire-api, granted by osn-api's ARC allowlist; resolved at claim/consume time via ARC verification of the requestor's org membership. | [[cire-auth]] |

## Production console access (the SOC 2 gap)

The matrix that needs to exist, by environment + system + role.

| System | Role | Granted to | MFA required? | Granted via | Reviewed |
|---|---|---|---|---|---|
| GitHub `xchromo` org | Owner | <named human> | ✓ Hardware key | Per-PR review | Quarterly |
| GitHub `xchromo` org | Maintainer | <named humans> | ✓ Hardware key | Per-PR review | Quarterly |
| GitHub `xchromo` org | Read | <named humans> | ✓ Any TOTP / WebAuthn | Manual | Quarterly |
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
| Stripe (when ticketing lands) | Admin | <named humans> | ✓ | Manual | Quarterly |
| Email provider (Resend today; Cloudflare Email Service is the legacy fallback) | Admin | <named humans> | ✓ | Manual | Quarterly |
| Redis provider (Upstash, `ap-southeast-2`) | Admin | <named humans> | ✓ | Manual | Quarterly |

This page is the template; the matrix with named humans lives in
a private successor under `wiki/compliance/access-matrix/<YYYY>-<Q>.md`
on a quarterly cadence and is **never committed publicly**. The public
template gives auditors the structure; the private quarterly file gives
them the evidence.

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
ID: **C-M16**.

## Service-account hygiene (ARC)

ARC tokens are S2S only; no human ever holds one. Rotation is automatic
(see [[arc-tokens]]). Per service account:

- One private key ever in use; rotated every 24 h with overlap window.
- Public keys distributed via JWKS or `service_account_keys` table.
- `allowedScopes` enforced at issuer + verifier sides.
- Revocation via `evictPublicKeyCacheEntry(kid)` is immediate (resolves S-H100).

## Cire access expectations

Cire's guest DB (Cloudflare D1) and `cire-sheets` R2 bucket hold guest PII
including special-category dietary free-text (see [[data-map]]). They are a
**separate** data store from `osn/db`, so operator access is a distinct
grant in the matrix above. Expectations:

- **No standing access.** Operators query cire D1 / R2 only for support,
  security, or a manual DSAR (cire has no DSAR endpoint yet — see [[dsar]]
  C-M1); each access is necessary, logged, attributable, and reviewable per
  "Internal admin actions on user data" above.
- **Guest claim codes are credentials.** `families.public_id` is treated as
  a secret (redacted in logs, C-M2), not a public identifier — do not paste
  codes into tickets or logs.
- **The wedding owner is not an operator.** Organiser access to their own
  wedding is in-product authz (OSN JWT → the `weddingOwner()` /
  `weddingEditor()` / `weddingMember()` role gates), not console access; it
  grants no visibility into other weddings.
- **Co-host roles are least-privilege in-product grants.** A wedding's owner —
  **or, since 2026-08-01, an `editor` co-host** — may seat other OSN accounts as
  `editor` (module writes) or `viewer` (read-only) co-hosts
  (`wedding_hosts.role`). Only the OWNER may change a role or revoke a seat, and
  an unknown/corrupted stored role degrades to `viewer`, never upward. Three
  controls bound the widened grant: `editor` is the ceiling anyone can grant, so
  no seat outranks its creator; seats are capped per wedding below the list's
  read ceiling, so the owner's view of who holds access can never silently
  truncate; and each row records `added_by_osn_profile_id`, surfaced in the
  panel, so an owner can see which seats they did not create. **Residual, and
  accepted rather than solved:** a new seat is live immediately and the owner is
  not notified — tracked as `S-M2` in `xchromo/osn-tracker`. See the
  roles capability matrix in [[cire-auth]].

## Project changes required

Tracked with `C-` IDs:

1. **Quarterly access matrix** — first cycle: 2026-Q3. ID: **C-M5** (also in [[soc2]]).
2. **Quarterly access review** — first cycle: 2026-Q3. ID: **C-L3**.
3. **`admin_actions` audit log** — append-only constraint + Grafana mirror. ID: **C-M16**.
4. **GitHub org hardening** — required hardware-key MFA, signed commits, branch
   protection, codeowners on prod paths. ID: **C-L4**. **Partly done (2026-08-30):**
   `.github/CODEOWNERS` now names an owner for the paths that decide whether a
   guard runs at all — `/.github/`, `/scripts/`, `/bunfig.toml`, `package.json`
   (unanchored, so every workspace manifest matches), `/oxlintrc.json`,
   `/lefthook.yml`, `/bun.lock`, `/.bun-version` and `/tools/oxlint/**`. Branch
   protection is ruleset `13921406` on `xchromo/osn` (active: pull request
   required, linear history, no deletion, no force-push, `CI` and
   `Require changeset` as required status checks).
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
5. **Tailscale or equivalent bastion** — for direct DB access; no public DB endpoint. ID: **C-L21** (decision: bastion vs read-replica vs CLI proxy).
6. **Departure runbook** — checklist above formalised. ID: **C-L22**.
