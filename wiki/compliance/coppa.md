---
title: COPPA — Under-13 protection
tags: [compliance, coppa, minors]
related:
  - "[[index]]"
  - "[[scope-matrix]]"
  - "[[identity-model]]"
  - "[[cire]]"
last-reviewed: 2026-07-22
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

This is the "actual knowledge" defence the FTC tolerates (16 CFR §312.2). It
puts us out of scope for COPPA's substantive obligations (verifiable
parental consent, parental review, data minimisation specific to children,
etc.).

## Cire (wedding invites) — household-mediated, no separate gate (C-L1)

Cire's guest flow does not create accounts and collects no date of birth.
Claim codes are issued to **households** by the organiser, and the guest
site is a general-adult-audience wedding page. There is no direct
child-signup surface, so cire needs **no cire-specific age gate**; it folds
into the platform-wide age-gate rollout (C-H8) if/when a guest flow ever
gains a signup. Light-touch by design — noted here so nobody forgets it,
not because it needs work today. See [[data-map]] (cire section) and [[cire]].

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

1. **Date-of-birth field on registration** — TypeBox `birthdate: Date` schema; validate ≥13 years before today; reject before email OTP send. ID: **C-H8**. ✅ **Shipped (2026-07-07).** `/register/begin` now requires `birthdate` (`YYYY-MM-DD`); `beginRegistration` validates format (`BirthdateSchema`) then hard-rejects under-13 via `AgeRestrictionError` → HTTP 422 `{ error: "age_restricted", message: "OSN is for users 13 and older" }`, **before** any collision probe or OTP send. The birthdate is a transient function argument — never written to any store or table (no rejected/accepted DOB retained). Client mirrors the gate for UX (`osn/ui` `Register.tsx`); server is authoritative. The legacy test/seed-only `registerProfile` is unrouted and intentionally ungated.
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
moves this way.
