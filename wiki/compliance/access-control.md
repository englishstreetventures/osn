---
title: Production Access Control Matrix (SOC 2 CC6)
tags: [compliance, soc2, access-control]
related:
  - "[[index]]"
  - "[[soc2]]"
  - "[[arc-tokens]]"
  - "[[identity-model]]"
last-reviewed: 2026-04-26
---

# Access Control

SOC 2 CC6 demands a documented, reviewed, least-privilege access posture.
This is the matrix.

## End-user authentication (in-product)

Already strong; documented elsewhere.

| Surface | Mechanism | Page |
|---|---|---|
| Account login | Passkey-primary (WebAuthn `userVerification: "required"`) | [[passkey-primary]] |
| API access | ES256 access tokens, 5 min TTL, JWKS-verified | [[identity-model]] |
| Sensitive ops | Step-up tokens (`aud: "osn-step-up"`, single-use JTI) | [[step-up]] |
| Recovery | 64-bit single-use codes (Copenhagen Book M2) | [[recovery-codes]] |
| Service-to-service | ARC tokens (ES256, scoped, kid-pinned, revocable, scope-validated on cache hit) | [[arc-tokens]] |
| Org admin (Zap M3) | Role-gated `org_agents.role = "admin"` | [[zap]] |

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
| Domain registrar | Owner | <named humans> | ✓ | Manual | Annual |
| Stripe (when ticketing lands) | Admin | <named humans> | ✓ | Manual | Quarterly |
| Email provider (Cloudflare Email Service today) | Admin | Same as Cloudflare | ✓ | — | — |
| Redis provider (TBD) | Admin | <named humans> | ✓ | Manual | Quarterly |

This page is the template; the actual matrix with named humans lives in
a private successor under `wiki/compliance/access-matrix/<YYYY>-<Q>.md`
on a quarterly cadence and is **never committed publicly**. The public
template gives auditors the structure; the private quarterly file gives
them the evidence.

## Access lifecycle

### Granting

Pre-conditions before any production access is granted:

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

This is currently informal; the `admin_actions` table is on the backlog.
ID: **C-M16**.

## Service-account hygiene (ARC)

ARC tokens are S2S only; no human ever holds one. Rotation is automatic
(see [[arc-tokens]]). Per service account:

- One private key ever in use; rotated every 24 h with overlap window.
- Public keys distributed via JWKS or `service_account_keys` table.
- `allowedScopes` enforced at issuer + verifier sides.
- Revocation via `evictPublicKeyCacheEntry(kid)` is immediate (resolves S-H100).

## Project changes required

Tracked with `C-` IDs:

1. **Quarterly access matrix** — first cycle: 2026-Q3. ID: **C-M5** (also in [[soc2]]).
2. **Quarterly access review** — first cycle: 2026-Q3. ID: **C-L3**.
3. **`admin_actions` audit log** — append-only constraint + Grafana mirror. ID: **C-M16**.
4. **GitHub org hardening** — required hardware-key MFA, signed commits, branch protection, codeowners on prod paths. ID: **C-L4**.
5. **Tailscale or equivalent bastion** — for direct DB access; no public DB endpoint. ID: **C-L21** (decision: bastion vs read-replica vs CLI proxy).
6. **Departure runbook** — checklist above formalised. ID: **C-L22**.
