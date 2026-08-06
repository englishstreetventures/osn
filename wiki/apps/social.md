---
title: Social
description: OSN Social app — identity and social-graph management UI
tags: [app, identity, social-graph]
status: active
packages:
  - "@osn/social"
related:
  - "[[osn-core]]"
  - "[[authorize-ui]]"
  - "[[social-mobile-ux]]"
  - "[[oidc-provider]]"
  - "[[production-deploy]]"
  - "[[musubi-identity-migration]]"
  - "[[social-graph]]"
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[rate-limiting]]"
last-reviewed: 2026-08-06
---

# Social

`@osn/social` is a SolidJS web app for managing your OSN identity and social graph. It is the first app dedicated to the cross-app identity layer — separate from Pulse (events) and Zap (messaging), which keep their own domain UI.

## Architecture

```
@osn/social (SolidJS + Vite, port 1422)
  ├── SolidJS frontend (src/)
  ├── Consumes @osn/client and @osn/ui
  └── Talks to @osn/api (port 4000) directly over REST
```

The app ships as a web build only.

## Pages

| Route | Component | Purpose |
|---|---|---|
| `/` + `/connections` | `ConnectionsPage` | All connections, pending requests, close friends, blocks (tabbed) |
| `/search` | `SearchPage` | People + organisations search (`GET /recommendations/search`), grouped under section headings, with real action buttons. The mobile shell's Search tab; reachable at any width |
| `/discover` | `DiscoverPage` | Contact suggestions (`GET /recommendations/connections`) — mutual connections and shared organisations, each card saying which. See [[social-graph]] |
| `/organisations` | `OrganisationsPage` | Orgs the user owns or belongs to; create new |
| `/organisations/:id` | `OrgDetailPage` | Org detail + member management |
| `/settings` | `SettingsPage` | Profile / Account / **Security** (passkey add/rename/delete, step-up gated) / Connected apps tabs. The Security tab is lazy-loaded (`SecuritySection` chunk) so `@simplewebauthn/browser` only ships when opened. |
| `/authorize` | `AuthorizePage` | The OIDC consent screen — another app asking to sign the user in with their OSN account. Lazy-loaded, and the one route on a **bare layout**: no sidebar, nothing to click but the decision. Full contract in [[authorize-ui]]. |

`BARE_ROUTES` in `src/App.tsx` is the allow-list that strips the sidebar. Add
a route there only when leaving the flow would be a security problem.

The app has two shells split at the `md` (768 px) breakpoint: the 240 px
left rail on desktop, and a bottom-tab-bar + top-bar shell on mobile
(`MobileNav` / `MobileTopBar`, nav items shared via `nav.tsx`; dialogs render
as bottom sheets through `ResponsiveDialogContent`). The mobile UX audit and
the design rules the responsive work follows live in [[social-mobile-ux]] and
`DESIGN.md` §Responsive layout.

## Search surfaces — two ARIA patterns, deliberately

The rail (`GlobalSearch`) and the page (`SearchPage`) render the same results under different accessibility contracts, because the two patterns are mutually exclusive:

- **Rail = combobox + listbox.** Activation runs through virtual focus (`aria-activedescendant` + Enter), and an ARIA listbox option may not contain operable descendants — assistive tech flattens an option to its accessible name, so a nested button or link is announced as text and cannot be triggered. So the option **is** the target (click or Enter), the Connect/Accept text is a non-interactive label, and each option carries an `aria-label` naming what activating it does ("Alice A, @alice, accept connection request").
- **Page = plain list.** No virtual focus, no listbox constraint, so it keeps real `<Button>`s and a real `<A>` per row.

`PersonAction`'s `interactive` prop is what switches between them. Changing one surface to match the other is almost always wrong — check which pattern you're in first.

## Client surface

Pages talk to `@osn/api` via three plain-fetch clients factored out of `@osn/client`:

- `createGraphClient` — connections, pending requests, close friends, blocks (`osn/client/src/graph.ts`)
- `createOrgClient` — org CRUD and membership (`osn/client/src/organisations.ts`)
- `createRecommendationClient` — contact suggestions + search (`osn/client/src/recommendations.ts`). `search` returns people and organisations together and takes an `AbortSignal` because it backs typeahead: the caller aborts the in-flight request when the query changes, so a slow early keystroke can't land after a fast later one.

All three share the same hardening: `authGet/authPost/authPatch/authDelete` with `safeJson` wrapping (no `SyntaxError` leakage), capped error strings, and per-module typed error classes. These helpers are duplicated per module; factoring them out is tracked as P-I1.

## Dev

```bash
bun run dev:social             # starts @osn/social + @osn/api together
bun run --cwd osn/social dev   # social only (:1422)
```

Environment variables (all prefixed `VITE_`):

- `VITE_OSN_ISSUER_URL` — defaults to `http://localhost:4000`
- `VITE_OSN_CLIENT_ID` — defaults to `social`

## Deployment

Cloudflare Pages, project **`osn-social`**, served at the apex
**`https://musubi.social`**. The `deploy-osn-social` job in
`.github/workflows/deploy.yml` builds and publishes it on every merge to
`main`.

The host is not cosmetic, on two counts.

**Cookies.** `@osn/social` serves `/authorize`, the OIDC consent screen, and
that page only works under the **same registrable domain as osn-api**: the
`__Host-osn_session` cookie and the per-request binding cookie
`__Host-osn_oar_<12hex>` are host-bound to `id.musubi.social` and `SameSite=Lax`,
so they ride along on credentialed fetches from `musubi.social` but not from a
`*.pages.dev` host. The apex is therefore in both osn-api allowlists —
`OSN_ORIGIN` (it runs passkey ceremonies) and `OSN_CORS_ORIGIN` (every call it
makes is cross-origin). See [[authorize-ui]] and [[oidc-provider]].

**The RP ID.** `OSN_RP_ID` is the registrable apex `musubi.social`, so this app is
the one surface that can run a WebAuthn ceremony — a ceremony is only legal on
an origin same-site with the RP ID. Putting the app on `id.musubi.social` instead
would have barred the apex from ever running one. The apex also covers every
future `*.musubi.social` surface with a single credential.

- `VITE_OSN_ISSUER_URL` is baked in **at build time** (`https://id.musubi.social`
  in the deploy job). Unset, the bundle dials `http://localhost:4000` and the
  deployed app calls the visitor's own machine.
- `public/_redirects` rewrites every path to `index.html` (200) so client-side
  routes deep-link; `public/_headers` ships the framing denial.
- The custom domain is attached in the Cloudflare dashboard, not by wrangler —
  see [[production-deploy]] §5.4.
- **No feature-branch preview.** `deploy-osn-social-preview.yml` (project
  `osn-social-preview`) was removed on 2026-07-27. A `*.pages.dev` preview could
  never sign anyone in — the RP ID is `musubi.social` and the `__Host-` session
  and OIDC binding cookies are host-bound to `id.musubi.social` — so it could
  only be looked at, while still spending a prod-scoped Cloudflare token on every
  branch push (the open S-M `preview-ci-prod-token` finding). Review social
  changes locally with `bun run dev:osn`. If one is ever reinstated it must
  target its own project, never `osn-social`, whose production deployment serves
  a live hostname.

The move from `id.cireweddings.com` happened 2026-07-27 — see
[[musubi-identity-migration]].

## Auth

Uses `AuthProvider` from `@osn/client/solid` with the standard OSN passkey-primary login model — see [[passkey-primary]]. Access tokens live in `localStorage` (the only auth secret there after Copenhagen Book C3); the refresh token lives in an HttpOnly cookie. `OsnAuthService.authFetch` handles silent refresh on 401. A "Lost your passkey?" link routes to the recovery-code login form.

## Response headers

`osn/social/public/_headers` is served by Pages on every path: `frame-ancestors 'none'`
plus `X-Frame-Options: DENY` (a consent screen must never be framed),
`X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin`.

## Rate limits

Per-user Redis-backed limiters on the two recommendations endpoints, both fail-closed — 20 req/min for the suggestion fan-out, 60 req/min for search (typeahead fires once per debounced keystroke). See `[[rate-limiting]]` and `createRedisRecommendationRateLimiters` in `@osn/api`.

## Testing

`osn/social/tests/` covers the sidebar mount path under `AuthContext` + `MemoryRouter` using `@solidjs/testing-library` + `happy-dom`. The tests do not assert the full open-and-click interaction for the Kobalte dropdown: Kobalte's trigger relies on pointer-capture behaviour that happy-dom does not reproduce.

`tests/lib/search.test.ts` drives `createSearchController` directly, covering three properties no component test can reach: the token accessor is re-read per request (so one controller survives a silent refresh — a captured token would 401 every user after five minutes), the previous page stays on screen while the next loads, and disposal aborts the in-flight request.

`tests/components/GlobalSearch.test.tsx` drives the rail combobox on fake timers: the debounce collapses a burst of keystrokes into one request, queries below the two-character minimum never leave the browser, arrow keys move `aria-activedescendant` across both sections without moving focus, Enter and click both activate the row, a failed search renders an error instead of spinning, and a failed connect does not flip the row to "Requested". One test asserts the ARIA invariant directly — **no option contains an operable control**. `tests/components/SearchPage.test.tsx` covers the grouped page, and `tests/components/DiscoverPage.test.tsx` the suggestion cards' reason line.

`tests/components/AuthorizePage.test.tsx` drives the consent screen the same way, with the authorize client mocked and `location.assign` stubbed: a malformed request id never reaches the API, a 404 is terminal, the decision carries the chosen profile, `login_required` keeps the request alive, and `invalid_client` ends the flow naming the app.
