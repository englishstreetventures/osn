---
title: EU ePrivacy Directive (Cookie Law)
tags: [compliance, eprivacy, cookies, consent]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[scope-matrix]]"
  - "[[sessions]]"
last-reviewed: 2026-04-26
---

# ePrivacy Directive

EU Directive 2002/58/EC ("Cookie Law"), as transposed by each member
state. Sits alongside GDPR — GDPR governs the processing of the personal
data once read; ePrivacy governs the **act of reading or writing on the
user's device** (cookies, localStorage, fingerprinting, SDKs).

## OSN posture

We are compliant **by absence**: we set exactly one first-party cookie
(`osn_session`, HttpOnly, Secure, SameSite=Lax, refresh token) which is
**strictly necessary** for authentication. ePrivacy Art. 5(3) exempts
strictly-necessary storage from the consent requirement. The same
exemption covers the `localStorage` access-token storage (also strictly
necessary for the authenticated session).

**Stay this way.** Adding any of the following flips us into "consent
required" and will need a banner before deploy:

- Analytics (GA, Plausible, Fathom, PostHog, Pirsch, etc. — even self-hosted, even server-side).
- Marketing pixels (Meta, X, LinkedIn, TikTok, Google Ads).
- A / B testing tools that persist a variant ID.
- Heatmap / session recording (Hotjar, FullStory, Clarity).
- Embed widgets that set their own cookies (YouTube, X embeds, Stripe Elements outside checkout).
- Any third-party SDK that fingerprints (CDN-hosted scripts that touch `navigator.userAgent` count).

## What "strictly necessary" means

Per the EDPB Guidelines 2/2023:

- The cookie must be **necessary** for a service the user explicitly requested.
- "We need it to make the service work" is acceptable.
- "We need it to improve the service" is not acceptable — that requires consent.
- Aggregated, no-PII analytics may be granted "necessary" status by
  some DPAs (CNIL has published a list); never assume — get legal sign-off.

## What we currently set

| Storage | Type | Necessary? | Notes |
|---|---|---|---|
| `osn_session` cookie | HttpOnly, Secure, SameSite=Lax, Path=/, refresh token | ✓ Strictly necessary for authenticated session | First-party only. |
| `localStorage:@osn/client:account_session` | Profile-scoped access tokens, active profile id | ✓ Strictly necessary | First-party only. 5-min TTL caps blast radius. |
| `localStorage:@pulse/app:*` (theme, last-tab, draft-event) | UX state | Borderline — request-driven UX state, generally accepted as exempt under "user-friendly design" tests | Document on the privacy notice anyway. |
| Tauri OS keychain (planned) | Refresh / session tokens on native | ✓ Strictly necessary | iOS Keychain / Android Keystore equivalent. |

## Project changes required

Tracked with `C-` IDs:

1. **Cookie + storage inventory** in the privacy notice — the table above, in plain language. ID: rolled into **C-H4**.
2. **Lint rule against new third-party scripts** — pre-commit hook fails if any HTML / Astro template references a script tag with a non-OSN origin. Forces explicit decision. ID: **C-L18**.
3. **CSP `connect-src` audit** — Pulse Tauri CSP has a transitional `https:` entry (S-L3-follow-up); pin to known origins so no hidden third-party requests can fire. Also covers ePrivacy. ID: rolled into existing S-L3.
4. **Banner scaffold** in `@osn/landing` — built but not mounted; mounting requires a code change + DPO sign-off. Forces deliberate decision the day someone wants to add an analytics tag. ID: **C-L19**.
