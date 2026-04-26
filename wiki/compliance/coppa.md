---
title: COPPA — Under-13 protection
tags: [compliance, coppa, minors]
related:
  - "[[index]]"
  - "[[scope-matrix]]"
  - "[[identity-model]]"
last-reviewed: 2026-04-26
---

# COPPA

US federal law (Children's Online Privacy Protection Act). Applies to
operators of online services directed to children under 13, OR with
**actual knowledge** of collecting personal information from children
under 13. Penalty: up to $51,744 per violation (per child) as of 2024.

## OSN posture: hard gate, no under-13 accounts

OSN is a general-audience social platform. Pulse / Zap / OSN Core all rely
on adult-style social interactions (event hosting, organisation chats,
passkey enrollment) that we are not designing for under-13 use. The
compliant strategy is therefore the **hard age gate at registration**:

- Registration form requires a date of birth.
- Server-side check rejects under-13 with HTTP 422 + a generic "OSN is for users 13 and older" message.
- No retry persistence — the rejected registration leaves no row in the DB.
- The age gate appears **once**, before any personal information is collected, so we never have actual knowledge of a child's data.

This is the FTC-blessed "actual knowledge" defense (16 CFR §312.2). It
puts us out of scope for COPPA's substantive obligations (verifiable
parental consent, parental review, data minimisation specific to children,
etc.).

## What we must not do

- **Do not market or design** for under-13 audiences. UI copy, mascots,
  illustrations, advertising channels — all must read as adult/general.
- **Do not require** a date that bypasses the gate (the user typing
  "1990" when actually 12 is the user's misrepresentation, not our knowledge).
- **Do not retain** the rejected DOB beyond the short-lived submission.
- **Do not allow** a user who reveals via support / chat that they are
  under 13 to remain on the platform — terminate + delete the account.

## Project changes required

Tracked with `C-` IDs:

1. **Date-of-birth field on registration** — TypeBox `birthdate: Date` schema; validate ≥13 years before today; reject before email OTP send. ID: **C-H8**.
2. **"Under-13 detected" account-deletion runbook** — when support discovers a minor account, immediate delete + parent notification. ID: **C-M13**.
3. **Annual COPPA self-assessment** — short doc, 30 minutes, confirms the design has not drifted toward a child audience. ID: **C-L11**.

## What changes if we ever target under-13 users

(We have no plan to.) The minimum surface would include:

- FTC-approved verifiable parental consent (credit card $0.10 charge, signed form, video conference, knowledge-based authentication, etc.).
- Parental access + delete portal.
- Children-specific privacy notice, separate from the general one.
- No behavioural advertising to known children.
- Data-minimisation review per data point (no nice-to-haves).

This would be a major engineering investment; flag any feature spec that
trends in this direction.
