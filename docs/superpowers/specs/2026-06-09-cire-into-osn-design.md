# Merging cire into osn.git as a sibling workspace

**Status:** Design approved 2026-06-09 — pending implementation plan.
**Author:** ac (single-developer project).
**Source projects:**
- `/Users/ac/.work/cire.git/main` — bespoke wedding-invite app, custom claim-code auth.
- `/Users/ac/.work/osn.git/main` — Open Social Network platform, OIDC issuer + passkey auth.

## 1. Goals and scope

Bring cire physically into osn.git as a sibling workspace alongside `osn/`, `pulse/`, `zap/`, so cire benefits from OSN's auth infrastructure and shared packages. Keep blast radius small: do not destabilise existing osn/pulse/zap, do not break cire's working guest-RSVP path.

**In scope:**

- Physical move of cire into `osn.git/main/cire/` via `git subtree` (history preserved).
- Organiser portal authenticates via OSN passkey — couples become OSN account holders.
- Cire/api validates OSN access JWTs on `/api/organiser/*` routes; deletes the interim `X-Organiser-Token` shared-secret middleware.
- Schema multi-tenancy scaffold (new `weddings` table, FKs from `families`, `events`, `imports`).
- Adopt `@shared/typescript-config` and `@shared/rate-limit`.
- Extract OSN-JWT verification (currently in pulse) into new `@shared/osn-auth-client`. Cire and pulse both consume.

**Explicitly out of scope (deferred, see §11):**

- Guest auth changes. Claim code → `cire_session` cookie path stays exactly as today.
- Multi-owner weddings. Single owner per wedding for now; join table comes later.
- Pulse pulling cire weddings into its event feed.
- `@shared/observability`, `@shared/email`, `@shared/redis` adoption.
- Adopting osn's stricter `oxlintrc.json` rules in cire.
- Lifting cire's `safeHttpUrl`, `decodePalette`, CSV-injection guard into a `@shared/safe-parse` package.
- Magic link / passkey for guests, SMS OTP fallback, session cleanup cron — all already deferred in cire's own roadmap.

## 2. Architecture (post-merge)

```
osn.git/main/
├── osn/                              (existing — OIDC issuer)
├── pulse/                            (existing — events)
├── zap/                              (existing — messaging)
├── cire/                             ← NEW workspace
│   ├── api/         @cire/api        (Hono on Cloudflare Workers)
│   ├── web/         @cire/web        (Astro + SolidJS, guest-facing)
│   ├── organiser/   @cire/organiser  (Astro, couple-facing, OSN-authed)
│   └── db/          @cire/db         (Drizzle schema, own D1 instance)
├── shared/
│   ├── crypto/                       (existing)
│   ├── email/                        (existing)
│   ├── observability/                (existing)
│   ├── rate-limit/                   (existing)
│   ├── redis/                        (existing)
│   ├── typescript-config/            (existing)
│   ├── db-utils/                     (existing)
│   └── osn-auth-client/              ← NEW (extracted from pulse/api/src/lib/)
└── docs/superpowers/specs/
    └── 2026-06-09-cire-into-osn-design.md   (this file)
```

**Two cohabiting auth systems, no overlap:**

| Route group | Auth | Identity carried |
|-------------|------|------------------|
| `cire/api: POST /api/claim`, `POST /api/rsvp` | `cire_session` cookie (existing) | `familyId` from cire D1 |
| `cire/api: /api/organiser/*` | OSN access JWT (Bearer header) verified via JWKS | `osnProfileId` (`usr_*`) from JWT `sub` |
| `cire/web` | none (public invite page) | — |
| `cire/organiser` | OSN passkey login via `@osn/client` SDK | OSN account |

Top-level `package.json` workspaces gains `"cire/*"`. `turbo.json` gets `dev:cire` filter chain (`@cire/api` + `@cire/web` + `@cire/organiser` + `@osn/api`, because organiser portal needs the local OIDC issuer running).

## 3. Auth bridge (organiser login)

End-to-end flow once landed:

1. Couple navigates to `cire-organiser.pages.dev` (or `localhost:4322` in dev).
2. `@osn/client`'s `OsnAuthProvider` detects no session, redirects to OSN sign-in (passkey-primary, recovery-code escape).
3. OSN issues access JWT (5-minute TTL, ES256, `aud: "osn-access"`, `sub: "usr_*"`) and refresh token in `__Host-osn_session` HttpOnly cookie (30-day, sliding-window).
4. SDK stores access token in browser memory (no refresh-token reads from JS — cookie-only per OSN's C3 model).
5. `authFetch()` injects `Authorization: Bearer <jwt>` on every request to `cire/api`; silent-refreshes via `/token` on 401.
6. `cire/api`'s new `osnAuth()` middleware (from `@shared/osn-auth-client`):
   - Extracts Bearer token.
   - Resolves signing key via JWKS cache (5-min TTL + stale-while-revalidate).
   - Verifies ES256 signature, `aud === "osn-access"`, `exp`.
   - Sets `c.var.osnProfileId = payload.sub`.
   - Returns 401 on missing/invalid token.
7. Wedding ownership check (per-route): query cire/db `SELECT 1 FROM weddings WHERE id = ? AND owner_osn_profile_id = ?`. Mismatch → 403.

**New code locations:**

| Path | Purpose |
|------|---------|
| `cire/api/src/middleware/osn-auth.ts` | Thin Hono wrapper around `@shared/osn-auth-client`. |
| `cire/api/src/middleware/wedding-owner.ts` | Authz check: `osnProfileId` owns `weddingId` from path. |
| `cire/organiser/src/auth/OsnProvider.tsx` | Wraps app, sets up `@osn/client` SDK. |
| `cire/organiser/src/pages/sign-in.astro` | Hosts `@osn/ui/auth/SignIn`. |
| `cire/organiser/src/lib/api.ts` | `authFetch()` wrapper, drops old `X-Organiser-Token` injection. |

**Code to delete after auth bridge lands:**

- `cire/api/src/routes/organiser-import.ts` lines 38–45 — `X-Organiser-Token` constant-time check.
- `cire/organiser/src/components/ImportPanel.tsx` lines 88–95 — token-header injection.
- `cire/api/src/local.ts` line(s) referencing `ORGANISER_TOKEN` env var.
- `cire/api/wrangler.toml` — `ORGANISER_TOKEN` secret declaration.
- `cire/organiser/src/...` — `sessionStorage["cire:organiser-token"]` reads.

**Environment additions to `cire/api/wrangler.toml`:**

```toml
[vars]
OSN_JWKS_URL = "http://localhost:4000/.well-known/jwks.json"  # dev default
OSN_ISSUER_URL = "http://localhost:4000"
OSN_AUDIENCE = "osn-access"

[env.production.vars]
OSN_JWKS_URL = "https://osn-api.example.com/.well-known/jwks.json"
OSN_ISSUER_URL = "https://osn-api.example.com"
OSN_AUDIENCE = "osn-access"
```

`@shared/osn-auth-client` fails-closed in non-local if `OSN_JWKS_URL` is HTTP (mirrors osn's existing S-H3 protection).

## 4. Schema changes (cire/db, separate D1)

Cire keeps its own D1 instance (`cire-db`). OSN identity referenced by opaque string ID — no cross-DB FK.

**New table:**

```sql
CREATE TABLE weddings (
  id                    TEXT PRIMARY KEY,        -- "wed_<ulid>"
  slug                  TEXT NOT NULL UNIQUE,    -- "patel-joy"
  display_name          TEXT NOT NULL,           -- "Aarti & Joy"
  owner_osn_profile_id  TEXT NOT NULL,           -- "usr_*" — no FK, cross-DB
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX weddings_owner_idx ON weddings(owner_osn_profile_id);
```

**FK additions:**

| Table | New column | Constraint |
|-------|-----------|-----------|
| `families` | `wedding_id` TEXT NOT NULL | `REFERENCES weddings(id) ON DELETE CASCADE` |
| `events` | `wedding_id` TEXT NOT NULL | `REFERENCES weddings(id) ON DELETE CASCADE` |
| `imports` | `wedding_id` TEXT NOT NULL | `REFERENCES weddings(id) ON DELETE CASCADE` |

`guests`, `rsvps`, `guest_events`, `sessions` inherit wedding scope via their existing FK chains (`guest → family → wedding`, `rsvp → guest → family → wedding`). No direct column changes.

**Migration file:** `cire/db/migrations/0006_multi_tenant.sql`

Steps (atomic in single transaction where SQLite supports it):

1. `CREATE TABLE weddings (...)` per above.
2. `INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at) VALUES ('wed_bootstrap', '<your-wedding-slug>', '<your-wedding-name>', '<your-osn-profile-id>', strftime('%s','now'), strftime('%s','now'));`
3. Add nullable columns: `ALTER TABLE families ADD COLUMN wedding_id TEXT`. (D1/SQLite cannot add NOT NULL with no default; backfill first.)
4. `UPDATE families SET wedding_id = 'wed_bootstrap' WHERE wedding_id IS NULL;` (same for `events`, `imports`).
5. Create indices: `CREATE INDEX families_wedding_idx ON families(wedding_id)`; same for `events`, `imports`.
6. Recreate tables with NOT NULL + FK (SQLite ALTER limitation — use rename/copy idiom). Drizzle's migration generator handles this.
7. Down migration drops new columns and `weddings` table — reversible.

**Bootstrap row prerequisite:**

The `<your-osn-profile-id>` value must be a real `usr_*` ID. Before running this migration:

1. Stand up `@osn/api` locally.
2. Register an account via `/register/begin` + `/register/complete`, enrol passkey.
3. `GET /profile` (or query `osn/db` directly) → copy `users.id`.
4. Substitute into migration SQL.

For production, you must already have an OSN account on the live OSN issuer. This is a one-time manual step documented in the implementation plan.

**Route changes:**

- Replace `GET /api/organiser/guests` with `GET /api/organiser/weddings/:weddingId/guests`.
- Same pattern for `/events`, `/import/*`, `/import/list`, etc.
- New: `GET /api/organiser/weddings` — lists weddings owned by `c.var.osnProfileId`. Returns array of 1 in bespoke mode, N in multi-tenant.
- Old flat routes can stay aliased through Phase 5, deleted in Phase 6.

**Claim code namespacing:** `families.public_id` stays globally unique (`PATEL-JOY-RK97`). No per-wedding namespacing needed yet — codes are long enough. Revisit if collisions occur.

## 5. Dedup and abstraction

### 5.1 Adopt now

| Action | Files touched | Cost |
|--------|--------------|------|
| `@shared/typescript-config` | `cire/tsconfig.json` (delete custom, extend `solid.json`); `cire/api/tsconfig.json` (extend `node.json` + CF types overlay); same for `cire/web`, `cire/organiser`, `cire/db`. | ~30min |
| `@shared/rate-limit` | Replace `cire/api/src/middleware/rate-limit.ts` (delete file, import `createRateLimiter` from `@shared/rate-limit` in `cire/api/src/app.ts`). | ~1hr |
| `@shared/crypto` (partial) | Delete `cire/api/src/lib/timing.ts`, swap callers to `@shared/crypto`'s constant-time-compare. Audit `cire/api/src/services/session.ts` for token-gen helpers that could reuse `@shared/crypto` primitives. | ~1hr |

### 5.2 Lift and share — new `@shared/osn-auth-client`

`pulse/api/src/lib/auth.ts` and `pulse/api/src/lib/jwks-cache.ts` already implement OSN-JWT verification with JWKS caching. Cire is the second consumer — the right moment to extract.

**Framework note:** osn and pulse use **Elysia**; cire uses **Hono**. The shared package keeps a framework-agnostic verification core and exports per-framework middleware adapters so each app gets a native API surface.

**New package:**

```
shared/osn-auth-client/
├── src/
│   ├── index.ts                  # exports
│   ├── verify.ts                 # verifyOsnAccessToken(token, opts) — framework-agnostic
│   ├── jwks-cache.ts             # LRU cache + 5-min TTL + stale-while-revalidate refresh
│   └── middleware/
│       ├── hono.ts               # osnAuth() Hono middleware factory  (consumed by cire/api)
│       └── elysia.ts             # osnAuth() Elysia plugin factory    (consumed by pulse/api)
├── tests/
│   └── verify.test.ts            # Existing pulse tests, repathed
├── package.json                  # @shared/osn-auth-client
├── tsconfig.json                 # extends @shared/typescript-config/node.json
└── README.md
```

**Migration moves:**

1. Copy `pulse/api/src/lib/{auth,jwks-cache}.ts` → `shared/osn-auth-client/src/{verify,jwks-cache}.ts`. Strip any Elysia-specific wiring; keep pure async verify fn.
2. Add `shared/osn-auth-client/src/middleware/elysia.ts` — Elysia plugin reproducing pulse's current behaviour (lifts Bearer header, calls `verifyOsnAccessToken`, derives context).
3. Add `shared/osn-auth-client/src/middleware/hono.ts` — Hono middleware factory: `osnAuth({ jwksUrl, audience })` returning `(c, next)` handler that sets `c.var.osnProfileId`.
4. Update `pulse/api/src/index.ts` (line 33) and any callers to import the Elysia adapter from `@shared/osn-auth-client/middleware/elysia` instead of local `./lib/auth`.
5. Delete `pulse/api/src/lib/auth.ts` and `pulse/api/src/lib/jwks-cache.ts`.
6. `cire/api/src/middleware/osn-auth.ts` imports the Hono adapter from `@shared/osn-auth-client/middleware/hono`.

Pulse changes are ~5 lines of imports. Cire becomes the first Hono consumer. Net: zero duplicated verification code; per-framework adapters live in one place.

### 5.3 Defer (locked)

| What | Rationale |
|------|-----------|
| `@shared/observability` adoption in cire | Opted out. Cire's local logger keeps working. Migrate when adding cross-app traces. |
| `@shared/email` adoption | Cire has no email surface yet (magic link deferred). Wire when first needed. |
| `@shared/redis` adoption | Cire doesn't need distributed state at scale yet. KV-backed rate-limit sufficient for bespoke usage. |
| Session-token primitives → shared | Cire's session is opaque-cookie, OSN's is OIDC. Different shapes. Reuse surface is small — not worth a package. |
| Adopt osn's stricter `oxlintrc.json` | **Explicit user defer.** Adopting would surface lint errors in cire. Tackle in dedicated cleanup pass, not during merge. Cire continues using its default oxlint config. |
| `@shared/safe-parse` (cire's `safeHttpUrl`, `decodePalette`, CSV-injection guard) | **Explicit user defer.** Premature abstraction — only one consumer. Revisit if pulse/zap need same primitives. |
| Lefthook merge | Two `lefthook.yml`. Merge keeps osn's structure, adds cire's `bun audit` step at root with cire's `--ignore=GHSA-77vg-94rm-hx3p` line. Cleanup-only, ~10 min. |
| Bun overrides | Cire root `package.json` has 6 overrides (devalue, esbuild, picomatch, postcss, smol-toml, vite). Merge into osn root in Phase 1 step 5; resolve case-by-case. |
| `bunfig.toml` `minimumReleaseAge` | Cire = 14d (conservative), osn = 3d (current). Keep osn's 3d. |

## 6. Migration sequence (phased)

Each phase ends with a working tree. No half-broken commits on main.

### Phase 0 — Pre-flight

- Confirm `turbo dev --filter=@osn/api` starts cleanly on :4000.
- Confirm `cire.git/main` builds + tests pass.
- User has an OSN account + profile bootstrapped locally and (for prod) on live OSN issuer. Capture `usr_*` ID for use in Phase 4.
- Create dedicated worktree: `git worktree add cire-merge-XXXX` in osn.git. Don't touch the existing `pulse-user-onboarding-AMxQ3` worktree.

### Phase 1 — Subtree merge (osn.git, sequential)

1. `git remote add cire /Users/ac/.work/cire.git && git fetch cire`.
2. `git subtree add --prefix=cire-import cire/main` — full cire history under `cire-import/`.
3. `git mv cire-import/apps/api cire/api && git mv cire-import/apps/web cire/web && git mv cire-import/apps/organiser cire/organiser && git mv cire-import/packages/db cire/db`.
4. Migrate root files: cire's `README.md` → `cire/README.md`; cire's `CLAUDE.md` → `cire/CLAUDE.md`; cire's `wiki/` → `cire/wiki/` (or merge into osn `wiki/cire/`).
5. Delete remaining `cire-import/` (root configs already absorbed manually).
6. Add `"cire/*"` to root `package.json` workspaces array.
7. Merge cire root `overrides` into osn root `package.json` overrides (diff for conflicts; Astro/SolidJS-only, likely zero collision with osn's React-less stack).
8. Merge cire `lefthook.yml` `bun audit` step into osn's `lefthook.yml` `pre-push` block.
9. `bun install` at root — workspaces resolve.
10. `bun run check && bun run test` — green using existing cire auth. (osn convention: `bun run check` for type-check, not `bun run build`. Tests via turbo.)
11. `bun run changeset` — generate a changeset capturing the import (osn convention requires one per change).
12. Commit on a feature branch (`feat/cire-import`), open PR — osn convention requires PRs; cire's prior "merge directly" rule is dropped post-merge. Commit message: `chore(cire): import cire as workspace via subtree`.

### Phase 2 — Shared package adoption (parallelizable)

Three independent swaps, three parallel subagents:

- **2a:** Swap all cire tsconfigs to extend `@shared/typescript-config/*`. Files: `cire/{tsconfig.json, api/tsconfig.json, web/tsconfig.json, organiser/tsconfig.json, db/tsconfig.json}`.
- **2b:** Swap `cire/api/src/middleware/rate-limit.ts` to import from `@shared/rate-limit`. Delete the local file.
- **2c:** Swap `cire/api/src/lib/timing.ts` callers to `@shared/crypto`. Delete the local file. Audit `session.ts` for further crypto reuse opportunities — note findings, don't necessarily act.

Join: `turbo build && turbo test`. Single squashed commit per swap or one combined.

### Phase 3 — Extract `@shared/osn-auth-client` (sequential, atomic)

1. Create `shared/osn-auth-client/` directory with `package.json`, `tsconfig.json`, `src/`, `tests/`.
2. Copy `pulse/api/src/lib/auth.ts` → `shared/osn-auth-client/src/verify.ts`. Copy `jwks-cache.ts` likewise.
3. Add `shared/osn-auth-client/src/middleware.ts` — Hono `osnAuth({ jwksUrl, audience })` factory.
4. Update `pulse/api/src/index.ts` (and any other callers) to import from `@shared/osn-auth-client`.
5. Delete `pulse/api/src/lib/auth.ts` and `pulse/api/src/lib/jwks-cache.ts`.
6. `turbo test --filter=@pulse/api` — must pass.
7. Single commit: `refactor(shared): extract OSN JWT verifier into @shared/osn-auth-client`.

### Phase 4 — Cire schema migration (sequential)

1. Write `cire/db/src/schema.ts` updates: add `weddings` table; add `weddingId` to `families`, `events`, `imports`.
2. `bun run db:generate` produces `cire/db/migrations/0006_multi_tenant.sql`. Hand-edit to add bootstrap `INSERT` between table create and column adds (Drizzle won't generate seed inserts).
3. Sub `<your-osn-profile-id>` placeholder with real value captured in Phase 0.
4. `bun run db:push` against local D1 (or in-memory) — confirm schema applies.
5. Smoke test: existing claim + rsvp flow still works (rows backfilled to `wed_bootstrap`).
6. `bun run db:push:remote` only after local pass.
7. Commit: `feat(cire/db): add weddings table + multi-tenant FKs`.

### Phase 5 — Organiser auth swap (parallelizable, joins at E2E)

Two parallel subagents:

- **5a — cire/api:** Add `cire/api/src/middleware/osn-auth.ts` wrapping `@shared/osn-auth-client/middleware/hono`. Add `cire/api/src/middleware/wedding-owner.ts`. Refactor `cire/api/src/routes/organiser*.ts` to use the new middlewares. Add new route group under `/api/organiser/weddings/:weddingId/*` plus the `GET /api/organiser/weddings` list endpoint. **Aliased old routes (the flat `/api/organiser/guests`, etc.) stay registered through Phase 5 but switch to the new `osnAuth()` middleware too — the `X-Organiser-Token` check is gone on the server side from Phase 5 onward. Only the URL shape lingers as an alias.** Tests for middleware first (TDD).
- **5b — cire/organiser:** Add `cire/organiser/src/auth/OsnProvider.tsx`, `sign-in.astro` page, `lib/api.ts` `authFetch` wrapper. Remove `sessionStorage["cire:organiser-token"]` reads. Update `ImportPanel.tsx` and other components to use `authFetch`.

Join: local E2E. Couple signs in on `cire/organiser` via OSN passkey → JWT lands on `cire/api` → 200 from `GET /api/organiser/weddings`. Then `200` on `GET /api/organiser/weddings/wed_bootstrap/guests`.

Two commits: `feat(cire/api): osn-auth middleware + wedding-owner authz`, `feat(cire/organiser): osn passkey sign-in`.

### Phase 6 — Cleanup (parallelizable)

Three parallel subagents:

- **6a:** Delete aliased old route definitions (`/api/organiser/guests`, `/api/organiser/events`, `/api/organiser/import/*` at the flat path) — clients have moved to the `/weddings/:weddingId/*` shape in Phase 5. Delete the `X-Organiser-Token` middleware file (already unused since Phase 5). Delete `ORGANISER_TOKEN` env from `wrangler.toml`, `local.ts`, and `.env.example`. Delete cire's old root `tsconfig.json` if not already (now extending shared).
- **6b:** Update `cire/CLAUDE.md` and `cire/wiki/`. Then create osn-side wiki pages per osn convention: `wiki/apps/cire.md` (overview, linked from `wiki/index` and root CLAUDE.md's wiki navigation table) and `wiki/systems/cire-auth.md` (the two-auth-system model: claim code for guests, OSN JWT for organisers). Each page needs YAML frontmatter (`title`, `tags`, `related`, `last-reviewed`). Update root CLAUDE.md current-state table to add cire row. Update `wiki/TODO.md` — move merge items to `wiki/changelog/completed-features`, add cire to app sections, add forward-looking entries for pulse integration and multi-owner weddings.
- **6c:** Final `turbo test` + `turbo build`. Manual smoke: claim code → RSVP works (guest path), organiser sign-in → guest list works (organiser path). Run `bun audit --audit-level=high`.

Single commit per subagent.

### Phase 7 — Archive cire.git (optional)

- Tag `cire.git/main` as `pre-osn-merge-archive`.
- Add a `MERGED.md` to cire.git pointing to `osn.git/main/cire/`.
- Do not delete cire.git. Recoverable.

### Estimated cost

- Sequential: ~12–15 hours focused work.
- With parallel subagents per phase plan: ~6–8 hours wall-clock.

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Subtree merge collides with existing osn paths | Low | Pre-check: `ls osn.git/main/cire/` returns nothing. Use unique `cire-import/` prefix, then `git mv`. |
| Root `package.json` `overrides` conflict | Med | Diff cire vs osn overrides in Phase 1 step 7. Cire's are Astro/Vite-driven; osn has no Astro yet — likely zero collision. Resolve case-by-case if found. |
| Bootstrap row needs real `osnProfileId` before Phase 4 | Med | Phase 0 captures it. Migration SQL has placeholder, substituted before run. Documented in the implementation plan. |
| Pulse breaks during `@shared/osn-auth-client` extraction | Med | Phase 3 step 6 gates on `turbo test --filter=@pulse/api`. Don't proceed to commit if red. |
| Lefthook `bun audit` flags new transitive deps post-merge | Low | Re-run lockfile after merge. The `GHSA-77vg-94rm-hx3p` ignore transfers as-is. |
| Multi-tenancy migration on prod D1 with live wedding data | Med-High | Test migration on a D1 clone first. Run during low-traffic window (no wedding ceremony active). Down migration must be tested too. |
| OSN JWKS unreachable → couple locked out of organiser | Low-Med | JWKS cached 5min + stale-while-revalidate. First-load failure is a transient 503. Solo project + bespoke wedding scope means emergency revert is one `git revert` of the Phase 5 commit (re-enables `X-Organiser-Token`). No need to keep dead code behind a flag. |
| Cire CORS allowlist breaks on organiser cross-origin auth | Low | Organiser uses Bearer header, not cookie — cross-origin works without CORS credentials. Add `OSN_ORIGIN` to allowlist defensively. |
| Existing pulse worktree (`pulse-user-onboarding-AMxQ3`) disrupted | Low | Do merge in fresh worktree. Don't touch the existing one. |

## 8. Subagent execution plan

| Phase | Parallel? | Subagents | Coordination |
|-------|-----------|-----------|--------------|
| 0 — Pre-flight | No | One agent (or manual) | — |
| 1 — Subtree merge | No | One agent, sequential | Eyes-on for risky `git mv` steps |
| 2 — Shared pkg adoption | **Yes** | 2a tsconfigs / 2b rate-limit / 2c crypto-timing | Join on `turbo test` |
| 3 — Extract osn-auth-client | No | One agent, atomic | Pulse test must pass before commit |
| 4 — Schema migration | No | One agent, sequential | DB push gates between local + remote |
| 5 — Organiser auth swap | **Yes** | 5a cire/api / 5b cire/organiser | Join on local E2E sign-in flow |
| 6 — Cleanup | **Yes** | 6a code delete / 6b docs / 6c tests | Join on final `turbo test` + smoke |
| 7 — Archive | No | Manual | — |

## 9. Skill mapping

| Skill | Phases | Why |
|-------|--------|-----|
| `superpowers:writing-plans` | After this spec is approved | Turn spec into stepwise implementation plan |
| `superpowers:executing-plans` | All phases | Drives phase-by-phase execution with checkpoints |
| `superpowers:subagent-driven-development` | 2, 5, 6 | Parallel independent units |
| `superpowers:using-git-worktrees` | 1 | Isolated merge worktree, doesn't disturb pulse work |
| `superpowers:test-driven-development` | 4, 5 | Write tests first for `osnAuth()` middleware, bootstrap row insertion, ownership check |
| `superpowers:verification-before-completion` | End of every phase | `turbo test` + `turbo build` before claiming done |
| `wrangler` | 4 | D1 migrate up/down, `db:push`/`db:push:remote` syntax |
| `workers-best-practices` | 5 review | Review new middleware + routes for floating promises, secret handling, KV correctness |
| `superpowers:requesting-code-review` | After 5 | Adversarial review of auth bridge before cleanup |
| `caveman:caveman-commit` | All phases | Tight conventional-commit messages |
| `superpowers:finishing-a-development-branch` | After 6 | Decide PR vs direct merge — solo project, likely direct merge with SSH-signed commit |
| `web-perf` | Optional post-6 | Audit organiser portal load if it feels slow after OSN sign-in lands |

**Explicitly not used:** `claude-api`, `agents-sdk`, `durable-objects`, `sandbox-sdk`, `ai:building-pydantic-ai-agents`, `web-design-guidelines` (no UI redesign), `init-project` (existing project), `turnstile-spin` (no CAPTCHA), `cloudflare-email-service` (email still deferred), `frontend-design` (no new visual design).

## 10. Verification gates (per phase)

| Phase | Gate |
|-------|------|
| 1 | `bun install` clean, `turbo build` green, `turbo test` green |
| 2 | `turbo test` green; type-check passes in all cire packages |
| 3 | `turbo test --filter=@pulse/api` green; `turbo test --filter=@shared/osn-auth-client` green |
| 4 | Drizzle schema gen idempotent; `db:push` succeeds local; existing claim+rsvp tests pass against migrated D1 |
| 5 | New middleware unit tests pass; local E2E manual: OSN sign-in → cire/api 200; ownership check returns 403 on wrong wedding |
| 6 | `turbo test` green; `bun audit` clean; manual guest + organiser smoke both pass |

## 11. Future integrations (deferred, captured for visibility)

- **Cire weddings surfaced in pulse:** Cire publishes wedding events into pulse's event feed. Two mechanism options to evaluate later: (a) pulse pulls from `cire/api` via ARC token + new scope `cire:events:read`; (b) cire writes events into pulse's DB at organiser-publish time. Decision deferred — pick when pulse user-onboarding work stabilises.
- **Multi-owner weddings:** Replace `weddings.owner_osn_profile_id` column with join table `wedding_owners (wedding_id, osn_profile_id, role)` where `role IN ('owner', 'editor', 'viewer')`. Migration adds the table, copies existing single-owner rows into it, drops the column. Update authz to query the join.
- **Guest claim-code → optional OSN account link:** Guests who are existing OSN users can optionally link their claim-code session to their OSN account for cross-app perks (social graph, RSVP history). Claim code still works anonymously.
- **Organiser passkey beyond OSN:** If OSN issuer goes down, organiser portal could fall back to a cire-local passkey or recovery code. Currently treated as low-probability; defer.
- **Magic link, SMS OTP, session cleanup cron** — all already deferred in cire's roadmap, unchanged by this merge.
- **Cire/api Hono → Elysia migration:** osn's CLAUDE.md establishes Elysia as the platform standard (TypeBox at HTTP boundary, Effect Schema in services). Cire stays on Hono through this merge — migrating during the merge would balloon scope. Listed as a follow-up to evaluate after the merge stabilises. Once migrated, cire could drop the Hono adapter in `@shared/osn-auth-client` and use the Elysia one shared with pulse/osn.
- **Cire test conventions alignment:** osn uses `it.effect` + `createTestLayer()` for service tests. Cire currently uses plain `bun:test`. Optional follow-up: align cire tests with osn's `[[wiki/conventions/testing-patterns]]`.

## 12. Decision log

| Date | Decision | Owner |
|------|----------|-------|
| 2026-06-09 | Auth coupling depth: organiser only; guest path unchanged | ac |
| 2026-06-09 | Layout: sibling workspace `cire/` matching osn/pulse/zap pattern | ac |
| 2026-06-09 | Git history: preserve via `git subtree` | ac |
| 2026-06-09 | DB: separate D1 for cire | ac |
| 2026-06-09 | Vision: platform-ready scaffold with `weddings` table from day one | ac |
| 2026-06-09 | Shared adoption: `@shared/typescript-config` + `@shared/rate-limit` now; observability/email/redis deferred | ac |
| 2026-06-09 | Lift `pulse/api/src/lib/auth.ts` + `jwks-cache.ts` into new `@shared/osn-auth-client` consumed by pulse + cire | ac |
| 2026-06-09 | Defer: `@shared/safe-parse` (premature), osn's stricter oxlint rules (separate cleanup pass) | ac |
| 2026-06-09 | Multi-owner weddings: schema scaffold single-owner now, join table later | ac |
| 2026-06-09 | Pulse-cire event integration: future work, mechanism deferred | ac |
| 2026-06-09 | Cire stays on Hono for the merge; Elysia migration tracked as follow-up | ac |
| 2026-06-09 | `@shared/osn-auth-client` exports per-framework adapters (Hono + Elysia) over a shared verification core | ac |
| 2026-06-09 | Post-merge, cire follows osn's contribution norms: feature branches, PRs, changesets, wiki page maintenance | ac |
