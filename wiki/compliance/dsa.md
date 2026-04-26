---
title: EU Digital Services Act (DSA)
tags: [compliance, dsa, content-moderation]
related:
  - "[[index]]"
  - "[[scope-matrix]]"
  - "[[event-access]]"
  - "[[social-graph]]"
last-reviewed: 2026-04-26
---

# Digital Services Act

The DSA classifies us as a **hosting service** (we host UGC: Pulse events,
Pulse RSVPs, Zap messages, Zap org-chat transcripts, profile content) and
an **online platform** (we connect recipients of the service for events).
We are below the Tier-3 VLOP threshold (45M EU MAU) and below the
medium-platform threshold (50 employees / €10M turnover) — the **micro /
SME exemption** lifts most transparency-reporting and risk-assessment
burdens, but not the operational ones below.

The micro / SME exemption is specifically **Art. 19**, which carves out
the "additional obligations for online platforms" in Section 3 (Arts.
20–28) for enterprises meeting the Recommendation 2003/361/EC employee /
turnover thresholds. It does **not** exempt the operational obligations
of Arts. 11–18 (Section 1 + 2), and Art. 15 transparency reporting for
hosting services should be confirmed with counsel before relying on the
exemption — the language is narrower than commonly summarised.

## Always-on obligations (no SME exemption)

| Article | Obligation | Status | Action |
|---|---|---|---|
| Art. 11 | Single point of contact for authorities | **Gap** | Designate; publish on `@osn/landing/legal/dsa-contact`. |
| Art. 12 | Single point of contact for recipients (users) | **Gap** | Email alias `dsa@osn.example` + `@osn/social` Settings link. |
| Art. 13 | Designated EU legal representative if not established in EU | **Conditional** | Required if we end up incorporated outside the EU. Decision deferred. |
| Art. 14 | ToS in clear, plain language; explain content moderation rules, recourse, algorithmic recommendation criteria | **Gap** | Draft ToS lives at `wiki/compliance/legal-drafts/tos.md`; published copy at `osn/landing/src/pages/legal/tos.astro`. |
| Art. 15 | Annual transparency report (content moderation actions, response times, resources) | **SME-exempt scope to confirm** — Art. 19 exempts Section 3 (Arts. 20–28) but the Art. 15 hosting-services report is in Section 2 and may still apply. | Confirm with counsel pre-launch. Collect the data either way (see C-L10). |
| Art. 16 | Notice-and-action mechanism — anyone can report illegal content with the prescribed minimum information; we must process timely + diligently | **Gap** | Build `POST /reports` (Pulse + Zap) with the Art. 16 schema. |
| Art. 17 | Statement of reasons — for every restriction (post removal, account suspension, demotion, RSVP rejection by host, etc.), we provide a structured explanation to the affected user | **Gap** | Build `moderation_actions` table + email template. |
| Art. 18 | Notification of suspicions of criminal offences threatening life / safety to law enforcement | **Gap** | Add to [[breach-response]] with named legal contact. |
| Art. 20 | Internal complaint-handling system — appeal mechanism free of charge for at least 6 months | **Gap** | Build `POST /moderation/appeals`; route to a human reviewer. |
| Art. 21 | Out-of-court dispute settlement — right of users to escalate to certified bodies | **Gap** | List options in ToS; no system change. |
| Art. 22 | Trusted flaggers — priority handling for accredited flaggers | **Gap** | Tag-based queue priority in moderation tooling. |
| Art. 23 | Misuse — suspend users / flaggers who repeatedly post manifestly illegal content / file unfounded notices | **Gap** | Strike-system in moderation tooling. |
| Art. 24 | Transparency reporting (online platforms specifically) | **SME-exempt per Art. 19** (Section 3 carve-out) | Skip until threshold; data collected anyway via C-L10. |
| Art. 25 | No "dark patterns" in interface design that distort autonomous choice | **Continuous** | Cover in design review checklist. |
| Art. 26 | Online advertising transparency — show "ad", who paid, parameters used | **N/A today** | Activate when "promoted events" lands. |
| Art. 27 | Recommender system transparency — main parameters disclosed in ToS | **Gap** | Pulse discovery uses friends + location + recency; Zap has no recommender; document in ToS. |
| Art. 28 | Online protection of minors — proportionate measures; no targeted ads to known minors | We hard-gate <13. Add: no "promoted events" to known 13–17 if/when ads land. | — |
| Art. 30 | Trader traceability — collect + verify identity of traders dealing with consumers via the platform | **Gap** | Verified-organisation flow in Zap M3 must capture: name, address, phone, email, registration ID, self-declaration of compliance. Block trader from interacting until verified. |
| Art. 31 | Compliance by design when the platform allows traders to conclude distance contracts | **N/A today** | Activate with paid Pulse ticketing. |
| Art. 32 | Right of recipients to request information about a specific trader | **Gap** | `GET /organisations/:handle/dsa-info` exposing the Art. 30 record. |

## Project changes required

Tracked with `C-` IDs:

1. **Notice-and-action endpoint** — `POST /reports` accepting the Art. 16 minimum schema (sufficiently substantiated explanation, exact electronic location of the content, name + email of the notifier unless trafficking / abuse exception, statement of good-faith belief). Lands in both `@pulse/api` and `@zap/api` with a shared `@shared/moderation` package. ID: **C-H6**.
2. **Statement of reasons system** — `moderation_actions` table + email template + `GET /account/moderation-actions` for the affected user. ID: **C-H7**.
3. **DSA points of contact + ToS draft** — public pages on `@osn/landing`. ID: **C-M10**.
4. **Internal complaint / appeal endpoint** — `POST /moderation/appeals`. ID: **C-M11**.
5. **Trader-traceability flow** in Zap M3 verification. ID: **C-M12** (built as part of Zap M3 spec).
6. **Recommender-transparency disclosure** in ToS — Pulse discovery factors documented in plain language. ID: **C-L8**.
7. **Strike system + misuse safeguards** — counter on accounts; auto-suspend at threshold; auto-rate-limit unfounded reporters. ID: **C-L9**.
8. **Annual transparency report scaffold** — collect the data even while SME-exempt; ready to publish if threshold crossed. ID: **C-L10**.

## Out of scope today

- **Crisis-response mechanism** (Art. 36) — VLOPs only.
- **Risk assessment + audit** (Art. 34, 37) — VLOPs only.
- **Researcher data access** (Art. 40) — VLOPs only.
- **Compliance officer** (Art. 41) — VLOPs only.
- **Supervisory fee** (Art. 43) — VLOPs only.
