---
title: EU ePrivacy Directive (Cookie Law)
tags: [compliance, eprivacy, cookies, consent]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[scope-matrix]]"
  - "[[sessions]]"
  - "[[cire-auth]]"
  - "[[cire-consent]]"
last-reviewed: 2026-10-20
---

# EU ePrivacy Directive (Cookie Law)

EU Directive 2002/58/EC ("Cookie Law"), as transposed by each member
state. Sits alongside GDPR — GDPR governs the processing of the personal
data once read; ePrivacy governs the **act of reading or writing on the
user's device** (cookies, localStorage, fingerprinting, SDKs).

## OSN posture

We are compliant **by absence**: ePrivacy Art. 5(3) exempts storage that
is **strictly necessary** for a service the user asked for, such as the
session cookie that keeps a user signed in, from the consent requirement.
[What we currently set](#what-we-currently-set) gives the basis for each
item we have assessed.

**Stay this way.** Each of the following moves us into "consent
required" and needs a consent banner before deploy:

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
- Some DPAs may grant "necessary" status to aggregated analytics that hold
  no PII (CNIL has published a list); never assume — get legal sign-off.

## What we currently set

| Storage | Attributes, lifetime, contents | Necessary? | Set, cleared and why |
|---|---|---|---|
| `osn_session` cookie | HttpOnly, Secure, SameSite=Lax, Path=/, refresh token | ✓ Strictly necessary for authenticated session | First-party only. |
| `cire_claimed` cookie (cire guest site) | First-party, not HttpOnly, Path=/, SameSite=Lax (Secure over HTTPS); Max-Age 30 days; value `1`, or `plus-one` when the claim showed the plus-one prompt | ✓ Strictly necessary: it serves the invite the guest opened | Written by the guest site on a successful claim, cleared on sign-out. Carries no authority. Without it a returning household's invite does not reopen: the page skips the session restore and asks for the code again, and the gift list shows them signed out. It also spares first-time visitors a request that could only answer 401, and says whether to load the plus-one prompt's code early ([[cire-auth]]). |
| `cire_session` cookie (cire guest site) | Host-only on the cire-api host (no `Domain`), HttpOnly, SameSite=Lax, Path=/ (Secure over HTTPS); Max-Age 30 days; opaque session token | ✓ Strictly necessary: the guest's signed-in invite session | Set by cire-api on a successful claim (`POST /api/claim`), replaced with a fresh token when the guest links an account, cleared on sign-out or when the session turns out dead ([[cire-auth]]). |
| `cire_org_session` cookie (cire host portal, vendor portal, and a guest who links an account) | Host-only on the cire-api host (no `Domain`), HttpOnly, SameSite=Lax, Path=/ (Secure over HTTPS); Max-Age 7 days; opaque session token | ✓ Strictly necessary: the signed-in organiser or vendor session | Set by cire-api's callback after an OSN sign-in (`/api/auth/oidc/callback`), cleared on sign-out ([[cire-auth]]). |
| `cire_oidc_tx` cookie (wherever a cire sign-in starts) | Host-only on the cire-api host (no `Domain`), HttpOnly, SameSite=Lax, Path=/ (Secure over HTTPS); Max-Age 10 minutes; signed sign-in state: `state`, nonce, PKCE verifier, return address | ✓ Strictly necessary: it completes the sign-in the user started | Set by cire-api when sign-in starts (`/api/auth/oidc/start`), cleared by the callback whether the sign-in succeeds or fails; an abandoned sign-in leaves it to expire. |
| `__Host-cire_consent` cookie (`cire_consent` over plain HTTP in local dev) (cire guest site) | First-party, not HttpOnly, Path=/, SameSite=Lax (Secure over HTTPS); Max-Age 182 days; record version, policy version, decision time and the guest's choice per category, no identifier | ✓ Strictly necessary: it records the guest's consent choice, a refusal included | Written and read by the guest site in the browser. A new policy version asks the guest again ([[cire-consent]]). |
| `sessionStorage:rp-auth.resumed-at` (cire host and vendor portals) | Tab-scoped, gone when the tab closes; a timestamp | ✓ Strictly necessary: it stops the sign-in page and the app sending each other back and forth | Written by `resumeSession()` in `@shared/rp-auth` when the sign-in page carries a signed-in visitor on to the app; blocks a second hand-off for 5 seconds; removed when the check finds no session. |
| `sessionStorage:cire.vendor.claim-token` (cire vendor portal) | Tab-scoped, gone when the tab closes; the token from the listing-claim link the vendor opened | ✓ Strictly necessary: it carries the claim the vendor asked to make across the sign-in redirect | Written by the claim page when it opens with a token. Removed when the claim succeeds, or fails for any reason other than the chosen organisation already having a listing (a network error or an expired sign-in included); kept in that one case so the vendor can pick another organisation. |
| `localStorage` on the cire host and vendor portals: `cire.host.theme`, `cire.host.haptics`, `cire.vendor.theme`, `cire.vendor.haptics`, and on the host portal `cire:getting-started-dismissed:<weddingId>` | No expiry; the theme choice, haptics `on` or `off`, and `1` for a dismissed checklist, whose key carries the wedding id | Borderline — request-driven UX state, generally accepted as exempt under "user-friendly design" tests | Written only when the user picks a theme, turns haptics on or off, or dismisses the getting-started checklist. Sign-out clears none of these keys. |
| `localStorage:@osn/client:account_session` | Profile-scoped access tokens, active profile id | ✓ Strictly necessary | First-party only. The 5-min TTL limits the damage. |
| `localStorage:@pulse/web:*` (theme, last-tab, draft-event) | UX state | Borderline — request-driven UX state, generally accepted as exempt under "user-friendly design" tests | Document on the privacy notice anyway. |
| iOS Keychain (planned) | Refresh / session tokens on native | ✓ Strictly necessary | iOS Keychain / Android Keystore equivalent. |

## Project changes required

Tracked with `C-` IDs:

1. **Cookie + storage inventory** in the privacy notice — the table above, in plain language. **Partly done (C-H4, PR #124):** the cire guest site publishes a `/privacy` notice built from its consent vendor registry ([[cire-consent]]). The musubi landing site's notice still has no inventory of the table's OSN rows. ID: rolled into **C-H4**.
2. **Lint rule against new third-party scripts** — pre-commit hook fails if any HTML / Astro template references a script tag with a non-OSN origin. Forces explicit decision. ID: **C-L18**.
3. **CSP `connect-src` audit** — moot: this tracked a transitional `https:` entry in Pulse's native-shell CSP config (S-L3-follow-up); that shell is removed, so the config no longer exists. ID: rolled into existing S-L3, closed.
4. **Banner scaffold** in `@musubi/landing` — built but not mounted; mounting requires a code change + DPO sign-off. Forces a deliberate decision the day someone wants to add an analytics tag. ID: **C-L19**.
