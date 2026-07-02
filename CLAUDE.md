# CLAUDE.md

AI coding assistant ref. Full spec in README.md. Progress/decisions in `wiki/TODO.md`.

## Quick Context

OSN: Modular social platform. Users own identity + social graph. Apps opt-in/out independently.

**Deployed (2026-06-18):** the cire stack is **live on `cireweddings.com`** (all Cloudflare Free tier). `osn-api` is a deployed **Cloudflare Worker** on `id.cireweddings.com` (Upstash prod secrets set; `OSN_EMAIL_OPTIONAL=true` → email degraded); `cire-api` on `api.cireweddings.com`; guest + organiser sites on Pages with custom domains. CI auto-deploys cire-api + Pages on merge. Architectural decision: **osn-api stays a single Worker** (split deferred). See `[[wiki/runbooks/production-deploy]]`, `[[wiki/runbooks/free-tier-limits]]`.

Phase 1 surfaces:

| Surface | Package(s) | Status |
|---|---|---|
| Identity / auth API | `@osn/api` (port 4000; prod Worker `id.cireweddings.com`) | Active — **deployed (Worker)** |
| Identity & graph UI | `@osn/social` (port 1422) | Active |
| Events | `@pulse/app` + `@pulse/api` (port 3001) + `@pulse/db` | Active |
| Messaging | `@zap/api` (port 3002) + `@zap/db` | M0 scaffolded; M1 in flight; client app not started |
| Wedding invites | @cire/api (:8787, prod `api.cireweddings.com`) + @cire/web (:4321) + @cire/organiser (:4322) + @cire/db | Active — **deployed on `cireweddings.com`** |
| Wedding marketing site | `@cire/landing` (:4323) | Active — built; ships to a non-apex Pages preview (apex cutover deferred). See `[[wiki/apps/cire-landing]]` |
| OSN marketing site | `@osn/landing` (:4324) | Active — built (dark/dotted, connections-led). See `[[wiki/apps/osn-landing]]` |
| Pulse marketing site | `@pulse/landing` (:4325) | Active — built (colourful + fun). See `[[wiki/apps/pulse-landing]]` |

## File Responsibilities

- `README.md` → Project spec, vision, features, tech stack, contributing (human-readable)
- `CLAUDE.md` → AI entry point: quick context, conventions, commands, wiki nav
- `pulse/DESIGN.md` → Pulse visual design system: typography, color tokens, component catalog, layout patterns
- `wiki/TODO.md` → Progress tracking, deferred decisions, task checklists
- `wiki/` → Obsidian knowledge graph: architecture, systems, observability, runbooks
  - Open in Obsidian for graph view; or navigate via `[[wiki links]]`
  - See `[[wiki/index]]` for full content map

## TODO.md Structure + Maintenance

`wiki/TODO.md` organised into top-level sections — add new items to right place:

| Section | What goes here |
|---------|---------------|
| **Up Next** | ≤8 highest-priority items across all areas. Keep short — if everything priority, nothing is. Prune when done or promoted. |
| **App sections** (Pulse, OSN Core, Zap, Landing) | Feature work per app. When done, move to `[[changelog/completed-features]]`. |
| **Platform** (API, DB, Client, UI, Infra) | Shared package work + infra. Same check-off rule. |
| **Security Backlog** | Open security findings only, sorted H → M → L. Fixed → move to `[[changelog/security-fixes]]`. |
| **Performance Backlog** | Open perf findings only. Fixed → move to `[[changelog/performance-fixes]]`. |
| **Compliance Backlog** | Open compliance findings only (`C-` prefix), sorted H → M → L. Each row links to `[[wiki/compliance/...]]`. Closed → move to `wiki/changelog/compliance-fixes.md` (created on first close). |
| **Deferred Decisions** | Questions not answering yet. Add row; remove when decided. |
| **Future** | Phase 2/3 items. Vague fine — detail added when phase starts. |

**When update TODO.md:**
- After PR merge → move completed items to `[[changelog/]]`; add new findings; update Up Next
- Security/performance review surfaces findings → add to relevant backlog with `[[wiki links]]` to affected system pages
- New deferred decision → add row to table
- Keep Up Next pruned to real next things — actionable at glance

## Wiki Navigation

`wiki/` has detailed ref pages. Use index to find right page — only read what you need:

| If you need to... | Read |
|---|---|
| Understand monorepo layout | `[[wiki/architecture/monorepo-structure]]` |
| Understand DB environments (local bun:sqlite vs dev/staging/prod D1) | `[[wiki/systems/database-environments]]` |
| Write new Effect service or Elysia route | `[[wiki/architecture/backend-patterns]]`, `[[wiki/architecture/schema-layers]]` |
| Understand accounts, profiles, orgs | `[[wiki/systems/identity-model]]` |
| Add or verify ARC S2S tokens | `[[wiki/systems/arc-tokens]]` |
| Add rate limiting to endpoint | `[[wiki/systems/rate-limiting]]`, `[[wiki/systems/redis]]` |
| Instrument logging, tracing, metrics | `[[wiki/observability/overview]]`, then specific page |
| Write or review tests | `[[wiki/conventions/testing-patterns]]` |
| Understand event visibility rules | `[[wiki/systems/event-access]]` |
| Work on Pulse share-attribution (share button, source enum, RSVP attribution columns) | `[[wiki/systems/event-access]]` (Share-Source Attribution section) |
| Add or use UI component (Button, Card, Dialog…) | `[[wiki/architecture/component-library]]` |
| Understand Pulse visual design (tokens, typography, Explore layout) | `pulse/DESIGN.md` |
| Work on social graph | `[[wiki/systems/social-graph]]` |
| Work on Pulse close friends | `[[wiki/systems/pulse-close-friends]]` |
| Work on Pulse onboarding flow | `[[wiki/systems/pulse-onboarding]]` |
| Work on Pulse venues / lineups | `[[wiki/systems/venues]]` |
| Gate sensitive action behind step-up auth | `[[wiki/systems/step-up]]` |
| Understand passkey-only login model | `[[wiki/systems/passkey-primary]]` |
| Add Turnstile bot protection to a form (key-optional, fail-closed) | `[[wiki/systems/turnstile]]` |
| Surface device / passkey management UI (PasskeysView, passkey-only step-up) | `[[wiki/systems/passkey-primary]]`, `[[wiki/systems/sessions]]` |
| Plan/extend Yoti-style verified-identity layer (AU DVS / mDL / myID, SD-JWT VC) | `[[wiki/systems/verified-identity]]` |
| Send transactional email (OTP, security notice) | `[[wiki/systems/email]]` |
| Surface session list / revoke per device | `[[wiki/systems/sessions]]` |
| Understand cross-service calls | `[[wiki/architecture/s2s-patterns]]` |
| Work on OSN identity / social UI | `[[wiki/apps/osn-core]]`, `[[wiki/apps/social]]` |
| Work on Pulse | `[[wiki/apps/pulse]]` |
| Work on Zap | `[[wiki/apps/zap]]` |
| Work on cire (wedding invites) | `[[wiki/apps/cire]]`, `[[wiki/systems/cire-auth]]` |
| Work on the cire marketing site / apex landing page (`@cire/landing`) | `[[wiki/apps/cire-landing]]` |
| Work on the OSN marketing site (`@osn/landing`) | `[[wiki/apps/osn-landing]]` |
| Work on the Pulse marketing site (`@pulse/landing`) | `[[wiki/apps/pulse-landing]]` |
| Deploy osn-api + cire to production (secrets/vars, migrations, CI pipeline, smoke checks) | `[[wiki/runbooks/production-deploy]]` |
| Check free-tier limits / what breaks at a cap / unavailability response / Cloudflare hardening TODO | `[[wiki/runbooks/free-tier-limits]]` |
| Debug auth failure | `[[wiki/runbooks/auth-failure]]` |
| Debug ARC verification failure | `[[wiki/runbooks/arc-token-debugging]]` |
| Debug rate-limit incident | `[[wiki/runbooks/rate-limit-incident]]` |
| Debug event-visibility leak | `[[wiki/runbooks/event-visibility-bug]]` |
| Wire new service into observability | `[[wiki/runbooks/observability-setup]]` |
| Check security or perf findings | `wiki/TODO.md` (Security Backlog / Performance Backlog sections) |
| Check which compliance standards apply (GDPR, SOC 2, CCPA, DSA, COPPA, EAA, ePrivacy) | `[[wiki/compliance/index]]`, `[[wiki/compliance/scope-matrix]]` |
| Add personal-data field, processor, or retention rule | `[[wiki/compliance/data-map]]`, `[[wiki/compliance/subprocessors]]`, `[[wiki/compliance/retention]]` |
| Build DSAR / account-export / account-delete endpoint | `[[wiki/compliance/dsar]]` |
| Respond to security incident or breach | `[[wiki/compliance/breach-response]]` |
| Set up production access / quarterly access review | `[[wiki/compliance/access-control]]` |
| Track progress and priorities | `wiki/TODO.md` |

### Searching the wiki

Check for Obsidian CLI first (requires Obsidian app running):

```bash
# 1. Check availability
which obsidian 2>/dev/null && OBSCLI=obsidian || OBSCLI=""

# 2a. If available — use obsidian CLI (vault-aware, follows [[wikilinks]])
obsidian search query="arc tokens"                     # full-text search
obsidian search:context query="arc tokens"             # search with line context
obsidian tag name=systems verbose                      # list files tagged #systems
obsidian read path=wiki/systems/arc-tokens.md          # read a page
obsidian backlinks file=arc-tokens                     # find pages linking to it
obsidian files folder=wiki/systems                     # list files in a folder

# 2b. Fallback — grep over markdown files (always works)
grep -r "arc token" wiki/ --include="*.md" -l          # find matching pages
grep -r "arc token" wiki/ --include="*.md" -n          # with line numbers
```

Note: `obsidian` CLI talks to running Obsidian app — fall back to grep if not open.

### Wiki maintenance rules

- **New system or pattern** → create wiki page, link from table above and `[[wiki/index]]`.
- **Modify existing pattern** → update wiki page in same PR.
- **Every wiki page must have YAML frontmatter** with `title`, `tags`, `related`, `last-reviewed`.
- **Use `[[wiki links]]`** between wiki pages; never relative markdown links.
- **Security/performance findings** in `wiki/TODO.md` include `[[wiki links]]` to affected system pages (e.g., `[[rate-limiting]]`, `[[arc-tokens]]`).
- **Update `last-reviewed`** in frontmatter of any wiki page you touch.

## Current State (summary)

Monorepo by domain. Five dirs, five prefixes — see `[[wiki/architecture/monorepo-structure]]` for full tree.

| Dir | Prefix | What lives here |
|-----|--------|-----------------|
| `osn/` | `@osn/*` | Identity stack (auth, graph, orgs, recommendations, SDK, landing, social app) — crypto moved to `@shared/crypto` |
| `pulse/` | `@pulse/*` | Events stack (app, API, DB) |
| `zap/` | `@zap/*` | Messaging stack (API on port 3002, DB) |
| `cire/` | `@cire/*` | Wedding-invite stack (guest site, organiser portal, API, DB) |
| `shared/` | `@shared/*` | Cross-cutting utils (`@shared/crypto` for ARC tokens, `@shared/email` for transactional mail, `@shared/observability`, `@shared/rate-limit`, `@shared/turnstile` for key-optional bot protection, `@shared/osn-auth-client` for downstream access-JWT verification) |

## Tech (one-liner)

Bun, TypeScript, Elysia, Effect.ts (trial), Drizzle, SQLite→Supabase, Eden+REST, WebSockets, Signal Protocol, SolidJS, Astro, Tauri, Turborepo, oxlint, oxfmt, Vitest + @effect/vitest

## Key Patterns

One-line summaries — open wiki page for full contract, API surface, finding history, observability.

| Pattern | Purpose | Wiki page |
|---|---|---|
| ARC Tokens | S2S auth via self-issued ES256 JWTs (kid + scope + audience). Lives in `@shared/crypto`. | `[[wiki/systems/arc-tokens]]` |
| Passkey-Primary Login | Only primary login factor. OTP/magic-link primary removed; OTP survives only as step-up. Account invariant: ≥1 WebAuthn credential always. | `[[wiki/systems/passkey-primary]]` |
| User Access Tokens | ES256 JWTs, **5-min TTL**, `aud: "osn-access"`. Public key at `/.well-known/jwks.json`; downstream services verify via `@shared/osn-auth-client` (`extractClaims` + JWKS cache + audience check; Elysia adapter). Client `authFetch` silent-refreshes on 401 from HttpOnly session cookie. | `[[wiki/systems/identity-model]]` |
| Cire Two-Auth Model | Guests use claim-code → opaque hashed session cookie (no OSN account); organisers use OSN passkey sign-in + access-JWT verification + wedding-ownership authz. The two middlewares never gate the same route — except the optional account-linking `POST /api/account/link`, which deliberately requires both (guest cookie binds the household, OSN token names the account; additive, not a privilege ladder). | `[[wiki/systems/cire-auth]]` |
| Server-side Sessions | Opaque `ses_*` refresh tokens, SHA-256 hashed at rest, 30-day sliding window. Rotated every `/token` grant; reuse → family revocation via `RotatedSessionStore`. Refresh token **only** in HttpOnly cookie (S-M1). | `[[wiki/systems/sessions]]` |
| Step-up (sudo) tokens | Short-lived `aud: "osn-step-up"` JWTs from fresh passkey/OTP ceremony. Required by `/recovery/generate`, `/account/email/complete`, security-event ack, passkey rename/delete. Single-use via `StepUpJtiStore`. | `[[wiki/systems/step-up]]` |
| Recovery Codes | Copenhagen Book M2 — 10 × 64-bit single-use codes, hashed at rest. Generate/consume both in `security_events` and surfaced via in-app banner. | `[[wiki/systems/recovery-codes]]` |
| Session Introspection | `GET/DELETE /sessions[/:id]`, `POST /sessions/revoke-all-other`. Coarse UA labels + HMAC-peppered IP hashes. | `[[wiki/systems/sessions]]` |
| Cross-Device Login | QR-code mediated session transfer. Device B begins + polls; device A scans QR, approves. 256-bit secret, SHA-256 hashed at rest, one-time consumption, 5-min TTL. In-memory store (Redis Phase 4). | `[[wiki/systems/sessions]]` |
| Email Change | Step-up gated; OTP to NEW address; atomically swaps email + revokes other sessions. Cap 2 changes / 7 days. | `[[wiki/systems/identity-model]]` |
| Email Transport | Transactional-only (OTPs + security notices). `EmailService` Effect Tag in `@shared/email`; `ResendEmailLive` POSTs to Resend's HTTP API (`api.resend.com/emails`, bearer-authed) — **preferred live transport** (works on workerd); `CloudflareEmailLive` is a legacy fallback; `LogEmailLive` captures in-memory for dev + tests. Selection precedence Resend → Cloudflare → Log (local) → Noop (`OSN_EMAIL_OPTIONAL`) → throw. With `RESEND_API_KEY` set the opt-in is unneeded. | `[[wiki/systems/email]]` |
| Origin Guard (M1) | Origin header validation on POST/PUT/PATCH/DELETE. ARC-protected internal routes exempt. | `osn/api/src/lib/origin-guard.ts` |
| Rate Limiting | Per-IP on auth endpoints; per-user on graph/org writes and `/recommendations/connections`. Behind Cloudflare, per-IP keys on `cf-connecting-ip` (`trustCloudflare`); the 60s auth-IP limiters run on **native Workers rate-limit bindings**, Upstash keeps the 1h-window IP limiters + all per-user/account limiters + stateful stores. Fail-closed. | `[[wiki/systems/rate-limiting]]`, `[[wiki/systems/redis]]` |
| Turnstile bot protection | Cloudflare Turnstile on osn register/login + cire claim/rsvp. Shared `@shared/turnstile` `createTurnstileVerifier`; **key-optional + fail-closed** (no secret ⇒ inert no-op; secret set ⇒ token required, rejects on missing/invalid/duplicate/unreachable). Shipped inert until a dashboard widget exists. | `[[wiki/systems/turnstile]]` |
| Observability | OpenTelemetry → Grafana Cloud. Three rules: no `console.*`, no raw OTel constructors, no unbounded metric attributes. | `[[wiki/observability/overview]]` |
| Testing | `it.effect` + `createTestLayer()` for service tests; `createXxxRoutes(createTestLayer())` for route tests. In-memory SQLite. | `[[wiki/conventions/testing-patterns]]` |
| Schema Layers | Elysia TypeBox at HTTP boundary, Effect Schema in services. Never mix. | `[[wiki/architecture/schema-layers]]` |
| Review Finding IDs | S-C/H/M/L (security), P-C/W/I (perf), T-M/U/E/R/S (tests). Four-field format (Issue / Why / Solution / Rationale). | `[[wiki/conventions/review-findings]]` |
| Component Library | Zaidan-style (shadcn for SolidJS) on Kobalte. Three class utils: `bx()` defaults, `clsx()` conditional joins, `cn()` only for arbitrary conflicts. | `[[wiki/architecture/component-library]]` |
| Share-source attribution | Closed `ShareSource` enum (`instagram | facebook | tiktok | x | whatsapp | copy_link | other`) drives the share picker, `?source=` URL injection, RSVP attribution columns (`share_source_first` sticky, `share_source_last` overwriting), and four bounded-cardinality counters. Single source of truth in `pulse/api/src/lib/shareSource.ts`; metric attribute type via `import type`. Lightweight `checkEventVisibility` (3 cols) gates the high-frequency share / exposure endpoints instead of the full `loadVisibleEvent`. Organiser self-RSVPs / self-views excluded. | `[[wiki/systems/event-access]]` |

## Conventions

| Area | Rule |
|---|---|
| Apps | Tauri apps created via CLI (`bunx create-tauri-app`), not manually |
| Functional core | Effect.ts trial in OSN/Pulse first, decision tracked in `wiki/TODO.md` Deferred Decisions |
| Effect runtime | Build the layer graph **once** (shared `ManagedRuntime` at boot), never `Effect.provide(DbLive/observability)` inside a per-request `runPromise` — it rebuilds the layer (restarts the OTel SDK + opens a new DB conn) every call. `@osn/api` threads one runtime through route factories via `makeAppRunner`. See `[[wiki/architecture/backend-patterns]]` |
| Messaging | `@zap/api` shared backend — Pulse consumes for event chats; users don't need Zap install |
| Privacy | E2E encryption everywhere; all personalisation data user-accessible + resettable |
| Platform priority | iOS > Web > Android (Android deferred) |
| Pre-commit | lefthook runs oxlint + oxfmt (auto-fix + re-stage) on staged files |
| Pre-push | lefthook runs type check |
| oxlint | `oxlintrc.json` — plugins: typescript, unicorn, oxc, import, promise, vitest, node, jsx-a11y (React plugin disabled — SolidJS) |
| oxfmt | `.oxfmtrc.json` — import sorting + Tailwind class sorting |
| Runtime | Use `bunx --bun` for all tooling |
| Branching | PRs required to merge to main; always work on feature branch |
| Changesets | Every PR includes changeset (`bun run changeset`) — CI fails without. Package names must match workspace `name` field exactly (e.g. `"@pulse/app"`, not `"pulse"`). Never mix ignored (version-less, e.g. `@cire/*`) and versioned packages in one changeset — split them; Changeset Check (`scripts/validate-changesets.sh`) enforces both rules |
| Versioning | Automatic — changesets consumed + committed by CI on merge to main |

## Commands

```bash
# Development
bun run dev              # Start all dev servers (turbo)
bun run dev:pulse        # Pulse work: pulse API + app, osn core, zap API
bun run dev:zap          # Zap work: zap API, osn core
bun run dev:osn          # OSN work: osn core + app
bun run dev:apis         # All backends only: osn core, pulse API, zap API
bun run dev:cire         # Cire work: cire API + web + organiser, osn core
bun run dev:landing      # Landing site only
bun run build            # Build all packages (turbo)
bun run check            # Type-check all packages (turbo)

# Testing
bun run test                          # run all tests (turbo, skips packages without test script)
bun run --cwd pulse/api test:run          # run Pulse events API tests once
bun run --cwd osn/api test:run            # run OSN API (auth + graph) tests once
bun run --cwd osn/client test:run         # run OSN client SDK tests once
bun run --cwd osn/ui test:run             # run shared auth component tests once
bun run --cwd pulse/db test:run           # run Pulse DB schema tests once
bun run --cwd pulse/api test              # watch mode
bun run --cwd zap/db test:run             # run Zap DB schema tests once
bun run --cwd zap/api test:run            # run Zap API service tests once

# Code quality
bun run lint             # oxlint
bun run fmt              # oxfmt format
bun run fmt:check        # oxfmt check (CI)

# Database (run from the relevant package directory)
bun run db:migrate       # Generate migrations
bun run db:push          # Push schema
bun run db:studio        # Drizzle Studio
# e.g. bun run --cwd pulse/db db:studio

# Versioning
bun run changeset        # Create changeset (required for every PR)
# Note: bun run version runs automatically on merge to main — do not run manually

# Maintenance
bun run clean            # git clean -fdX
bun run reset            # clean + reinstall

# Tauri (from app directory)
bunx tauri init          # Initialize app
bunx tauri dev           # Dev server
bunx tauri build         # Build app
```

## Workspace Installs

```bash
# Use --cwd (not --filter)
bun add solid-js --cwd osn/landing
bun add drizzle-orm --cwd pulse/db
```