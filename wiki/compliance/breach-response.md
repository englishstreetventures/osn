---
title: Breach Response Runbook
tags: [compliance, gdpr, soc2, runbook, incident]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[soc2]]"
  - "[[subprocessors]]"
  - "[[runbooks/auth-failure]]"
last-reviewed: 2026-04-26
---

# Breach Response

What to do when a personal-data breach happens. Required by GDPR Arts.
33 + 34 (notification clocks), SOC 2 CC7 (incident response), and CCPA
§1798.82 (California breach notification statute).

## Detection sources

| Source | Channel |
|---|---|
| OTel anomaly alerts | Grafana on-call rotation (planned) |
| Vendor breach notification | DPA-mandated channel from each processor |
| Researcher disclosure | `security@osn.example` + `/.well-known/security.txt` (planned C-M8) |
| User report | `dsar@osn.example` mentioning "breach" |
| Internal discovery | Engineering team `#sev` channel |

## The 72-hour clock

GDPR Art. 33: notify the supervisory authority **within 72 hours** of
becoming aware of a personal-data breach, unless the breach is unlikely
to result in a risk to rights and freedoms. The clock starts when we
have reasonable certainty that a breach has occurred — investigation
time counts.

CCPA: notify affected California residents "in the most expedient time
possible and without unreasonable delay". No fixed clock, but DPAs
benchmark against the GDPR 72 h.

State laws (most): 30–60 days from discovery, with notice to state AG above
threshold counts.

## Severity classification

| Level | Criteria | Response |
|---|---|---|
| **SEV-1** — Confirmed exposure of plaintext credentials, large-scale PII, or message content | "Plaintext refresh tokens leaked", "Profile email + password reset tokens posted publicly", "Unencrypted message body retrieved by unauthorised party" | All hands; full GDPR + CCPA notification; consider service shutdown |
| **SEV-2** — Confirmed exposure of hashed credentials, IP-derived metadata, or profile graph | "Hashed sessions table exfil", "ip_hash column copied", "connection edges exposed" | DPO + identity team; GDPR notification; risk-assessment to determine user notification |
| **SEV-3** — Confirmed control failure with no confirmed exposure | "ARC kid not rotated for 60 d", "rate limiter fail-open observed", "redaction missed a field but logs already purged" | Internal-only; remediate; document; report in next monthly review |
| **SEV-4** — Vendor breach with potential downstream impact | "Cloudflare disclosed breach affecting Email Service" | Validate scope per their notice; act on subset of users affected |

## Step-by-step

### 0–1 hour: triage

1. Open an incident in `wiki/compliance/incidents/<YYYYMMDD>-<slug>.md` from the template below.
2. Page the on-call (`#sev`).
3. Designate Incident Commander (IC) and Scribe.
4. Snapshot evidence: queries, log excerpts (redacted), tracer screenshots, chat threads.
5. **Stop the bleeding** — revoke compromised tokens, rotate keys, take affected service offline if SEV-1.

### 1–24 hours: contain + assess

6. Determine **scope** — which records, which users, which services. Use [[data-map]] to enumerate downstream consequences.
7. Determine **impact** — what could a competent attacker do with the data? Drives SEV.
8. Determine **likelihood of harm** — Recital 75 factors (identity theft, financial loss, discrimination, reputational damage, loss of confidentiality, etc.). Drives Art. 34 user-notification decision.
9. Update incident doc with scope + impact + likelihood.
10. Notify processors per their DPA if our breach involves their data path.

### 24–72 hours: notify

11. **GDPR Art. 33** — file with the lead supervisory authority (the one for our establishment). Information to include:
    - Nature of breach including categories + approximate number of data subjects + record count.
    - Name + contact details of DPO.
    - Likely consequences.
    - Measures taken or proposed.
12. **CCPA** — coordinate with state AG if California residents affected and threshold count met.
13. **State AGs** — per state-by-state thresholds (most 500 records of state residents).
14. **Customers (Zap M3 controllers)** — per their DPA, typically ≤24 h. We are processor in that flow.

### 72 hours – 30 days: communicate to data subjects

15. **GDPR Art. 34** — notify data subjects without undue delay if the breach is likely to result in a high risk to their rights and freedoms. Channel: in-app banner + email. Content: plain language, nature of breach, likely consequences, measures taken, contact for questions.
16. **CCPA / state laws** — notify in the most expedient time possible. Same channel.
17. Skip Art. 34 only if Art. 34(3) applies (encrypted data + key not compromised, OR subsequent measures eliminate risk, OR disproportionate effort + public communication used).

### Post-incident

18. Postmortem within 7 days. Blame-free; focus on systemic prevention.
19. Add findings to security backlog with `S-` IDs.
20. Update wiki pages affected.
21. Run a tabletop exercise within 30 days to validate the lesson.

## Incident doc template

```markdown
---
title: Incident <YYYY-MM-DD> — <slug>
tags: [compliance, incident]
sev: 1 | 2 | 3 | 4
opened-at: 2026-04-26T10:30Z
closed-at:
ic:
scribe:
last-reviewed: 2026-04-26
---

## Summary

(One paragraph for the executive reader.)

## Timeline

| UTC time | Actor | Action / observation |
|---|---|---|

## Scope

- Records affected:
- Users affected:
- Data classes:
- Services affected:

## Impact

(What can the attacker do with the data?)

## Likelihood of harm

(Recital 75 factors. Drives Art. 34 decision.)

## Notifications

- [ ] DPO informed
- [ ] Lead SA notified — date + reference
- [ ] Affected processors notified — list
- [ ] Customer-controllers notified (Zap M3) — list
- [ ] State AGs notified — list
- [ ] Data subjects notified — channel + count
- [ ] security.txt advisory published

## Containment + remediation

(What we did, in order.)

## Postmortem

(After incident closed: what allowed this, what changes prevent recurrence.)
```

## Project changes required

Tracked with `C-` IDs:

1. **DPO designation** + named on `@osn/landing/legal/contact`. ID: **C-L2** (also in [[gdpr]]).
2. **`security.txt` + VDP** for researcher disclosure. ID: **C-M8** (also in [[soc2]]).
3. **Lead supervisory authority decision** — determined by where we are established. Document on this page once known.
4. **Cyber insurance** — claim contact must be listed in this runbook. ID: **C-L6**.
5. **Tabletop drill** — annual; document under `wiki/compliance/incidents/drills/`.
6. **Vendor notification SLA tracking** — verify each DPA (per [[subprocessors]]) commits to ≤24 h breach notification to us; chase any that don't.
