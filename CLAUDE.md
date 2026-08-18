# CLAUDE.md

AI coding assistant ref. Full spec in README.md. Work tracked in GitHub Issues — `xchromo/osn` for product work, the private `xchromo/osn-tracker` for findings.

## Quick Context

OSN: Modular social platform. Users own identity + social graph. Apps opt-in/out independently.

**Deployed (2026-06-18):** the cire stack is **live on the `cireweddings.com` zone** (all Cloudflare Free tier). Domain reshuffle 2026-07-16: apex `cireweddings.com` = marketing landing, `invite.cireweddings.com` = guest site, `host.cireweddings.com` = organiser portal. **Identity moved to its own zone 2026-07-27:** `osn-api` is a deployed **Cloudflare Worker** on `id.musubi.social`, `@osn/social` (identity app + the OIDC consent screen) is on the apex `musubi.social`, and the WebAuthn RP ID is `musubi.social` — so the cireweddings.com origins can no longer run passkey ceremonies and sign in through the OIDC redirect flow instead (see `[[wiki/runbooks/musubi-identity-migration]]`). osn-api has Upstash prod secrets set; email is live over Resend from `hello@cireweddings.com` (the `OSN_EMAIL_OPTIONAL` degraded mode was dropped in #160). `cire-api` on `api.cireweddings.com`; guest + organiser sites on Pages with custom domains. **Two tiers since 2026-08-13:** a merge to `main` auto-deploys the isolated **dev** tier (`*.dev.cireweddings.com`, `id.dev`/`dev.musubi.social`), and the production jobs in the same run wait on a human approving the `production` GitHub Environment — no more unattended deploys to live weddings. Path filters mean only changed surfaces deploy. See `[[wiki/runbooks/dev-environment]]`. Architectural decision: **osn-api stays a single Worker** (split deferred). See `[[wiki/runbooks/production-deploy]]`, `[[wiki/runbooks/free-tier-limits]]`.

Phase 1 surfaces:

| Surface | Package(s) | Status |
|---|---|---|
| Identity / auth API | `@osn/api` (port 4000; prod Worker `id.musubi.social`) | Active — **deployed (Worker)** |
| Identity & graph UI | `@osn/social` (port 1422; prod Pages `musubi.social`) | Active — **deployed (Pages)** |
| Events | `@pulse/web` + `@pulse/api` (port 3001) + `@pulse/db` | Active |
| Messaging | `@zap/api` (port 3002) + `@zap/db` | M0 scaffolded; M1 in flight; client app not started |
| Wedding invites | @cire/api (:8787, prod `api.cireweddings.com`) + @cire/invites (:4321, prod `invite.cireweddings.com`) + @cire/host (:4322, prod `host.cireweddings.com`) + @cire/db + @cire/theme | Active — **deployed** (domain reshuffle 2026-07-16: guest→`invite.`, organiser→`host.`; package rename 2026-08-07: `@cire/web`→`@cire/invites`, `@cire/organiser`→`@cire/host`) |
| Wedding marketing site | `@cire/landing` (:4323) | Active — serves the **apex `cireweddings.com`** (reshuffle 2026-07-16). See `[[wiki/apps/cire-landing]]` |
| OSN marketing site | `@osn/landing` (:4324) | Active — built (dark/dotted, connections-led). See `[[wiki/apps/osn-landing]]` |
| Pulse marketing site | `@pulse/landing` (:4325) | Active — built (colourful + fun). See `[[wiki/apps/pulse-landing]]` |

## File Responsibilities

- `README.md` → Project spec, vision, features, tech stack, contributing (human-readable)
- `CLAUDE.md` → AI entry point: quick context, conventions, commands, wiki nav
- `pulse/DESIGN.md` → Pulse visual design system: typography, color tokens, component catalog, layout patterns
- `wiki/TODO.md` → A pointer to GitHub Issues. No work is tracked in the wiki
- `wiki/` → Obsidian knowledge graph: architecture, systems, observability, runbooks
  - Open in Obsidian for graph view; or navigate via `[[wiki links]]`
  - See `[[wiki/index]]` for full content map

## Where Work Is Tracked

GitHub Issues, not the wiki. Two repos:

| Repo | Holds | Visibility |
|---|---|---|
| `xchromo/osn` | Product work, ops, docs, schema | Public |
| `xchromo/osn-tracker` | Every security, performance and compliance finding | Private |

Route by *kind*, never by severity: an `S-`, `P-` or `C-` ID goes to the tracker however minor it looks. `xchromo/osn` is public, and a finding names an unpatched route.

Every issue carries exactly one `product:` label — `osn-core`, `pulse`, `cire`, `zap`, `shared`, `landing` — and an org issue type: `Feature`, `Bug` or `Task`. An `area:` label is optional and only ever `security`, `performance`, `compliance`, `ops`, `docs` or `schema`; an issue with none is ordinary product work, which is what `Feature` already says. Findings also carry a `severity:`, taken from the tier letter in the ID. Epics are parents with sub-issues, so a phased piece of work is one issue plus its parts.

```bash
gh issue list --repo xchromo/osn --state open --label product:pulse
gh issue list --repo xchromo/osn-tracker --state open --label severity:high
gh issue create --repo xchromo/osn --type Feature --label product:cire --title "..."
```

`/new-feat` opens a well-formed issue; `/prep-pr` files findings at the end of a review. Label and type definitions, and the Project setup, are in `[[wiki/runbooks/github-issues-setup]]`; how a finding is filed is in `[[wiki/conventions/review-findings]]`.

**Never delete an issue — close it.** The history matters.

## Wiki Navigation

`wiki/` has detailed ref pages. Hot-path lookups below; full page-by-page map (per-app subsystems, Pulse sub-features, individual debug runbooks, compliance pages) → `[[wiki/index]]`:

| If you need to... | Read |
|---|---|
| Understand monorepo layout | `[[wiki/architecture/monorepo-structure]]` |
| Understand DB environments (local bun:sqlite vs dev/staging/prod D1) | `[[wiki/systems/database-environments]]` |
| Write new Effect service or Elysia route | `[[wiki/architecture/backend-patterns]]`, `[[wiki/architecture/schema-layers]]` |
| Understand accounts, profiles, orgs | `[[wiki/systems/identity-model]]` |
| Add or verify ARC S2S tokens | `[[wiki/systems/arc-tokens]]` |
| Let another app sign a user in with their OSN account (OIDC, PKCE, consent, pairwise `sub`) | `[[wiki/systems/oidc-provider]]` |
| Add a handle/name search (query normalisation, LIKE escaping, index-friendly prefix ranges — use `@shared/db-utils/search`, never a hand-rolled `LIKE 'q%'`) | `[[wiki/systems/social-graph]]` §Search |
| Add rate limiting to endpoint | `[[wiki/systems/rate-limiting]]`, `[[wiki/systems/redis]]` |
| Instrument logging, tracing, metrics | `[[wiki/observability/overview]]`, then specific page |
| Write or review tests | `[[wiki/conventions/testing-patterns]]` |
| Add or use UI component (Button, Card, Dialog…) | `[[wiki/architecture/component-library]]` |
| Work on a specific app/surface (osn-core, social, pulse, zap, cire, cire-landing, osn-landing, pulse-landing) | `[[wiki/apps/<name>]]` |
| Build the OIDC consent screen (states, decision-error contract, login_required retry loop) | `[[wiki/apps/authorize-ui]]` |
| Deploy osn-api + cire to production (secrets/vars, migrations, CI pipeline, smoke checks) | `[[wiki/runbooks/production-deploy]]` |
| Use the dev tier — what deploys automatically, how to promote past the approval gate, how to reset dev | `[[wiki/runbooks/dev-environment]]` |
| Check free-tier limits / what breaks at a cap / Cloudflare hardening TODO | `[[wiki/runbooks/free-tier-limits]]` |
| Move OSN identity to `musubi.social` (RP-ID change, credential bridge, cutover order) | `[[wiki/runbooks/musubi-identity-migration]]` |
| Debug auth / ARC / rate-limit / event-visibility failure | `wiki/runbooks/` (`auth-failure`, `arc-token-debugging`, `rate-limit-incident`, `event-visibility-bug`) |
| Check security or perf findings | `gh issue list --repo xchromo/osn-tracker --state open` — see `[[wiki/conventions/review-findings]]` |
| Check which compliance standards apply, or add personal-data field/DSAR/breach/access-review work | `[[wiki/compliance/index]]` |
| Track progress and priorities | GitHub Issues + the OSN Platform Project — see §Where Work Is Tracked |

### Searching the wiki

Three ways, in order. Try each; drop to the next when it isn't there.

**1. Obsidian MCP (`mcp__obsidian-wiki__*`) — preferred, local sessions only.** The MCP Connector plugin (`mcp-tools-istefox`) serving the `wiki` vault. Reachable when the `mcp__obsidian-wiki__*` tools are listed and a call returns; an error ending `is Obsidian open with the vault loaded?` means it isn't — drop to step 2.

Where it exists:

| Where you're running | Obsidian MCP? |
|---|---|
| Claude Code on Aniket's Mac, Obsidian open with the `wiki` vault | Yes — registered at user scope |
| Claude Code on that Mac, Obsidian shut | No — the server can't resolve a port |
| Claude Desktop | Only if the `.mcpb` is installed there as well; the Claude Code registration doesn't carry over |
| Remote or cloud session, cloud agent, CI, another machine | **Never.** It reaches a local Obsidian over `127.0.0.1`. Skip to step 3 — the `obsidian` CLI is local-only too. |

Don't hunt for it, retry it, or ask for it to be started when the tools aren't listed. Absent means absent: go to grep.

| To... | Call |
|---|---|
| Search by meaning, not wording | `search_vault_smart` (semantic index over the vault) |
| Search for an exact string | `search_vault_simple` (substring + surrounding context) |
| Read one page / up to 20 pages | `get_vault_file`, `get_vault_files` |
| Read one heading, field, or the outline only | `get_vault_file_partial`, `get_note_outline` |
| Follow the graph | `get_backlinks`, `get_outgoing_links` |
| Find pages by tag | `get_files_by_tag`, `list_tags` |
| Orient in an unfamiliar area | `get_vault_overview`, `list_vault_files` |

Some tools start inactive — `tool_catalog` lists them, `activate_tools` promotes several in one call.

**It always shows you `main`, not your branch.** The vault path is baked into the connector as the `main` worktree's `wiki/`. Obsidian stays open on that one vault; nobody re-points it per branch. Two consequences:

- **Read only.** The write tools (`create_vault_file`, `patch_vault_file`, `search_and_replace`, …) would edit `main`'s working tree, not your branch. Retrieve over MCP; edit wiki pages in your own worktree with Edit/Write.
- **Your branch's own wiki edits are invisible to it.** Before trusting a page the branch might have changed, run the guard — one command, not a re-read of the wiki:

  ```bash
  git diff --name-only origin/main...HEAD -- wiki/   # pages this branch changed
  ```

  Empty output (the usual case) → MCP results are authoritative, use them. Any page you need in that list → read the branch copy with Read; MCP has the pre-branch version.

Keep the vault fresh, since a stale `main` worktree means stale answers. Obsidian re-indexes on file change, and a fast-forward of a clean worktree is safe:

```bash
git -C ~/.work/osn.git/main pull --ff-only
```

If it refuses, leave it alone — never force or reset another worktree. Grep your own `wiki/` instead.

That's the whole protocol: freshen, one guard command, then lean on semantic search instead of grepping and reading whole pages.

**2. Obsidian CLI** — same limits: local machine, app running. Invoke the **`obsidian:obsidian-cli` skill** for the command surface; it wraps `obsidian help`, which is authoritative and stays current. Quick reference:

```bash
which obsidian 2>/dev/null || echo "not installed"
obsidian search vault=wiki query="arc tokens"          # full-text search
obsidian search:context vault=wiki query="arc tokens"  # search with line context
obsidian tag vault=wiki name=systems verbose           # list files tagged #systems
obsidian read vault=wiki path=systems/arc-tokens.md    # read a page
obsidian backlinks vault=wiki file=arc-tokens          # find pages linking to it
obsidian files vault=wiki folder=systems               # list files in a folder
```

Two repo-specific rules the skill can't know:

- **Paths are vault-root-relative, and the vault root is `wiki/`.** `path=systems/arc-tokens.md`, not `path=wiki/systems/...` — the latter errors with `File not found`. `file=` takes a wikilink target (`file=arc-tokens`) instead.
- **Read only, same as the MCP and for the same reason.** The CLI acts on the vault, and the vault is `main`'s `wiki/`. `create`, `append`, and `property:set` would write to `main`'s working tree, not your branch. There are three vaults registered (`wiki`, `echo_chamber`, `vault_india_22`) — always pass `vault=wiki` rather than trusting the default.

**3. grep** — works everywhere, including remote and CI. Reads your worktree's own `wiki/`:

```bash
grep -r "arc token" wiki/ --include="*.md" -l          # find matching pages
grep -r "arc token" wiki/ --include="*.md" -n          # with line numbers
```

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
- **Modify existing pattern** → update wiki page in same PR.
- **Every wiki page must have YAML frontmatter** with `title`, `tags`, `related`, `last-reviewed`.
- **Use `[[wiki links]]`** between wiki pages; never relative markdown links. The vault is `wiki/` alone, so a page in another tree — `cire/wiki/` — cannot be reached by a wikilink in any form: cite it as a backticked repo path (`` `cire/wiki/systems/vendors.md` ``). `[[vendors]]`, `[[systems/vendors]]` and `[[cire/wiki/systems/vendors]]` all render as broken links.
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
| `shared/` | `@shared/*` | Cross-cutting utils (`@shared/crypto` for ARC tokens, `@shared/email` for transactional mail, `@shared/observability`, `@shared/rate-limit`, `@shared/turnstile` for key-optional bot protection, `@shared/osn-auth-client` for downstream access-JWT verification) |

## Tech (one-liner)

Bun, TypeScript, Elysia, Effect.ts (trial), Drizzle, SQLite→Supabase, Eden+REST, WebSockets, Signal Protocol, SolidJS, Astro, Turborepo, oxlint, oxfmt, Vitest + @effect/vitest

## Key Patterns

One-line summaries — open wiki page for full contract, API surface, finding history, observability.

| Pattern | Purpose | Wiki page |
|---|---|---|
| ARC Tokens | S2S auth via self-issued ES256 JWTs (kid + scope + audience). Lives in `@shared/crypto`. | `[[wiki/systems/arc-tokens]]` |
| Passkey-Primary Login | Only primary login factor. OTP/magic-link primary removed; OTP survives only as step-up. Account invariant: ≥1 WebAuthn credential always. | `[[wiki/systems/passkey-primary]]` |
| User Access Tokens | ES256 JWTs, **5-min TTL**, `aud: "osn-access"`. Public key at `/.well-known/jwks.json`; downstream services verify via `@shared/osn-auth-client` (`extractClaims` + JWKS cache + audience check; Elysia adapter). Client `authFetch` silent-refreshes on 401 from HttpOnly session cookie. | `[[wiki/systems/identity-model]]` |
| Cire Consent Framework | Site-wide cookie/third-party consent on the cire guest site. Categories are the unit of consent; one vendor registry drives the preferences dialog, the `/privacy` disclosure and (by test) the CSP allowlist. `<ConsentGate>` doesn't *render* gated children, so their effects never run. Defaults are **opt-out** for third-party content, opt-in for analytics — and three grant maps (floor / pre-decision / accept-all) are kept distinct so a refusal is never briefly ignored. | `[[cire/wiki/architecture/consent]]` |
| Cire Two-Auth Model | Guests use claim-code → opaque hashed session cookie (no OSN account); organisers use OSN passkey sign-in + access-JWT verification + wedding-ownership authz. The two middlewares never gate the same route — except the optional account-linking `POST /api/account/link`, which deliberately requires both (guest cookie binds the household, OSN token names the account; additive, not a privilege ladder). | `[[wiki/systems/cire-auth]]` |
| Server-side Sessions | Opaque `ses_*` refresh tokens, SHA-256 hashed at rest, 30-day sliding window. Rotated every `/token` grant; reuse → family revocation via `RotatedSessionStore`. Refresh token **only** in HttpOnly cookie (S-M1) — so **any browser call that sets or reads it MUST pass `credentials: "include"`**. The issuer (`id.musubi.social`) is a different origin from every app that calls it, and a cross-origin `fetch` on the default `same-origin` mode silently discards `Set-Cookie` — no error, no warning, just no session. This is the bug class behind the 2026-08-06 registration fix; check it first whenever a ceremony "succeeds" but the user is still signed out. | `[[wiki/systems/sessions]]` |
| Step-up (sudo) tokens | Short-lived `aud: "osn-step-up"` JWTs from fresh passkey/OTP ceremony. Required by `/recovery/generate`, `/account/email/complete`, security-event ack, passkey rename/delete. Single-use via `StepUpJtiStore`. **Purpose-bound at every gate** (`passkey_register`/`passkey_delete`/`email_change`/`security_event_ack`/`recovery_generate`): a verifier requires its own `purpose` claim, so a token minted for one ceremony can't be replayed at another before its jti is consumed. | `[[wiki/systems/step-up]]` |
| Recovery Codes | Copenhagen Book M2 — 10 × 64-bit single-use codes, hashed at rest. Generate/consume both in `security_events` and surfaced via in-app banner. | `[[wiki/systems/recovery-codes]]` |
| Session Introspection | `GET/DELETE /sessions[/:id]`, `POST /sessions/revoke-all-other`. Coarse UA labels + HMAC-peppered IP hashes. | `[[wiki/systems/sessions]]` |
| OIDC Provider | `@osn/api` is an OpenID Connect provider, so other apps recognise an OSN account without holding a passkey. Authorization code + PKCE (S256 only), pairwise `sub` per client sector, consent stored per (account, client). Invalid client / redirect URI **renders** an error, never redirects (open-redirect guard). Codes hashed, single use, 60s TTL. No refresh tokens, never an `osn-access` audience. Hardened 2026-07-24: real `auth_time` + `max_age`/`prompt=login` enforcement, per-request browser-binding cookie, reserved client-id deny-list + `typ: at+jwt`, `GET/DELETE /oidc/connections` (revoke kills in-flight codes). Hardened 2026-07-29: self-serve client sector = its own `client_id` (colluding clients can't share a sector); `auth_time` survives silent rotation via `sessions.authenticated_at`; consent-screen anti-impersonation (name confusable-skeleton block + verified-app/third-party-host signal); RFC 9207 `iss`; required browser-binding on every parked request; consent revocation is now a live Settings surface (`@osn/social` "Connected apps"). | `[[wiki/systems/oidc-provider]]` |
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
| Native apps (iOS) | Swift. One local SPM package at `shared/swift/OSNShared` with four library products — `OSNKit`, `OSNAuth`, `OSNUI`, `OSNTesting`; consumers depend on `.product(name: "OSNKit", package: "OSNShared")`. App targets are thin: all code lives in packages, `*.xcodeproj` is generated by XcodeGen from a committed `project.yml` and is gitignored. **Every target must compile against the macOS SDK too** — `platforms:` is package-level (SPM has no per-target platform) and `swift test` builds every target on the host, so a bare `import UIKit` anywhere in `OSNShared` fails CI. SwiftUI and Liquid Glass exist on macOS 26; genuinely UIKit-only code goes behind `#if canImport(UIKit)` or into the app target |
| Functional core | Effect.ts trial in OSN/Pulse first; the decision is an open issue in `xchromo/osn` |
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
| Changesets | Every PR includes changeset (`bun run changeset`) — CI fails without. Package names must match workspace `name` field exactly (e.g. `"@pulse/web"`, not `"pulse"`). Never mix ignored (version-less, e.g. `@cire/*`) and versioned packages in one changeset — split them; Changeset Check (`scripts/validate-changesets.sh`) enforces both rules. **One exception**, added with the Swift work: a PR that touches nothing any versioned package ships — `shared/swift/`, `pulse/ios/`, `osn/ios/`, `.github/`, `.claude/`, `scripts/`, `wiki/`, `docs/`, top-level prose — needs no changeset, because there is no honest package to name. The test is an **allowlist** (`scripts/changeset-required.sh`, fixtures in `changeset-required.test.sh`): anything not on it, including `bun.lock` and root `turbo.json`/`tsconfig.json`, still requires one |
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
```

## Workspace Installs

```bash
# Use --cwd (not --filter)
bun add solid-js --cwd osn/landing
bun add drizzle-orm --cwd pulse/db
```

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
