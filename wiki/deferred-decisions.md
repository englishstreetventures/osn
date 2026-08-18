---
title: "Deferred decisions"
tags: [decisions, deferred]
related:
  - "[[index]]"
  - "[[github-issues-setup]]"
last-reviewed: 2026-08-17
---

# Deferred decisions

Open questions we have chosen not to answer yet, and the ones we have closed.
Nothing here is tracked work — planned work lives in [GitHub Issues](https://github.com/xchromo/osn/issues).
A row graduates to an issue when its "Revisit When" lands.

## Open

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

## Resolved

### Decided 2026-06-18

- **Email provider → degraded-for-now.** osn-api ships with **no** Cloudflare Email Service creds and `OSN_EMAIL_OPTIONAL=true` (no-op transport). The provider choice (Resend / SendGrid / Postmark / SES at the Worker level) is parked until email is re-enabled — see [[email]]. Redis provider likewise **decided: Upstash** (`ap-southeast-2`, C-M18) — see [[redis]].
- **Production domain → `cireweddings.com`** (guest apex / `app.` / `api.` / `id.`; passkey RP ID `cireweddings.com`) — #149. **Superseded twice:** the 2026-07-16 reshuffle moved the guest site to `invite.` and the organiser portal to `host.`, and the 2026-07-27 move took identity off the zone entirely — issuer `id.musubi.social`, RP ID `musubi.social`. See [[musubi-identity-migration]].
- **Maps approach → Google Maps Embed** (key-optional, CSS-card fallback) — #146.
- **WAF vs own rate limiter → keep the app limiter.** The Cloudflare Free WAF (1 rule, 10s window) can't replace the app's per-IP/per-user limiters; WAF is reserved for coarse edge defence. Free dashboard hardening steps documented in [[free-tier-limits]].
- **osn-api topology → single Worker** (split + service-bindings/Access "VPC" evaluated and **deferred**); osn-api runs as one Worker, on `id.musubi.social` since 2026-07-27 (`id.cireweddings.com` until then). The topology decision is unchanged by the move — only the hostname is.
- **Cire test idiom** → unblocked by the Hono → Elysia migration (2026-06-12); cire now follows the platform `it.effect` + `createTestLayer()` convention.
