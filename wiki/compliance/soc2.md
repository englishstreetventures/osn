---
title: SOC 2 (Trust Services Criteria)
tags: [compliance, soc2, audit, controls]
related:
  - "[[index]]"
  - "[[scope-matrix]]"
  - "[[access-control]]"
  - "[[backup-dr]]"
  - "[[breach-response]]"
  - "[[subprocessors]]"
  - "[[observability/overview]]"
  - "[[cire]]"
last-reviewed: 2026-08-30
---

# SOC 2

We pursue **SOC 2 Type II** because Zap M3 (verified-organisation chats +
embeddable customer-support widget) is a B2B surface — businesses will not
embed an unaudited chat widget on their checkout pages. The plan is **Type
I before the first paying org** (point-in-time attestation that controls
exist) and **Type II within 12 months of Type I** (operating-effectiveness
attestation over a continuous 6+ month observation window).

## Scope

| Trust Services Criterion | In scope | Why |
|---|---|---|
| **Security** (CC1–CC9) | ✓ Mandatory | The common criteria; foundation of SOC 2. |
| **Confidentiality** (C1) | ✓ | Customer chat transcripts (Zap M3), event guest lists (Pulse), social-graph edges. |
| **Availability** (A1) | ✓ | The widget is on customers' checkout pages — downtime hits their conversion rate. |
| **Privacy** (P1–P8) | ✓ | Overlaps GDPR; signals to enterprise that we take it seriously. |
| **Processing Integrity** (PI1) | Not yet | Add when paid Pulse ticketing lands — financial accuracy matters then. |

Audit boundary: **production hosting + first-party services + data
processors**. Specifically the deployed `@osn/api`, `@pulse/api`,
`@zap/api` instances; the production database; Redis; Cloudflare Email
Service; Grafana Cloud (logs / traces / metrics); and the corporate
GitHub org. Personal devices and untargeted internal tools (e.g. a local
dev SQLite) are out of scope.

## Control inventory

The full inventory lives in [[access-control]] (CC6 specifically) and
[[backup-dr]] (A1 specifically). This is the index.

### CC1 — Control Environment

| Control | Evidence | Gaps |
|---|---|---|
| Code of conduct + ethics policy | — | **Need to write.** Short doc, lives in `wiki/governance/`. |
| Background checks for engineers with prod access | — | Defer until first hire outside founders. |
| Annual compliance training | — | Defer to first audit prep. |
| Org chart + responsibility matrix | — | Captured per-feature in wiki frontmatter `related:`; need a single page. |

### CC2 — Communication and Information

| Control | Evidence | Gaps |
|---|---|---|
| Internal: this wiki, CLAUDE.md, README.md | ✓ | — |
| External: a public security.txt at `/.well-known/security.txt` | — | Add to `@osn/landing`. |
| Vulnerability disclosure policy | — | Add to `wiki/compliance/vdp.md`; reference from security.txt. |

### CC3 — Risk Assessment

| Control | Evidence | Gaps |
|---|---|---|
| Per-PR security review | `/review-security` skill | — |
| Per-PR performance review | `/review-performance` skill | — |
| Per-PR compliance review | This PR adds it to `/review-security` | — |
| Annual risk-assessment doc | — | One-page doc, refresh each year. |
| Threat-model docs per feature | Implicit in wiki system pages | Make it explicit for new features. |

### CC4 — Monitoring Activities

| Control | Evidence | Gaps |
|---|---|---|
| OpenTelemetry across all services | [[observability/overview]] | — |
| Grafana Cloud retention | 14 d traces, 50 GB logs, 50 GB metrics free tier | — |
| Anomaly alerts | — | Set up after first dashboards land (currently in Up Next). |
| Continuous-control monitoring tool (Vanta / Drata / Secureframe) | — | Pick one before Type I prep. |

### CC5 — Control Activities

| Control | Evidence | Gaps |
|---|---|---|
| This wiki, the TODO backlogs, the slash-command skills | ✓ | — |
| Quarterly access review | — | Calendar reminder + checklist. |

### CC6 — Logical and Physical Access

The big one. See [[access-control]] for the matrix.

| Control | Evidence | Gaps |
|---|---|---|
| End-user authentication | Passkey-primary, WebAuthn `userVerification: "required"`, sessions C1/C2/C3, step-up tokens | — |
| Service-to-service auth | ARC tokens (ES256, scoped, kid-pinned, revocable, scope-validated on cache hit) | — |
| Production console access | — | **Define + record.** Who has DB / Grafana / Cloudflare / GitHub admin? Quarterly review. |
| MFA on every admin surface | — | Enforce on GitHub, Cloudflare, Grafana, Stripe, registrar. |
| Least-privilege per service account | ARC `allowedScopes` enforced server-side | — |
| Physical access | N/A — all cloud-hosted | — |

### CC7 — System Operations

| Control | Evidence | Gaps |
|---|---|---|
| Incident response runbook | [[breach-response]] (planned) | Write it. |
| Vulnerability scanning of dependencies | `bun audit`-style tool TBD | **Need.** Add `osv-scanner` or `npm audit signatures` in CI. |
| Logging of security events | `security_events` table + observability | — |
| `/health`, `/ready` endpoints | `@shared/observability/elysia` plugin | **`@cire/api` excepted** — does not yet carry `@shared/observability` (no RED metrics, no `/health`, no redacted logger). Tracked exception C-M2. |

### CC8 — Change Management

| Control | Evidence | Gaps |
|---|---|---|
| Branch protection on `main` | GitHub | — |
| Required PR review | GitHub | — |
| Required status checks (lint, fmt, type-check, test) | Turbo + lefthook + CI | — |
| Changesets for every release | Yes — Changeset Check enforced | — |
| Documented release runbook | — | One-page doc; covers rollback. |

### CC9 — Risk Mitigation

| Control | Evidence | Gaps |
|---|---|---|
| Vendor risk assessment | — | One row per processor in [[subprocessors]] with risk score + DPA status. |
| Insurance | — | Cyber + E&O policies before first paying customer. |
| Business continuity | [[backup-dr]] (planned) | Write it. |

### C1 — Confidentiality

| Control | Evidence |
|---|---|
| Encryption in transit | TLS at edge (Cloudflare); ARC over HTTPS S2S |
| Encryption at rest | Platform-level (Cloudflare R2, Supabase Postgres encrypt at rest); document once Supabase migration lands |
| E2E for messages | Signal Protocol w/ PQXDH (planned, Zap M1 hard requirement) |
| Confidential customer data segregation | Per-account DB isolation via FK + service-layer authorisation |

### A1 — Availability

| Control | Evidence | Gaps |
|---|---|---|
| Backup cadence | — | **Define.** Daily DB snapshots + weekly off-region copy. |
| Restore drill | — | Quarterly. |
| RTO / RPO targets | — | RTO 4 h, RPO 24 h initial targets; revisit after first paying customer. |
| Capacity planning | — | Lightweight doc; revisit per dashboard set. |
| Redis fail-open / fail-closed posture | Documented in [[redis]] (rate-limiter fail-closed; rotated-session store fail-open) | — |

### Privacy (P1–P8)

These mirror GDPR + CCPA. See [[gdpr]] and [[ccpa]] for the underlying
obligations; SOC 2 asks "do you do this and can you prove it?".

## Project changes required

Tracked with `C-` IDs in `xchromo/osn-tracker` under `label:compliance`:

1. **Continuous-control monitoring tool** — pick Vanta / Drata / Secureframe before Type I prep. Cost is $7–15k/year and saves months of evidence collection. ID: **C-M4**.
2. **Production access control matrix** — [[access-control]]. ID: **C-M5**.
3. **Backup + DR plan + first restore drill** — [[backup-dr]]. ID: **C-M6**.
4. **Incident response runbook** — [[breach-response]]. Shared with GDPR. ID: **C-M1** (same row).
5. **Dependency CVE scanning in CI** — `osv-scanner` step running on PRs. Fail on critical, warn on high. ID: **C-M7**.

   **Vendored dependencies.** One dependency does not come from a registry and so
   is invisible to a scanner keyed on `bun.lock`: `tools/oxlint/anti-slop` is a
   verbatim copy of [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop),
   MIT licensed (`tools/oxlint/anti-slop/LICENSE`, vendored beside the code),
   pinned to upstream commit `446268e5d15baa968eaec669ff65358d36ae6259`
   (2026-08-14). Upstream publishes no package — the plugin is meant to be copied
   in — so there is no version to resolve, no integrity hash from a registry and
   no advisory feed to subscribe to. Integrity is asserted in-repo instead, by
   three checks that each cover a different failure:
   `tools/oxlint/anti-slop/SHA256SUMS`
   plus `scripts/verify-vendored-anti-slop.sh` catch a change to the tree's
   contents or file set; the same script, given a base ref, also catches a
   change to that tree with no matching change to the pinned commit, which is
   what a self-certifying manifest cannot see; and `.github/CODEOWNERS` puts the
   tree behind a named owner. What none of them do is compare the tree against
   upstream — that claim rests on the pin and on whoever performs the next
   re-vendor. Reviewing the pin is a manual step at each re-vendor, not a
   scheduled control.
6. **`security.txt` + VDP** — public coordinated-disclosure channel + 90-day disclosure clock. ID: **C-M8**.
7. **Quarterly access review** — calendar event + checklist landing in `wiki/compliance/access-reviews/<YYYY>-<Q>.md`. ID: **C-L3**.
8. **Org-level GitHub hardening** — required MFA, required signed commits, branch
   protection, codeowners on prod paths. ID: **C-L4**. **Partly done (2026-08-30):**
   branch protection is ruleset `13921406` (active), and `.github/CODEOWNERS`
   names an owner for the CI wiring, the guard scripts, the files that decide a
   guard runs (`package.json`, `bunfig.toml`, `oxlintrc.json`, `lefthook.yml`),
   the dependency pins (`bun.lock`, `.bun-version`), the vendored plugin tree and
   the five `wrangler.toml`/`wrangler.jsonc` files. **Not yet a gate:** the
   ruleset requires zero approving reviews and no code-owner review, since there
   is one maintainer; required MFA and required signed commits are org settings
   and are unset. Full state and what unblocks each in [[access-control]].
9. **Penetration test** — third-party annual pen-test before Type II. Plan budget. ID: **C-L5**.
10. **Insurance** — cyber + E&O. Quote before first paying customer. ID: **C-L6**.
11. **Cire observability adoption** — `@cire/api` does not yet carry
    `@shared/observability`: no RED metrics, no `/health` / `/ready`, and no
    redacted structured logger. This is a **tracked exception**, not a
    silent gap. **Interim guard:** the cire PII field names + `cire_session`
    are on the log-redaction deny-list (`shared/observability/src/logger/redact.ts`),
    so *if* a cire payload is logged from a service that does use the shared
    logger it is scrubbed — but cire's own logs are unguarded today.
    **Deadline:** adopt before cire handles production guest traffic at scale.
    The Hono→Elysia migration landed 2026-06-12, unblocking the shared
    `@shared/observability/elysia` plugin. ID:
    **C-M2** (cire redaction deny-list + observability exception).

## Who pushes which control to "operating effectively"

| Area | Owner | Cadence |
|---|---|---|
| CC6 access reviews | Platform | Quarterly |
| CC7 incident drills | Platform | Quarterly |
| CC8 release runbook | Platform | Per release |
| CC9 vendor reviews | Platform | Annual + on add |
| C1 encryption posture | Platform | Per Supabase migration milestone |
| A1 backup drills | Platform | Quarterly |
| Privacy DSARs | Identity | Continuous (request-driven) |
