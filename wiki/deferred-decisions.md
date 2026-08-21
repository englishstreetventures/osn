---
title: "Deferred decisions"
tags: [decisions, deferred]
related:
  - "[[index]]"
  - "[[TODO]]"
  - "[[github-issues-setup]]"
  - "[[cire-platform-plan]]"
  - "[[cire]]"
last-reviewed: 2026-08-21
---

# Deferred decisions

Open questions we have chosen not to answer yet, and the ones we have closed.
Nothing here is tracked work — planned work lives in [GitHub Issues](https://github.com/xchromo/osn/issues).
A row graduates to an issue when its "Revisit When" lands.

## Open

### Platform

| Decision | Context | Revisit When |
|----------|---------|--------------|
| Storybook (or another browser-rendering component tier)? | **The gap is real and was measured, not assumed.** Building the cire RSVP confirmation (`claude/cire-rsvp-success-feedback-phnf60`, 2026-08-06) surfaced three failure modes that the whole existing test tier is structurally blind to, because jsdom and happy-dom compute **no CSS at all**: (a) Tailwind v4's `scale-*` sets the standalone `scale` property, not `transform`, so a `transition-transform` that didn't also list `scale` would animate nothing — silently; (b) two conflicting utilities on one element (`scale-x-0` / `scale-x-100`) resolve by **stylesheet order**, not class-attribute order, so which one wins is a property of Tailwind's generated output and can invert on a version bump; (c) whether the global `prefers-reduced-motion` clamp actually lands an animation on its end state. All three were caught only by driving the built CSS through headless Chromium by hand, and the current answer is text-matching drift guards (`rsvp-saved.test.ts`, `styles/root-type-scale.test.ts`) — which pin that the *source* says the right thing, never that the *render* does. **Options.** (1) **Storybook** via `storybook-solidjs-vite` (v10.x, Storybook 9+; note it lives under the `storybookjs` GitHub org but is explicitly **community-maintained**, not first-party — the earlier `storybook-solidjs` adapter went unmaintained and broke on Storybook 9, so maintainer risk here is demonstrated, not hypothetical). Buys a browser-rendered harness, prop controls, and a place to eyeball every state of a component; costs a dep tree, a config surface (root `.storybook/` vs per-package — five Solid packages would want it: `osn/social`, `pulse/web`, `cire/invites`, `cire/host`, `cire/vendor`), CI minutes, and stories to write and keep current. (2) **Vitest browser mode** — materially lighter and already half-paid-for: every package is on Vitest 4, which ships browser mode, and Chromium + Playwright are already provisioned in the dev containers. Same tests, same files, real CSS, no second tool or authoring format; no visual catalogue. (3) **Status quo** — text-matching drift guards plus manual browser checks on the branches that need them. **Leaning: (2) first**, on the grounds that the demonstrated need is *assertions against real computed style*, not a component gallery, and (2) reaches that without a community-maintained renderer on the critical path. (1) becomes the better answer if the driver turns out to be design review and cross-package component discovery rather than correctness. | When a second CSS-invisible bug of this class ships, or when someone wants a design-review surface across the five Solid packages. Raised 2026-08-06. |
| Social media platform name | Need a catchy name | Before starting Phase 3 |
| CI lint gate: deny warnings? | 2026-07-03 quality review drove oxlint 463 → 21 warnings; the 21 survivors are the deliberately-warn jsx-a11y set (native `<dialog>`/`<progress>`/`<output>` refactors that change behaviour). `--deny-warnings` in CI would stop future drift but makes "warn" mean "error" — either fix/waive the a11y set first or keep warnings advisory | Next time lint drift is noticed, or when the a11y items are done |
| Signal vs MLS for Zap group chats — see [[zap]] | Sender-keys is simpler; MLS scales past ~50 members. **Hard constraint either way:** hybrid PQ KEM (classical + ML-KEM-768) — messages are durable and HNDL-exposed | Before Zap M2 |
| Zap media storage (images / voice / video) | Needs E2E-friendly blob storage; SQLite-only won't cut it | When Zap M2 lands |
| Effect.ts adoption | Trial underway in `pulse/api` | After more service coverage |
| Supabase migration | Currently SQLite | When scaling needed |
| Android support | iOS priority | Phase 3 |
| Self-hosting | Enterprise use case | Phase 3 |
| Payment handling | Deferred for Pulse ticketing | After core Pulse features |
| Two-way calendar sync | Currently one-way (Pulse → external) | Phase 2 |
| Community event-ended reporting | 15–20 attendees auto-finish; host notified | When attendee/messaging features land |
| DB table rename `users` → `profiles` | Table represents profiles; renaming is migration-heavy for minimal benefit | Only if it causes genuine confusion |
| S2S scaling — see [[s2s-patterns]], [[arc-tokens]], [[s2s-migration]] | `pulse/api` graphBridge now uses HTTP + ARC. Remaining: `zap/api` bridge still uses direct import | When `zap/api` needs horizontal scaling |
| Per-app blocking — see [[social-graph]] | Blocks global across all OSN apps. Per-app scope deferred | When Messaging or third-party app needs independent block lists |
| `@chenglou/pretext` for Zap virtual scroll — see [[zap]] | Pure-JS text measurement/layout. Enables virtualised message lists | When Zap UI needs message list virtualisation |
| Profile transfer between accounts | Meta supports unlinking/relinking profiles | After multi-account ships (P6) |
| Per-profile notification email | Profiles might want separate contact emails | When notification system is built |
| Profile-level 2FA | Currently 2FA would be account-wide (passkeys on accounts) | When 2FA is implemented |
| Cross-profile content sharing | Reposting between own profiles | Phase 2 social features |
| Max profiles per account | Set to 5 via `accounts.maxProfiles`; make configurable? | Before launch |
| Self-interaction policy | Two profiles from same account CAN interact (preventing it leaks the link) | Multi-account P6 privacy audit |
| Build-time `cn()` evaluation — see [[component-library]] | `tailwind-merge` runs at runtime. Options: Vite plugin, drop to `clsx`-only | When bundle size is a concern |
| Email Worker per-recipient rate-limit bound — see [[email]] | Prevents OSN from flooding an inbox under bug / abuse. Tune once we have send-rate telemetry | After first week of real traffic |
| Dry-run flag for email — see [[email]] | `OSN_EMAIL_DRY_RUN` env knob that short-circuits before Worker dispatch; useful for staging smoke tests | When we need it |
| KYC vendor for V-M1 / V-M2 — see [[verified-identity]] | Persona (top AU age-assurance trial scorer; combined estimation + verification) vs idvPacific (AU-domiciled DVS gateway, OCR-first) vs Equifax IDMatrix (heavyweight gateway) vs MATTR/GBG (mDL-native; mDL roadmap partner) | V-M0 vendor RFP |
| BBS+ vs SD-JWT-per-audience for verified presentations — see [[verified-identity]] | SD-JWT-per-audience is the v1 default (mint a fresh credential per RP); BBS+ adds true unlinkable presentations at higher operational cost | If a documented cross-RP correlation threat lands |
| Verified attributes scope: account-level vs profile-level — see [[verified-identity]], [[identity-model]] | Verification ceremony is per-account; multi-account P3-P6 lets one account hold multiple profiles. Should profile-A be able to present `age_over_18` while profile-B presents nothing, or are attributes always inherited? | Before V-M4 ships consent UX |
| Pulse–cire integration mechanism — see [[cire]] | ARC-token pull (Pulse fetches weddings from `cire/api` at feed time) vs push-on-publish (cire writes into `pulse/db` when a wedding goes live) | When Pulse surfaces cire weddings in its feed |
| vite 7→8 + Astro 6→7 upgrade | **Deferred — ecosystem beta-only (checked 2026-06-21).** vite 8 requires Astro 7, and `astro@7`, `@astrojs/cloudflare@14` (the gating one — `@cire/invites` is a live SSR Worker), and `@astrojs/solid-js@7` are all `beta`/`alpha`-only on npm. Root override `"vite": "^7.3.5"` is the single lever holding the whole tree at vite 7; `@osn/social`/`@osn/ui`/`@pulse/web`/`@cire/host` already *declare* `vite@^8` in-manifest but are force-held down by it. Astro 7 also ships a Rust compiler default + Rolldown-powered vite 8 (esbuild→Oxc) — re-check the `esbuild`/`postcss` overrides + `cire/invites` `astro.config.ts`/`middleware.ts` when upgrading. | When `astro@7`, `@astrojs/cloudflare@14`, `@astrojs/solid-js@7`, and an Astro-7 `@astrojs/check` are all on the `latest` dist-tag — then flip the override to `^8`, `bun install`, full `check`/`test`/`lint`/`build`, and a Cloudflare deploy-preview of the SSR Worker before relying on it |

### Cire

| Decision | Context | Revisit When |
|----------|---------|--------------|
| SSR the restored invite (widen `cire_session` to `Domain=cireweddings.com`)? | Today the session restore (`GET /api/claim/session`) is a client-side fetch on island mount, because the cookie is host-scoped to `api.cireweddings.com` and the guest-site Worker never receives it. Painting a returning household's events into the FIRST HTML byte would need `Domain=cireweddings.com`, which hands the household session to every subdomain (`host.`, `vendor.`, the apex) — against the standing audit in `cire/api/src/lib/cookie.ts`. Alternative: have the guest-site Worker mint its own same-origin cookie mirroring the session, which is a second session store to keep in sync. Current call: **keep host-scoping**; the client-side restore already removes the retyping, and one RTT after hydration is not worth widening a credential's blast radius. | If invite open-latency is measured and the post-hydration restore is the bottleneck, or if a same-origin API path (API behind `invite.cireweddings.com/api/*`) lands and makes the question moot. Raised 2026-08-02 (`claude/invite-code-gating-hints-g8nw0o`). |
| Free (invites) vs paid (management platform) tiering | Invites stay free; the management modules (Checklist, Budget, Vendors incl. the S3 directory browse) become a paid tier — needs a billing model + a tier gate wrapping the modules. Directory browse would become tier-gated. Own brainstorm. | Before the wedding-management platform is offered beyond the single live wedding. Surfaced during Vendors S3 review (2026-07-18). |
| Venue-discovery sets the event location | A wedding may have no venue yet; the couple browses the directory (Vendors S3) to choose one. A later flow can let "add a venue vendor" optionally set the event's `location`/coords from the chosen listing (ties into `events.venue_vendor_id`). | With S5 geo directory-search + the "Venue link" platform item. |
| Event invitations per-family vs per-guest | Per-guest matches sheet exactly (current schema); per-family simpler but loses fidelity | After first import lands and real spreadsheet variation is observed |
| Surname collision handling in publicId | Accept multiple `PATEL-*-*` IDs (different word/hash disambiguates) vs. enforce uniqueness on family_name | Stay on current accept-multiple unless aesthetic problem reported |
| Astro → Solid Start migration | Keep Astro+islands vs migrate guest-facing app to Solid Start for tighter SPA flows | Post-platformisation — only if SaaS direction is taken |
| SMS OTP fallback | Twilio/similar vs email-only | If magic link is not enough |
| Photo collections | Cloudflare R2 + upload UI | Post-MVP |
| Vendor business identity (directory v2) | Plain OSN account (recommended start) vs OSN **org** with staff | When directory self-serve opens — see [[cire-platform-plan]] §5.2 |
| External vendor-discovery overlay | None (recommended start) vs Google Places live-search layer (ToS: display-only, never stored in D1) | After directory v1 proves thin coverage — see [[cire-platform-plan]] §5.2 |
| Pricing baseline sourcing + regions | Hand-curated AU-first dataset vs licensed data | Phase 3 start — see [[cire-platform-plan]] §6 |
| Multi-currency budget entries | v1 single-currency (all figures in the wedding's main `currency`, organiser converts on entry — decided) vs additive v2: display-only `original_currency` + `original_amount_minor` (+ entered rate) on `budget_items`/`payments` | Budget v1 build, or first real multi-country wedding asking for it — see [[cire-platform-plan]] §4.2 |
| Guest email collection point (comms) | Guest-entered at RSVP vs organiser-entered vs both; consent design first | Comms build (Phase 4) — see [[cire-platform-plan]] §7 |
| Wishing well | Payment processing (requires ABN) | After business is set up |
| Guest photo sharing | R2 + moderation | Post-MVP |
| iPhone AirDrop sharing | Web Share API + custom payload | After core invite is built |
| Account-linking ARC key provisioning + rotation | Stable `CIRE_API_ARC_PRIVATE_KEY` secret pre-registered in osn-api `service_accounts` (shipped) vs. lazy self-registration per isolate vs. KV-persisted rotating key | Before production launch of linking — wire the secret + osn-side registration; decide rotation story (Workers have no startup hook) |
| Workerd metric/trace **export** | otel-cf-workers vs. Workers Analytics Engine vs. stay no-op | cire now defines spans + `cire/api/src/metrics.ts` counters/histograms (recording call-sites correct, no-op until an exporter exists). Decide the reader before relying on cire dashboards. See `[[cire-workerd]]` |
| `OSN_API_URL` https enforcement (linking) | Enforce `https://` for the ARC call in prod (like `graphBridge.ts` module-load guard) vs. trust deploy config | Before production launch — Workers has no module-load env, so guard must live in `index.ts` config wiring |
| Invite builder draft→publish model | Today two persistence models coexist (text/theme via Save; images/crops/design instantly live — see `[[cire-invite-builder]]`), so a mid-redesign invite can go live half-updated. Options: draft columns + a Publish action on `wedding_invite_customisations` vs. a shadow draft row vs. keep the marked split (current, 2026-07-30 UX pass added badges + remove-confirm). | If an organiser reports a half-updated live invite, or when the builder next grows a surface that writes instantly |
| Invite builder concurrent-edit guard | The organiser GET payload exposes no row version, so two co-editors are last-write-wins with no warning. Cheap fix: return `updatedAt` from `GET /invite`, compare on save, warn on mismatch. | With the first multi-editor wedding complaint, or alongside the draft→publish decision above |

## Resolved

### Decided 2026-06-18

- **Email provider → degraded-for-now.** osn-api ships with **no** Cloudflare Email Service creds and `OSN_EMAIL_OPTIONAL=true` (no-op transport). The provider choice (Resend / SendGrid / Postmark / SES at the Worker level) is parked until email is re-enabled — see [[email]]. Redis provider likewise **decided: Upstash** (`ap-southeast-2`, C-M18) — see [[redis]].
- **Production domain → `cireweddings.com`** (guest apex / `app.` / `api.` / `id.`; passkey RP ID `cireweddings.com`) — #149. **Superseded twice:** the 2026-07-16 reshuffle moved the guest site to `invite.` and the organiser portal to `host.`, and the 2026-07-27 move took identity off the zone entirely — issuer `id.musubi.social`, RP ID `musubi.social`. See [[musubi-identity-migration]].
- **Maps approach → Google Maps Embed** (key-optional, CSS-card fallback) — #146.
- **WAF vs own rate limiter → keep the app limiter.** The Cloudflare Free WAF (1 rule, 10s window) can't replace the app's per-IP/per-user limiters; WAF is reserved for coarse edge defence. Free dashboard hardening steps documented in [[free-tier-limits]].
- **osn-api topology → single Worker** (split + service-bindings/Access "VPC" evaluated and **deferred**); osn-api runs as one Worker, on `id.musubi.social` since 2026-07-27 (`id.cireweddings.com` until then). The topology decision is unchanged by the move — only the hostname is.
- **Cire test idiom** → unblocked by the Hono → Elysia migration (2026-06-12); cire now follows the platform `it.effect` + `createTestLayer()` convention.

### Cire — decided

Folded in from the retired `cire/wiki/deferred.md` when the cire vault merged into this one.

| Question | Resolution | Resolved |
|---|---|---|
| Guest/event editor endpoint shape | **Batch draft-save (desired-state reconcile)**, not per-row `POST/PATCH/DELETE` — the editor submits a whole draft through the same preview → warnings → apply pipeline the import uses, with an ID-aware diff; per-row endpoints may land later as sugar over the same reconcile. Amends [[cire-platform-plan]] §3.3. See [[cire-guest-event-editor]] §3 + §11. | 2026-07-12 |
| Editor checkpoint retention | **Keep the last 10 before-image snapshots** per wedding (R2 Free-tier cap); older change-history rows stay listed but lose revertability, marked in the UI. See [[cire-guest-event-editor]] §4. | 2026-07-12 |
| Editor-created household code minting (pre-PR-4) | **Auto-mint claim codes**, exactly like the import, until platform PR 4 (code-less households) lands — then manual creation switches to code-less per the decided §3.2 model. See [[cire-guest-event-editor]] §11. | 2026-07-12 |
| Geocoding wedding/vendor locations | **RETIRED 2026-07-16 (migration 0036).** The Phase-0 key-optional geocoding flow + the `pricing_region` it derived were removed — they only fed unbuilt Phase 3 features and the guest map never used them (it renders `address` alone). If Phase 2/3 ever needs a point, geocode `events.address` on-demand then. ~~Settings form geocoded the typed address server-side (Google Geocoding; no key ⇒ manual lat/lng fallback).~~ See [[cire-platform-plan]] §3.1. | 2026-07-16 |
| Location scope: wedding vs event | **RESOLVED → then RETIRED 2026-07-16 (migration 0036): there is no stored event location at all.** An event's place is its free-text `address` (the sole location source). ~~Location is EVENT-scoped; `location_lat`/`location_lng` + `pricing_region` live on `events`~~ — those columns were dropped as a redundant, unbuilt-only config. See [[cire-platform-plan]] §3.1. | 2026-07-16 |
| Organiser route aliases during module move | **One-release alias layer.** Same factories mounted at old + new prefixes for one release, old prefix deleted next release — Worker/Pages deploys are non-atomic and cached portal bundles outlive the Worker flip, so lockstep-only guarantees a broken window. See [[cire-platform-plan]] §3.4. | 2026-07-08 |
| Import code minting after invite decoupling | **Import keeps auto-minting** claim codes at apply time (sheet = invite list, current workflow preserved); only manually-created households start code-less. See [[cire-platform-plan]] §3.2. | 2026-07-08 |
| Import diff vs manually-added rows | **Provenance column** — `source: 'import' \ | 'manual'` on families/guests; diff manages import-sourced rows only by default, explicit toggle to include manual rows. See [[cire-platform-plan]] §3.3. |
| Platformise Cire | **Yes — wedding-management platform.** The organiser portal grows into a full planning product (guests/events decoupled from the invite, vendors + availability, pricing estimates, budget, checklist, seating, comms); the invite becomes one module. Phased build plan in [[cire-platform-plan]]; work in GitHub Issues. | 2026-07-08 |
| Seating planner | Promoted from a vague row into [[cire-platform-plan]] §7 (Phase 4: `seating_tables` + `seating_assignments` per event, reads Guests + live RSVPs); tracked in GitHub Issues. | 2026-07-08 |
| Pinterest embed approach | iframe for MVP (good-enough preview, no API rate limits); upgrade to static-image board snapshots post-launch | 2026-05-05 |
| Pinterest embed approach (revised) | Script-widget (`<a data-pin-do>` + `pinit_main.js`) with a "View moodboard on Pinterest" link button fallback when `pinit_main.js` is blocked or fails to transform within 2.5s. Direct `<iframe src=.../embed.html>` was abandoned: `pinit_main.js` inside it silently bails on referrer / 3rd-party-storage / sandbox conditions and renders blank. Static-image snapshot path still available as a future upgrade if tracker-blocker fallback rates grow uncomfortable. PR #28. | 2026-06-08 |
| Pinterest consent gate scope | **One-time, page-wide, persisted in localStorage** (PR #126), not session-scoped. A single shared signal backs the gate, so opting in on one board reveals every Pinterest board on the page and the prompt never returns on a later visit. Consent prompt links the `/privacy` notice; fallback link always available pre-consent. | 2026-06-17 |
| Pinterest embed scope: which devices | **Desktop-only** (`feat/pinterest-moodboard-ux`). The embed widget is slow + unreliable on touch and is the *only* reason the consent gate exists, so on a coarse-pointer / no-hover device (capability check, not UA) we don't load the tracker, don't show the gate, and don't mount the embed — guests get a prominent "View moodboard on Pinterest" link-out card instead. A desktop-persisted consent is ignored on touch. Desktop keeps the consent-gated embed + an immediate "Loading board…" feedback state on click. Revisit only if a reliable mobile embed path (e.g. static R2 board snapshots) ships. | 2026-06-19 |
| Spreadsheet input format | CSV-only for MVP (two sheets: events + guests). `.xlsx` deferred — would need SheetJS, slower upload, and most organisers can export CSV from any tool. | 2026-05-05 |
| Organiser auth model | Reuse OSN passkey infra (cire now lives in the OSN monorepo): organisers sign in with OSN passkeys on the portal; `cire/api` verifies the issued access JWT via `osnAuth()` from `@shared/osn-auth-client`; authorization via `weddings.owner_osn_profile_id` + `weddingOwner()`/`ownedWedding()`. No separate `organisers` table; the interim `X-Organiser-Token` is deleted. See `[[cire-auth]]` in the root OSN wiki. | 2026-06-10 |
| Guest account-linking granularity | **Per-invitee** (one `guests` row ↔ one OSN account), not per-family. The family claim-code session is shared, so the link POST carries `{ guestId }` (validated ∈ family). Lets each member of a household link their own OSN account and, in Pulse, see other members' RSVPs. See `[[cire-auth]]` (root). | 2026-06-12 |
| Guest-link stored identifier | Store **account-level** `osn_account_id` (resolved S2S over ARC via `GET /graph/internal/profile-account`), not profile-level — so any of a user's OSN profiles surfaces the invitation in Pulse. `osn_profile_id` kept for audit. account id is S2S-only, never returned to clients (redacted in logs via `@shared/observability`). | 2026-06-12 |
| ARC token signing on Cloudflare Workers | Added a DB-free, metric-free `signArcToken` to `@shared/crypto/jwk` (the workerd-safe subpath) rather than pulling the `@shared/crypto` barrel (→ `@osn/db`/`bun:sqlite`) or `@shared/observability` (node OTel) into the Worker bundle. `createArcToken` now wraps it + the issuance metric for bun/node. Verified via `cire/api` `wrangler` dry-run build. | 2026-06-12 |
| Account-linking observability on workerd | **Adopt `@shared/observability` (workerd-safe subpaths).** cire/api now installs the shared redacting logger (`runCire`/`runCireSync` → `cireLoggerLayer`), spans on every service fn, `instrumentedFetch` on the S2S ARC call, and `cire/api/src/metrics.ts` (define-now-export-later — incl. `cire.account_link.{requests,unlinks}` + resolve-duration). Workerd metric/trace **export** is the only remaining open item (own row in Open). Verified via `wrangler` dry-run + `bun test`. | 2026-06-16 |

## Parked ideas — cire

Post-MVP ideas, too vague to be issues. Folded in from the retired `cire/wiki/future.md`.
An idea graduates to a GitHub issue when someone can write its "done when".

> **Promoted 2026-07-08:** "Platformise as multi-tenant SaaS" and "General wedding planning — guest list management, seating charts" graduated into the wedding-management platform build-out — architecture in [[cire-platform-plan]], phased work in GitHub Issues. Wishing well, guest photos, and Wallet passes stay here (referenced by the plan's Phase 4 as later work).

- Astro → Solid Start migration for the guest-facing app (post-platformisation, only if SaaS path is taken)
- Apple Wallet pass generation for each event
- Physical + digital hybrid: QR codes on printed invites linking to digital counterparts
- Wishing well with payment processing
- Photo collection and guest photo uploads
- iPhone tip-to-tip AirDrop invite sharing
- White-label / custom domain support per wedding
- **Auto contrast-check the hero title vs the backdrop image** — deferred from `feat/hero-display-options`. Today the organiser manually picks the hero **title backdrop** (`none | solid`) for legibility over a busy/sharp photo. A later version could sample the uploaded hero image's brightness behind the title region and auto-suggest (or auto-enable) the `solid` panel and/or flip the title colour when the WCAG contrast is too low — instead of leaving it to the organiser. Marked with a `// TODO(future)` in `cire/invites/src/components/InviteHeader.tsx` (the title-block panel). See `[[cire-invite-builder]]`.
