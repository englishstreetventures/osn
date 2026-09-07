# CLAUDE.md

AI coding assistant ref. Full spec in README.md. Work tracked in GitHub Issues — `xchromo/osn` for product work, the private `xchromo/osn-tracker` for findings.

## Quick Context

OSN: Modular social platform. Users own identity + social graph. Apps opt-in/out independently.

**Deployed:** the cire stack is **live on the `cireweddings.com` zone** (all Cloudflare Free tier). Domain reshuffle 2026-07-16: apex `cireweddings.com` = marketing landing, `invite.cireweddings.com` = guest site, `host.cireweddings.com` = organiser portal; `vendor.cireweddings.com` joined them with the vendor portal (`cire/vendor`, its own Pages project and deploy job). **Identity moved to its own zone 2026-07-27:** `osn-api` is a deployed **Cloudflare Worker** on `id.musubi.social`, `@osn/social` (identity app + the OIDC consent screen) is on the apex `musubi.social`, and the WebAuthn RP ID is `musubi.social` — so the cireweddings.com origins can no longer run passkey ceremonies and sign in through the OIDC redirect flow instead (see `[[wiki/runbooks/musubi-identity-migration]]`). osn-api has Upstash prod secrets set; email is live over Resend from `hello@cireweddings.com` (`OSN_EMAIL_OPTIONAL` still exists as the degraded-boot opt-in — `selectEmailLayer` in `osn/api/src/lib/email-layer.ts` — and is unneeded once `RESEND_API_KEY` is set). `cire-api` on `api.cireweddings.com`; guest + organiser sites on Pages with custom domains. **Two tiers since 2026-08-13:** a merge to `main` auto-deploys the isolated **dev** tier (`*.dev.cireweddings.com`, `id.dev`/`dev.musubi.social`), and the production jobs in the same run wait on a human approving the `production` GitHub Environment — no more unattended deploys to live weddings. Path filters mean only changed surfaces deploy. See `[[wiki/runbooks/dev-environment]]`. Architectural decision: **osn-api stays a single Worker** (split deferred). See `[[wiki/runbooks/production-deploy]]`, `[[wiki/runbooks/free-tier-limits]]`.

Phase 1 surfaces:

| Surface | Package(s) | Status |
|---|---|---|
| Identity / auth API | `@osn/api` (port 4000; prod Worker `id.musubi.social`) | Active — **deployed (Worker)** |
| Identity & graph UI | `@osn/social` (port 1422; prod Pages `musubi.social`) | Active — **deployed (Pages)** |
| Events | `@pulse/web` + `@pulse/api` (port 3001) + `@pulse/db` | Active |
| Messaging | `@zap/api` (port 3002) + `@zap/db` | Backend only — per-package milestone status is on `[[wiki/apps/zap]]` |
| Wedding invites | @cire/api (:8787, prod `api.cireweddings.com`) + @cire/invites (:4321, prod `invite.cireweddings.com`) + @cire/host (:4322, prod `host.cireweddings.com`) + @cire/db + @cire/theme | Active — **deployed** (domain reshuffle 2026-07-16: guest→`invite.`, organiser→`host.`; package rename 2026-08-07: `@cire/web`→`@cire/invites`, `@cire/organiser`→`@cire/host`) |
| Wedding vendor portal | `@cire/vendor` (:4326, prod `vendor.cireweddings.com`) | Active — **deployed (Pages)**. The vendor self-service portal: claim flow and directory listing. See `[[wiki/systems/cire-vendors]]` |
| Wedding marketing site | `@cire/landing` (:4323) | Active — serves the **apex `cireweddings.com`** (reshuffle 2026-07-16). See `[[wiki/apps/cire-landing]]` |
| OSN marketing site | `@osn/landing` (:4324) | Active — built (dark/dotted, connections-led). See `[[wiki/apps/osn-landing]]` |
| Pulse marketing site | `@pulse/landing` (:4325) | Active — built (colourful + fun). See `[[wiki/apps/pulse-landing]]` |

## File Responsibilities

- `README.md` → Project spec, vision, features, tech stack, contributing (human-readable)
- `CLAUDE.md` → **the** AI entry point: quick context, conventions, commands, wiki nav.
  There is exactly one, at the repo root. A product with build conventions of its own
  gets a wiki page — `wiki/apps/<product>-development.md` — not a second `CLAUDE.md`
- `pulse/DESIGN.md` → Pulse visual design system: typography, color tokens, component catalog, layout patterns
- `wiki/TODO.md` → A pointer to GitHub Issues. No work is tracked in the wiki
- `wiki/` → Obsidian knowledge graph: architecture, systems, observability, runbooks, compliance. One vault for the whole monorepo — cire included
  - Open in Obsidian for graph view; or navigate via `[[wiki links]]`
  - See `[[wiki/index]]` for full content map

## Where Work Is Tracked

GitHub Issues, not the wiki. Two repos:

| Repo | Holds | Visibility |
|---|---|---|
| `xchromo/osn` | Product work, ops, docs, schema | Public |
| `xchromo/osn-tracker` | Every security, performance and compliance finding | Private |

Route by *kind*, never by severity: an `S-`, `P-` or `C-` ID goes to the tracker however minor it looks. `xchromo/osn` is public, and a finding names an unpatched route.

Every issue carries exactly one `product:` label — `osn-core`, `pulse`, `cire`, `zap`, `shared`, `landing` — and an org issue type: `Feature`, `Bug` or `Task`. An `area:` label is optional and only ever `security`, `performance`, `compliance`, `ops`, `docs` or `schema`; an issue with none is ordinary product work, which is what `Feature` already says. Findings also carry a `severity:`, taken from the tier letter in the ID. Every issue also carries a `complexity:` rating — `1`, `2`, `3`, `5` or `8` — declared **before** work starts, plus `complexity:unconfirmed` when no human signed off on it. It is the denominator every session-metrics query divides spend by, so a rating made after the cost is known is worthless; `/new-feat` sets it through the `rate-complexity` skill. See `[[wiki/observability/session-metrics]]`. Epics are parents with sub-issues, so a phased piece of work is one issue plus its parts.

```bash
gh issue list --repo xchromo/osn --state open --label product:pulse
gh issue list --repo xchromo/osn-tracker --state open --label severity:high
gh issue create --repo xchromo/osn --type Feature --label product:cire --title "..."
```

**Feature or fix work starts with `/new-feat`, in every environment.** It takes or opens the issue, cuts the branch, writes the plan to `NEW-FEAT.md` and runs `/stress-plan` against that plan before any code exists — the one gate with no downstream equivalent, since every later review checks the code against the plan rather than the plan against the repo. A `SessionStart` hook in `.claude/settings.json` says so at the top of each session. Skip it only for a one-line change on a branch that already exists. `/prep-pr` files findings at the end of a review. Label and type definitions, and the Project setup, are in `[[wiki/runbooks/github-issues-setup]]`; how a finding is filed is in `[[wiki/conventions/review-findings]]`.

One label is orthogonal to all of that: **`needs:decision`**, on both repos. It means the next step needs a choice only the repo owner can make. An agent working the backlog writes what the issue is and what it proposes, applies the label, and moves to a different issue — one open question never parks the queue. See `[[wiki/conventions/review-findings]]` §When the fix needs a decision from the owner.

**Never delete an issue — close it.** The history matters.

**Every issue body stands on its own.** Someone opens it months later with nothing checked out. Name the file and line; state the concrete fix or the observable "done when"; spell out the acronyms. A body whose content is a pointer — "see the TODO", "per `wiki/todo/api.md`", "migrated from …" — is a bookmark, not an issue, and the 2026-08-15 migration deleted every page those pointers named. Where a wiki page adds real context, reference it by **repo path** (`wiki/systems/rate-limiting.md`) and restate the fact in the issue anyway: a `[[wikilink]]` does not resolve on GitHub.

**Several PRs for one goal get stacked**, each based on the one below it — `[[wiki/conventions/stacked-prs]]`.

## Wiki Navigation

`wiki/` has detailed ref pages. Hot-path lookups below; full page-by-page map (per-app subsystems, Pulse sub-features, individual debug runbooks, compliance pages) → `[[wiki/index]]`:

| If you need to... | Read |
|---|---|
| Understand monorepo layout | `[[wiki/architecture/monorepo-structure]]` |
| Understand DB environments (local bun:sqlite vs dev/staging/prod D1) | `[[wiki/systems/database-environments]]` |
| Cut D1 latency with read replicas (the Sessions API, `first-primary`, one session per invocation, turning replication on) | `[[wiki/systems/d1-read-replication]]` |
| Write new Effect service or Elysia route | `[[wiki/architecture/backend-patterns]]`, `[[wiki/architecture/schema-layers]]` |
| Write Effect code (v4 — see §Effect v4 below for the API shapes that changed) | `[[wiki/architecture/backend-patterns]]`, `[[wiki/architecture/schema-layers]]`, `[[wiki/conventions/testing-patterns]]` |
| Understand accounts, profiles, orgs | `[[wiki/systems/identity-model]]` |
| Add or verify ARC S2S tokens | `[[wiki/systems/arc-tokens]]` |
| Let another app sign a user in with their OSN account (OIDC, PKCE, consent, pairwise `sub`) | `[[wiki/systems/oidc-provider]]` |
| Add a handle/name search (query normalisation, LIKE escaping, index-friendly prefix ranges — use `@shared/db-utils/search`, never a hand-rolled `LIKE 'q%'`) | `[[wiki/systems/social-graph]]` §Search |
| Add rate limiting to endpoint | `[[wiki/systems/rate-limiting]]`, `[[wiki/systems/redis]]` |
| Instrument logging, tracing, metrics | `[[wiki/observability/overview]]`, then specific page |
| See what an agent session cost a PR (token/cost cards, the complexity comparison, the DuckDB queries) | `[[wiki/observability/session-metrics]]` |
| Write or review tests | `[[wiki/conventions/testing-patterns]]` |
| Run the devloop (named HTTPS hosts per app, a stack per worktree, adding an app to it) | `[[wiki/conventions/devloop-urls]]` |
| Split one goal across several PRs (stacked PRs — setting the base with the gh CLI, merge order, rebasing a stack) | `[[wiki/conventions/stacked-prs]]` |
| Write, re-baseline or debug a guard that gates on a number (bundle budgets, and the two rules any such threshold obeys) | `[[wiki/conventions/bundle-size-guards]]` |
| Add or use UI component (Button, Card, Dialog…) | `[[wiki/architecture/component-library]]` |
| Raise a toast, theme one for an app, or debug a toast's stacking/contrast | `[[wiki/systems/toast]]` |
| Add drag-to-reorder to a list (and get the keyboard + screen-reader path for free) | `[[wiki/architecture/drag-and-drop]]` |
| Prototype a component, a three.js scene or canvas work in isolation (`bun run dev:lab`, `https://lab.localhost`) | `[[wiki/conventions/component-lab]]`, `tools/lab/README.md` |
| Work on a specific app/surface (osn-core, social, pulse, zap, cire, cire-landing, osn-landing, pulse-landing) | `[[wiki/apps/<name>]]` |
| Build cire itself (Elysia `aot: false`, the middleware/role gates, the two test tiers, the by-hand deploy) | `[[wiki/apps/cire-development]]` |
| Hit a Solid/Motion/Tailwind rendering bug the unit tests cannot see (computed classes, `createMemo` TDZ, `transform` breaking `position: fixed`, Motion One's leftover inline styles, sticky offsets) | `[[wiki/architecture/frontend-patterns]]` §Rendering and animation gotchas |
| Build the OIDC consent screen (states, decision-error contract, login_required retry loop) | `[[wiki/apps/authorize-ui]]` |
| Work on a cire organiser module (budget, checklist, entitlements, registry, vendors, RSVP deadline) | `[[wiki/systems/cire-budget]]`, `[[wiki/systems/cire-checklist-tasks]]`, `[[wiki/systems/cire-entitlements]]`, `[[wiki/systems/cire-registry]]`, `[[wiki/systems/cire-vendors]]`, `[[wiki/systems/cire-rsvp-deadline]]` |
| Change the cire invite (slots, images, theming, design selector) | `[[wiki/architecture/cire-invite-builder]]`, `[[wiki/systems/cire-invite-designs]]` |
| Understand where cire is going (guests/events decoupled, vendors, pricing, seating, comms) | `[[wiki/architecture/cire-platform-plan]]` |
| Add a third party to a cire page (cookies, CSP, the consent gate) | `[[wiki/architecture/cire-consent]]` |
| Write a test that needs real CSS or layout (the Chromium Vitest project) | `[[wiki/conventions/browser-tests]]` |
| Deploy osn-api + cire to production (secrets/vars, migrations, CI pipeline, smoke checks) | `[[wiki/runbooks/production-deploy]]` |
| Use the dev tier — what deploys automatically, how to promote past the approval gate, how to reset dev | `[[wiki/runbooks/dev-environment]]` |
| Check free-tier limits / what breaks at a cap / Cloudflare hardening TODO | `[[wiki/runbooks/free-tier-limits]]` |
| Move OSN identity to `musubi.social` (RP-ID change, credential bridge, cutover order) | `[[wiki/runbooks/musubi-identity-migration]]` |
| Debug auth / ARC / rate-limit / event-visibility failure | `wiki/runbooks/` (`auth-failure`, `arc-token-debugging`, `rate-limit-incident`, `event-visibility-bug`) |
| Check security or perf findings | `gh issue list --repo xchromo/osn-tracker --state open` — see `[[wiki/conventions/review-findings]]` |
| Check which compliance standards apply, or add personal-data field/DSAR/breach/access-review work | `[[wiki/compliance/index]]` |
| Track progress and priorities | GitHub Issues + the OSN Platform Project — see §Where Work Is Tracked |

### Searching the wiki

Three tiers. Try each, drop to the next when it isn't there:

1. **Obsidian MCP** (`mcp__obsidian-wiki__*`) — semantic search, outlines,
   backlinks. **Local machine with Obsidian open, and nowhere else.**
2. **The `obsidian` CLI** — same limits: local machine, app running.
3. **grep** — works everywhere, including remote and CI.

```bash
grep -r "arc token" wiki/ --include="*.md" -l          # find matching pages
grep -r "arc token" wiki/ --include="*.md" -n          # with line numbers
```

Two rules that apply to the first two tiers and cost real time when missed.
**Both are read-only**: they act on the `main` worktree's `wiki/`, so a write
through either edits `main`'s working tree instead of your branch. And **both
show you `main`, not your branch** — before trusting a page this branch might
have changed, run the guard, not a re-read:

```bash
git diff --name-only origin/main...HEAD -- wiki/   # pages this branch changed
```

Empty output, the usual case, means the results are authoritative. Anything in
that list, read with Read instead.

The rest — which tool answers which kind of question, where each tier does and
does not exist, vault-relative paths, keeping the vault fresh — is in
`[[wiki/conventions/wiki-search]]`. Grep can read that page from any session,
which is why the grep tier is written out here rather than only there.

### Writing to the wiki

Searching is the three tiers above. **Writing is always Edit/Write in your own worktree** — never the MCP write tools, never `obsidian create`/`append`/`property:set`. Both of those target `main`'s working tree.

Invoke the **`obsidian:obsidian-markdown` skill** before writing or restructuring any page under `wiki/`. It is the syntax authority for the flavour this vault is in: wikilinks (`[[Note#Heading]]`, `[[Note#^block-id]]`, `[[Note|alias]]`), embeds (`![[…]]`), callouts (`> [!warning]`, `> [!faq]-` for collapsed), properties, `#nested/tags`, `%%comments%%`, `==highlights==`, and mermaid nodes that link back to notes (`class NodeName internal-link;`). Don't hand-guess the syntax — half of it is not CommonMark.

Two rendering surfaces, and pages are read on both:

| Feature | Obsidian | GitHub |
|---|---|---|
| Tables, mermaid, footnotes | Yes | Yes |
| Callouts — `note`/`tip`/`important`/`warning`/`caution` only | Yes | Yes (GitHub alerts, same syntax) |
| Any other callout type, `[[wikilinks]]`, embeds, block IDs, `==highlight==` | Yes | No — renders as literal text |
| `.base` (Obsidian Bases) and `.canvas` (JSON Canvas) files | Yes | No — raw YAML/JSON |

So: tables and mermaid for anything a reader might hit through GitHub; the Obsidian-only features where the vault is the real audience. `.base` and `.canvas` are additions to a page's prose, never a replacement for it — a remote or CI session only has grep, and grep can't read either.

### Wiki maintenance rules

- **New system or pattern** → create wiki page, link from table above and `[[wiki/index]]`.
- **Product-specific build conventions** → `wiki/apps/<product>-development.md`, linked from
  that product's overview page. Never a nested `CLAUDE.md`. Put a fact there only if it is
  genuinely that product's alone — anything true of another Solid or Workers package belongs
  in `[[wiki/architecture/frontend-patterns]]`, `[[wiki/architecture/backend-patterns]]` or
  `[[wiki/conventions/testing-patterns]]`, where the next person will actually find it.
- **Modify existing pattern** → update wiki page in same PR.
- **Every wiki page must have YAML frontmatter** with `title`, `tags`, `related`, `last-reviewed`.
- **Use `[[wiki links]]`** between wiki pages; never relative markdown links. `wiki/` is the only vault — the second one at `cire/wiki/` folded into it on 2026-08-21, and every cire page is now a plain wikilink (`[[cire-vendors]]`, `[[cire-platform-plan]]`, `[[cire-invite-builder]]`). Cire pages carry a `cire-` prefix where a bare name would collide.
- **Security/performance findings** are issues in `xchromo/osn-tracker`, and the body names the affected wiki page by path (e.g. `wiki/systems/rate-limiting.md`) — a wikilink does not resolve on GitHub.
- **Update `last-reviewed`** in frontmatter of any wiki page you touch.

## Current State (summary)

Monorepo by domain. Five dirs, five prefixes — see `[[wiki/architecture/monorepo-structure]]` for full tree.

| Dir | Prefix | What lives here |
|-----|--------|-----------------|
| `osn/` | `@osn/*` | Identity stack (auth, graph, orgs, recommendations, SDK, landing, social app) — crypto moved to `@shared/crypto` |
| `pulse/` | `@pulse/*` | Events stack (app, API, DB) |
| `zap/` | `@zap/*` | Messaging stack (API on port 3002, DB) |
| `cire/` | `@cire/*` | Wedding-invite stack (guest site, organiser portal, API, DB) |
| `shared/` | `@shared/*` | Cross-cutting utils (`@shared/crypto` for ARC tokens, `@shared/email` for transactional mail, `@shared/observability`, `@shared/rate-limit`, `@shared/turnstile` for key-optional bot protection, `@shared/osn-auth-client` for downstream access-JWT verification, `@shared/toast` + `@shared/sortable` for the SolidJS toast and drag-to-reorder surfaces) |

## Tech (one-liner)

Bun, TypeScript, Elysia, Effect.ts (trial), Drizzle, `bun:sqlite` locally → Cloudflare D1 deployed, Eden+REST, WebSockets, Signal Protocol, SolidJS, Astro, Turborepo, oxlint, oxfmt, Vitest + @effect/vitest (`@cire/api` runs on `bun test`)

## Key Patterns

One-line summaries — open wiki page for full contract, API surface, finding history, observability.

| Pattern | Purpose | Wiki page |
|---|---|---|
| ARC Tokens | S2S auth via self-issued ES256 JWTs (kid + scope + audience). Lives in `@shared/crypto`. | `[[wiki/systems/arc-tokens]]` |
| Passkey-Primary Login | Only primary login factor. OTP/magic-link primary removed; OTP survives only as step-up. Account invariant: ≥1 WebAuthn credential always. | `[[wiki/systems/passkey-primary]]` |
| User Access Tokens | ES256 JWTs, **5-min TTL**, `aud: "osn-access"`. Public key at `/.well-known/jwks.json`; downstream services verify via `@shared/osn-auth-client` (`extractClaims` + JWKS cache + audience check; Elysia adapter). Client `authFetch` silent-refreshes on 401 from HttpOnly session cookie. | `[[wiki/systems/identity-model]]` |
| Cire Consent Framework | Site-wide cookie/third-party consent on the cire guest site. Categories are the unit of consent; one vendor registry drives the preferences dialog, the `/privacy` disclosure and (by test) the CSP allowlist. `<ConsentGate>` doesn't *render* gated children, so their effects never run. Defaults are **opt-out** for third-party content, opt-in for analytics — and three grant maps (floor / pre-decision / accept-all) are kept distinct so a refusal is never briefly ignored. | `[[wiki/architecture/cire-consent]]` |
| Cire Two-Auth Model | Guests use claim-code → opaque hashed session cookie (no OSN account); organisers use OSN passkey sign-in + access-JWT verification + wedding-ownership authz. The two middlewares never gate the same route — except the optional account-linking `POST /api/account/link`, which deliberately requires both (guest cookie binds the household, OSN token names the account; additive, not a privilege ladder). | `[[wiki/systems/cire-auth]]` |
| Server-side Sessions | Opaque `ses_*` refresh tokens, SHA-256 hashed at rest, 30-day sliding window. Rotated every `/token` grant; reuse → family revocation via `RotatedSessionStore`. Refresh token **only** in HttpOnly cookie (S-M1) — so **any browser call that sets or reads it MUST pass `credentials: "include"`**. The issuer (`id.musubi.social`) is a different origin from every app that calls it, and a cross-origin `fetch` on the default `same-origin` mode silently discards `Set-Cookie` — no error, no warning, just no session. This is the bug class behind the 2026-08-06 registration fix; check it first whenever a ceremony "succeeds" but the user is still signed out. | `[[wiki/systems/sessions]]` |
| Step-up (sudo) tokens | Short-lived `aud: "osn-step-up"` JWTs from fresh passkey/OTP ceremony. Required by `/recovery/generate`, `/account/email/complete`, security-event ack, passkey rename/delete. Single-use via `StepUpJtiStore`. **Purpose-bound at every gate** (`passkey_register`/`passkey_delete`/`email_change`/`security_event_ack`/`recovery_generate`): a verifier requires its own `purpose` claim, so a token minted for one ceremony can't be replayed at another before its jti is consumed. | `[[wiki/systems/step-up]]` |
| Recovery Codes | Copenhagen Book M2 — 10 × 64-bit single-use codes, hashed at rest. Generate/consume both in `security_events` and surfaced via in-app banner. | `[[wiki/systems/recovery-codes]]` |
| Session Introspection | `GET/DELETE /sessions[/:id]`, `POST /sessions/revoke-all-other`. Coarse UA labels + HMAC-peppered IP hashes. | `[[wiki/systems/sessions]]` |
| OIDC Provider | `@osn/api` is an OpenID Connect provider, so other apps recognise an OSN account without holding a passkey. Authorization code + PKCE (S256 only), pairwise `sub` per client sector, consent stored per (account, client). Invalid client / redirect URI **renders** an error, never redirects (open-redirect guard). Codes hashed, single use, 60s TTL. No refresh tokens, never an `osn-access` audience. Hardened 2026-07-24: real `auth_time` + `max_age`/`prompt=login` enforcement, per-request browser-binding cookie, reserved client-id deny-list + `typ: at+jwt`, `GET/DELETE /oidc/connections` (revoke kills in-flight codes). Hardened 2026-07-29: self-serve client sector = its own `client_id` (colluding clients can't share a sector); `auth_time` survives silent rotation via `sessions.authenticated_at`; consent-screen anti-impersonation (name confusable-skeleton block + verified-app/third-party-host signal); RFC 9207 `iss`; required browser-binding on every parked request; consent revocation is now a live Settings surface (`@osn/social` "Connected apps"). | `[[wiki/systems/oidc-provider]]` |
| Cross-Device Login | QR-code mediated session transfer. Device B begins + polls; device A scans QR, approves. 256-bit secret, SHA-256 hashed at rest, one-time consumption, 5-min TTL. Stored in the shared ceremony-store bundle — Redis-backed where a client is configured (`osn/api/src/lib/redis-ceremony-stores.ts`), in-memory otherwise. | `[[wiki/systems/sessions]]` |
| Email Change | Step-up gated; OTP to NEW address; atomically swaps email + revokes other sessions. Cap 2 changes / 7 days. | `[[wiki/systems/identity-model]]` |
| Email Transport | Transactional-only (OTPs + security notices). `EmailService` Effect Tag in `@shared/email`; `ResendEmailLive` POSTs to Resend's HTTP API (`api.resend.com/emails`, bearer-authed) — **preferred live transport** (works on workerd); `CloudflareEmailLive` is a legacy fallback; `LogEmailLive` captures in-memory for dev + tests. Selection precedence Resend → Cloudflare → Log (local) → Noop (`OSN_EMAIL_OPTIONAL`) → throw. With `RESEND_API_KEY` set the opt-in is unneeded. | `[[wiki/systems/email]]` |
| Origin Guard (M1) | Origin header validation on POST/PUT/PATCH/DELETE. ARC-protected internal routes exempt. | `osn/api/src/lib/origin-guard.ts` |
| Rate Limiting | Per-IP on auth endpoints; per-user on graph/org writes and `/recommendations/connections`. Behind Cloudflare, per-IP keys on `cf-connecting-ip` (`trustCloudflare`); the 60s auth-IP limiters run on **native Workers rate-limit bindings**, Upstash keeps the 1h-window IP limiters + all per-user/account limiters + stateful stores. Fail-closed. | `[[wiki/systems/rate-limiting]]`, `[[wiki/systems/redis]]` |
| Turnstile bot protection | Cloudflare Turnstile on osn register/login + cire claim/rsvp. Shared `@shared/turnstile` `createTurnstileVerifier`; **key-optional + fail-closed** (no secret ⇒ inert no-op; secret set ⇒ token required, rejects on missing/invalid/duplicate/unreachable). Shipped inert until a dashboard widget exists. | `[[wiki/systems/turnstile]]` |
| Toasts | `@shared/toast` — internal SolidJS toasts. Styled from `--toast-*` custom properties each app maps onto its own tokens, so no `!important` and no library-owned `z-index` (the layer is a class). Portalled to `<body>` so an ancestor `transform` can't trap the fixed container. Tone is a distinct glyph shape + `sr-only` word, never hue alone; errors `assertive`, the rest `polite`. | `[[wiki/systems/toast]]` |
| Drag-to-reorder | `@shared/sortable` — internal, replacing the unmaintained solid-dnd. Pointer sensor with an activation threshold, `closestCenter`, provider-scoped groups for multi-container lists. `createSortableList` owns the five accessibility obligations (real button grip, `sr-only` move buttons for browse mode, focus restore, clear-before-set live region, no auto-repeat) so adopting drag is no longer an accessibility project. | `[[wiki/architecture/drag-and-drop]]` |
| Observability | OpenTelemetry → Grafana Cloud. Three rules: no `console.*`, no raw OTel constructors, no unbounded metric attributes. | `[[wiki/observability/overview]]` |
| Testing | `it.effect` + `createTestLayer()` for service tests; `createXxxRoutes(createTestLayer())` for route tests. In-memory SQLite. | `[[wiki/conventions/testing-patterns]]` |
| Schema Layers | Elysia TypeBox at HTTP boundary, Effect Schema in services. Never mix. | `[[wiki/architecture/schema-layers]]` |
| Review Finding IDs | S-C/H/M/L (security), P-C/W/I (perf), T-M/U/E/R/S (tests). Four-field format (Issue / Why / Solution / Rationale). | `[[wiki/conventions/review-findings]]` |
| Stacked PRs | Branch cut from the parent branch, `git config branch.<name>.gh-merge-base <parent>` at worktree creation, `gh pr create --base` — that fixes the diff. The stack itself is a separate object GitHub never infers: register it with `gh stack link <bottom-pr> … <top-pr>` (extension `github/gh-stack`). | `[[wiki/conventions/stacked-prs]]` |
| Component Library | Zaidan-style (shadcn for SolidJS) on Kobalte. Component defaults use `base:`-prefixed classes written directly in source; two class utils cover the rest: `clsx()` conditional joins, `cn()` only for arbitrary conflicts. | `[[wiki/architecture/component-library]]` |
| Share-source attribution | Closed `ShareSource` enum (`instagram | facebook | tiktok | x | whatsapp | copy_link | other`) drives the share picker, `?source=` URL injection, RSVP attribution columns (`share_source_first` sticky, `share_source_last` overwriting), and four bounded-cardinality counters. Single source of truth in `pulse/api/src/lib/shareSource.ts`; metric attribute type via `import type`. Lightweight `checkEventVisibility` (3 cols) gates the high-frequency share / exposure endpoints instead of the full `loadVisibleEvent`. Organiser self-RSVPs / self-views excluded. | `[[wiki/systems/event-access]]` |

## Effect v4

The repo moved off Effect v3 on 2026-09-06 and is pinned at the exact
`4.0.0-rc.112` (pre-GA, so exact rather than caret). Everything below is a v3
form that will not compile, and the v4 form to write instead. Most of the
surface is unchanged — `Effect.gen`, `provide`, `runPromise`, `tryPromise`,
`fail`, `flip`, `withSpan`, `catchTag`, `provideService`, `annotateLogs`,
`Layer.effect`/`succeed`/`merge`, `Option.*`, `Exit.*`, `it.effect`, `it.layer`,
and **`Data.TaggedError`**, which is this repo's whole error vocabulary and
needed zero edits.

### Renames

| v3 | v4 |
| --- | --- |
| `Effect.catchAll` / `catchAllDefect` / `catchAllCause` | `Effect.catch` / `catchDefect` / `catchCause` |
| `Effect.either` | `Effect.result` |
| `Effect.zipRight` / `forkDaemon` / `dieMessage` | `Effect.andThen` / `forkDetach` / `die(new Error(…))` |
| `Effect.yieldNow()` | `Effect.yieldNow` — a value, not a call |
| `Layer.scoped` | `Layer.effect` — it supplies and excludes the `Scope` |
| `Either` module | `Result` — tags are `"Success"`/`"Failure"` |
| `Cause.failureOption` | `Cause.findErrorOption` |
| `Context.Tag(id)<Self, Shape>()` | `Context.Service<Self, Shape>()(id)` — argument order flips; `Context.Tag<I, S>` in **type** position is `Context.Key<I, S>` |

Service **identifier strings** are runtime lookup keys. Preserve them exactly
through any such rewrite — a typo is a service-not-found at request time, not a
compile error.

### Errors, `Cause` and `Runtime`

`FiberFailure` is gone. `runPromise` rejects with `Cause.squash(cause)`, which
for a typed failure is the tagged error itself — so a `catch` that checks
`_tag` now matches. The catch: where v3's `Cause.failureOption` returned `None`
for a **defect**, `squash` hands you the defect object, which can carry an
internal message. Gate on the tag before showing a rejection to anyone.

`Cause` is a flat list of reasons, so there is no `Fail` node:

```ts
// v3: exit.cause._tag === "Fail" && exit.cause.error instanceof NotFound
Option.getOrUndefined(Cause.findErrorOption(exit.cause)) instanceof NotFound
```

`ManagedRuntime` no longer extends `Effect`; `runtimeEffect`/`runtime` are
`contextEffect`/`context`, and `Runtime<R>` is replaced by `Context<R>`.

### Schema

`Schema.decodeUnknown` is `decodeUnknownEffect`, and its failure is tagged
**`SchemaError`**, not `ParseError` — that is what `catchTag` takes. Constraint
combinators are *checks*, applied with a schema's `.check(…)`:

```ts
Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 99 }))
Schema.String.check(Schema.isPattern(/^\d{4}$/))
Schema.String.check(Schema.makeFilter((s) => ok(s) ? undefined : "why not"))
```

`isMinLength`/`isMaxLength` cover collections too (v3's `minItems`/`maxItems`).
A `makeFilter` returns `undefined`/`true` for success and **a string as the
failure message**; a check's `message` annotation is a plain string, not a
thunk. `.check(a, b)` short-circuits on the first failure, so ordering a cheap
bound before an expensive lookup still works.

Four more, and the first two fail quietly:

- **`Schema.Literal` takes one literal, `Schema.Union` takes one array.** Pass
  the v3 variadic shape and the extra members are dropped rather than rejected;
  the mistake surfaces later as `{}` where a real type was expected, or as a
  union that has stopped rejecting one of its cases. Use
  `Schema.Literals([…])` and `Schema.Union([…])`.
- **Decode messages no longer echo the input.** v4 renders a reason line plus
  an `at ["path"]` line where v3 wrote `Expected number, actual "x"`. A test
  pinned to the old text passes vacuously if it only checks something threw.
- `Schema.optionalWith(S, { default: () => v })` →
  `S.pipe(Schema.withDecodingDefaultType(Effect.succeed(v)))`.
- `Schema.transform(from, to, {decode, encode})` →
  `from.pipe(Schema.decodeTo(to, SchemaTransformation.transform({ decode, encode })))`.
  Often unnecessary: `Schema.Trim.check(…)` covers "trim then bound", and
  `Schema.DateFromString` now rejects a string that parses to an Invalid Date,
  which is what three hand-rolled transforms here existed for.
  `Schema.parseJson(S)` is `Schema.fromJsonString(S)`; `DateFromSelf` is `Date`;
  `Schema.Record({key, value})` is positional, `Schema.Record(key, value)`.

### Logging

`Logger.layer([…])` **replaces the whole active set**, so
`Logger.tracerLogger` must be listed explicitly or log-to-span correlation
disappears with no error and no failing type-check. Levels are string literals
(`"Warn"`, not v3's `"Warning"`), the minimum level is
`References.MinimumLogLevel` rather than `Logger.withMinimumLogLevel`,
annotations live on the fiber rather than the logger's `Options`, and **the
JSON severity field is `level`, not `logLevel`** — a Grafana query on the old
name matches nothing. `@shared/observability` owns all of this; see
`[[wiki/observability/logging]]`.

### Layer memoization

The `MemoMap` is shared across `Effect.provide` calls **within one run**, not
across separate `runPromise` roots. A per-request `Effect.provide(scopedLayer)`
is a new root every time, so it still **builds and tears the layer down on
every request** — measured, 5 provides → 5 acquires and 5 releases, against a
`ManagedRuntime`'s 1 acquire and 0 releases. So the v3 rebuild-cost argument
for a shared runtime is not weakened at all where it matters; if anything the
§Conventions "Effect runtime" rule is understated.

## Conventions

| Area | Rule |
|---|---|
| Native apps (iOS) | Swift. One local SPM package at `shared/swift/OSNShared` with four library products — `OSNKit`, `OSNAuth`, `OSNUI`, `OSNTesting`; consumers depend on `.product(name: "OSNKit", package: "OSNShared")`. App targets are thin: all code lives in packages, `*.xcodeproj` is generated by XcodeGen from a committed `project.yml` and is gitignored. **Every target must compile against the macOS SDK too** — `platforms:` is package-level (SPM has no per-target platform) and `swift test` builds every target on the host, so a bare `import UIKit` anywhere in `OSNShared` fails CI. SwiftUI and Liquid Glass exist on macOS 26; genuinely UIKit-only code goes behind `#if canImport(UIKit)` or into the app target |
| Functional core | **Effect.ts is the backend, settled — not a trial.** Every backend (`osn/api`, `cire/api`, `pulse/api`, `zap/api`), the shared packages and `@osn/client` are built on it, and the 2026-09-06 v4 migration was carried out on that basis. `effect` and `@effect/vitest` are pinned at the exact `4.0.0-rc.112` across 13 packages — exact rather than caret because it is pre-GA. Nothing is left on v3. The API shapes that moved are in §Effect v4. **The frontends use Effect nowhere**, and that stays an open question rather than a rule: it gets evaluated when the Solid apps move to Solid v2, not before |
| Effect runtime | Build the layer graph **once** (shared `ManagedRuntime` at boot), never `Effect.provide(DbLive/observability)` inside a per-request `runPromise`. The reason is lifecycle ownership — one OTel SDK and one DB connection per process, owned by something that can close them. The rebuild-cost reason still holds too: v4's shared `MemoMap` spans one run, not separate `runPromise` roots, so a per-request `Effect.provide` of a scoped layer acquires AND releases it every request (measured: 5 provides → 5 acquires, 5 releases; a `ManagedRuntime` → 1 and 0). `@osn/api` threads one runtime through route factories via `makeAppRunner`. See `[[wiki/architecture/backend-patterns]]` |
| Messaging | `@zap/api` shared backend — Pulse consumes for event chats; users don't need Zap install |
| Privacy | E2E encryption everywhere; all personalisation data user-accessible + resettable |
| Platform priority | iOS > Web > Android (Android deferred) |
| Map-membership guards | A guard that narrows to `keyof typeof MAP` must test `Object.hasOwn(MAP, key)`, never `key in MAP`. `in` walks the prototype chain, so `constructor`, `toString` and `__proto__` pass and the predicate then asserts an inherited `Object.prototype` member is a real entry. `house/no-in-operator-key-guard` (in `tools/oxlint/house`) is an error, and it matches the narrowed parameter rather than the literal `keyof typeof` syntax, so an aliased predicate is caught too — see `cire/theme/src/palette.ts` for the house form |
| Non-subscribing store reads | In a `*-store.ts` organiser cache (cire only), `entryFor(id).accessor()` is the subscribing read — it mints the cache entry, so a tracked read always has something to register a dependency on. `cache.get(id)?.accessor()` does not mint the entry: when it is absent the read short-circuits before `accessor` ever runs, so a tracked read registers zero dependencies and never re-runs once the entry is created. That non-minting form is confined to `peekCached*`/`hasCached*` functions, whether written as the direct `cache.get(id)?.accessor()` chain or split across a `const entry = cache.get(id)` and a later `entry?.accessor()` / guarded `entry.accessor()`. `house/no-non-subscribing-store-read` (in `tools/oxlint/house`) enforces it as an error, scoped to `cire/**/*-store.ts` |
| Where tests live | `tests/` at the package root, mirroring `src/` — **never** beside the source. Test-only support code (mocks, request harnesses, fixtures) lives there too, so `src/` holds nothing test-shaped: `cire/api/tests/test-helpers/`, `cire/host/tests/test-support/`. `scripts/` is not a workspace but follows the same rule (`scripts/tests/`, shell tests included). The one deliberate carve-out is the Miniflare-backed D1 tier at `tests/d1/` (cire's at `tests/db/`), which the vitest configs exclude by path because it imports `bun:test` and boots workerd — `bun run test:d1` is the only thing that runs it. See `[[wiki/conventions/testing-patterns]]` |
| Pre-commit | lefthook runs oxlint + oxfmt (auto-fix + re-stage) on staged files |
| Pre-push | lefthook runs type check |
| oxlint | `oxlintrc.json` — plugins: typescript, unicorn, oxc, import, promise, vitest, node, jsx-a11y (React plugin disabled — SolidJS) |
| oxfmt | `.oxfmtrc.json` — import sorting + Tailwind class sorting |
| Runtime | Use `bunx --bun` for all tooling |
| Branching | PRs required to merge to main; always work on feature branch |
| Changesets | Every PR includes changeset (`bun run changeset`) — CI fails without. Package names must match workspace `name` field exactly (e.g. `"@pulse/web"`, not `"pulse"`). Never mix ignored (version-less, e.g. `@cire/*`) and versioned packages in one changeset — split them; Changeset Check (`scripts/validate-changesets.sh`) enforces both rules. **One exception**, added with the Swift work: a PR that touches nothing any versioned package ships — `shared/swift/`, `pulse/ios/`, `osn/ios/`, `.github/`, `.claude/`, `scripts/`, `wiki/`, `docs/`, top-level prose — needs no changeset, because there is no honest package to name. The test is an **allowlist** (`scripts/changeset-required.sh`, fixtures in `changeset-required.test.sh`): anything not on it, including `bun.lock` and root `turbo.json`/`tsconfig.json`, still requires one. `.changeset/config.json` must keep `"privatePackages": { "version": true, "tag": false }` — every workspace package here is `private: true`, and `@changesets/config` 4 (shipped with CLI 3) defaults that key's `version` to `false`, so dropping the line makes `changeset add` abort with "No versionable packages found" and stops versioning outright |
| Versioning | Automatic — changesets consumed + committed by CI on merge to main |
| Dependency soak | `bunfig.toml` sets `minimumReleaseAge = 259200` (3 days) so a fresh publish cannot install straight away. An entry in `minimumReleaseAgeExcludes` is a hole in that, so it must carry a `# DROP AFTER <name> <YYYY-MM-DD>` marker comment in the same file, dated no more than 30 days out. `scripts/check-release-age-excludes.ts` (CI step in the `script-tests` job, `bun run check:release-age-excludes` locally) fails on a missing, invalid, expired or over-long marker, and on `minimumReleaseAge` itself dropping below 259200 |
| Vendored trees | `tools/oxlint` holds two plugins and they are not the same kind of thing. `tools/oxlint/house` is ours: a real workspace (`@tools/oxlint-house`), formatted, linted, typechecked and tested like any other package, and where a rule this repo needs but nobody publishes belongs. `tools/oxlint/anti-slop` is a verbatim upstream copy — excluded from oxfmt and oxlint, MIT licence vendored beside it. Its `SHA256SUMS` covers every tracked file and CI checks both the checksums and the file set, so a re-vendor must regenerate it with the recipe in that directory's `README.md`. `.github/CODEOWNERS` puts the tree under a human owner, along with `scripts/`, `.github/`, `bunfig.toml` and the files that decide a guard runs at all (`package.json`, `oxlintrc.json`, `lefthook.yml`) |
| Agent skills and their evals | A procedure an agent follows lives in `.claude/skills/<name>/SKILL.md`, and nowhere else. **Every skill here is ours.** No third-party skill is installed, so there is no `.agents/` tree and no `skills-lock.json`, and neither path is in `.github/CODEOWNERS` or the changeset allowlist any more — an allowlist entry for a path nothing writes is a hole nobody is watching. The two `Effect-TS/skills` ones went with the v4 migration, since a migration skill has no second use and what it taught is in §Effect v4. To install one again, use `npx skills add <owner>/<repo>` rather than copying the text in (so `npx skills update` can move the pin) — it lands in `.agents/skills/<name>/` with a `.claude/skills/<name>` symlink and a content-hashing `skills-lock.json`, and **the same commit must restore the CODEOWNERS and allowlist entries for both paths**: that tree is someone else's instructions running with full agent permissions. Claude Code invokes a skill as `/<name>`, so a wrapper in `.claude/commands/` buys nothing and only splits the procedure across two files that drift; the older commands still in that directory are the ones not yet converted. Skills are also what makes a procedure measurable: `.claude/` is a Tessl plugin (`.tessl-plugin/plugin.json`), and each scenario under `.claude/evals/<scenario>/` runs an agent with and without the skill and scores the gap. A scenario pins a real commit of this repo and builds its branch in `setup.sh`, and that commit ships whatever `.claude/` held at the time, so `setup.sh` deletes it — `exclude` in `scenario.json` does not. Every merged fix PR is a free labelled scenario — pin its parent SHA, one checklist item per finding it fixed. `.claude/settings.json` is committed, so its hooks travel to the remote environment — that is what makes a standing rule hold in a session that never reads a local config. Personal hooks and permissions belong in `.claude/settings.local.json`, which is gitignored; a personal untracked `settings.json` will block the pull that first brings the tracked one down. See `.claude/evals/README.md` |

## Commands

```bash
# Development
bun run dev              # Start all dev servers (turbo)
bun run dev:pulse        # @pulse/api + @pulse/web + @osn/api + @zap/api
bun run dev:zap          # @zap/api + @osn/api
bun run dev:osn          # @osn/api alone
bun run dev:social       # @osn/social + @osn/api
bun run dev:apis         # backends only: @osn/api + @pulse/api + @zap/api
bun run dev:cire         # @cire/api + @cire/invites + @cire/host + @osn/api
                         # (NOT @cire/vendor — run that one on its own)
bun run dev:landing      # @osn/landing        (dev:cire-landing, dev:pulse-landing for the others)
bun run dev:lab          # @tools/lab — component/three.js prototyping
bun run build            # Build all packages (turbo)
bun run check            # Type-check all packages (turbo)
```

The shell is **fish** on the local machine and **bash** in Claude Code's remote
environments, so a command that works in one can fail to parse in the other.
Two that bite. An unquoted glob argument (`grep --include=*.ts`) is expanded by
fish, which errors when nothing matches; quote it (`--include='*.ts'`). And a
heredoc fails whenever its `<<` reaches fish's own tokenizer, which fish reads
as a redirection: `fish: Expected a string, but found a redirection`. Quoting
style is not what decides that — `bash -c 'cat <<EOF … EOF'` and
`bash -c "cat <<EOF … EOF"` both run, because fish passes a quoted argument
through as text and bash does the parsing. What breaks it is a `$(…)` command
substitution, whose body fish parses itself: `bash -c "$(cat <<EOF … EOF)"`
errors before bash is ever reached, with or without a quoted delimiter. That
is the shape a long commit message reaches for, so write those to a file and
pass the file (`git commit -F <file>`). All of it is fine under bash.

### Local URLs

Every dev server runs behind [portless](https://github.com/vercel-labs/portless): each app answers on a named HTTPS host instead of a port, so there are no port numbers to remember and no clashes between stacks. Each package's `dev` script is `portless`, which reads that package's own `"portless"` key and runs its real `dev:app` command behind the proxy.

One-time setup on a new machine — it binds port 443, adds a local CA to the system trust store and writes an `/etc/hosts` block, so it asks for sudo:

```bash
bunx portless proxy start     # or: bunx portless service install (starts at boot)
bunx portless doctor          # check proxy, routes, DNS, CA trust
bunx portless clean           # undo it all: state, CA trust entry, hosts block
```

That CA is a TLS-interception primitive for every host the machine talks to, so `portless` is pinned with a tilde (`~0.15.5`) rather than a caret: it is pre-1.0, and a version bump is a change to review, not a lockfile refresh. Nothing installs or starts it for you — the package has no lifecycle scripts, and it refuses to run without a TTY or under `CI`.

| App | URL |
| --- | --- |
| `@osn/social` | `https://musubi.localhost` |
| `@osn/api` | `https://id.musubi.localhost` |
| `@osn/landing` | `https://www.musubi.localhost` |
| `@pulse/web` | `https://pulse.localhost` |
| `@pulse/api` | `https://api.pulse.localhost` |
| `@pulse/landing` | `https://www.pulse.localhost` |
| `@cire/landing` | `https://cire.localhost` |
| `@cire/invites` | `https://invite.cire.localhost` |
| `@cire/host` | `https://host.cire.localhost` |
| `@cire/vendor` | `https://vendor.cire.localhost` |
| `@cire/api` | `https://api.cire.localhost` |
| `@zap/api` | `https://zap.cire.localhost` |

The names mirror production hostnames, and the nesting is load-bearing: a WebAuthn RP ID has to be the origin's host or a registrable suffix of it, so `@osn/social` (`musubi.*`) and `@osn/api` (`id.musubi.*`) sit under a shared `musubi` parent that can serve as the RP ID for both. Flat names would put every passkey out of reach of the API that verifies it.

**Worktrees get their own stack.** In a linked worktree portless prepends the branch, so the same `bun run dev` gives `https://my-branch.host.cire.localhost` and friends. Two worktrees can run the full devloop at once without colliding. The `main` worktree keeps the bare names.

Because those hostnames differ per worktree, no app can be told where its siblings live from a committed `.env`. Each `dev:app` runs through the `dev-env` launcher (`@shared/dev-urls`), which derives every sibling's origin from the app's own `PORTLESS_URL` and exports the same env vars the deployed tiers set (`OSN_ISSUER_URL`, `WEB_ORIGIN`, `PUBLIC_API_URL`, …). Those values win over `.env`. Adding an app means the `"portless"` key in its `package.json` and an entry in `DEV_APPS` (`shared/dev-urls/src/index.ts`), plus its env-var map in `src/app-env.ts`; a test asserts the first two agree.

**What it costs.** Tens of milliseconds in the steady state, and a markedly slower *first* load after a cold start. Numbers, method and the reason are in `[[wiki/conventions/devloop-urls]]`.

To run without the proxy, on the fixed ports the repo used before (`:4000` osn-api, `:8787` cire-api, `:1422` musubi, …):

```bash
PORTLESS=0 bun run dev                    # whole devloop, fixed ports
bun run --cwd cire/host dev:app           # one app, no proxy at all
```

One trap for agents: Astro 7 detects an agent environment and puts `astro dev` in the background. Control returns to portless, portless deregisters the route when its child exits, and the URL then 404s while a stray daemon still holds the port. Run it as `CLAUDECODE= bun run dev` to keep it in the foreground, and clear a stray with `bunx astro dev stop`. A human terminal is unaffected.

```bash

# Testing
bun run test                          # run all tests (turbo, skips packages without test script)
bun run test:d1                       # the Miniflare/workerd D1 tier (excluded from `test`)
bun run test:browser                  # the real-Chromium tier
bun run test:scripts                  # bun tests under scripts/ — TypeScript only. `bun test`
                                      # never collects a *.test.sh, so the three shell tests
                                      # get their own CI steps (changeset-check.yml, ci.yml);
                                      # a new one needs a step or it runs nowhere
bun run --cwd <pkg> test:run          # one package, once   (vitest packages)
bun run --cwd <pkg> test              # one package, watch mode
bun run --cwd cire/api test           # three packages run on `bun test` and have no test:run
                                      # at all: @cire/api (which also picks up its own
                                      # tests/db/ D1 tier), @cire/db, @tools/oxlint-house

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
```

## Workspace Installs

```bash
# Use --cwd (not --filter)
bun add solid-js --cwd osn/landing
bun add drizzle-orm --cwd pulse/db
```

**Never a bare `bun install` here.** Resolving on one machine drops every
entry for a platform it is not running on — on a Mac that is 46 entries,
including all the non-darwin binaries CI needs — and the diff then reads as a
dependency change nobody asked for. Use `bun install --frozen-lockfile` to
install, and when a dependency genuinely changes, splice the `bun.lock` entry
by hand and prove it with `bun install --frozen-lockfile`. A lockfile diff
larger than the dependency you changed is the tell.

`bun run reset` (`bun run clean && bun i`) is the one script that still chains
a bare install, so check `git diff bun.lock` after running it and discard the
pruning it does.

## Cloudflare Workers debugging

- Multi-service request misbehaving in prod → `wrangler tail` the actual failing service FIRST, before any architecture speculation.
- Never `source` a secrets file to set a JSON/JWK-shaped secret — bash brace-expansion mangles `{"a":"b"}` unquoted. Extract with grep/sed, pipe via `printf`:
  ```bash
  VAL=$(grep -m1 '^KEY=' "$SF" | sed 's/^[^=]*=//'); printf '%s' "$VAL" | wrangler secret put KEY --env production
  ```
- `wrangler secret put/delete` doesn't cycle warm isolates — redeploy (`wrangler deploy --env production`) after a secret change when behavior must flip now.
- First-ever deploy of a Worker (even with existing `wrangler.toml`) can crash at deploy-time module eval: `fileURLToPath(import.meta.url)` at module top level, or module-top-level `process.env` reads/validation, both undefined/unpopulated during workerd's deploy eval. Fix: defer both into request-time/lazy thunks. Verify with a real `wrangler deploy`, not `--dry-run` (dry-run doesn't catch these).
- Named envs don't inherit top-level routes — add `[[env.production.routes]]` with `custom_domain = true` for a never-deployed named env.
- Changing a shared package's schema (e.g. a DB package other services import) → run the FULL monorepo test suite before merging, not just that package's own tests.
