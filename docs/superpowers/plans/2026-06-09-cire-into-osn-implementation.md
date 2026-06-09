# Merging cire into osn.git — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Physically land cire.git as a sibling `cire/` workspace inside osn.git, route the organiser portal through OSN passkey auth via a new `@shared/osn-auth-client`, scaffold multi-tenancy in cire's schema, and keep guest claim-code auth unchanged.

**Architecture:** Cire becomes the fourth sibling workspace alongside `osn/`, `pulse/`, `zap/`. Two cohabiting auth systems by route prefix — `cire_session` cookie for guests (untouched), OSN JWT (Bearer) for organisers. The OSN-JWT verification logic currently embedded in pulse/api lifts into a shared package with per-framework adapters (Elysia for pulse/osn, Hono for cire).

**Tech Stack:** Bun + TypeScript + Hono (cire) / Elysia (pulse, osn) on Cloudflare Workers, Drizzle ORM on D1, Astro + SolidJS frontends, `jose` for JWT, Turborepo, lefthook, oxlint, oxfmt, Vitest + bun:test, Changesets.

**Spec:** [`../specs/2026-06-09-cire-into-osn-design.md`](../specs/2026-06-09-cire-into-osn-design.md)

**Repos:**
- osn (target): `/Users/ac/.work/osn.git/` — bare repo with worktrees in subdirectories
- cire (source): `/Users/ac/.work/cire.git/` — bare repo with `main` worktree

---

## File Structure

### New files (created during this plan)

| Path | Purpose |
|------|---------|
| `shared/osn-auth-client/package.json` | New shared package declaration |
| `shared/osn-auth-client/tsconfig.json` | Extends `@shared/typescript-config/node.json` |
| `shared/osn-auth-client/src/index.ts` | Re-exports |
| `shared/osn-auth-client/src/verify.ts` | Framework-agnostic `verifyOsnAccessToken()` and `extractClaims()` |
| `shared/osn-auth-client/src/jwks-cache.ts` | Lifted from `pulse/api/src/lib/jwks-cache.ts` |
| `shared/osn-auth-client/src/middleware/elysia.ts` | Elysia plugin for pulse/osn |
| `shared/osn-auth-client/src/middleware/hono.ts` | Hono middleware for cire |
| `shared/osn-auth-client/tests/verify.test.ts` | Lifted/repathed from pulse |
| `shared/osn-auth-client/tests/middleware-hono.test.ts` | New tests for the Hono adapter |
| `shared/osn-auth-client/tests/middleware-elysia.test.ts` | New tests for the Elysia adapter (or repathed if pulse already had them) |
| `shared/osn-auth-client/README.md` | Usage doc for both adapters |
| `cire/api/src/middleware/osn-auth.ts` | Thin wrapper that configures the Hono adapter for cire/api |
| `cire/api/src/middleware/wedding-owner.ts` | Authz: caller's `osnProfileId` owns the `weddingId` from path |
| `cire/api/src/routes/organiser-weddings.ts` | New routes: list owned weddings; nested guest/event/import routes |
| `cire/api/src/middleware/__tests__/osn-auth.test.ts` | Unit tests |
| `cire/api/src/middleware/__tests__/wedding-owner.test.ts` | Unit tests |
| `cire/api/src/routes/__tests__/organiser-weddings.test.ts` | Route tests |
| `cire/db/src/schema/weddings.ts` *(or inline in `schema.ts`)* | `weddings` table definition |
| `cire/db/migrations/0006_multi_tenant.sql` | Drizzle-generated + hand-edited bootstrap insert |
| `cire/organiser/src/auth/OsnProvider.tsx` | Wraps the SolidJS app with `@osn/client`'s OSN auth provider |
| `cire/organiser/src/pages/sign-in.astro` | Hosts `@osn/ui/auth/SignIn` |
| `cire/organiser/src/lib/api.ts` | `authFetch()` wrapper around `@osn/client`'s SDK |
| `wiki/apps/cire.md` | New osn-side wiki page |
| `wiki/systems/cire-auth.md` | Two-auth-system reference |
| `.changeset/cire-merge-import.md` | Phase 1 changeset |
| `.changeset/shared-osn-auth-client.md` | Phase 3 changeset |
| `.changeset/cire-multi-tenant-schema.md` | Phase 4 changeset |
| `.changeset/cire-organiser-osn-auth.md` | Phase 5 changeset |

### Modified files (existing)

| Path | Change |
|------|--------|
| `package.json` (osn root) | Add `"cire/*"` to `workspaces`; merge cire's `overrides` block |
| `turbo.json` | Add cire scripts to pipeline |
| `lefthook.yml` (osn root) | Merge cire's `bun audit` step into `pre-push` |
| `bunfig.toml` (osn root) | Keep osn's `minimumReleaseAge = 259200` (3 days) |
| `oxlintrc.json` (osn root) | No changes — cire's defaults coexist; stricter adoption deferred |
| `pulse/api/src/index.ts` | Swap import to `@shared/osn-auth-client/middleware/elysia` |
| `cire/tsconfig.json` (cire's root, imported by subtree) | After Phase 1 move: replace with `extends: "@shared/typescript-config/solid.json"` |
| `cire/api/tsconfig.json` | Replace with `extends: "@shared/typescript-config/node.json"` + CF Workers types |
| `cire/web/tsconfig.json` | Extends `@shared/typescript-config/solid.json` (or per-package idiom) |
| `cire/organiser/tsconfig.json` | Same |
| `cire/db/tsconfig.json` | Extends `@shared/typescript-config/node.json` |
| `cire/api/src/app.ts` | Mount `@shared/rate-limit`-backed limiter; register new organiser routes |
| `cire/api/src/middleware/rate-limit.ts` | Delete after Phase 2b |
| `cire/api/src/lib/timing.ts` | Delete after Phase 2c (swap callers to `node:crypto`'s `timingSafeEqual`) |
| `cire/api/src/services/session.ts` | No mandatory change; audit-only |
| `cire/api/src/routes/organiser-import.ts` | Replace `X-Organiser-Token` gate with `osnAuth()` (Phase 5); delete file or fold into new routes (Phase 6) |
| `cire/api/wrangler.toml` | Add `OSN_JWKS_URL`, `OSN_ISSUER_URL`, `OSN_AUDIENCE`; remove `ORGANISER_TOKEN` |
| `cire/api/src/local.ts` | Remove `ORGANISER_TOKEN` env wiring |
| `cire/organiser/src/components/ImportPanel.tsx` | Drop `X-Organiser-Token` injection; use `authFetch` |
| `cire/db/src/schema.ts` | Add `weddings` table + `weddingId` columns on `families`, `events`, `imports` |
| `CLAUDE.md` (osn root) | Add cire to current-state table + wiki navigation |
| `wiki/TODO.md` | Add cire-related entries to app sections; move merge tasks to changelog on completion |

### Deleted files

| Path | Reason |
|------|--------|
| `cire/api/src/middleware/rate-limit.ts` | Replaced by `@shared/rate-limit` (Phase 2b) |
| `cire/api/src/lib/timing.ts` | Replaced by `node:crypto`'s `timingSafeEqual` (Phase 2c) |
| `pulse/api/src/lib/auth.ts` | Moved into `@shared/osn-auth-client` (Phase 3) |
| `pulse/api/src/lib/jwks-cache.ts` | Same |

---

## Phase 0 — Pre-flight

Solo dev, manual environment checks. Captures the OSN profile ID needed in Phase 4.

### Task T0.1: Verify osn dev stack runs

**Files:** none (read-only verification).

- [ ] **Step 1: Open a terminal in the osn worktree**

```bash
cd /Users/ac/.work/osn.git/main
```

- [ ] **Step 2: Start the OSN API**

```bash
bun run dev:osn
```

Expected: log line `osn-api: listening on http://localhost:4000` (or similar). Leave running.

- [ ] **Step 3: Hit the OIDC discovery endpoint from a second terminal**

```bash
curl -s http://localhost:4000/.well-known/openid-configuration | head -20
```

Expected: JSON with `issuer`, `token_endpoint`, `jwks_uri`. Non-empty.

- [ ] **Step 4: Hit JWKS**

```bash
curl -s http://localhost:4000/.well-known/jwks.json
```

Expected: JSON with `keys: [{kty: "EC", crv: "P-256", ...}]`.

If any of the above fails, stop and fix the OSN dev environment before proceeding. The plan assumes OSN is reachable.

### Task T0.2: Verify cire builds and tests pass

**Files:** none.

- [ ] **Step 1: Open a terminal in the cire worktree**

```bash
cd /Users/ac/.work/cire.git/main
```

- [ ] **Step 2: Install dependencies**

```bash
bun install
```

Expected: no errors. Lockfile may update but should not.

- [ ] **Step 3: Build**

```bash
bun run build
```

Expected: each workspace builds clean.

- [ ] **Step 4: Test**

```bash
bun run test
```

Expected: all suites pass.

If anything is red, fix cire first. Importing a broken tree into osn just spreads the problem.

### Task T0.3: Bootstrap your OSN profile, capture the `usr_*` ID

**Files:** none.

This step produces the value substituted into `cire/db/migrations/0006_multi_tenant.sql` in Phase 4.

- [ ] **Step 1: With osn-api still running, register an account**

Use the osn dev UI if running (`@osn/social` on :1422) or hit the API directly:

```bash
EMAIL="you+cire@example.com"
curl -X POST http://localhost:4000/register/begin \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\"}"
```

Expected: 200 OK; an OTP appears in the log buffer (`makeLogEmailLive` captures it for dev).

- [ ] **Step 2: Read the OTP from the log buffer**

```bash
# In the osn-api log stream, find a line shaped like:
# [email:log] template=otp_verification to=you+cire@example.com
# Then query the in-memory log API if exposed, or grep the dev console.
```

For local dev, the OTP code is typically logged or stored in-process and surfaced via a dev endpoint. If you cannot retrieve it programmatically, restart osn-api with `OSN_DEV_EXPOSE_OTPS=true` (if supported) or instrument a temporary log. **Capture the 6-digit code.**

- [ ] **Step 3: Complete registration**

```bash
OTP="123456"   # paste the captured value
HANDLE="cire-admin"
curl -X POST http://localhost:4000/register/complete \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\", \"otp\": \"$OTP\", \"handle\": \"$HANDLE\", \"displayName\": \"Cire Admin\"}"
```

Expected: 200 with `{session: {access_token, ...}, profile: {id: "usr_...", handle, ...}}`.

- [ ] **Step 4: Save the profile ID**

Extract `profile.id` from the response (e.g. `usr_01HXY...`). Store it somewhere durable for the next steps (a shell variable, a sticky note):

```bash
export OSN_PROFILE_ID="usr_01HXYZABCDEF"   # YOUR actual value here
echo "$OSN_PROFILE_ID"
```

- [ ] **Step 5 (optional but recommended): Enrol a passkey on this profile**

Use the osn dev UI's SignIn / Register flow, or follow the WebAuthn ceremony described in `wiki/systems/passkey-primary.md`. Enrolling now means Phase 5's E2E test has a working credential to drive.

### Task T0.4: Create the work worktree

Spec §6 Phase 0 calls for an isolated worktree. The current plan-writing worktree (`docs-cire-merge-plan`) holds the spec + plan but should not host disruptive merge work.

- [ ] **Step 1: From the osn bare repo, list existing worktrees**

```bash
cd /Users/ac/.work/osn.git && git worktree list
```

Expected: `main` worktree on its current branch, `pulse-user-onboarding-AMxQ3` worktree on its branch, `docs-cire-merge-plan` worktree (this one).

- [ ] **Step 2: Create a fresh worktree on a new branch off `docs/cire-merge-plan`**

```bash
cd /Users/ac/.work/osn.git
git worktree add cire-merge -b feat/cire-merge docs/cire-merge-plan
```

Expected: `Preparing worktree (new branch 'feat/cire-merge')` and `HEAD is now at <sha> docs(cire): plan merging cire into osn as workspace`. The spec + plan are carried into the new branch.

- [ ] **Step 3: Switch into it**

```bash
cd /Users/ac/.work/osn.git/cire-merge
ls
```

Expected: full osn tree (osn/, pulse/, zap/, shared/, docs/, etc.). The remainder of this plan runs in this worktree unless stated otherwise.

- [ ] **Step 4: Confirm clean state**

```bash
git status --short
```

Expected: empty output.

---

## Phase 1 — Subtree merge

Sequential, no parallelism. Risky steps demand eyes-on. Single resulting commit at the end of the phase plus a changeset.

### Task T1.1: Add cire as a git remote and fetch

**Files:** none (git state only).

- [ ] **Step 1: Add the remote**

```bash
cd /Users/ac/.work/osn.git/cire-merge
git remote add cire /Users/ac/.work/cire.git
```

Expected: no output.

- [ ] **Step 2: Fetch cire's refs**

```bash
git fetch cire
```

Expected: lines like `From /Users/ac/.work/cire.git` followed by `* [new branch] main -> cire/main`.

- [ ] **Step 3: Confirm the ref**

```bash
git log --oneline cire/main -3
```

Expected: cire's most recent three commits.

### Task T1.2: Subtree-add cire's tree under `cire-import/`

**Files:** creates `cire-import/...` (entire cire tree).

- [ ] **Step 1: Run `git subtree add`**

```bash
git subtree add --prefix=cire-import cire/main
```

Expected: merge commit message `Add 'cire-import/' from commit '<sha>'`. History from cire is now reachable; tree shows `cire-import/` populated.

- [ ] **Step 2: Verify**

```bash
ls cire-import/
test -d cire-import/apps/api && echo OK_API
test -d cire-import/packages/db && echo OK_DB
```

Expected: `apps`, `packages`, `wiki`, `README.md`, `CLAUDE.md`, etc. listed; `OK_API` and `OK_DB` printed.

### Task T1.3: Rename into the target `cire/` layout

**Files:** moves `cire-import/apps/{api,web,organiser}` → `cire/{api,web,organiser}`; `cire-import/packages/db` → `cire/db`.

- [ ] **Step 1: Create the destination directory**

```bash
mkdir -p cire
```

- [ ] **Step 2: Move each workspace**

```bash
git mv cire-import/apps/api cire/api
git mv cire-import/apps/web cire/web
git mv cire-import/apps/organiser cire/organiser
git mv cire-import/packages/db cire/db
```

Expected: no output. Each `git mv` stages a rename.

- [ ] **Step 3: Verify staged renames**

```bash
git status --short | head -20
```

Expected: lines beginning with `R  cire-import/apps/api/... -> cire/api/...` etc.

### Task T1.4: Migrate cire's root documentation files

**Files:** moves `cire-import/README.md` → `cire/README.md`; `CLAUDE.md` → `cire/CLAUDE.md`; `wiki/` → `cire/wiki/`.

- [ ] **Step 1: Move docs**

```bash
git mv cire-import/README.md cire/README.md
git mv cire-import/CLAUDE.md cire/CLAUDE.md
git mv cire-import/wiki cire/wiki
```

- [ ] **Step 2: Verify**

```bash
test -f cire/README.md && echo OK
test -f cire/CLAUDE.md && echo OK
test -d cire/wiki && echo OK
```

Expected: three `OK` lines.

### Task T1.5: Absorb cire's root configs (package.json overrides, bunfig, lefthook)

**Files:** modifies osn `package.json`, `lefthook.yml`; reads `cire-import/{package.json,bunfig.toml,lefthook.yml}`.

- [ ] **Step 1: Compare overrides**

```bash
echo "=== cire overrides ==="
jq '.overrides' cire-import/package.json
echo "=== osn overrides ==="
jq '.overrides // {}' package.json
```

- [ ] **Step 2: Merge cire's `overrides` into osn's root `package.json`**

Open osn root `package.json`. Add (or extend) the `overrides` block to include every key from cire's:

```json
{
  "overrides": {
    "devalue": "^5.8.1",
    "esbuild": "^0.25.0",
    "picomatch": "^4.0.4",
    "postcss": "^8.5.15",
    "smol-toml": "^1.6.1",
    "vite": "^7.3.2"
  }
}
```

If osn already has any of these keys, use the higher version. Document any conflict in the commit message.

- [ ] **Step 3: Decide on `bunfig.toml`**

```bash
diff cire-import/bunfig.toml bunfig.toml
```

Expected: cire's `minimumReleaseAge = 1209600` (14 days) vs osn's `259200` (3 days). Keep osn's. No file change needed; delete cire's after this step.

- [ ] **Step 4: Merge cire's `lefthook.yml` `pre-push` audit step into osn's**

Edit osn's `lefthook.yml`. Add an `audit` command under `pre-push.commands`:

```yaml
pre-push:
  commands:
    typecheck:
      run: bun run check
    audit:
      run: >
        bun audit --audit-level=high
        --ignore=GHSA-77vg-94rm-hx3p
```

(Keep cire's `--ignore=GHSA-77vg-94rm-hx3p` comment block intact in the YAML or relocate to a sibling comment.)

- [ ] **Step 5: Add `"cire/*"` to root workspaces**

Edit osn root `package.json`. In the `workspaces` array, add `"cire/*"`:

```json
{
  "workspaces": [
    "osn/*",
    "pulse/*",
    "zap/*",
    "cire/*",
    "shared/*",
    "pulse/*/web",
    "pulse/*/ios"
  ]
}
```

- [ ] **Step 6: Stage everything**

```bash
git add package.json lefthook.yml
```

### Task T1.6: Delete the `cire-import/` remnant

**Files:** deletes `cire-import/` (all remaining files — root configs already absorbed).

- [ ] **Step 1: Remove**

```bash
git rm -rf cire-import
```

Expected: lines beginning with `rm 'cire-import/...'` for each remaining file (root configs that we chose not to migrate).

- [ ] **Step 2: Verify directory gone**

```bash
test ! -e cire-import && echo OK
```

Expected: `OK`.

### Task T1.7: Update `turbo.json` to include cire

**Files:** modifies `turbo.json`.

- [ ] **Step 1: Inspect existing turbo config**

```bash
cat turbo.json
```

- [ ] **Step 2: Confirm cire workspaces are discoverable**

Turbo derives workspaces from `package.json` `workspaces`. With `cire/*` added, `turbo run build`, `turbo run dev`, `turbo run test`, `turbo run check` automatically include cire packages. Verify by listing:

```bash
bun install   # propagate workspaces config
bunx turbo run check --filter='cire/*' --dry
```

Expected: dry-run output listing `@cire/api`, `@cire/web`, `@cire/organiser`, `@cire/db`.

- [ ] **Step 3: Add a `dev:cire` script to root `package.json`**

Edit the `scripts` block:

```json
{
  "scripts": {
    "dev:cire": "turbo dev --filter=@cire/api --filter=@cire/web --filter=@cire/organiser --filter=@osn/api"
  }
}
```

(`@osn/api` is included because the organiser portal needs JWKS reachable.)

- [ ] **Step 4: Stage**

```bash
git add package.json turbo.json
```

### Task T1.8: Resolve workspaces, run install and verification

**Files:** none code; lockfile updates.

- [ ] **Step 1: Install**

```bash
bun install
```

Expected: workspaces resolve; cire's deps populate `node_modules/`; lockfile updates.

- [ ] **Step 2: Run check (type-check)**

```bash
bun run check
```

Expected: all packages type-check clean. Cire's existing tsconfigs work as-is at this point (we haven't swapped to shared yet).

- [ ] **Step 3: Run tests**

```bash
bun run test
```

Expected: every workspace's tests pass (osn, pulse, zap, cire, shared).

- [ ] **Step 4: Run build**

```bash
bun run build
```

Expected: all packages build clean.

If any of these fail, stop. Don't commit a broken tree.

### Task T1.9: Write Phase 1 changeset

**Files:** creates `.changeset/cire-merge-import.md`.

- [ ] **Step 1: Generate via CLI**

```bash
bun run changeset
```

Walk through the prompts: select all cire packages (`@cire/api`, `@cire/web`, `@cire/organiser`, `@cire/db`) at `minor` bump level. Summary: `Import cire as a sibling workspace under osn`.

If non-interactive flow is required, write the file directly:

```bash
cat > .changeset/cire-merge-import.md <<'EOF'
---
"@cire/api": minor
"@cire/web": minor
"@cire/organiser": minor
"@cire/db": minor
---

Import cire as a sibling workspace under osn. Cire packages enter the
monorepo with their existing surface area; auth/integration changes
arrive in later phases.
EOF
```

- [ ] **Step 2: Stage**

```bash
git add .changeset/cire-merge-import.md
```

### Task T1.10: Commit Phase 1

**Files:** the merge commit + subtree-add merge are both already present.

- [ ] **Step 1: Verify final state**

```bash
git status --short
```

Expected: only staged changes (no untracked, no unstaged modifications).

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore(cire): import cire as workspace via git subtree

Brings the cire.git/main tree under `cire/` (api, web, organiser, db)
preserving full upstream history via `git subtree add`. Updates root
package.json workspaces, merges cire's overrides and lefthook audit
step, adds dev:cire script. Existing cire auth (claim code + cookie)
remains untouched at this point.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: lefthook runs (lint + format on staged files). Pre-commit passes.

- [ ] **Step 3: Sanity check**

```bash
git log --oneline -3
ls cire/
```

Expected: commit at tip; cire workspaces present.

---

## Phase 2 — Shared package adoption (parallelizable)

Three independent swaps. Section 2a / 2b / 2c can run in parallel subagents. Join with a full `turbo run check && turbo run test` before commits.

### Task T2a.1: Audit cire's tsconfigs

**Files:** read-only.

- [ ] **Step 1: List cire tsconfigs**

```bash
find cire -name 'tsconfig.json' -not -path '*/node_modules/*'
```

Expected output:

```
cire/tsconfig.json
cire/api/tsconfig.json
cire/web/tsconfig.json
cire/organiser/tsconfig.json
cire/db/tsconfig.json
```

- [ ] **Step 2: Inspect each, plus the shared configs we'll extend**

```bash
for f in cire/tsconfig.json cire/api/tsconfig.json cire/web/tsconfig.json cire/organiser/tsconfig.json cire/db/tsconfig.json; do
  echo "=== $f ==="
  cat "$f"
done
echo "=== shared bases ==="
cat shared/typescript-config/base.json
cat shared/typescript-config/node.json
cat shared/typescript-config/solid.json
```

### Task T2a.2: Replace cire root tsconfig

**Files:** modifies `cire/tsconfig.json`.

- [ ] **Step 1: Overwrite with shared extension**

```json
{
  "extends": "@shared/typescript-config/solid.json"
}
```

(Cire's root tsconfig set `jsx: preserve` + `jsxImportSource: solid-js` — those live in `solid.json`. If `solid.json` does not include them, fall back to keeping cire's overrides inline:)

Inspect `shared/typescript-config/solid.json`. If it lacks Solid JSX settings, write instead:

```json
{
  "extends": "@shared/typescript-config/base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "lib": ["ES2022", "DOM"],
    "moduleResolution": "bundler"
  }
}
```

- [ ] **Step 2: Verify type-check at root**

```bash
bun run check
```

Expected: passes for all cire packages (they still inherit from this root tsconfig where applicable).

### Task T2a.3: Replace `cire/api/tsconfig.json`

**Files:** modifies `cire/api/tsconfig.json`.

- [ ] **Step 1: Write new file**

```json
{
  "extends": "@shared/typescript-config/node.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/**/*", "worker-configuration.d.ts"]
}
```

- [ ] **Step 2: Type-check**

```bash
bun run --cwd cire/api check 2>&1 | tail -20
```

If `cire/api`'s package.json has no `check` script, use:

```bash
bunx --bun tsc --noEmit -p cire/api/tsconfig.json
```

Expected: passes.

### Task T2a.4: Replace `cire/web/tsconfig.json` and `cire/organiser/tsconfig.json`

**Files:** modifies both.

- [ ] **Step 1: Inspect first**

```bash
cat cire/web/tsconfig.json cire/organiser/tsconfig.json
```

- [ ] **Step 2: Write new `cire/web/tsconfig.json`**

```json
{
  "extends": "@shared/typescript-config/solid.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM"],
    "jsx": "preserve",
    "jsxImportSource": "solid-js"
  },
  "include": ["src/**/*", "astro.config.mjs"]
}
```

(Inline the Solid options if `solid.json` doesn't already provide them.)

- [ ] **Step 3: Write new `cire/organiser/tsconfig.json`** with the same contents (organiser is also Astro + Solid).

- [ ] **Step 4: Type-check**

```bash
bunx --bun tsc --noEmit -p cire/web/tsconfig.json
bunx --bun tsc --noEmit -p cire/organiser/tsconfig.json
```

Expected: passes.

### Task T2a.5: Replace `cire/db/tsconfig.json`

**Files:** modifies `cire/db/tsconfig.json`.

- [ ] **Step 1: Write new**

```json
{
  "extends": "@shared/typescript-config/node.json",
  "include": ["src/**/*", "drizzle.config.ts"]
}
```

- [ ] **Step 2: Type-check**

```bash
bunx --bun tsc --noEmit -p cire/db/tsconfig.json
```

Expected: passes.

### Task T2a.6: Commit Phase 2a

**Files:** stages all five tsconfig.json files.

- [ ] **Step 1: Verify full type-check**

```bash
bun run check
```

Expected: all packages green.

- [ ] **Step 2: Stage and commit**

```bash
git add cire/tsconfig.json cire/api/tsconfig.json cire/web/tsconfig.json cire/organiser/tsconfig.json cire/db/tsconfig.json
git commit -m "$(cat <<'EOF'
chore(cire): extend @shared/typescript-config in all packages

Drops cire's bespoke tsconfigs in favour of the shared base. No
behavioural change — same target/lib/moduleResolution settings.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task T2b.1: Find every caller of cire's rate-limit middleware

**Files:** read-only.

- [ ] **Step 1: Grep for the import**

```bash
grep -rn "from .*middleware/rate-limit\|services/rate-limit" cire --include='*.ts' --include='*.tsx' -l 2>/dev/null
```

Expected: at least `cire/api/src/app.ts`. Note all occurrences.

- [ ] **Step 2: Read the existing middleware**

```bash
cat cire/api/src/middleware/rate-limit.ts
cat cire/api/src/services/rate-limit.ts
```

Confirm: the file exports `rateLimitMiddleware(limiter)` returning a `MiddlewareHandler`; the service exports `RateLimiter` type, `createRateLimiter(...)`, and `getClientIp(headers)`.

### Task T2b.2: Confirm `@shared/rate-limit`'s shape

**Files:** read-only.

- [ ] **Step 1: Read its index**

```bash
cat shared/rate-limit/src/index.ts | head -80
```

Confirm: it exports `RateLimiterBackend` interface, `RateLimiter` type, `createRateLimiter(config)`, `RateLimiterConfig`.

- [ ] **Step 2: Check `getClientIp` availability**

```bash
grep -rn "getClientIp\|client.*ip" shared/rate-limit/src/
```

If `getClientIp` is **not** in `@shared/rate-limit`, keep cire's local `services/rate-limit.ts` `getClientIp` helper (it's tiny — extract just IP parsing from cire's file). Otherwise replace.

### Task T2b.3: Write a failing test for cire's rate-limit middleware on top of the shared limiter

**Files:** creates `cire/api/src/middleware/__tests__/rate-limit.test.ts`.

- [ ] **Step 1: Write the test**

```ts
// cire/api/src/middleware/__tests__/rate-limit.test.ts
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createRateLimiter } from "@shared/rate-limit";
import { rateLimitMiddleware } from "../rate-limit";

describe("rateLimitMiddleware on @shared/rate-limit", () => {
  it("allows requests up to maxRequests then returns 429", async () => {
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const app = new Hono();
    app.use("/limited", rateLimitMiddleware(limiter));
    app.get("/limited", (c) => c.text("ok"));

    const req = () =>
      app.request("/limited", { headers: { "CF-Connecting-IP": "203.0.113.1" } });

    const r1 = await req();
    const r2 = await req();
    const r3 = await req();

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(r3.headers.get("Retry-After")).toBe("60");
  });
});
```

- [ ] **Step 2: Run — expect to FAIL** (current middleware imports from local `../services/rate-limit`, not the shared package)

```bash
bun test cire/api/src/middleware/__tests__/rate-limit.test.ts
```

Expected: failure (import error, or signature mismatch).

### Task T2b.4: Switch cire's rate-limit middleware to `@shared/rate-limit`

**Files:** modifies `cire/api/src/middleware/rate-limit.ts` and `cire/api/src/app.ts`; conditionally deletes `cire/api/src/services/rate-limit.ts`.

- [ ] **Step 1: Update the middleware file**

```ts
// cire/api/src/middleware/rate-limit.ts
import type { MiddlewareHandler } from "hono";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { getClientIp } from "../lib/client-ip";

/**
 * Hono middleware enforcing per-IP rate limiting via @shared/rate-limit.
 * Returns 429 with Retry-After when the limit is exceeded.
 */
export function rateLimitMiddleware(limiter: RateLimiterBackend): MiddlewareHandler {
  return async (c, next) => {
    const ip = getClientIp(c.req.raw.headers);
    const allowed = await limiter.check(ip);

    if (!allowed) {
      c.header("Retry-After", "60");
      return c.json({ error: "Too many requests" }, 429);
    }

    return next();
  };
}
```

- [ ] **Step 2: Extract `getClientIp` into `cire/api/src/lib/client-ip.ts`**

If cire previously had `getClientIp` inside `services/rate-limit.ts`, lift just that function:

```ts
// cire/api/src/lib/client-ip.ts
/** Resolve the caller's IP from CF / X-Forwarded-For headers. */
export function getClientIp(headers: Headers): string {
  return (
    headers.get("CF-Connecting-IP") ??
    headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
```

- [ ] **Step 3: Update `cire/api/src/app.ts` to construct the shared limiter**

Open `cire/api/src/app.ts`. Replace any reference to `services/rate-limit`'s `createRateLimiter` with:

```ts
import { createRateLimiter } from "@shared/rate-limit";
```

Construction of the claim limiter remains structurally the same:

```ts
const claimLimiter = createRateLimiter({
  maxRequests: 5,
  windowMs: 60_000,
});
app.use("/api/claim", rateLimitMiddleware(claimLimiter));
```

- [ ] **Step 4: Delete the obsolete local service**

```bash
git rm cire/api/src/services/rate-limit.ts
```

(If the file has other exports cire depends on, scrub callers first. Most likely it only exported `createRateLimiter` and `RateLimiter`, both now from `@shared/rate-limit`.)

- [ ] **Step 5: Add the dependency to cire/api**

```bash
bun add @shared/rate-limit --cwd cire/api
```

Expected: `package.json` adds `"@shared/rate-limit": "workspace:*"`.

- [ ] **Step 6: Run the test — expect to PASS**

```bash
bun test cire/api/src/middleware/__tests__/rate-limit.test.ts
```

Expected: green.

### Task T2b.5: Full cire/api regression test

**Files:** none.

- [ ] **Step 1: Run cire/api tests**

```bash
bun run --cwd cire/api test
```

Expected: all green, including the existing claim-route rate-limit integration tests.

- [ ] **Step 2: Stage and commit**

```bash
git add cire/api
git commit -m "$(cat <<'EOF'
refactor(cire/api): adopt @shared/rate-limit

Replaces cire/api's in-package createRateLimiter with the shared
backend-agnostic version. Hono middleware remains in cire/api but now
delegates to the shared limiter; getClientIp moved to a lib file.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task T2c.1: Find every caller of cire's `lib/timing.ts`

**Files:** read-only.

- [ ] **Step 1: Grep**

```bash
grep -rn "constantTimeEqual\|from .*lib/timing" cire --include='*.ts' 2>/dev/null
```

Expected: `cire/api/src/routes/organiser-import.ts` and possibly a test file.

- [ ] **Step 2: Read the existing helper**

```bash
cat cire/api/src/lib/timing.ts
```

Confirm function signature: `constantTimeEqual(a: string, b: string): boolean`.

### Task T2c.2: Write failing tests asserting `timingSafeEqual` behaviour at call sites

**Files:** creates `cire/api/src/routes/__tests__/organiser-import-timing.test.ts` (if not present already).

This task may be skipped if existing tests cover the path well — search first:

```bash
grep -rn "constantTimeEqual\|timing.*safe\|organiser.*token" cire/api -l
```

If existing tests already cover the X-Organiser-Token comparison, run them after the swap. If not:

- [ ] **Step 1: Write a minimal test**

```ts
// cire/api/src/routes/__tests__/organiser-import-timing.test.ts
import { describe, expect, it } from "bun:test";

describe("organiser token comparison", () => {
  it("accepts the configured token", async () => {
    const ORG = "test-token-1234567890abcdef";
    const res = await fetch("http://localhost/api/organiser/import/list", {
      headers: { "X-Organiser-Token": ORG },
    });
    // Cannot exercise via fetch without spinning up the app; instead,
    // import the comparison module directly and exercise it:
    const { timingSafeEqual } = await import("node:crypto");
    const a = Buffer.from(ORG, "utf8");
    const b = Buffer.from(ORG, "utf8");
    expect(timingSafeEqual(a, b)).toBe(true);
  });
});
```

This is a smoke test for the swap; real coverage comes from the existing route tests.

### Task T2c.3: Swap `constantTimeEqual` callers to `node:crypto`'s `timingSafeEqual`

**Files:** modifies `cire/api/src/routes/organiser-import.ts` (and any other caller). Deletes `cire/api/src/lib/timing.ts`.

- [ ] **Step 1: Update each caller**

Open `cire/api/src/routes/organiser-import.ts`. Replace:

```ts
import { constantTimeEqual } from "../lib/timing";
// ...
if (!constantTimeEqual(provided, expected)) {
```

with:

```ts
import { timingSafeEqual } from "node:crypto";
// ...
const providedBuf = Buffer.from(provided, "utf8");
const expectedBuf = Buffer.from(expected, "utf8");
if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
```

The length check is required because `timingSafeEqual` throws on unequal-length inputs.

- [ ] **Step 2: Delete the old helper**

```bash
git rm cire/api/src/lib/timing.ts
```

- [ ] **Step 3: Run cire/api tests**

```bash
bun run --cwd cire/api test
```

Expected: all green; the X-Organiser-Token test still passes against the new comparison.

### Task T2c.4: Commit Phase 2c

- [ ] **Step 1: Stage and commit**

```bash
git add cire/api
git commit -m "$(cat <<'EOF'
refactor(cire/api): use node:crypto timingSafeEqual

Drops the local constantTimeEqual XOR-fold helper in favour of the
standard library implementation. Same constant-time semantics, fewer
moving parts. Callers explicit-length-check before comparing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task T2.6: Phase 2 join — full repo verification

**Files:** none.

- [ ] **Step 1: Run full pipeline**

```bash
bun run check
bun run test
bun run build
```

Expected: all green across osn, pulse, zap, cire, shared.

---

## Phase 3 — Extract `@shared/osn-auth-client`

Sequential. Atomic single commit at the end (after pulse tests pass).

### Task T3.1: Create the package skeleton

**Files:** creates `shared/osn-auth-client/{package.json, tsconfig.json, src/index.ts, README.md}`.

- [ ] **Step 1: Make the directory**

```bash
mkdir -p shared/osn-auth-client/src/middleware shared/osn-auth-client/tests
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "@shared/osn-auth-client",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./verify": "./src/verify.ts",
    "./jwks-cache": "./src/jwks-cache.ts",
    "./middleware/hono": "./src/middleware/hono.ts",
    "./middleware/elysia": "./src/middleware/elysia.ts"
  },
  "scripts": {
    "check": "tsc --noEmit",
    "test": "bunx --bun vitest",
    "test:run": "bunx --bun vitest run"
  },
  "dependencies": {
    "jose": "^5.9.0"
  },
  "devDependencies": {
    "@shared/typescript-config": "workspace:*",
    "vitest": "^4.1.5",
    "hono": "^4.12.23",
    "elysia": "^1.4.20"
  }
}
```

(Versions: pin to what pulse already uses for `jose`; check `pulse/api/package.json` and match.)

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "extends": "@shared/typescript-config/node.json",
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 4: Write `README.md`**

```md
# @shared/osn-auth-client

Verifies OSN-issued access tokens (ES256, `aud: "osn-access"`) via JWKS
with an LRU cache and stale-while-revalidate refresh. Ships
framework-agnostic primitives plus per-framework middleware adapters.

## Usage — Hono (cire)

```ts
import { osnAuth } from "@shared/osn-auth-client/middleware/hono";

app.use("/api/organiser/*", osnAuth({
  jwksUrl: process.env.OSN_JWKS_URL!,
  audience: "osn-access",
}));
```

## Usage — Elysia (pulse, osn)

```ts
import { osnAuth } from "@shared/osn-auth-client/middleware/elysia";

new Elysia().use(osnAuth({
  jwksUrl: process.env.OSN_JWKS_URL!,
  audience: "osn-access",
}));
```

## Direct verification

```ts
import { extractClaims } from "@shared/osn-auth-client/verify";
const claims = await extractClaims(req.headers.get("authorization"), jwksUrl);
```
```

- [ ] **Step 5: Write `src/index.ts`** (placeholder re-exports; details land in following tasks)

```ts
export * from "./verify";
export * from "./jwks-cache";
```

- [ ] **Step 6: Install**

```bash
bun install
```

Expected: workspace resolves; `node_modules/@shared/osn-auth-client` is a symlink into the new package.

### Task T3.2: Lift `jwks-cache.ts` from pulse

**Files:** copies `pulse/api/src/lib/jwks-cache.ts` → `shared/osn-auth-client/src/jwks-cache.ts`.

- [ ] **Step 1: Inspect the source**

```bash
cat pulse/api/src/lib/jwks-cache.ts
```

- [ ] **Step 2: Copy and update imports**

```bash
cp pulse/api/src/lib/jwks-cache.ts shared/osn-auth-client/src/jwks-cache.ts
```

Edit the new file: change any internal imports (`./...`) so they resolve from `shared/osn-auth-client/src/`. If `jwks-cache.ts` imports from `./auth`, refactor — circular imports between `verify.ts` and `jwks-cache.ts` indicate one direction wins. Inspect for this; usually `verify.ts` imports `jwks-cache.ts`, not the other way.

- [ ] **Step 3: Type-check**

```bash
bunx --bun tsc --noEmit -p shared/osn-auth-client/tsconfig.json
```

Expected: clean.

### Task T3.3: Lift `verify.ts` from pulse

**Files:** copies `pulse/api/src/lib/auth.ts` → `shared/osn-auth-client/src/verify.ts`.

- [ ] **Step 1: Copy**

```bash
cp pulse/api/src/lib/auth.ts shared/osn-auth-client/src/verify.ts
```

- [ ] **Step 2: Edit imports**

Change

```ts
import { resolvePublicKeyForKid, refreshPublicKeyForKid } from "./jwks-cache";
```

to

```ts
import { resolvePublicKeyForKid, refreshPublicKeyForKid } from "./jwks-cache";
```

(Same — file is now in the same directory of the shared package.) Confirm.

- [ ] **Step 3: Remove the `DEFAULT_JWKS_URL` env-coupled export**

The shared package must not read `process.env` at module load — that ties consumers to a specific env name. Delete this export from `verify.ts`:

```ts
// REMOVE
export const DEFAULT_JWKS_URL =
  process.env.OSN_JWKS_URL ?? "http://localhost:4000/.well-known/jwks.json";
```

Pulse's `src/index.ts` already reads `OSN_JWKS_URL` directly; cire will do the same. No shared default.

- [ ] **Step 4: Type-check**

```bash
bunx --bun tsc --noEmit -p shared/osn-auth-client/tsconfig.json
```

Expected: clean.

### Task T3.4: Move pulse's existing tests for verify into the shared package

**Files:** moves `pulse/api/src/lib/__tests__/auth.test.ts` (if it exists) → `shared/osn-auth-client/tests/verify.test.ts`.

- [ ] **Step 1: Locate existing tests**

```bash
find pulse/api -name '*.test.ts' -path '*lib*' -exec grep -l 'extractClaims\|jwks' {} \;
```

- [ ] **Step 2: Move and update imports**

```bash
git mv pulse/api/<found-test-path> shared/osn-auth-client/tests/verify.test.ts
```

Edit the moved test: change relative imports

```ts
import { extractClaims } from "../auth";
```

to

```ts
import { extractClaims } from "../src/verify";
```

(Or `../src/verify` if the import root is `tests/` relative to package root.)

- [ ] **Step 3: Add a vitest config if needed**

```bash
cat shared/osn-auth-client/vitest.config.ts 2>/dev/null || cat > shared/osn-auth-client/vitest.config.ts <<'EOF'
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
EOF
```

- [ ] **Step 4: Run tests**

```bash
bun run --cwd shared/osn-auth-client test:run
```

Expected: pre-existing assertions pass; imports resolve.

### Task T3.5: Write a Hono-adapter test (TDD, fails initially)

**Files:** creates `shared/osn-auth-client/tests/middleware-hono.test.ts`.

- [ ] **Step 1: Write the test**

```ts
// shared/osn-auth-client/tests/middleware-hono.test.ts
import { describe, expect, it, beforeAll } from "vitest";
import { Hono } from "hono";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { osnAuth } from "../src/middleware/hono";

describe("osnAuth (Hono adapter)", () => {
  let signKey: CryptoKey;
  let verifyKey: CryptoKey;
  let jwksHandler: (req: Request) => Promise<Response>;
  let kid: string;

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    signKey = pair.privateKey;
    verifyKey = pair.publicKey;
    const jwk = await exportJWK(verifyKey);
    kid = "test-kid-1";
    const keys = [{ ...jwk, kid, alg: "ES256", use: "sig" }];
    jwksHandler = async () =>
      new Response(JSON.stringify({ keys }), {
        headers: { "Content-Type": "application/json" },
      });

    // Stub global fetch for the duration of the test
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
    ) => {
      if (String(input).endsWith("/.well-known/jwks.json")) {
        return jwksHandler(new Request(String(input)));
      }
      throw new Error(`unexpected fetch: ${input}`);
    }) as typeof fetch;
  });

  it("401 when no Bearer header", async () => {
    const app = new Hono();
    app.use(
      "/protected/*",
      osnAuth({ jwksUrl: "http://test/.well-known/jwks.json", audience: "osn-access" }),
    );
    app.get("/protected/me", (c) => c.json({ profileId: c.var.osnProfileId }));
    const res = await app.request("/protected/me");
    expect(res.status).toBe(401);
  });

  it("sets osnProfileId on valid token", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("usr_test123")
      .setAudience("osn-access")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);

    const app = new Hono<{ Variables: { osnProfileId: string } }>();
    app.use(
      "/protected/*",
      osnAuth({ jwksUrl: "http://test/.well-known/jwks.json", audience: "osn-access" }),
    );
    app.get("/protected/me", (c) =>
      c.json({ profileId: c.var.osnProfileId }),
    );

    const res = await app.request("/protected/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profileId: string };
    expect(body.profileId).toBe("usr_test123");
  });

  it("401 on wrong audience", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("usr_test123")
      .setAudience("wrong-aud")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);

    const app = new Hono();
    app.use(
      "/protected/*",
      osnAuth({ jwksUrl: "http://test/.well-known/jwks.json", audience: "osn-access" }),
    );
    app.get("/protected/me", (c) => c.text("ok"));

    const res = await app.request("/protected/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
bun run --cwd shared/osn-auth-client test:run -- middleware-hono
```

Expected: module-not-found on `../src/middleware/hono`.

### Task T3.6: Implement the Hono adapter

**Files:** creates `shared/osn-auth-client/src/middleware/hono.ts`.

- [ ] **Step 1: Write the implementation**

```ts
// shared/osn-auth-client/src/middleware/hono.ts
import type { MiddlewareHandler } from "hono";
import { extractClaims } from "../verify";

export interface OsnAuthOptions {
  /** Full JWKS URL — e.g. `https://osn-api.example.com/.well-known/jwks.json` */
  jwksUrl: string;
  /** Expected `aud` claim — typically `"osn-access"` */
  audience: string;
  /** Optional injected verifying key for tests (skips JWKS fetch). */
  _testKey?: CryptoKey;
}

/**
 * Hono middleware that verifies an OSN-issued access token from the
 * Authorization: Bearer header. On success sets `c.var.osnProfileId` to
 * the `sub` claim. On any failure returns 401.
 *
 * Audience checking happens here (extractClaims doesn't enforce aud);
 * the audience parameter is mandatory.
 */
export function osnAuth(options: OsnAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    const claims = await extractClaims(
      c.req.header("authorization"),
      options.jwksUrl,
      options._testKey,
    );
    if (!claims) return c.json({ error: "unauthorised" }, 401);

    // Audience check (extractClaims doesn't verify aud — jwtVerify does
    // signature + exp + alg, audience is the caller's responsibility).
    // Re-decode to read the aud claim safely.
    const token = c.req.header("authorization")?.slice("Bearer ".length);
    if (!token) return c.json({ error: "unauthorised" }, 401);
    try {
      const { decodeJwt } = await import("jose");
      const payload = decodeJwt(token);
      const aud = payload.aud;
      const matches = typeof aud === "string" ? aud === options.audience : aud?.includes(options.audience);
      if (!matches) return c.json({ error: "unauthorised" }, 401);
    } catch {
      return c.json({ error: "unauthorised" }, 401);
    }

    c.set("osnProfileId", claims.profileId);
    await next();
  };
}
```

(Note the audience check addition. `extractClaims` already gated on `alg === "ES256"` and signature; audience is enforced at the middleware layer so the same `extractClaims` is reusable for tools that don't care about aud.)

- [ ] **Step 2: Re-export from `src/index.ts`**

```ts
// shared/osn-auth-client/src/index.ts
export * from "./verify";
export * from "./jwks-cache";
// Adapters are not re-exported from root to keep the import surface
// explicit: consumers pick the framework they use.
```

- [ ] **Step 3: Run the Hono adapter tests — expect PASS**

```bash
bun run --cwd shared/osn-auth-client test:run -- middleware-hono
```

Expected: green.

### Task T3.7: Write an Elysia-adapter test

**Files:** creates `shared/osn-auth-client/tests/middleware-elysia.test.ts`.

If pulse already has equivalent middleware tests, repath them here. Otherwise:

- [ ] **Step 1: Write a minimal Elysia smoke test**

```ts
// shared/osn-auth-client/tests/middleware-elysia.test.ts
import { describe, expect, it, beforeAll } from "vitest";
import { Elysia } from "elysia";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { osnAuth } from "../src/middleware/elysia";

describe("osnAuth (Elysia adapter)", () => {
  let signKey: CryptoKey;
  let kid: string;

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    signKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    kid = "test-kid-1";
    const keys = [{ ...jwk, kid, alg: "ES256", use: "sig" }];
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
    ) => {
      if (String(input).endsWith("/.well-known/jwks.json")) {
        return new Response(JSON.stringify({ keys }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${input}`);
    }) as typeof fetch;
  });

  it("401 on missing token", async () => {
    const app = new Elysia()
      .use(osnAuth({ jwksUrl: "http://test/.well-known/jwks.json", audience: "osn-access" }))
      .get("/me", ({ store }) => ({ profileId: (store as { osnProfileId?: string }).osnProfileId }));

    const res = await app.handle(new Request("http://localhost/me"));
    expect(res.status).toBe(401);
  });

  it("sets store.osnProfileId on valid token", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("usr_elysia")
      .setAudience("osn-access")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);

    const app = new Elysia()
      .use(osnAuth({ jwksUrl: "http://test/.well-known/jwks.json", audience: "osn-access" }))
      .get("/me", ({ store }) => ({ profileId: (store as { osnProfileId?: string }).osnProfileId }));

    const res = await app.handle(
      new Request("http://localhost/me", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profileId: string };
    expect(body.profileId).toBe("usr_elysia");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun run --cwd shared/osn-auth-client test:run -- middleware-elysia
```

Expected: module-not-found on `../src/middleware/elysia`.

### Task T3.8: Implement the Elysia adapter

**Files:** creates `shared/osn-auth-client/src/middleware/elysia.ts`.

- [ ] **Step 1: Inspect pulse's current Elysia wiring**

```bash
sed -n '1,60p' pulse/api/src/routes/events.ts
```

Look for how pulse currently calls `extractClaims` from an Elysia route — that pattern informs the plugin shape. Typically:

```ts
const app = new Elysia()
  .derive(async ({ headers }) => {
    const claims = await extractClaims(headers.authorization, JWKS_URL);
    return { claims };
  });
```

- [ ] **Step 2: Write the plugin**

```ts
// shared/osn-auth-client/src/middleware/elysia.ts
import { Elysia } from "elysia";
import { decodeJwt } from "jose";
import { extractClaims } from "../verify";

export interface OsnAuthOptions {
  jwksUrl: string;
  audience: string;
  _testKey?: CryptoKey;
}

/**
 * Elysia plugin that derives `osnProfileId` (string) when the request
 * carries a valid OSN access token. Routes that need authentication
 * should check `osnProfileId` and return 401 themselves, or use the
 * shorthand `.guard({ beforeHandle: requireOsnProfile })` pattern.
 */
export function osnAuth(options: OsnAuthOptions) {
  return new Elysia({ name: "osn-auth-client" })
    .derive(async ({ headers, set }) => {
      const claims = await extractClaims(
        headers.authorization,
        options.jwksUrl,
        options._testKey,
      );
      if (!claims) {
        return { osnProfileId: undefined };
      }
      const token = headers.authorization?.slice("Bearer ".length);
      if (!token) return { osnProfileId: undefined };
      try {
        const payload = decodeJwt(token);
        const aud = payload.aud;
        const matches =
          typeof aud === "string" ? aud === options.audience : aud?.includes(options.audience);
        if (!matches) return { osnProfileId: undefined };
      } catch {
        return { osnProfileId: undefined };
      }
      return { osnProfileId: claims.profileId };
    })
    .onBeforeHandle(({ osnProfileId, set }) => {
      if (!osnProfileId) {
        set.status = 401;
        return { error: "unauthorised" };
      }
    });
}
```

(If pulse uses a different idiom — e.g. setting `store.osnProfileId` instead of `derive`-injected — replicate that pattern. The test above probes `store.osnProfileId`; update the test or the plugin to match.)

- [ ] **Step 3: Run Elysia adapter test — expect PASS**

```bash
bun run --cwd shared/osn-auth-client test:run -- middleware-elysia
```

Expected: green.

### Task T3.9: Update pulse/api to import from the shared package

**Files:** modifies `pulse/api/src/index.ts` and any other callers of `pulse/api/src/lib/auth` or `pulse/api/src/lib/jwks-cache`.

- [ ] **Step 1: Grep for callers**

```bash
grep -rn "from .*lib/auth\b\|from .*lib/jwks-cache\b" pulse/api/src --include='*.ts' -l
```

- [ ] **Step 2: For each, update the import**

Change

```ts
import { extractClaims, DEFAULT_JWKS_URL } from "./lib/auth";
```

to

```ts
import { extractClaims } from "@shared/osn-auth-client/verify";
```

And, where `DEFAULT_JWKS_URL` was imported, replace with the env read directly (already pattern in `pulse/api/src/index.ts`):

```ts
const jwksUrl = process.env.OSN_JWKS_URL ?? "http://localhost:4000/.well-known/jwks.json";
```

- [ ] **Step 3: If pulse uses an Elysia middleware/plugin for OSN auth elsewhere, switch that too**

```bash
grep -rn "extractClaims" pulse/api/src --include='*.ts'
```

Each occurrence: replace with `import { osnAuth } from "@shared/osn-auth-client/middleware/elysia"` where the call shape is `app.use(osnAuth({...}))`. For raw extract-and-use call sites (route handlers), keep `extractClaims` from the shared verify module.

- [ ] **Step 4: Add the dependency to pulse/api**

```bash
bun add @shared/osn-auth-client --cwd pulse/api
```

- [ ] **Step 5: Delete pulse's local files**

```bash
git rm pulse/api/src/lib/auth.ts pulse/api/src/lib/jwks-cache.ts
```

- [ ] **Step 6: Run pulse tests**

```bash
bun run --cwd pulse/api test
```

Expected: all green.

### Task T3.10: Write a changeset + commit Phase 3

**Files:** creates `.changeset/shared-osn-auth-client.md`.

- [ ] **Step 1: Write changeset**

```bash
cat > .changeset/shared-osn-auth-client.md <<'EOF'
---
"@shared/osn-auth-client": minor
"@pulse/api": patch
---

Extract OSN access-token verification + JWKS cache into a new shared
package, `@shared/osn-auth-client`, with per-framework middleware
adapters (Hono + Elysia). Pulse switches to consuming the shared
verifier; cire will follow in a later phase.
EOF
```

- [ ] **Step 2: Run full pipeline**

```bash
bun run check
bun run test
```

Expected: green everywhere.

- [ ] **Step 3: Commit**

```bash
git add shared/osn-auth-client .changeset/shared-osn-auth-client.md pulse/api
git commit -m "$(cat <<'EOF'
refactor(shared): extract OSN JWT verifier into @shared/osn-auth-client

Lifts pulse/api/src/lib/{auth,jwks-cache}.ts into a new shared package
with Hono and Elysia adapters. Pulse swaps to consuming the shared
verifier; cire will gain its first Hono consumer in Phase 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Cire schema multi-tenancy

Sequential. Single commit at the end plus a changeset.

### Task T4.1: Update Drizzle schema

**Files:** modifies `cire/db/src/schema.ts`.

- [ ] **Step 1: Open the file**

```bash
sed -n '1,30p' cire/db/src/schema.ts
```

- [ ] **Step 2: Insert the `weddings` table near the top, before `families`**

```ts
export const weddings = sqliteTable(
  "weddings",
  {
    id: text("id").primaryKey(),                                // wed_<ulid>
    slug: text("slug").notNull().unique(),                      // "patel-joy"
    displayName: text("display_name").notNull(),                // "Aarti & Joy"
    ownerOsnProfileId: text("owner_osn_profile_id").notNull(),  // usr_*
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("weddings_owner_idx").on(t.ownerOsnProfileId)],
);
```

- [ ] **Step 3: Add `weddingId` to `families`**

In the `families` table definition, add the column and an index:

```ts
export const families = sqliteTable(
  "families",
  {
    id: text("id").primaryKey(),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull().unique(),
    familyName: text("family_name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("families_family_name_idx").on(t.familyName),
    index("families_wedding_idx").on(t.weddingId),
  ],
);
```

- [ ] **Step 4: Add `weddingId` to `events`**

```ts
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(),
    // ... rest unchanged
  },
  (t) => [
    index("events_sort_order_idx").on(t.sortOrder),
    index("events_wedding_idx").on(t.weddingId),
  ],
);
```

- [ ] **Step 5: Add `weddingId` to `imports`**

Find the `imports` table definition; add the same column and index pattern.

- [ ] **Step 6: Type-check**

```bash
bun run --cwd cire/db check
```

Expected: clean.

### Task T4.2: Generate migration

**Files:** creates `cire/db/migrations/0006_multi_tenant.sql` (Drizzle-generated).

- [ ] **Step 1: Run generator**

```bash
bun run --cwd cire/db db:generate
```

Expected: `cire/db/migrations/0006_multi_tenant.sql` and updated journal.

- [ ] **Step 2: Inspect**

```bash
cat cire/db/migrations/0006_multi_tenant.sql
```

You'll see CREATE TABLE for weddings and ALTERs for the FKs. SQLite ALTER limitations mean Drizzle generates table-recreation idiom (`__new_families` rename pattern). That's expected.

### Task T4.3: Hand-edit the migration to add bootstrap insert

**Files:** modifies `cire/db/migrations/0006_multi_tenant.sql`.

- [ ] **Step 1: Find the line after `CREATE TABLE weddings`**

It should be immediately after the index creation for `weddings_owner_idx`.

- [ ] **Step 2: Insert the bootstrap row before any `families`/`events`/`imports` table recreation**

```sql
-- Bootstrap row for the existing bespoke wedding. Substitute the real
-- OSN profile ID captured in Phase 0 (Task T0.3) before running.
INSERT INTO weddings (id, slug, display_name, owner_osn_profile_id, created_at, updated_at)
VALUES (
  'wed_bootstrap',
  '__SUBSTITUTE_WEDDING_SLUG__',
  '__SUBSTITUTE_WEDDING_NAME__',
  '__SUBSTITUTE_OSN_PROFILE_ID__',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER)
);
```

- [ ] **Step 3: After each table recreation that adds `wedding_id NOT NULL`, ensure backfill**

Drizzle's generated SQL for adding a NOT NULL column on SQLite uses the rename idiom: it creates `__new_families` with the new column, copies data with a default, drops the old table, renames. The default for `wedding_id` will need to be supplied — modify the copy step:

```sql
-- Within Drizzle's __new_families recreation block, when copying:
INSERT INTO `__new_families` (`id`, `wedding_id`, `public_id`, `family_name`, `created_at`, `updated_at`)
SELECT `id`, 'wed_bootstrap' AS `wedding_id`, `public_id`, `family_name`, `created_at`, `updated_at`
FROM `families`;
```

Apply the same edit to the events and imports recreation blocks.

- [ ] **Step 4: Substitute placeholders**

Open the migration and replace:
- `__SUBSTITUTE_WEDDING_SLUG__` → e.g. `patel-joy`
- `__SUBSTITUTE_WEDDING_NAME__` → e.g. `Aarti & Joy`
- `__SUBSTITUTE_OSN_PROFILE_ID__` → the `usr_*` from Phase 0 step 4

### Task T4.4: Write a schema/migration test

**Files:** creates `cire/db/src/__tests__/schema-multi-tenant.test.ts`.

- [ ] **Step 1: Write**

```ts
// cire/db/src/__tests__/schema-multi-tenant.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { resolve } from "node:path";
import * as schema from "../schema";
import { weddings, families } from "../schema";

function freshDb(): BunSQLiteDatabase<typeof schema> {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(__dirname, "../../migrations") });
  return db;
}

describe("multi-tenant schema", () => {
  let db: BunSQLiteDatabase<typeof schema>;

  beforeEach(() => {
    db = freshDb();
  });

  it("bootstrap row exists after migration", () => {
    const rows = db.select().from(weddings).all();
    const bootstrap = rows.find((w) => w.id === "wed_bootstrap");
    expect(bootstrap).toBeDefined();
    expect(bootstrap?.ownerOsnProfileId).toMatch(/^usr_/);
  });

  it("families cannot exist without a wedding", () => {
    expect(() => {
      db.insert(families)
        .values({
          id: "fam_orphan",
          weddingId: "wed_does_not_exist",
          publicId: "ORPHAN-1",
          familyName: "Orphan",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("cascades delete weddings → families", () => {
    db.insert(weddings).values({
      id: "wed_test",
      slug: "test-wedding",
      displayName: "Test Wedding",
      ownerOsnProfileId: "usr_test",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();
    db.insert(families).values({
      id: "fam_test_1",
      weddingId: "wed_test",
      publicId: "TEST-1",
      familyName: "Test Family",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();

    db.delete(weddings).where(eq(weddings.id, "wed_test")).run();

    const survivors = db.select().from(families).where(eq(families.weddingId, "wed_test")).all();
    expect(survivors).toHaveLength(0);
  });
});
```

Note: the test assumes the existing cire/db test idiom uses `bun:test` + `bun:sqlite` + `drizzle-orm/bun-sqlite`. If cire/db tests run under a different harness (e.g. Vitest + better-sqlite3), mirror that idiom instead — only the imports change; the test shape stays the same.

- [ ] **Step 2: Run — expect PASS**

```bash
bun run --cwd cire/db test
```

Expected: green.

### Task T4.5: Push schema to local D1

**Files:** none code; D1 state mutation.

- [ ] **Step 1: Push**

```bash
bun run --cwd cire/db db:push
```

Expected: migration applied, no errors. (If `db:push` is wired to remote D1 by default, use `wrangler d1 migrations apply cire-db --local` instead.)

- [ ] **Step 2: Smoke check**

```bash
bunx --bun wrangler d1 execute cire-db --local --command "SELECT * FROM weddings"
```

Expected: one row, `wed_bootstrap`.

### Task T4.6: Smoke-test existing guest flow against migrated DB

**Files:** none.

- [ ] **Step 1: Run cire/api tests (which use in-memory SQLite with the migrations applied)**

```bash
bun run --cwd cire/api test
```

Expected: claim, RSVP, rate-limit tests all pass — the new `wedding_id` column is backfilled, existing logic is unaffected.

- [ ] **Step 2: If any test fails because the test setup seeds rows without `weddingId`**, update the test seed helpers (likely `cire/api/src/db/setup.ts`) to insert a wedding row before inserting families.

### Task T4.7: Commit Phase 4

**Files:** stages all schema + migration + test changes; writes a changeset.

- [ ] **Step 1: Write changeset**

```bash
cat > .changeset/cire-multi-tenant-schema.md <<'EOF'
---
"@cire/db": minor
"@cire/api": patch
---

Scaffold multi-tenancy: new `weddings` table, FKs from `families`,
`events`, `imports`. Bootstrap row inserted for the existing bespoke
wedding. Single-owner today; join-table for multi-owner deferred.
EOF
```

- [ ] **Step 2: Commit**

```bash
git add cire/db .changeset/cire-multi-tenant-schema.md
git commit -m "$(cat <<'EOF'
feat(cire/db): add weddings table + multi-tenant FKs

Adds a `weddings` table keyed by `wed_*`, with `owner_osn_profile_id`
referencing the OSN profile (string, no cross-DB FK). `families`,
`events`, `imports` each gain a `wedding_id` FK with cascade on delete.
Bootstrap row seeded by the migration; backfill applied to existing
rows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(Remote push is deferred to Phase 6 verification — running `db:push:remote` happens after the auth bridge proves out locally.)

---

## Phase 5 — Organiser auth swap (parallelizable, joins at E2E)

Phase 5a (cire/api) and Phase 5b (cire/organiser) run in parallel subagents. Phase 5c joins them at a manual E2E test.

### Task T5a.1: Write tests for `osn-auth.ts` (TDD)

**Files:** creates `cire/api/src/middleware/__tests__/osn-auth.test.ts`.

- [ ] **Step 1: Write**

```ts
// cire/api/src/middleware/__tests__/osn-auth.test.ts
import { describe, expect, it, beforeAll } from "bun:test";
import { Hono } from "hono";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import { osnAuth } from "../osn-auth";

describe("cire osnAuth wrapper", () => {
  let signKey: CryptoKey;
  let verifyKey: CryptoKey;
  let kid: string;

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    signKey = pair.privateKey;
    verifyKey = pair.publicKey;
    kid = "test-kid-cire-1";
    const jwk = await exportJWK(verifyKey);
    const keys = [{ ...jwk, kid, alg: "ES256", use: "sig" }];
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
    ) => {
      if (String(input).endsWith("/.well-known/jwks.json")) {
        return new Response(JSON.stringify({ keys }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${input}`);
    }) as typeof fetch;
  });

  it("rejects missing Bearer with 401", async () => {
    const app = new Hono();
    app.use("/organiser/*", osnAuth({
      jwksUrl: "http://test/.well-known/jwks.json",
      audience: "osn-access",
    }));
    app.get("/organiser/me", (c) => c.json({ profileId: c.var.osnProfileId }));
    const res = await app.request("/organiser/me");
    expect(res.status).toBe(401);
  });

  it("sets c.var.osnProfileId on valid token", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("usr_organiser_alice")
      .setAudience("osn-access")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signKey);

    const app = new Hono<{ Variables: { osnProfileId: string } }>();
    app.use("/organiser/*", osnAuth({
      jwksUrl: "http://test/.well-known/jwks.json",
      audience: "osn-access",
    }));
    app.get("/organiser/me", (c) => c.json({ profileId: c.var.osnProfileId }));
    const res = await app.request("/organiser/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { profileId: string }).profileId).toBe("usr_organiser_alice");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found)

```bash
bun test cire/api/src/middleware/__tests__/osn-auth.test.ts
```

### Task T5a.2: Implement `cire/api/src/middleware/osn-auth.ts`

**Files:** creates the file.

- [ ] **Step 1: Write**

```ts
// cire/api/src/middleware/osn-auth.ts
import { osnAuth as honoOsnAuth } from "@shared/osn-auth-client/middleware/hono";

export type { OsnAuthOptions } from "@shared/osn-auth-client/middleware/hono";

/** Re-export so cire/api routes import from a stable path. */
export const osnAuth = honoOsnAuth;
```

(The thin wrapper exists so future cire-specific defaults can be applied without changing every import site.)

- [ ] **Step 2: Install the dep**

```bash
bun add @shared/osn-auth-client --cwd cire/api
```

- [ ] **Step 3: Run tests — expect PASS**

```bash
bun test cire/api/src/middleware/__tests__/osn-auth.test.ts
```

### Task T5a.3: Write tests for `wedding-owner.ts`

**Files:** creates `cire/api/src/middleware/__tests__/wedding-owner.test.ts`.

- [ ] **Step 1: Write**

```ts
// cire/api/src/middleware/__tests__/wedding-owner.test.ts
import { describe, expect, it, beforeEach } from "bun:test";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { weddings } from "@cire/db";
import { weddingOwner } from "../wedding-owner";

describe("weddingOwner middleware", () => {
  let db: ReturnType<typeof drizzle>;

  beforeEach(async () => {
    db = drizzle(new Database(":memory:"));
    // Apply migrations and seed: wedding wed_a owned by usr_alice
    // … (use the project's migrator helper)
    await db.insert(weddings).values({
      id: "wed_a",
      slug: "alpha",
      displayName: "Alpha Wedding",
      ownerOsnProfileId: "usr_alice",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it("403 when caller does not own the wedding", async () => {
    const app = new Hono<{ Variables: { db: typeof db; osnProfileId: string } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      c.set("osnProfileId", "usr_bob");
      await next();
    });
    app.use("/weddings/:weddingId/*", weddingOwner());
    app.get("/weddings/:weddingId/x", (c) => c.text("ok"));
    const res = await app.request("/weddings/wed_a/x");
    expect(res.status).toBe(403);
  });

  it("200 when caller owns the wedding", async () => {
    const app = new Hono<{ Variables: { db: typeof db; osnProfileId: string } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      c.set("osnProfileId", "usr_alice");
      await next();
    });
    app.use("/weddings/:weddingId/*", weddingOwner());
    app.get("/weddings/:weddingId/x", (c) => c.text("ok"));
    const res = await app.request("/weddings/wed_a/x");
    expect(res.status).toBe(200);
  });

  it("404 when the wedding does not exist", async () => {
    const app = new Hono<{ Variables: { db: typeof db; osnProfileId: string } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      c.set("osnProfileId", "usr_alice");
      await next();
    });
    app.use("/weddings/:weddingId/*", weddingOwner());
    app.get("/weddings/:weddingId/x", (c) => c.text("ok"));
    const res = await app.request("/weddings/wed_missing/x");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test cire/api/src/middleware/__tests__/wedding-owner.test.ts
```

### Task T5a.4: Implement `cire/api/src/middleware/wedding-owner.ts`

**Files:** creates the file.

- [ ] **Step 1: Write**

```ts
// cire/api/src/middleware/wedding-owner.ts
import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { weddings } from "@cire/db";

export function weddingOwner(): MiddlewareHandler<{
  Variables: {
    db: import("@cire/db").Db;
    osnProfileId: string;
    weddingId: string;
  };
}> {
  return async (c, next) => {
    const weddingId = c.req.param("weddingId");
    if (!weddingId) return c.json({ error: "wedding_id missing" }, 400);

    const osnProfileId = c.var.osnProfileId;
    const db = c.var.db;

    const row = await db
      .select({ ownerOsnProfileId: weddings.ownerOsnProfileId })
      .from(weddings)
      .where(eq(weddings.id, weddingId))
      .get();

    if (!row) return c.json({ error: "wedding_not_found" }, 404);
    if (row.ownerOsnProfileId !== osnProfileId) {
      return c.json({ error: "forbidden" }, 403);
    }

    c.set("weddingId", weddingId);
    await next();
  };
}
```

(The `Db` type comes from cire/db's existing export. Confirm the import name; adjust if needed.)

- [ ] **Step 2: Run tests — expect PASS**

```bash
bun test cire/api/src/middleware/__tests__/wedding-owner.test.ts
```

### Task T5a.5: Add new `/api/organiser/weddings*` routes

**Files:** creates `cire/api/src/routes/organiser-weddings.ts` and updates `cire/api/src/app.ts`.

- [ ] **Step 1: Write the routes**

```ts
// cire/api/src/routes/organiser-weddings.ts
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { weddings, families, events as eventsTable, imports } from "@cire/db";
import { weddingOwner } from "../middleware/wedding-owner";

type V = {
  db: import("@cire/db").Db;
  osnProfileId: string;
  weddingId: string;
};

export const organiserWeddingsRoutes = new Hono<{ Variables: V }>();

// GET /api/organiser/weddings — list weddings owned by caller
organiserWeddingsRoutes.get("/weddings", async (c) => {
  const owner = c.var.osnProfileId;
  const rows = await c.var.db
    .select()
    .from(weddings)
    .where(eq(weddings.ownerOsnProfileId, owner));
  return c.json({ weddings: rows });
});

// All routes below require the wedding to exist and be owned by caller.
organiserWeddingsRoutes.use("/weddings/:weddingId/*", weddingOwner());

// GET /api/organiser/weddings/:weddingId/guests
organiserWeddingsRoutes.get("/weddings/:weddingId/guests", async (c) => {
  const rows = await c.var.db
    .select()
    .from(families)
    .where(eq(families.weddingId, c.var.weddingId));
  return c.json({ families: rows });
});

// GET /api/organiser/weddings/:weddingId/events
organiserWeddingsRoutes.get("/weddings/:weddingId/events", async (c) => {
  const rows = await c.var.db
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.weddingId, c.var.weddingId));
  return c.json({ events: rows });
});

// (Import sub-routes mounted from another file — wire similarly.)
```

- [ ] **Step 2: Wire into app**

Open `cire/api/src/app.ts`. After existing route registrations:

```ts
import { osnAuth } from "./middleware/osn-auth";
import { organiserWeddingsRoutes } from "./routes/organiser-weddings";

app.use("/api/organiser/*", osnAuth({
  jwksUrl: c.env.OSN_JWKS_URL ?? process.env.OSN_JWKS_URL ?? "http://localhost:4000/.well-known/jwks.json",
  audience: c.env.OSN_AUDIENCE ?? "osn-access",
}));
app.route("/api/organiser", organiserWeddingsRoutes);
```

(Adjust the env access pattern to match cire's existing approach — likely `options.osnJwksUrl` threaded through the `createApp` factory rather than read inline.)

- [ ] **Step 3: Update the factory `createApp(...)` signature**

In `cire/api/src/app.ts`:

```ts
export function createApp(db: Db, options: AppOptions) {
  const app = new Hono<{ Variables: AppVariables }>();
  // ... existing setup
  app.use("/api/organiser/*", osnAuth({
    jwksUrl: options.osnJwksUrl,
    audience: options.osnAudience ?? "osn-access",
  }));
  // ...
}

export interface AppOptions {
  // existing
  webOrigin: string;
  r2?: R2Bucket;
  organiserToken?: string;     // still here through Phase 5; deleted Phase 6
  // new
  osnJwksUrl: string;
  osnAudience?: string;
}
```

- [ ] **Step 4: Update `cire/api/src/local.ts`**

```ts
const app = createApp(db, {
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:4321",
  organiserToken: process.env.ORGANISER_TOKEN,  // still wired in Phase 5
  osnJwksUrl: process.env.OSN_JWKS_URL ?? "http://localhost:4000/.well-known/jwks.json",
  osnAudience: process.env.OSN_AUDIENCE ?? "osn-access",
});
```

- [ ] **Step 5: Update `cire/api/wrangler.toml`**

Add to `[vars]`:

```toml
[vars]
WEB_ORIGIN = "http://localhost:4321"
OSN_JWKS_URL = "http://localhost:4000/.well-known/jwks.json"
OSN_ISSUER_URL = "http://localhost:4000"
OSN_AUDIENCE = "osn-access"

[env.production.vars]
WEB_ORIGIN = "https://cire.pages.dev"
OSN_JWKS_URL = "https://osn-api.example.com/.well-known/jwks.json"
OSN_ISSUER_URL = "https://osn-api.example.com"
OSN_AUDIENCE = "osn-access"
```

### Task T5a.6: Switch aliased flat organiser routes to `osnAuth`

**Files:** modifies `cire/api/src/routes/organiser.ts` and `cire/api/src/routes/organiser-import.ts`.

- [ ] **Step 1: Open `cire/api/src/routes/organiser.ts`**

Replace any `X-Organiser-Token` gating with the assumption that `osnAuth()` is already applied via `app.use("/api/organiser/*", osnAuth(...))`. Remove `X-Organiser-Token` reads.

Each handler now has access to `c.var.osnProfileId`. To preserve URL compatibility, derive the wedding from the caller:

```ts
organiserRoutes.get("/guests", async (c) => {
  // Find the wedding owned by this caller. In bespoke mode, exactly one.
  const owned = await c.var.db
    .select()
    .from(weddings)
    .where(eq(weddings.ownerOsnProfileId, c.var.osnProfileId));
  if (owned.length === 0) return c.json({ error: "no_weddings" }, 404);
  if (owned.length > 1) {
    return c.json({
      error: "multiple_weddings",
      hint: "use /api/organiser/weddings/:weddingId/guests",
    }, 400);
  }
  const wedding = owned[0];
  // Same query as before, scoped to wedding.id
  const families = await c.var.db.select().from(families).where(eq(families.weddingId, wedding.id));
  return c.json({ guests: families });
});
```

(In Phase 6, delete the aliased routes; clients move to the explicit `/weddings/:weddingId/*` shape.)

- [ ] **Step 2: Open `cire/api/src/routes/organiser-import.ts`**

Remove the `X-Organiser-Token` constant-time check (lines ~38–45). Replace with the new auth — the `osnAuth` middleware up the chain already covers this route group. The wedding context can be inferred (single-owner) or required as a query param `?weddingId=` for safety:

```ts
import { eq } from "drizzle-orm";
import { weddings } from "@cire/db";

organiserImportRoutes.post("/preview", async (c) => {
  // osnAuth already validated; pull wedding context
  const weddingId = c.req.query("weddingId");
  if (!weddingId) return c.json({ error: "weddingId_required" }, 400);

  const w = await c.var.db
    .select({ owner: weddings.ownerOsnProfileId })
    .from(weddings)
    .where(eq(weddings.id, weddingId))
    .get();
  if (!w) return c.json({ error: "wedding_not_found" }, 404);
  if (w.owner !== c.var.osnProfileId) return c.json({ error: "forbidden" }, 403);

  // Existing preview logic, with imports.weddingId = weddingId on insert
  // ...
});
```

- [ ] **Step 3: Run cire/api tests**

```bash
bun run --cwd cire/api test
```

Expected: green. Update existing tests if they injected `X-Organiser-Token` directly — they now need to mint a fake JWT instead. Use the same `_testKey` injection pattern as in T3.5.

### Task T5a.7: Commit Phase 5a

**Files:** stages cire/api changes.

- [ ] **Step 1: Stage and commit**

```bash
git add cire/api
git commit -m "$(cat <<'EOF'
feat(cire/api): osnAuth middleware + wedding-owner authz

Adds @shared/osn-auth-client-backed osnAuth() wrapper for the
organiser route group, plus a per-route weddingOwner() authz middleware
that gates on `weddings.owner_osn_profile_id == c.var.osnProfileId`.
New /api/organiser/weddings/:weddingId/* routes mounted; flat aliased
routes (e.g. /api/organiser/guests) keep working by deriving the
caller's single owned wedding. ORGANISER_TOKEN remains wired through
Phase 5 to keep options stable; deleted in Phase 6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task T5b.1: Audit cire/organiser's current auth

**Files:** read-only.

- [ ] **Step 1: Find token-related code**

```bash
grep -rn 'cire:organiser-token\|X-Organiser-Token\|sessionStorage' cire/organiser/src
```

Expected: hits in `ImportPanel.tsx`, possibly `lib/api.ts`, login page.

### Task T5b.2: Install `@osn/client` and `@osn/ui`

**Files:** modifies `cire/organiser/package.json`.

- [ ] **Step 1: Add the deps**

```bash
bun add @osn/client @osn/ui --cwd cire/organiser
```

Expected: workspace deps added (`workspace:*`).

### Task T5b.3: Write `cire/organiser/src/auth/OsnProvider.tsx`

**Files:** creates the file.

- [ ] **Step 1: Inspect osn/social or another consumer for the canonical provider pattern**

```bash
grep -rn 'createOsnAuthLive\|OsnAuthProvider' osn/social/src osn/landing/src 2>/dev/null | head -20
```

Mirror what the example consumer does. Likely shape:

```tsx
// cire/organiser/src/auth/OsnProvider.tsx
import type { ParentComponent } from "solid-js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { createOsnAuthLive, OsnAuth } from "@osn/client";

const osnAuthLayer = createOsnAuthLive({
  apiBaseUrl: import.meta.env.PUBLIC_OSN_API_URL ?? "http://localhost:4000",
  // Storage uses localStorage by default; provide custom Storage if needed.
});

const runtime = ManagedRuntime.make(osnAuthLayer);

export const OsnProvider: ParentComponent = (props) => {
  return <>{props.children}</>;
};

export const osnRuntime = runtime;
```

- [ ] **Step 2: Confirm shape against the actual `@osn/client` exports**

```bash
cat osn/client/src/index.ts
```

If the API differs, adjust. The goal: a SolidJS-compatible runtime wrapper exposing `OsnAuth` operations.

### Task T5b.4: Create the sign-in page

**Files:** creates `cire/organiser/src/pages/sign-in.astro`.

- [ ] **Step 1: Write**

```astro
---
// cire/organiser/src/pages/sign-in.astro
import Layout from "../layouts/Layout.astro";
import { SignIn } from "@osn/ui/auth";
---

<Layout title="Organiser Sign-In">
  <main class="container">
    <h1>Cire Organiser</h1>
    <p>Sign in with your OSN account to manage weddings.</p>
    <SignIn
      client:only="solid-js"
      apiBaseUrl="http://localhost:4000"
      onSuccess={() => (window.location.href = "/")}
    />
  </main>
</Layout>
```

(Replace `apiBaseUrl` with the production OSN issuer when deployed; thread via `import.meta.env`.)

### Task T5b.5: Create `cire/organiser/src/lib/api.ts` with `authFetch`

**Files:** creates the file.

- [ ] **Step 1: Inspect `@osn/client`'s `authFetch` to learn its call shape**

```bash
grep -rn 'authFetch' osn/client/src/
```

Likely: `authFetch(url, init?)` returns `Promise<Response>`, injects Bearer, silent-refreshes on 401.

- [ ] **Step 2: Write a thin wrapper**

```ts
// cire/organiser/src/lib/api.ts
import { Effect } from "effect";
import { OsnAuth } from "@osn/client";
import { osnRuntime } from "../auth/OsnProvider";

const CIRE_API = import.meta.env.PUBLIC_CIRE_API_URL ?? "http://localhost:8787";

/**
 * Fetch wrapper that authenticates against OSN.
 * Throws on network errors; returns Response on HTTP errors (caller handles 401/403/etc).
 */
export async function api(path: string, init?: RequestInit): Promise<Response> {
  const url = `${CIRE_API}${path}`;
  return osnRuntime.runPromise(
    Effect.gen(function* () {
      const auth = yield* OsnAuth;
      return yield* Effect.promise(() => auth.authFetch(url, init));
    }),
  );
}
```

(Adjust to the actual `OsnAuth` interface — if methods are direct, drop the Effect boilerplate.)

### Task T5b.6: Refactor `ImportPanel.tsx` to use `authFetch`

**Files:** modifies `cire/organiser/src/components/ImportPanel.tsx`.

- [ ] **Step 1: Read current implementation**

```bash
cat cire/organiser/src/components/ImportPanel.tsx
```

- [ ] **Step 2: Replace token-header injection**

Find lines around 88–95 (the `X-Organiser-Token` injection). Replace:

```tsx
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  "X-Organiser-Token": getOrganiserToken() ?? "",
};
const res = await fetch(`${API_URL}/api/organiser/import/preview`, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
});
```

with:

```tsx
import { api } from "../lib/api";

// ...
const res = await api(`/api/organiser/import/preview?weddingId=${weddingId}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
```

- [ ] **Step 3: Remove the `sessionStorage["cire:organiser-token"]` reads/writes**

```bash
grep -rn 'cire:organiser-token' cire/organiser/src
```

Delete each occurrence; if there's a hand-off page that prompted for the token at startup, replace with the sign-in page or redirect to it.

### Task T5b.7: Wire the unauth redirect

**Files:** modifies `cire/organiser/src/pages/index.astro` (or its layout component).

- [ ] **Step 1: At the top of the page (or in a SolidJS component), check for a session and redirect if missing**

```tsx
// cire/organiser/src/components/RequireAuth.tsx
import { onMount, type ParentComponent } from "solid-js";
import { Effect } from "effect";
import { OsnAuth } from "@osn/client";
import { osnRuntime } from "../auth/OsnProvider";

export const RequireAuth: ParentComponent = (props) => {
  onMount(() => {
    osnRuntime
      .runPromise(
        Effect.gen(function* () {
          const auth = yield* OsnAuth;
          const session = yield* Effect.promise(() => auth.getSession());
          if (!session.hasSession) {
            window.location.href = "/sign-in";
          }
        }),
      )
      .catch(() => {
        window.location.href = "/sign-in";
      });
  });
  return <>{props.children}</>;
};
```

Wrap the organiser dashboard with `<RequireAuth>`.

### Task T5b.8: Type-check and lint cire/organiser

**Files:** none.

- [ ] **Step 1: Type-check**

```bash
bunx --bun tsc --noEmit -p cire/organiser/tsconfig.json
```

Expected: clean. If `@osn/ui` types don't resolve, ensure the workspace dep is installed and `tsconfig`'s `extends` picks up Solid JSX.

- [ ] **Step 2: Lint**

```bash
bunx --bun oxlint -c oxlintrc.json cire/organiser/src
```

Expected: 0 errors (warnings tolerated through cire's default oxlint settings).

### Task T5b.9: Commit Phase 5b

- [ ] **Step 1: Stage and commit**

```bash
git add cire/organiser
git commit -m "$(cat <<'EOF'
feat(cire/organiser): OSN passkey sign-in via @osn/client + @osn/ui

Replaces the interim X-Organiser-Token shared-secret flow with OSN
passkey auth. Adds OsnProvider runtime, RequireAuth wrapper, sign-in
page hosting @osn/ui/auth/SignIn, and an authFetch wrapper. ImportPanel
and other API callers now route through authFetch and pass weddingId
as a query param.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task T5c.1: Manual E2E — start the dev stack

**Files:** none.

- [ ] **Step 1: From the cire-merge worktree, start all needed services**

```bash
bun run dev:cire
```

Expected: turbo starts `@osn/api` (:4000), `@cire/api` (:8787 or whatever wrangler-dev port), `@cire/web` (:4321), `@cire/organiser` (:4322).

If `@osn/api` isn't running yet on :4000, the cire-api startup may log a warning. That's fine — JWKS is fetched lazily on first auth attempt.

### Task T5c.2: Manual smoke — passkey sign-in flow

**Files:** none.

- [ ] **Step 1: Open the organiser portal**

Navigate to `http://localhost:4322`. Expected: redirect to `/sign-in`.

- [ ] **Step 2: Click sign-in**

Use the OSN account created in Phase 0 (with the enrolled passkey). The passkey ceremony should pop the platform authenticator. On success, expect redirect to `/` (the organiser dashboard).

- [ ] **Step 3: Open browser devtools, Network tab**

Confirm: requests to `cire/api` carry `Authorization: Bearer eyJ...` headers. Responses are 200.

### Task T5c.3: Curl test the cire/api with a token

**Files:** none.

- [ ] **Step 1: Copy the access token from devtools**

(Application → Local Storage → `osn:auth:session` or the configured storage key. Find the JWT.)

- [ ] **Step 2: Hit the endpoints**

```bash
TOKEN="eyJ..."   # paste here
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/organiser/weddings
```

Expected: JSON with one wedding (`wed_bootstrap`).

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/organiser/weddings/wed_bootstrap/guests
```

Expected: 200 with the existing families.

- [ ] **Step 3: Negative tests**

```bash
# No token
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/api/organiser/weddings
# Expected: 401

# Different wedding
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/organiser/weddings/wed_other/guests
# Expected: 404 (no such wedding) — if seeded, would be 403
```

### Task T5c.4: Verify guest path still works

**Files:** none.

- [ ] **Step 1: Open the guest portal**

Navigate to `http://localhost:4321`. Expected: claim-code entry screen.

- [ ] **Step 2: Enter a known publicId**

(Use a seeded family's `public_id`.) Expected: 200, `cire_session` cookie set, RSVP UI renders.

- [ ] **Step 3: Submit an RSVP**

Expected: 200, RSVP saved.

### Task T5c.5: Commit if any drift surfaced

If the E2E surfaced bugs (env wiring, CORS, etc.), fix them in a follow-up commit. Otherwise no commit at this step — Phase 5 is complete.

```bash
git status --short
```

Expected: empty unless fixes were applied.

### Task T5.6: Write Phase 5 changeset

**Files:** creates `.changeset/cire-organiser-osn-auth.md`.

- [ ] **Step 1: Write**

```bash
cat > .changeset/cire-organiser-osn-auth.md <<'EOF'
---
"@cire/api": minor
"@cire/organiser": minor
---

Organiser portal authentication switched from X-Organiser-Token shared
secret to OSN passkey login. Cire/api validates OSN access JWTs on
/api/organiser/* via @shared/osn-auth-client. Organiser dashboard
gated by @osn/client; sign-in page hosts @osn/ui/auth/SignIn.
EOF
```

- [ ] **Step 2: Stage and commit**

```bash
git add .changeset/cire-organiser-osn-auth.md
git commit -m "$(cat <<'EOF'
chore: changeset for cire/organiser OSN auth swap

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Cleanup (parallelizable)

Three independent subagents. Join at final verification.

### Task T6a.1: Delete aliased flat organiser routes

**Files:** modifies `cire/api/src/routes/organiser.ts` (or deletes if empty after stripping); modifies `cire/api/src/app.ts`.

- [ ] **Step 1: Confirm no clients depend on the flat paths**

```bash
grep -rn '/api/organiser/guests\|/api/organiser/events\|/api/organiser/import' cire/organiser/src cire/web/src 2>/dev/null
```

Expected: zero hits. Phase 5b moved everything to `/weddings/:weddingId/*`.

- [ ] **Step 2: Delete the flat routes from `organiser.ts`**

Open the file, remove handlers for `/guests` and `/events`. If the file is now empty, delete it and remove the registration from `app.ts`.

- [ ] **Step 3: Same for `organiser-import.ts`**

If the routes have been moved to live under the wedding path (or kept with the `?weddingId=` requirement), keep them. Otherwise delete and re-mount under the new prefix.

- [ ] **Step 4: Run cire/api tests**

```bash
bun run --cwd cire/api test
```

Expected: green.

### Task T6a.2: Delete `X-Organiser-Token` middleware and env wiring

**Files:** deletes any remaining `cire/api/src/lib` or `middleware` files specific to the old token; modifies `cire/api/wrangler.toml`, `cire/api/src/local.ts`, `cire/api/src/app.ts`.

- [ ] **Step 1: Grep for any residual references**

```bash
grep -rn 'X-Organiser-Token\|ORGANISER_TOKEN\|organiserToken' cire/api 2>/dev/null
```

- [ ] **Step 2: Remove**

- Delete `ORGANISER_TOKEN` from `cire/api/wrangler.toml` `[vars]` (both default and `[env.production.vars]`).
- Delete the `organiserToken` field from `AppOptions` in `cire/api/src/app.ts`.
- Delete `process.env.ORGANISER_TOKEN` read in `cire/api/src/local.ts`.
- Delete `.env.example` lines for `ORGANISER_TOKEN`.

- [ ] **Step 3: Type-check + test**

```bash
bun run --cwd cire/api check
bun run --cwd cire/api test
```

Expected: green.

### Task T6a.3: Delete `cire/api/src/lib/timing.ts` if still present

```bash
test -f cire/api/src/lib/timing.ts && git rm cire/api/src/lib/timing.ts
```

(Likely already deleted in Phase 2c.)

### Task T6a.4: Commit Phase 6a

- [ ] **Step 1: Stage and commit**

```bash
git add cire/api
git commit -m "$(cat <<'EOF'
chore(cire/api): drop X-Organiser-Token and flat aliased routes

Clients moved to /api/organiser/weddings/:weddingId/* in Phase 5;
remove the flat aliases and the now-dead X-Organiser-Token shared
secret wiring (wrangler vars, AppOptions, local.ts, .env.example).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task T6b.1: Update `cire/CLAUDE.md` and `cire/wiki/`

**Files:** modifies `cire/CLAUDE.md` and existing `cire/wiki/*.md`.

- [ ] **Step 1: Open `cire/CLAUDE.md`**

Find the auth section. Replace any `X-Organiser-Token` references with: "Organiser auth is OSN passkey login via `@osn/client` + `@osn/ui/auth/SignIn`. cire/api validates OSN access JWTs on `/api/organiser/*` via `@shared/osn-auth-client/middleware/hono`."

- [ ] **Step 2: Add forward-looking notes**

Append to `cire/CLAUDE.md`:

```md
## Future integrations

- **Pulse**: weddings will surface in pulse's event feed once the
  mechanism is chosen (ARC-token-mediated pull vs. push-on-publish).
- **Multi-owner weddings**: `weddings.owner_osn_profile_id` will become
  a join table when needed (`wedding_owners(wedding_id, osn_profile_id, role)`).
- **Elysia migration**: cire/api may migrate from Hono to Elysia to
  match osn convention. Until then, the @shared/osn-auth-client
  package ships Hono and Elysia adapters side-by-side.
```

- [ ] **Step 3: Update `cire/wiki/*.md`**

Find references to `X-Organiser-Token`, claim-code-only auth, etc., and align with the new model. Keep guest claim-code documentation unchanged.

### Task T6b.2: Create `wiki/apps/cire.md`

**Files:** creates `wiki/apps/cire.md` (osn-side wiki).

- [ ] **Step 1: Write**

```md
---
title: Cire (digital wedding invites)
tags: [apps, cire, surface]
related:
  - "[[wiki/systems/cire-auth]]"
  - "[[wiki/systems/identity-model]]"
  - "[[wiki/apps/pulse]]"
last-reviewed: 2026-06-09
---

# Cire

Bespoke digital wedding invites with a long-term path to a multi-couple
platform. Cire is the fourth sibling workspace alongside `osn/`,
`pulse/`, `zap/`.

## Packages

| Package | Purpose | Port (dev) |
|---------|---------|------------|
| `@cire/api` | Hono backend on Cloudflare Workers — guest claim flow, RSVP, organiser API | 8787 |
| `@cire/web` | Astro + SolidJS guest-facing invite | 4321 |
| `@cire/organiser` | Astro + SolidJS organiser dashboard (OSN-authed) | 4322 |
| `@cire/db` | Drizzle schema + D1 migrations | — |

## Auth model

Two systems coexist by route prefix — see `[[wiki/systems/cire-auth]]`.

- Guests: `cire_session` cookie minted by `POST /api/claim`.
- Organisers: OSN passkey login via `@osn/client`; `cire/api` validates
  access tokens on `/api/organiser/*` via
  `@shared/osn-auth-client/middleware/hono`.

## Data model

Multi-tenant scaffold: `weddings` table at the root; `families`,
`events`, `imports` carry `wedding_id` FKs. Single-owner today; join
table for multi-owner deferred.

## Local development

```bash
bun run dev:cire
```

Starts `@osn/api` (JWKS source), `@cire/api`, `@cire/web`, `@cire/organiser`.
```

### Task T6b.3: Create `wiki/systems/cire-auth.md`

**Files:** creates `wiki/systems/cire-auth.md`.

- [ ] **Step 1: Write**

```md
---
title: Cire Auth (two-system model)
tags: [systems, cire, auth, passkey, claim-code]
related:
  - "[[wiki/apps/cire]]"
  - "[[wiki/systems/identity-model]]"
  - "[[wiki/systems/passkey-primary]]"
  - "[[wiki/systems/sessions]]"
last-reviewed: 2026-06-09
---

# Cire Auth

Cire runs two parallel auth systems because guest and organiser
needs diverge sharply.

## Guest auth — claim code + opaque cookie

- Guest enters short code (e.g. `PATEL-JOY-RK97`) on the invite site.
- `POST /api/claim` looks up `families.public_id`; on match mints a
  256-bit token, hashes it (SHA-256), stores hash in `sessions.token`.
- Raw token returned via `Set-Cookie: cire_session=...; HttpOnly;
  SameSite=Lax; Path=/`, 30-day TTL.
- Subsequent RSVP requests go through `sessionAuth()` middleware:
  hashes the cookie token, looks up the session, sets
  `c.var.familyId`.

This system is intentionally low-friction. Guests do **not** become
OSN account holders.

## Organiser auth — OSN passkey + JWT

- Organiser dashboard `@cire/organiser` redirects unauth'd users to
  `/sign-in`.
- `@osn/ui/auth/SignIn` drives the OSN passkey ceremony.
- On success, the OSN issuer hands back an ES256 access JWT (5-min,
  `aud: "osn-access"`) + refresh in HttpOnly cookie.
- `@osn/client`'s `authFetch` adds the Bearer to every cire/api call.
- `cire/api` mounts
  `@shared/osn-auth-client/middleware/hono.osnAuth({...})` on
  `/api/organiser/*`. The middleware verifies signature + audience +
  expiry, then sets `c.var.osnProfileId`.
- Per-route `weddingOwner()` middleware joins through the `weddings`
  table to confirm the caller owns the targeted wedding.

## No overlap

The two middlewares never run on the same route. Guest routes
(`/api/claim`, `/api/rsvp`) use `sessionAuth()`. Organiser routes use
`osnAuth() + weddingOwner()`. Cire/api boots both side-by-side.
```

### Task T6b.4: Update root `CLAUDE.md`

**Files:** modifies `CLAUDE.md` at the osn root.

- [ ] **Step 1: Open it**

```bash
sed -n '1,40p' CLAUDE.md
```

- [ ] **Step 2: Find the surface table and add cire**

```md
| Bespoke wedding invite | `@cire/*` (api :8787, web :4321, organiser :4322) | Active |
```

- [ ] **Step 3: Find the wiki navigation table and add a cire row**

```md
| Work on cire (wedding invite) | `[[wiki/apps/cire]]`, `[[wiki/systems/cire-auth]]` |
```

- [ ] **Step 4: Find the dir table and add a cire row**

```md
| `cire/` | `@cire/*` | Digital wedding invite stack (api, web, organiser, db) |
```

### Task T6b.5: Update `wiki/TODO.md`

**Files:** modifies `wiki/TODO.md`.

- [ ] **Step 1: Add cire section**

Add under app sections:

```md
## Cire

- [ ] Cross-DB integrity check: nightly worker that sweeps
      `weddings.owner_osn_profile_id` against osn/api `/profiles/:id`
      to flag orphaned owners.
- [ ] Multi-owner weddings: design + migrate when first co-couple
      lands.
- [ ] Pulse integration: surface cire weddings in pulse's event feed.
- [ ] Elysia migration: evaluate moving cire/api from Hono.
```

- [ ] **Step 2: Add to Deferred Decisions**

```md
| Cire pulse integration mechanism | ARC-token pull from cire/api vs push-on-publish into pulse/db |
| Cire test framework alignment | Move from bun:test to it.effect + createTestLayer for parity |
```

### Task T6b.6: Verify wiki links resolve

**Files:** none.

- [ ] **Step 1: If `obsidian` CLI is on PATH, use it**

```bash
which obsidian 2>/dev/null && obsidian search query="cire-auth" verbose || \
  grep -rn '\[\[wiki/apps/cire\]\]\|\[\[wiki/systems/cire-auth\]\]' wiki/ CLAUDE.md
```

Expected: references resolve to the new files.

### Task T6b.7: Commit Phase 6b

- [ ] **Step 1: Stage and commit**

```bash
git add cire/CLAUDE.md cire/wiki CLAUDE.md wiki/apps/cire.md wiki/systems/cire-auth.md wiki/TODO.md
git commit -m "$(cat <<'EOF'
docs(cire): wiki + CLAUDE.md updates post-merge

Adds wiki/apps/cire.md and wiki/systems/cire-auth.md (two-system auth
reference). Updates root CLAUDE.md surface + wiki tables. Rewrites
cire's own CLAUDE.md to remove X-Organiser-Token language. TODO.md
gains cire app section and two deferred decisions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task T6c.1: Run full pipeline

**Files:** none.

- [ ] **Step 1: Clean + reinstall**

```bash
bun run clean
bun install
```

- [ ] **Step 2: Check, test, build**

```bash
bun run check
bun run test
bun run build
```

Expected: every workspace green.

### Task T6c.2: Audit

```bash
bun audit --audit-level=high
```

Expected: no new high/critical advisories beyond the cire `--ignore=GHSA-77vg-94rm-hx3p` carried over.

### Task T6c.3: Manual guest smoke

Re-run T5c.4. Expected: claim → RSVP works end-to-end.

### Task T6c.4: Manual organiser smoke

Re-run T5c.2 + T5c.3. Expected: passkey sign-in → guest list works.

### Task T6c.5: Apply migration to remote D1

**Files:** none code; remote D1 state.

- [ ] **Step 1: Confirm production wrangler config**

```bash
cat cire/api/wrangler.toml
```

Make sure `database_id` is the production cire-db ID (not a placeholder).

- [ ] **Step 2: Run remote push**

```bash
bun run --cwd cire/db db:push:remote
```

(Or `wrangler d1 migrations apply cire-db --remote`.)

Expected: migration applied. **Do not run this if the bespoke wedding is happening within the next 48 hours** — pick a low-traffic window.

- [ ] **Step 3: Verify**

```bash
bunx --bun wrangler d1 execute cire-db --remote --command "SELECT id, slug, owner_osn_profile_id FROM weddings"
```

Expected: one row, `wed_bootstrap`, with the production `osn_profile_id` (set at hand-edit time in Phase 4.3).

### Task T6c.6: Open PR

**Files:** none.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/cire-merge
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create --title "feat(cire): merge cire into osn as sibling workspace" --body "$(cat <<'EOF'
## Summary

- Imports cire.git/main as `cire/` workspace via `git subtree` (history preserved)
- Adopts `@shared/typescript-config` and `@shared/rate-limit`; swaps `lib/timing.ts` to `node:crypto`'s `timingSafeEqual`
- Extracts OSN-JWT verification into new `@shared/osn-auth-client` with Hono + Elysia adapters; pulse migrated to the shared verifier
- Scaffolds multi-tenancy in cire/db (`weddings` table + FKs on families/events/imports)
- Switches organiser auth from `X-Organiser-Token` shared secret to OSN passkey via `@osn/client` + `@osn/ui/auth/SignIn`
- Deletes legacy organiser token + flat aliased routes
- Adds wiki pages `wiki/apps/cire.md` and `wiki/systems/cire-auth.md`; updates root `CLAUDE.md`

## Spec

See `docs/superpowers/specs/2026-06-09-cire-into-osn-design.md`.

## Test plan

- [ ] `bun run check` green
- [ ] `bun run test` green
- [ ] `bun run build` green
- [ ] Manual: guest claim → RSVP works
- [ ] Manual: organiser passkey sign-in → guest list works
- [ ] Manual: `curl` with valid Bearer returns 200; missing/invalid returns 401; non-owner wedding returns 403
- [ ] `bun audit --audit-level=high` clean
- [ ] D1 remote migration applied successfully

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Return the PR URL when done.

---

## Phase 7 — Archive cire.git (optional, manual)

### Task T7.1: Tag cire.git/main

```bash
cd /Users/ac/.work/cire.git
git tag pre-osn-merge-archive
git push --tags  # if you have a remote configured
```

### Task T7.2: Add `MERGED.md` pointer

- [ ] **Step 1: Write**

In the cire.git/main worktree (`/Users/ac/.work/cire.git/main`):

```bash
cat > MERGED.md <<'EOF'
# cire has moved

This repository has been merged into osn as a sibling workspace.

- New location: `osn.git/main/cire/`
- Merge commit: see osn.git history, branch `feat/cire-merge`
- Archive tag in this repo: `pre-osn-merge-archive`

Open issues, PRs, and continuing work happen in osn.git.
EOF
git add MERGED.md
git commit -m "chore: cire has moved into osn — see MERGED.md"
```

- [ ] **Step 2: Do not delete `cire.git`**

Keep it as a read-only archive. The tag plus this commit makes the move clear.

---

## Self-Review (run after completing every task)

After finishing all tasks, re-read the spec (`docs/superpowers/specs/2026-06-09-cire-into-osn-design.md`) section-by-section against this plan.

### Spec coverage check

| Spec section | Plan task(s) |
|--------------|--------------|
| §2 Architecture | T1.1–T1.10 (subtree merge), T2.6 join |
| §3 Auth bridge | T5a.1–T5a.7, T5b.1–T5b.9, T5c.1–T5c.5 |
| §4 Schema | T4.1–T4.7 |
| §5.1 Adopt now (tsconfig) | T2a.1–T2a.6 |
| §5.1 Adopt now (rate-limit) | T2b.1–T2b.5 |
| §5.1 Adopt now (crypto/timing) | T2c.1–T2c.4 |
| §5.2 Lift osn-auth-client | T3.1–T3.10 |
| §5.3 Defers | (no tasks — explicitly out of scope) |
| §6 Migration phases | this plan, T0–T7 |
| §7 Risks | T6c.5 (low-traffic D1 push); T5c (E2E gates); T3.10 (pulse-test gate) |
| §8 Subagent plan | T2 / T5 / T6 marked parallelizable |
| §9 Skills mapping | (executed during plan execution, not in tasks) |
| §10 Verification gates | T1.8, T2.6, T3.10, T4.6, T5c.1–.4, T6c.1–.4 |
| §11 Future integrations | T6b.5 (documented in TODO.md), T6b.1 (cire CLAUDE.md) |

### Placeholder scan

Run a grep over this plan file before execution:

```bash
grep -nE 'TBD|TODO|implement later|fill in|<placeholder>' \
  docs/superpowers/plans/2026-06-09-cire-into-osn-implementation.md
```

The expected non-match areas: runtime placeholder strings `__SUBSTITUTE_WEDDING_SLUG__`, `__SUBSTITUTE_WEDDING_NAME__`, `__SUBSTITUTE_OSN_PROFILE_ID__` — these are documented as "fill at migration time" in T0.3 and T4.3, not plan gaps.

### Type consistency check

- `osnAuth()` Hono adapter: signature `(options: OsnAuthOptions): MiddlewareHandler`. Used in T3.6, T5a.2.
- `OsnAuthOptions`: `{ jwksUrl: string; audience: string; _testKey?: CryptoKey }`. Used consistently in T3.5, T3.6, T3.7, T3.8, T5a.1.
- `weddingOwner()`: returns `MiddlewareHandler<{ Variables: { db, osnProfileId, weddingId } }>`. Used in T5a.4, T5a.5.
- Variable names: `c.var.osnProfileId` (not `c.var.profileId`, not `osn_profile_id`) — consistent across T3.6, T5a.2, T5a.4, T5a.5.
- Wedding ID prefix: `wed_*`. Bootstrap: `wed_bootstrap`. Consistent.
- OSN profile ID prefix: `usr_*`. Consistent.
- Audience claim value: `"osn-access"`. Consistent.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-06-09-cire-into-osn-implementation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Parallelizable phases (T2a/b/c, T5a/b, T6a/b/c) run as concurrent subagent fan-outs.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
