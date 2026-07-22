---
title: DSAR Runbook (Access, Erasure, Rectification, Portability)
tags: [compliance, gdpr, ccpa, dsar, runbook]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[ccpa]]"
  - "[[data-map]]"
  - "[[retention]]"
  - "[[cire]]"
  - "[[cire-auth]]"
last-reviewed: 2026-07-22
---

# DSAR Runbook

How OSN handles a **Data Subject Access Request** (GDPR Arts. 15, 16, 17,
18, 20, 21) or a **Verifiable Consumer Request** (CCPA / state laws). One
runbook, two regimes, because the operational steps overlap.

## Endpoints and entry points

| Channel | Who uses it | Where it lands | SLA |
|---|---|---|---|
| `GET /account/export` (**shipped** C-H1) | The account holder, self-service | `@osn/api` — streams NDJSON | Immediate |
| `DELETE /account` (osn-api, C-H2) | The account holder, self-service | `@osn/api` — soft delete, then hard delete in 7 d | 7 d |
| `DELETE /account` (pulse-api, Flow B) | Leave Pulse without losing OSN | `@pulse/api` — soft delete + hosted-event 14-day cancellation window | 7 d (account) / 14 d (events) |
| `dsar@osn.example` (planned, alias on landing) | Anyone via email | Identity team inbox | 30 d (GDPR) / 45 d (CCPA) |
| Postal address (planned, on landing) | Anyone via mail | Identity team inbox | Same |
| Authorised agent | Third party with notarised authority | Same email + verification | Same; verification adds days, log it |

## Step-by-step for a written request

1. **Acknowledge within 72 hours** — automated reply confirming receipt and the response deadline.
2. **Identify the regime** — GDPR if EU/UK; CCPA + state laws if US-resident; treat unclear cases as both (apply the stricter rule).
3. **Verify identity** — for the account holder using the in-app endpoints, the bearer token + step-up token verifies them. For email/postal:
   - First test: email-controlled OTP to the email on file.
   - If that fails (e.g. user has lost the email): require step-up via a recovery code, OR a notarised statement of identity, OR proof of association (last login IP region, recent profile activity).
   - **Do not** require government ID for a basic DSAR — over-collection.
4. **Verify scope** — the request must specify the right exercised. "I want my data" = Art. 15 (access). "I want it deleted" = Art. 17. "I want it sent to Acme" = Art. 20 (portability). Document the inferred scope back to the requester before acting.
5. **Authorised agent path** — verify notarised power-of-attorney + the underlying user's identity per step 3. CCPA also allows the user to confirm directly.
6. **Execute** — see "Per-right execution" below.
7. **Respond** — include what was provided / deleted, the format, the lawful basis to refuse anything refused (see "Refusals"), and the right to lodge a complaint with a supervisory authority (GDPR Art. 77 — list the relevant DPA based on user's residence).
8. **Log** — add a row to `dsar_requests` (planned table) including: opened, closed, regime, right exercised, decisions, evidence path. Retain 24 months (CCPA min).

## Per-right execution

### Art. 15 — Right of access

Status: **shipped** (C-H1, 2026-07-07). `GET /account/export` — bearer +
`x-step-up-token` (purpose `account_export`) gated, 1 export / 24 h / account,
streams the NDJSON bundle below. Implementation: `osn/api/src/routes/account-export.ts`
+ `osn/api/src/services/account-export.ts`; the `pulse.*` / `zap.*` sections are
fetched over ARC (scope `account:export`) from each app's
`POST /internal/account-export` and streamed through line-by-line, degrading to a
`{"degraded":...}` line if a bridge fails. Building Zap's inbound-ARC stack for
this also closed the gap where Zap had no `/internal` ARC surface.

Use `GET /account/export`. The endpoint returns a JSON bundle:

- `account` — explicit field list: `email`, `passkey_user_id`, `max_profiles`, `created_at`, `updated_at`. **Never includes the internal `accountId`** per the [[identity-model]] privacy invariant — `accountId` is the multi-account correlation key and must not appear in any API response, even one served to the account holder.
- `profiles[]` — rows from `users` for this account.
- `passkeys[]` — `id`, `label`, `aaguid`, `backup_eligible`, `backup_state`, `last_used_at`, `created_at`. **Not** `credentialId` or `publicKey` — those have no value to the user and could leak in transport.
- `sessions[]` — `ua_label`, `ip_hash` (raw, not the public 16-hex handle), `last_used_at`, `created_at`. Note: `ip_hash` is HMAC-peppered; we cannot reverse to an IP.
- `security_events[]` — kind, metadata, created_at, acknowledged_at.
- `recovery_codes` — `total`, `used` (counts only; never the hashes).
- `email_changes[]` — old / new email, timestamp.
- `connections[]` — requester / addressee handles + status + timestamps.
- `blocks[]` — blocked handles + timestamps.
- `organisations[]` — orgs the account's profiles own or are members of.
- `pulse.rsvps[]` — fetched via ARC from `@pulse/api`. Status, event title (if visible to the requester), timestamps.
- `pulse.events_hosted[]` — events created by the account's profiles.
- `pulse.close_friends[]`.
- `zap.chats[]` — chat ids, role, joined-at. **Message content is excluded** because it is E2E-encrypted and we cannot decrypt; the user's local Zap client can export the decrypted history separately.
- `consents[]` — once consent records ship (C-L1).
- `dsar_requests[]` — prior requests for this user.

**Wire format (locked before C-H1 implementation starts):**

- **NDJSON envelope** — one JSON object per line, prefixed by a header line `{"version":1,"sections":[...]}` and terminated by `{"end":true}`. This lets the response stream via `ReadableStream` without ever holding the full bundle in memory.
- **Per-section keyset pagination** — every multi-row section (`security_events`, `sessions`, `connections`, `pulse.rsvps`, `pulse.events_hosted`, `zap.chats`) is fetched in batches of `LIMIT 500` ordered by `id` with `WHERE id > :cursor`. No `OFFSET` (degrades on large tables).
- **ARC fan-out sub-bundles streamed** — `pulse.*` and `zap.*` sections are fetched via ARC and re-serialised line-by-line into the outer NDJSON; the bridge call uses chunked transfer too (see P-W2 below).
- **Memory budget** — ≤32 MB resident per export. A run that exceeds the budget logs a warning + truncates with a tombstone record, so the user gets a partial bundle + a notice rather than an OOM.

Auth: bearer access token + step-up token. Rate-limit: 1 export per 24 h per account.

### Art. 16 — Rectification

Most fields are user-editable in `@osn/social` (handle change, displayName, avatar, email change). For non-editable fields (security_events metadata, sessions ua_label) — these are observed facts, not user-supplied data; rectification right is narrower under GDPR Recital 65 ("inaccuracy" must be the data itself). Document the refusal under "Refusals" if challenged.

### Art. 17 — Right of erasure

Status: **shipped** (C-H2). Two flows:

- **Flow A — full OSN account delete.** `DELETE /account` on osn-api. Soft-deletes the account, fans out to currently-enrolled apps via ARC, hard-deletes after the 7-day grace window via `account-erasure.runHardDeleteSweep`.
- **Flow B — per-app delete (leave Pulse).** `DELETE /account` on pulse-api. Soft-deletes the user's Pulse-scoped data; hosted public events get a 14-day public-cancellation window (audience-commitment, independent of the account grace) before being hard-deleted. Pulse calls back to osn-api `/internal/app-enrollment/leave` to flip `app_enrollments.left_at`. The OSN account stays alive — the user can keep using Zap / OSN identity.

Use `DELETE /account`. Two-phase:

1. **Soft delete** — sets `accounts.deleted_at`, immediately invalidates all sessions, redacts handles to `deleted_<id>`, blocks new logins. Returns 202.
2. **Hard delete** after 7 days unless the user re-authenticates (recovery flow). Cascade includes:
   - All rows in `osn/db` referencing the account (via existing FK cascade or explicit deletes in the deletion service).
   - ARC fan-out to `@pulse/api/internal/account-deleted` and `@zap/api/internal/account-deleted` — Pulse hard-deletes RSVPs / events / close-friends entries; Zap revokes chat memberships, replaces sender_id with a deletion sentinel in retained ciphertext (we cannot decrypt, but participants can still read).
   - Backups remain until next rotation cycle (document in privacy notice).
   - Grafana logs: redacted at write time, no PII to scrub. Trace and metric retention windows handle the rest.

Tombstone (deletion sentinel) retained 30 days then purged.

**Fan-out reliability (locked before C-H2 implementation starts):**

- **`deletion_jobs` table** — one row per soft-delete, with columns `account_id`, `soft_deleted_at`, `pulse_done_at`, `zap_done_at`, `hard_delete_at` (= `soft_deleted_at + 7 d`). The hard-delete sweeper refuses to fire until both `*_done_at` columns are non-null.
- **Idempotent per-bridge** — `@pulse/api/internal/account-deleted` and `@zap/api/internal/account-deleted` accept the same `accountId` repeatedly; second call is a no-op. The C-M15 sweeper retries failed bridges every cycle until the row clears.
- **Parallel fan-out** — `Effect.all([pulseCall, zapCall], { concurrency: "unbounded" })` with a per-bridge timeout of 10 s. A failing bridge does not block the soft-delete (which already returned 202); it just leaves the job row partially complete for the sweeper to retry.
- **Per-bridge ARC rate-limit budget** — the deletion endpoints must be exempted from the standard ARC rate limit, OR sized to absorb a mass-deletion event without throttling. Pre-merge: agree on a 100 req/s ceiling per bridge with ARC token tagged `scope: "account-deletion"`.

The export path uses the same `Effect.all` parallelism + 10 s per-bridge timeout. A failing bridge during export emits a partial bundle with a `{"degraded":"pulse|zap","reason":"..."}` line so the user can see the gap and re-request later.

#### Cire (wedding-invite) data — cross-DB, no fan-out yet (C-M1)

Cire runs its **own** Cloudflare D1 + R2, separate from `osn/db` (see
[[cire]], [[cire-auth]]). The wedding and its guest data are linked to the
organiser's OSN account only by `weddings.owner_osn_profile_id` — an opaque
profile-id string with **no cross-DB FK**. Two consequences:

- **DSAR reachability (Art. 15 / 17 / 20).** A DSAR from the *organiser*
  reaches their cire data via that `owner_osn_profile_id`: export/erasure can
  query cire's D1 for the weddings they own, the `families` / `guests` /
  `rsvps` / `imports` rows under them, and the R2 `cire-sheets` CSVs.
  This needs an ARC bridge to `@cire/api` that mirrors the
  pulse/zap pattern — **not built yet** (cire/api has no
  `internal/account-deleted` or export endpoint, and does not carry
  `@shared/observability`). Until it exists, an operator with cire D1/R2
  access handles such a DSAR **manually** (logged per [[access-control]]).
- **Guest DSARs.** Guests are not OSN account holders; a guest exercising a
  right is the organiser's responsibility as **controller** (cire is
  processor — see [[data-map]]). Route guest requests to the organiser and
  assist as processor.

**Cross-DB deletion orphan — decision: orphan-tolerance (for now).** Nothing
fans OSN-account deletion out into cire. Erasing an OSN account today
therefore **orphans** the wedding + guest data in cire's D1/R2, and the
planned `GET /account/export` / `DELETE /account` cannot reach it. We had two
options: (a) build the ARC fan-out into cire now, or (b)
document an orphan-tolerance rationale and revisit. **We choose (b)** because
there is no `DELETE /account` endpoint to hook yet, and the orphan-tolerance
framing is defensible on the merits:

- A wedding is a **jointly-owned record with its own lifecycle** — it
  belongs as much to the couple's event as to one organiser's OSN login.
  Tearing it down because one owner deletes their OSN account would destroy
  the other party's record and every guest's RSVP.
- Guest data is **organiser-controlled** (cire is processor); the controller
  obligation to erase it survives the organiser's OSN-account deletion and is
  discharged through the organiser, not by cascading from OSN identity.

**Recorded decision.** Orphan-tolerance is the interim position. It is
**revisited when `DELETE /account` lands** (planned C-H2): at that point we
either (i) add a cire ARC bridge so deletion fans out, or (ii) re-affirm
orphan-tolerance with a privacy-notice disclosure that wedding/guest records
persist independently of the organiser's OSN account. Tracked as **C-M1**
(below).

**Refusals permitted** under Art. 17(3):

- Legal-obligation retention (e.g. Pulse ticketing receipts under tax law — once paid Pulse ticketing lands).
- Establishment / exercise / defence of legal claims (open dispute, abuse-report under investigation).
- Public-interest archiving (N/A here).

Document refusals in the response with the specific exemption.

### Art. 18 — Restriction of processing

Sets `accounts.processing_restricted_at` (planned column with C-H2). Effect: account cannot post events, send messages, accept connections, but data is preserved. Used pending dispute.

### Art. 20 — Portability

Same `GET /account/export` JSON bundle. Format is machine-readable + commonly used. Per Art. 20(2), where technically feasible, we will offer direct transmission to another controller — defer this until requested in practice; not mandatory under "technically feasible" if no industry-standard receiver exists.

### Art. 21 — Right to object

Today: no marketing email, no LI-based processing of individuals beyond
fraud detection and security. Objection to fraud detection / security =
account suspension (we cannot serve the user without those). Document.

If a marketing channel ever lands (e.g. event-host newsletter from
Pulse), this becomes operational: object → flag account → exclude from
future sends.

## Refusals

When refusing in whole or part, the response must:

- Identify the request and the refused part.
- State the exemption with the article reference.
- Inform of right to complain to the supervisory authority (list relevant DPA with contact link).
- Inform of right to a judicial remedy.
- Be sent within the same 30 / 45 day deadline as a positive response.

Refusals get logged in `dsar_requests` with `decision: refused` + `exemption: <article>`.

## Verification thresholds for "manifestly unfounded or excessive"

Per GDPR Art. 12(5), we may charge a reasonable fee or refuse if a request is manifestly unfounded or excessive. In practice:

- Repeated identical request <30 d after the prior — refuse OR charge.
- Request that requires disproportionate effort relative to benefit — limited grounds; document carefully.
- Request submitted to harass (threats, automation) — refuse.

Default position: do the work. Refusals are exceptional and have to survive a DPA challenge.

## Escalation

| Trigger | Action |
|---|---|
| Request from a minor's parent | Treat as legitimate; verify per COPPA process. |
| Request invokes "right to be forgotten" against indexed search engines | Out of scope (we are not the search engine); inform requester. |
| Request claims breach has occurred | Treat as breach notification; trigger [[breach-response]]. |
| Authority subpoena vs DSAR | Different flow; route to legal counsel. |

## Project changes required

Tracked with `C-` IDs, all rolled up under **C-M1** (DSAR runbook):

1. `dsar_requests` table for audit log.
2. `dsar@osn.example` email alias + automated acknowledgement.
3. Postal address published on `@osn/landing` legal page.
4. Internal triage doc with the team rotation.
5. SLA monitoring (alert when a request is >25 d unresponded).
6. **Cire DSAR reachability + deletion fan-out** — ARC bridge to `@cire/api`
   for organiser-scoped export/erasure of cire D1 + R2 data, mirroring the
   pulse/zap `internal/account-deleted` + export pattern. Until built, cire
   DSARs are manual. **Decision: orphan-tolerance** for OSN-account deletion
   (see "Cire data" above) — revisit when `DELETE /account` (C-H2) lands.
