# Invite Design Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A wedding's invite renders as one of several full template packs, resolved server-side from a `design_id` DB column; ships with the current layout as the `classic` pack, a dormant-but-tested `premium_templates` entitlement gate, and an organiser Design selector.

**Architecture:** A tiny shared catalog package (`@shared/invite-designs`) is the single source of truth for design ids/names/tiers. The DB stores `design_id` on `wedding_invite_customisations`; both invite GETs surface it and a new `PUT /invite/design` persists it (validating against the catalog + the entitlement tier). The guest site gains `cire/web/src/designs/` — a registry keyed by `DesignId` mapping to per-design component trees; the existing invite components move to `designs/classic/` and `[slug].astro` renders the resolved pack's `Document`. Unknown ids always fall back to classic.

**Tech Stack:** Bun workspaces, Drizzle/D1, Elysia (`aot:false`) + Effect (backend only), Astro SSR + SolidJS islands, vitest (web/organiser) + bun:test (api).

**Spec:** `docs/superpowers/specs/2026-07-22-invite-design-selector-design.md`

## Global Constraints

- Worktree: all work happens in `/Users/ac/.work/osn.git/.claude/worktrees/feat+invite-design-selector` on branch `feat/invite-design-selector`. Run every command from that repo root unless a step says otherwise.
- **DDL lockstep (T-S1):** any schema change must land in THREE places in the same commit — `cire/db/migrations/*.sql`, the `DDL` string in `cire/api/src/db/setup.ts`, and `cire/db/src/schema.ts`. `cire/api/src/db/ddl-lockstep.test.ts` enforces this.
- **WT-P-I1:** a design change bumps `updatedAt` only — NEVER `imagesUpdatedAt` (that would cold-start the guest image transform caches).
- Effect is backend + DB only — never import `effect` in `cire/web` or `cire/organiser`.
- No `console.*` in `cire/api` — Effect structured logger; every catch/`catchAllDefect` logs; never log PII.
- POST/PUT routes with JSON bodies use the `manualParse` sentinel + hand `request.json().catch(() => null)` (existing pattern in `cire/api/src/routes/invite.ts`).
- Changesets: required; package names must match workspace `name` exactly. `@cire/*` packages are version-less — they must NEVER share a changeset file with the versioned `@shared/invite-designs`; write two separate changeset files (Task 7).
- `@cire/db` (shared schema) changes → run the FULL monorepo suite (`bun run test`) before opening the PR, not just cire packages.
- Test commands: `bun run --cwd cire/api test`, `bun run --cwd cire/web test`, `bun run --cwd cire/organiser test`, `bun run --cwd shared/invite-designs test:run`, full suite `bun run test`; web build `bun run --cwd cire/web build`.
- If lefthook is missing at commit time (`Can't find lefthook in PATH`), run `bun install` once; do not habitually `--no-verify`.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Before editing any file, Read it first — line anchors in this plan were verified 2026-07-22 but the file is the source of truth.

---

### Task 1: `@shared/invite-designs` catalog package

**Files:**
- Create: `shared/invite-designs/package.json`
- Create: `shared/invite-designs/tsconfig.json`
- Create: `shared/invite-designs/vitest.config.ts`
- Create: `shared/invite-designs/src/index.ts`
- Test: `shared/invite-designs/src/index.test.ts`
- Modify: `cire/api/package.json`, `cire/organiser/package.json`, `cire/web/package.json` (add dependency)

**Interfaces:**
- Produces: `DesignMeta { readonly id: string; readonly name: string; readonly tier: "free" | "premium" }`, `DESIGNS: readonly DesignMeta[]` (launch: one entry `{ id: "classic", name: "Classic", tier: "free" }`), `DesignId` union type (`"classic"` at launch), `DEFAULT_DESIGN_ID = "classic"`, `isDesignId(value: unknown): value is DesignId`. Tasks 4–6 import all of these from `@shared/invite-designs`.

- [ ] **Step 1: Scaffold the package**

`shared/invite-designs/package.json`:

```json
{
  "name": "@shared/invite-designs",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "check": "tsc --noEmit",
    "test": "bunx --bun vitest",
    "test:run": "bunx --bun vitest run"
  },
  "devDependencies": {
    "@shared/typescript-config": "workspace:*",
    "vitest": "^4.1.8"
  }
}
```

`shared/invite-designs/tsconfig.json`:

```json
{
  "extends": "@shared/typescript-config/node.json",
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

`shared/invite-designs/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Write the failing test**

`shared/invite-designs/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { DEFAULT_DESIGN_ID, DESIGNS, isDesignId } from "./index";

describe("invite design catalog", () => {
  it("contains classic as a free design", () => {
    expect(DESIGNS).toContainEqual({ id: "classic", name: "Classic", tier: "free" });
  });

  it("defaults to classic", () => {
    expect(DEFAULT_DESIGN_ID).toBe("classic");
  });

  it("has unique ids", () => {
    expect(new Set(DESIGNS.map((d) => d.id)).size).toBe(DESIGNS.length);
  });

  it("accepts every catalog id", () => {
    for (const d of DESIGNS) expect(isDesignId(d.id)).toBe(true);
  });

  it("rejects unknown ids and non-strings", () => {
    expect(isDesignId("gala")).toBe(false);
    expect(isDesignId(42)).toBe(false);
    expect(isDesignId(null)).toBe(false);
    expect(isDesignId(undefined)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun install && bun run --cwd shared/invite-designs test:run`
Expected: FAIL — `./index` has no exports yet / module not found.

- [ ] **Step 4: Write the implementation**

`shared/invite-designs/src/index.ts`:

```ts
/** One entry in the invite design catalog. */
export interface DesignMeta {
  readonly id: string;
  /** Display name shown in the organiser selector. */
  readonly name: string;
  /** `premium` requires the wedding's `premium_templates` entitlement. */
  readonly tier: "free" | "premium";
}

/**
 * The invite design catalog — single source of truth for design ids, names and
 * entitlement tiers. `@cire/api` validates writes against it, the organiser
 * renders the selector from it, and `@cire/web` keys its design registry off
 * the derived `DesignId` union (a catalog entry without a matching component
 * pack is a type error there). Launch catalog is `classic` only; the gate for
 * `premium` tiers is built and tested but dormant.
 */
export const DESIGNS = [
  { id: "classic", name: "Classic", tier: "free" },
] as const satisfies readonly DesignMeta[];

/** Union of catalog design ids (`"classic"` at launch). */
export type DesignId = (typeof DESIGNS)[number]["id"];

/** The design every wedding starts on and every unknown id falls back to. */
export const DEFAULT_DESIGN_ID = "classic" satisfies DesignId;

/** Whether `value` is a catalog design id. */
export function isDesignId(value: unknown): value is DesignId {
  return typeof value === "string" && DESIGNS.some((d) => d.id === value);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run --cwd shared/invite-designs test:run`
Expected: PASS (5 tests).

- [ ] **Step 6: Wire the dependency into the three consumers**

In `cire/api/package.json`, `cire/organiser/package.json`, and `cire/web/package.json`, add to `"dependencies"` (keep alphabetical order with the existing `@shared/*` entries, e.g. next to `@shared/feature-flags` in cire/api):

```json
"@shared/invite-designs": "workspace:*",
```

Run: `bun install`
Expected: lockfile updates, no errors. Verify link: `bun run --cwd shared/invite-designs check` passes.

- [ ] **Step 7: Commit**

```bash
git add shared/invite-designs cire/api/package.json cire/organiser/package.json cire/web/package.json bun.lock
git commit -m "feat(shared): add @shared/invite-designs catalog package"
```

---

### Task 2: `design_id` column (migration + schema + DDL, lockstep)

**Files:**
- Create: `cire/db/migrations/0045_invite_design.sql`
- Modify: `cire/db/src/schema.ts` (~line 716, `weddingInviteCustomisations`, after `inviteMessage`)
- Modify: `cire/api/src/db/setup.ts` (`DDL` string, `wedding_invite_customisations` block ~lines 147–178, after `invite_message TEXT,`)
- Test: existing `cire/api/src/db/ddl-lockstep.test.ts` (no edits — it enforces the lockstep)

**Interfaces:**
- Produces: Drizzle column `weddingInviteCustomisations.designId` (`text("design_id").notNull().default("classic")`) — Task 3/4 select and upsert it.

- [ ] **Step 1: Confirm the migration number**

Run: `ls cire/db/migrations | tail -3`
Expected: last numbered file is `0044_invite_palette.sql` → new file is `0045`. If a later number exists (parallel merge), use next.

- [ ] **Step 2: Write the migration (first lockstep surface)**

`cire/db/migrations/0045_invite_design.sql`:

```sql
-- Invite design selector: which full template pack the wedding's invite
-- renders as. Stored on the customisation row so the guest site's single
-- SSR fetch resolves it with no extra round-trip. Additive with a default —
-- existing rows stay on the current look ('classic'); no backfill needed.
ALTER TABLE wedding_invite_customisations ADD COLUMN design_id TEXT NOT NULL DEFAULT 'classic';
```

Match the header prose style of `0044_invite_palette.sql` (Read it first).

- [ ] **Step 3: Run the lockstep test to verify it fails**

Run: `bun run --cwd cire/api test`
Expected: `ddl-lockstep.test.ts` FAILS — migration chain has `design_id` but the test `DDL` and Drizzle schema don't.

- [ ] **Step 4: Update the other two lockstep surfaces**

`cire/db/src/schema.ts` — in `weddingInviteCustomisations`, insert after the `inviteMessage: text("invite_message"),` line (~716):

```ts
  // Which design pack the invite renders as (invite design selector, 0045).
  // Always a concrete id; unknown values fall back to 'classic' on read.
  designId: text("design_id").notNull().default("classic"),
```

`cire/api/src/db/setup.ts` — in the `CREATE TABLE IF NOT EXISTS wedding_invite_customisations (` block, insert after the `  invite_message TEXT,` line (~176):

```sql
  design_id TEXT NOT NULL DEFAULT 'classic',
```

(One column per line, matching the existing block's formatting.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run --cwd cire/api test`
Expected: PASS, including `ddl-lockstep.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add cire/db/migrations/0045_invite_design.sql cire/db/src/schema.ts cire/api/src/db/setup.ts
git commit -m "feat(cire/db): add wedding_invite_customisations.design_id (default classic)"
```

---

### Task 3: API read path — `designId` on both invite GETs

**Files:**
- Modify: `cire/api/src/services/invite.ts` (interface ~83–116, `EMPTY` ~134–142, `toCustomisation` ~157–251, `getForWeddingId` select ~295–327)
- Test: `cire/api/src/routes/invite.test.ts`

**Interfaces:**
- Consumes: `weddingInviteCustomisations.designId` (Task 2).
- Produces: `InviteCustomisation.designId: string` (always concrete, defaults `"classic"`) on `GET /api/invite/:slug` and `GET /api/organiser/weddings/:weddingId/invite`. Task 4 reuses `inviteService.getForWeddingId`; Tasks 5/6 read `designId` off these payloads.

- [ ] **Step 1: Write the failing tests**

In `cire/api/src/routes/invite.test.ts`, add a describe block (mirror the file's existing helpers exactly — `buildApp`, `appRequest`, `authHeaders`, `orgBase`, `SLUG`; Read a neighbouring public-GET test first and copy its request shape):

```ts
describe("invite designId", () => {
  it("defaults to classic on the public invite", async () => {
    const { app } = await buildApp();
    const res = await appRequest(app, `/api/invite/${SLUG}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { designId: string };
    expect(body.designId).toBe("classic");
  });

  it("defaults to classic on the organiser GET", async () => {
    const { app, auth } = await buildApp();
    const res = await appRequest(app, orgBase, {
      headers: await authHeaders(auth, BOOTSTRAP_OWNER),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { designId: string };
    expect(body.designId).toBe("classic");
  });
});
```

(If `authHeaders`/`appRequest` signatures differ from the above, keep the file's own idiom — the assertions are what matter.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd cire/api test`
Expected: the two new tests FAIL — `designId` is `undefined`.

- [ ] **Step 3: Implement the read path**

In `cire/api/src/services/invite.ts`:

1. `InviteCustomisation` interface — after `inviteMessage: string | null;` (~line 115) add:

```ts
  // Which design pack the invite renders as (0045). Always concrete — a
  // missing row or a pre-0045 null reads as "classic".
  designId: string;
```

2. `EMPTY` — after `inviteMessage: null,` (~line 141) add:

```ts
  designId: "classic",
```

3. `toCustomisation` — in the `c` parameter type, after `inviteMessage: string | null;` (~line 189) add:

```ts
    // NOT NULL column, but a LEFT JOIN miss (no customisation row) yields null.
    designId: string | null;
```

and in the returned object, after `inviteMessage: c.inviteMessage,` (~line 249) add:

```ts
    designId: c.designId ?? "classic",
```

4. `getForWeddingId` — in the explicit `.select({...})` list, after `inviteMessage: weddingInviteCustomisations.inviteMessage,` (~line 324) add:

```ts
            designId: weddingInviteCustomisations.designId,
```

(`getForWedding` uses `.select()` (full row) so it needs no change; the public `getForSlug` delegates to it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd cire/api test`
Expected: PASS (typecheck of the `c` param stays satisfied because the full-row select includes `designId`).

- [ ] **Step 5: Commit**

```bash
git add cire/api/src/services/invite.ts cire/api/src/routes/invite.test.ts
git commit -m "feat(cire/api): surface invite designId on public + organiser GETs"
```

---

### Task 4: API write path — `PUT /invite/design` with entitlement gate

**Files:**
- Modify: `cire/api/src/schemas/invite.ts` (append at end of file)
- Modify: `cire/api/src/services/invite.ts` (add `setDesign` to `inviteService`)
- Modify: `cire/api/src/routes/invite.ts` (imports; `createInviteOrganiserRoutes` signature ~388; new route after the `/invite/theme` PUT ~508)
- Modify: `cire/api/src/app.ts` (`AppOptions` ~172, destructure ~316, call site ~557)
- Test: `cire/api/src/routes/invite.test.ts`

**Interfaces:**
- Consumes: `DESIGNS`, `DesignMeta` from `@shared/invite-designs` (Task 1); `entitlementService.has(weddingId, "premium_templates"): Effect<boolean, never, DbService>` from `cire/api/src/services/entitlements.ts` (exists); `inviteService.getForWeddingId` (Task 3).
- Produces: `PUT /api/organiser/weddings/:weddingId/invite/design` (weddingEditor role), body `{ designId: string }` → 400 malformed / 422 unknown id / 403 premium-unentitled (`{ error: "premium_design" }`) / 200 with the full updated `InviteCustomisation`. `createInviteOrganiserRoutes(db, assets, osnAuthOptions, limiter, designs = DESIGNS)` — the 5th param is the test-injection seam. `AppOptions.inviteDesigns?: readonly DesignMeta[]`. `inviteService.setDesign(weddingId, designId): Effect<void, never, DbService>`.

- [ ] **Step 1: Write the failing tests**

In `cire/api/src/routes/invite.test.ts`. First Read the file's `buildApp` helper: it builds `createApp(db, { osnTestKey, assets, images, inviteLimiter })`. Extend `buildApp` to (a) accept and pass through an `inviteDesigns` option, and (b) return the `db` handle it already creates (add `db` to the returned object) if it doesn't already. Also add to the file's `@cire/db` import: `weddingEntitlements`. Add at top: `import { DESIGNS } from "@shared/invite-designs"; import type { DesignMeta } from "@shared/invite-designs";`

Then add:

```ts
// Test-only catalog: a second free design (so the happy path can change the
// stored value) and a premium design (so the dormant entitlement gate is
// exercised — the launch catalog is all-free).
const TEST_CATALOG = [
  ...DESIGNS,
  { id: "test-free", name: "Test Free", tier: "free" },
  { id: "test-premium", name: "Test Premium", tier: "premium" },
] as const satisfies readonly DesignMeta[];

describe("PUT /api/organiser/weddings/:weddingId/invite/design", () => {
  const put = (body: unknown) => ({
    method: "PUT" as const,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  it("401 without a token", async () => {
    const { app } = await buildApp({ inviteDesigns: TEST_CATALOG });
    const res = await appRequest(app, `${orgBase}/design`, put({ designId: "classic" }));
    expect(res.status).toBe(401);
  });

  it("403 for a non-member", async () => {
    const { app, auth } = await buildApp({ inviteDesigns: TEST_CATALOG });
    const res = await appRequest(app, `${orgBase}/design`, {
      ...put({ designId: "classic" }),
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders(auth, "usr_someone_else")),
      },
    });
    expect(res.status).toBe(403);
  });

  it("400 for a malformed body", async () => {
    const { app, auth } = await buildApp({ inviteDesigns: TEST_CATALOG });
    const res = await appRequest(app, `${orgBase}/design`, {
      ...put("{"),
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders(auth, BOOTSTRAP_OWNER)),
      },
    });
    expect(res.status).toBe(400);
  });

  it("422 for an unknown design id", async () => {
    const { app, auth } = await buildApp({ inviteDesigns: TEST_CATALOG });
    const res = await appRequest(app, `${orgBase}/design`, {
      ...put({ designId: "not-a-design" }),
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders(auth, BOOTSTRAP_OWNER)),
      },
    });
    expect(res.status).toBe(422);
  });

  it("403 for a premium design without the entitlement", async () => {
    const { app, auth } = await buildApp({ inviteDesigns: TEST_CATALOG });
    const res = await appRequest(app, `${orgBase}/design`, {
      ...put({ designId: "test-premium" }),
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders(auth, BOOTSTRAP_OWNER)),
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("premium_design");
  });

  it("saves a premium design when the wedding holds premium_templates", async () => {
    const { app, auth, db } = await buildApp({ inviteDesigns: TEST_CATALOG });
    // Grant the entitlement directly — match the weddingEntitlements schema
    // columns exactly (Read cire/db/src/schema.ts before writing this insert).
    db.insert(weddingEntitlements)
      .values({ weddingId: BOOTSTRAP_WEDDING_ID, entitlement: "premium_templates" })
      .run();
    const res = await appRequest(app, `${orgBase}/design`, {
      ...put({ designId: "test-premium" }),
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders(auth, BOOTSTRAP_OWNER)),
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { designId: string };
    expect(body.designId).toBe("test-premium");
  });

  it("persists a free design and surfaces it on both GETs", async () => {
    const { app, auth } = await buildApp({ inviteDesigns: TEST_CATALOG });
    const res = await appRequest(app, `${orgBase}/design`, {
      ...put({ designId: "test-free" }),
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders(auth, BOOTSTRAP_OWNER)),
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { designId: string }).designId).toBe("test-free");

    const organiserRes = await appRequest(app, orgBase, {
      headers: await authHeaders(auth, BOOTSTRAP_OWNER),
    });
    expect(((await organiserRes.json()) as { designId: string }).designId).toBe("test-free");

    const publicRes = await appRequest(app, `/api/invite/${SLUG}`);
    expect(((await publicRes.json()) as { designId: string }).designId).toBe("test-free");
  });
});
```

Adapt helper call shapes (`authHeaders`, `appRequest`, `buildApp` options object, whether the drizzle insert needs `await`/extra NOT NULL columns like a granted-at timestamp) to the file's existing idiom — the status codes and assertions are the contract. Also verify the 403-role test: if the wedding-editor gate returns a body distinguishing `read_only_role`, just assert status 403.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd cire/api test`
Expected: new tests FAIL (route 404s; `buildApp` may need the option first to compile).

- [ ] **Step 3: Add the body schema**

Append to `cire/api/src/schemas/invite.ts`:

```ts
/**
 * Body for `PUT /invite/design`. Deliberately just "a string" here — catalog
 * membership (and the premium entitlement) is checked in the route against
 * `@shared/invite-designs`, so an unknown id is a 422, not a 400.
 */
export const InviteDesignBody = Schema.Struct({
  designId: Schema.String,
});
export type InviteDesignBody = Schema.Schema.Type<typeof InviteDesignBody>;
```

- [ ] **Step 4: Add `inviteService.setDesign`**

In `cire/api/src/services/invite.ts`, add to the `inviteService` object (after `upsertTheme`):

```ts
  /**
   * Set which design pack the wedding's invite renders as. The id has already
   * passed catalog + entitlement checks at the route boundary. Bumps
   * `updatedAt` only — NEVER `imagesUpdatedAt` — a design switch changes no
   * stored image bytes, so the guest image transform caches stay warm
   * (WT-P-I1).
   */
  setDesign(weddingId: string, designId: string): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const now = new Date();
      yield* dbQuery(() =>
        db
          .insert(weddingInviteCustomisations)
          .values({ weddingId, designId, updatedAt: now })
          .onConflictDoUpdate({
            target: weddingInviteCustomisations.weddingId,
            set: { designId, updatedAt: now },
          })
          .run(),
      );
      yield* Effect.logInfo("invite design saved", { weddingId, designId });
      yield* Effect.sync(() => metricInviteSaved("ok"));
    }).pipe(Effect.withSpan("cire.invite.setDesign"));
  },
```

- [ ] **Step 5: Add the route + catalog injection seam**

In `cire/api/src/routes/invite.ts`:

1. Imports — add:

```ts
import { DESIGNS } from "@shared/invite-designs";
import type { DesignMeta } from "@shared/invite-designs";
```

add `InviteDesignBody` to the `../schemas/invite` import list, and:

```ts
import { entitlementService } from "../services/entitlements";
```

2. Factory signature (~line 388) — add a 5th parameter with the production default (the test seam for premium fixtures, mirroring the `inviteLimiter` precedent):

```ts
export const createInviteOrganiserRoutes = (
  db: Db,
  assets: AssetsBucket | undefined,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
  designs: readonly DesignMeta[] = DESIGNS,
) =>
```

3. Route docblock (~line 380): add a line to the route table comment:

```
 *   PUT    /weddings/:weddingId/invite/design      → which design pack renders
```

4. New route — in the `weddingEditor` group, immediately after the `/invite/theme` `.put(...)` (after its closing `manualParse,\n        )` ~line 508):

```ts
        // Which design pack the invite renders as. The id must be in the
        // catalog (unknown → 422, so a newer organiser build can't half-save)
        // and a premium tier requires the wedding's `premium_templates`
        // entitlement (403 otherwise — the client greys locked cards out, but
        // the server is the gate).
        .put(
          "/invite/design",
          async ({ request, weddingId, set }) => {
            if (!weddingId) {
              set.status = 500;
              return { error: "Internal error" };
            }
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknown(InviteDesignBody)(raw);
                const design = designs.find((d) => d.id === body.designId);
                if (!design) {
                  set.status = 422;
                  return { error: "Unknown design" };
                }
                if (design.tier === "premium") {
                  const entitled = yield* entitlementService.has(
                    weddingId,
                    "premium_templates",
                  );
                  if (!entitled) {
                    set.status = 403;
                    return { error: "premium_design" };
                  }
                }
                yield* inviteService.setDesign(weddingId, design.id);
                return yield* inviteService.getForWeddingId(weddingId);
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("ParseError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchTag("WeddingNotFound", () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "Not found" };
                  }),
                ),
                Effect.catchAllDefect(() =>
                  Effect.gen(function* () {
                    yield* Effect.logError("invite design save failed", { weddingId });
                    set.status = 500;
                    return { error: "Internal error" };
                  }),
                ),
              ),
            );
          },
          manualParse,
        )
```

(If `entitlementService.has` takes the key as a typed union, `"premium_templates"` is already a member of `ENTITLEMENT_KEYS` — no cast needed.)

- [ ] **Step 6: Thread the option through `createApp`**

In `cire/api/src/app.ts`:

1. Import (top, with the other `@shared/*` type imports):

```ts
import type { DesignMeta } from "@shared/invite-designs";
```

2. `AppOptions` (~line 172, next to `inviteLimiter`):

```ts
  /** Test seam: override the invite design catalog (e.g. to add a premium fixture). */
  inviteDesigns?: readonly DesignMeta[];
```

3. Destructure (~line 316, next to `inviteLimiter = defaultInviteLimiter,`):

```ts
    inviteDesigns,
```

4. Call site (~line 557):

```ts
      .use(createInviteOrganiserRoutes(db, assets, osnAuthOptions, inviteLimiter, inviteDesigns))
```

(Passing `undefined` explicitly still triggers the factory's `= DESIGNS` default.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun run --cwd cire/api test`
Expected: PASS — full file including the new matrix and Task 3's tests.

- [ ] **Step 8: Commit**

```bash
git add cire/api/src/schemas/invite.ts cire/api/src/services/invite.ts cire/api/src/routes/invite.ts cire/api/src/app.ts cire/api/src/routes/invite.test.ts
git commit -m "feat(cire/api): PUT /invite/design with catalog validation + premium entitlement gate"
```

---

### Task 5: Web — design registry + classic pack

**Files:**
- Create: `cire/web/src/components/invite-images.ts` (extracted from InviteHeader)
- Create: `cire/web/src/components/invite-images.test.ts` (srcset tests moved out of InviteHeader.test.tsx)
- Create: `cire/web/src/designs/types.ts`
- Create: `cire/web/src/designs/resolve.ts`
- Test: `cire/web/src/designs/resolve.test.ts`
- Create: `cire/web/src/designs/registry.ts`
- Move (git mv): `cire/web/src/components/InviteDocument.astro` → `cire/web/src/designs/classic/Document.astro`; `InviteHeader.tsx`, `InviteHeader.test.tsx`, `InvitePage.tsx`, `InvitePage.test.tsx`, `UnlockReveal.motion.ts`, `UnlockReveal.motion.test.ts` → `cire/web/src/designs/classic/`
- Modify: `cire/web/src/components/EventCard.tsx:4`, `cire/web/src/lib/invite.ts:1`, `cire/web/src/pages/[slug].astro`, plus any straggler importers (grep in Step 8)

**Interfaces:**
- Consumes: `DesignId`, `DEFAULT_DESIGN_ID`, `isDesignId` (Task 1); API payload `designId` (Task 3).
- Produces: `designs/types.ts` exports `HeroDisplay`, `InviteCustomisation` (moved from InviteHeader, gains `designId?: string`), `InviteDesignProps { apiUrl: string; slug: string; initialInvite: InviteCustomisation | null; siteUrl?: string }`; `designs/resolve.ts` exports `resolveDesignId(value: unknown): DesignId`; `designs/registry.ts` exports `registry: Record<DesignId, DesignEntry>` with `DesignEntry { Document }`; `components/invite-images.ts` exports `VARIANT_WIDTHS`, `VariantName`, `HERO_BG_VARIANT`, `buildSrcSet`, `variantSrc`.

**Ordering matters:** extract `invite-images.ts` BEFORE moving InviteHeader, so shared `components/EventCard.tsx` never imports from a design pack (shared → design would invert the dependency direction).

- [ ] **Step 1: Extract `invite-images.ts` (shared image-URL helpers)**

Read `cire/web/src/components/InviteHeader.tsx` lines 1–60. Cut `VARIANT_WIDTHS`, `type VariantName`, `HERO_BG_VARIANT`, `buildSrcSet`, `variantSrc` (WITH their doc comments, verbatim) into new `cire/web/src/components/invite-images.ts`, each `export`ed. In `InviteHeader.tsx` replace the removed code with:

```ts
import { buildSrcSet, HERO_BG_VARIANT, variantSrc } from "./invite-images";
```

(keep only the names InviteHeader actually uses; let the typechecker guide). In `cire/web/src/components/EventCard.tsx` line 4, change:

```ts
import { buildSrcSet, variantSrc } from "./InviteHeader";
```

to:

```ts
import { buildSrcSet, variantSrc } from "./invite-images";
```

Move the `buildSrcSet`/`variantSrc` tests (the T-M1 width assertions, 320/800/1600) from `InviteHeader.test.tsx` into new `cire/web/src/components/invite-images.test.ts`, importing from `./invite-images`.

Run: `bun run --cwd cire/web test`
Expected: PASS.

- [ ] **Step 2: Create `designs/types.ts`**

Move (cut) the `HeroDisplay` and `InviteCustomisation` interface declarations verbatim (with doc comments) from `InviteHeader.tsx` into `cire/web/src/designs/types.ts`, then add the `designId` field and the props contract:

```ts
// ...moved HeroDisplay + InviteCustomisation interfaces here, verbatim...

// Add inside InviteCustomisation (last field):
//   /** Which design pack renders this invite (0045). Optional so payloads from
//    *  an older API deploy still parse; resolve through `resolveDesignId`. */
//   designId?: string;

/**
 * The data contract every design pack's `Document.astro` receives — the same
 * data regardless of design. Claim flow and `ClaimResult` stay design-agnostic.
 */
export interface InviteDesignProps {
  /** cire-api origin the islands fetch from at runtime. */
  apiUrl: string;
  /** The wedding slug resolved from the request path; threaded to the islands. */
  slug: string;
  /** Invite customisation fetched server-side for this slug (per request). */
  initialInvite: InviteCustomisation | null;
  /** Canonical guest-site origin for share metadata (PUBLIC_SITE_URL). */
  siteUrl?: string;
}
```

In `InviteHeader.tsx` add `import type { HeroDisplay, InviteCustomisation } from "../designs/types";` (path becomes `../types` after the move in Step 5) and re-export nothing. Update `cire/web/src/lib/invite.ts:1`:

```ts
import type { InviteCustomisation } from "../designs/types";
```

If `InviteCustomisation` referenced types from `./image-crop` / `./invite-theme`, import them in `types.ts` from `../components/image-crop` / `../components/invite-theme`.

- [ ] **Step 3: Write the failing resolver test**

`cire/web/src/designs/resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { resolveDesignId } from "./resolve";

describe("resolveDesignId", () => {
  it("returns a known catalog id unchanged", () => {
    expect(resolveDesignId("classic")).toBe("classic");
  });

  it("falls back to classic for an unknown id", () => {
    expect(resolveDesignId("gala")).toBe("classic");
  });

  it("falls back to classic for missing or malformed values", () => {
    expect(resolveDesignId(undefined)).toBe("classic");
    expect(resolveDesignId(null)).toBe("classic");
    expect(resolveDesignId(42)).toBe("classic");
  });
});
```

Run: `bun run --cwd cire/web test`
Expected: FAIL — `./resolve` doesn't exist.

- [ ] **Step 4: Implement `designs/resolve.ts` (pure — the vitest-safe piece)**

```ts
import { DEFAULT_DESIGN_ID, isDesignId, type DesignId } from "@shared/invite-designs";

/**
 * Resolve a stored design id to a renderable catalog id. Unknown, missing, or
 * malformed ids fall back to the default design — a guest invite must never
 * 500 (or render blank) because a wedding row references a design this deploy
 * doesn't ship. Kept free of `.astro` imports so vitest can exercise it (the
 * registry itself can't be unit-tested — vitest can't load Astro components).
 */
export function resolveDesignId(value: unknown): DesignId {
  return isDesignId(value) ? value : DEFAULT_DESIGN_ID;
}
```

Run: `bun run --cwd cire/web test`
Expected: PASS.

- [ ] **Step 5: Move the classic pack (git mv, one commit-atomic step)**

```bash
mkdir -p cire/web/src/designs/classic
git mv cire/web/src/components/InviteDocument.astro cire/web/src/designs/classic/Document.astro
git mv cire/web/src/components/InviteHeader.tsx cire/web/src/designs/classic/InviteHeader.tsx
git mv cire/web/src/components/InviteHeader.test.tsx cire/web/src/designs/classic/InviteHeader.test.tsx
git mv cire/web/src/components/InvitePage.tsx cire/web/src/designs/classic/InvitePage.tsx
git mv cire/web/src/components/InvitePage.test.tsx cire/web/src/designs/classic/InvitePage.test.tsx
git mv cire/web/src/components/UnlockReveal.motion.ts cire/web/src/designs/classic/UnlockReveal.motion.ts
git mv cire/web/src/components/UnlockReveal.motion.test.ts cire/web/src/designs/classic/UnlockReveal.motion.test.ts
```

Then fix imports in the moved files (from `designs/classic/`, shared code is two levels up):

- `Document.astro` frontmatter becomes:

```astro
---
import '../../styles/global.css'
import { inviteTitle } from '../../lib/invite-title'
import InviteHeader from './InviteHeader'
import InvitePage from './InvitePage'
import { paletteRootVars, styleAttr } from '../../components/invite-theme'
import SiteFooter from '../../components/SiteFooter.astro'
import type { InviteDesignProps } from '../types'

type Props = InviteDesignProps

const { apiUrl, slug, initialInvite, siteUrl } = Astro.props
```

(delete the old inline `interface Props` — its doc comments now live on `InviteDesignProps`; keep the rest of the frontmatter — heroBase/pageTitle/paletteStyle/preloadHeroHref — and the whole template unchanged; update the comment "Must stay in step with HERO_BG_VARIANT in InviteHeader.tsx" to point at `components/invite-images.ts`).

- `InviteHeader.tsx`: `./image-crop` → `../../components/image-crop`, `./invite-emptiness` → `../../components/invite-emptiness`, `./invite-theme` → `../../components/invite-theme`, `./invite-images` → `../../components/invite-images`, types → `../types`.
- `InvitePage.tsx`: `../lib/osn` → `../../lib/osn`; `./DetailsModal`, `./EventCard`, `./invite-theme`, `./LoginSection`, `./PulseAccountLink`, `./RsvpModal`, `./types` → `../../components/<same>`; the dynamic `await import("./UnlockReveal.motion")` stays `./UnlockReveal.motion`.
- `InvitePage.test.tsx`: update the `vi.mock` specifiers to match what the SUT now imports — `vi.mock("../../components/RsvpModal", ...)`, `vi.mock("../../components/DetailsModal", ...)`, `vi.mock("../../components/PulseAccountLink", ...)`; `vi.mock("motion", ...)`, `vi.mock("./UnlockReveal.motion", ...)`, `vi.mock("@osn/client/solid", ...)`, `vi.mock("solid-toast", ...)` are unchanged; fixture/type imports from `../../components/types`.
- `InviteHeader.test.tsx`: import `InviteHeader from "./InviteHeader"`, types from `../types` (the srcset tests already moved out in Step 1).
- `UnlockReveal.motion.test.ts`: no specifier changes (mocks `motion`, imports `./UnlockReveal.motion`).

- [ ] **Step 6: Create `designs/registry.ts`**

```ts
import type { DesignId } from "@shared/invite-designs";

import ClassicDocument from "./classic/Document.astro";

/** One renderable design pack. */
export interface DesignEntry {
  /** Full-page Astro document — owns fonts, preloads, and which islands ship. */
  Document: typeof ClassicDocument;
}

/**
 * Design id → component tree. Keyed by the shared catalog's `DesignId` union,
 * so adding a catalog entry without a matching pack is a type error here.
 * Never index this with a raw string — go through `resolveDesignId` so
 * unknown/missing ids fall back to classic (a guest invite must never 500).
 * NOTE: imports `.astro`, so vitest must never import this module — pure logic
 * belongs in `resolve.ts`.
 */
export const registry: Record<DesignId, DesignEntry> = {
  classic: { Document: ClassicDocument },
};
```

- [ ] **Step 7: Render the resolved design in `[slug].astro`**

Replace the frontmatter imports + render of `cire/web/src/pages/[slug].astro` (keep the existing explanatory comments about slug resolution and 404-vs-error):

```astro
---
import { fetchInvite, API_URL } from '../lib/invite'
import NotFoundDocument from '../components/NotFoundDocument.astro'
import { registry } from '../designs/registry'
import { resolveDesignId } from '../designs/resolve'

const { slug } = Astro.params

const result = slug ? await fetchInvite(slug) : ({ kind: 'not-found' } as const)

if (result.kind === 'not-found') {
  Astro.response.status = 404
}

const siteUrl = import.meta.env.PUBLIC_SITE_URL

// Which design pack renders this wedding — resolved server-side off the same
// SSR fetch (zero extra round-trips, no client-side design switch, no flash).
// Unknown/missing ids fall back to classic; an API error renders the classic
// shell with defaults, same as before.
const invite = result.kind === 'ok' ? result.invite : null
const { Document } = registry[resolveDesignId(invite?.designId)]
---
{result.kind === 'not-found' ? (
  <NotFoundDocument />
) : (
  <Document apiUrl={API_URL} slug={slug!} initialInvite={invite} siteUrl={siteUrl} />
)}
```

- [ ] **Step 8: Sweep for stragglers**

Run: `grep -rn "components/InviteDocument\|components/InviteHeader\|components/InvitePage\|components/UnlockReveal\|from \"./InviteHeader\"\|from './InviteHeader'" cire/web/src`
Expected: no hits (check `lib/invite-title.ts`, `components/invite-emptiness.ts`, `pages/index.astro` in particular; repoint any type imports to `../designs/types`).

- [ ] **Step 9: Run tests + build**

Run: `bun run --cwd cire/web test`
Expected: PASS (all moved suites + resolve + invite-images).
Run: `bun run --cwd cire/web build`
Expected: builds clean — this is what catches broken `.astro` imports vitest can't see.

- [ ] **Step 10: Commit**

```bash
git add -A cire/web/src
git commit -m "feat(cire/web): design registry + classic pack; [slug] renders the resolved design"
```

---

### Task 6: Organiser — Design selector section

**Files:**
- Modify: `cire/organiser/src/components/ModuleShell.tsx` (~line 273)
- Modify: `cire/organiser/src/components/InviteBuilder.tsx` (props ~109, local `InviteCustomisation` ~83, new `selectDesign` near `saveInvite` ~336, new fieldset before the "Look" fieldset ~468)
- Test: `cire/organiser/src/components/InviteBuilder.test.tsx`

**Interfaces:**
- Consumes: `DESIGNS`, `DesignMeta` (Task 1); `PUT ${base()}/design` → updated customisation JSON (Task 4); `ModuleShellProps.entitlements: string[]` (exists).
- Produces: `InviteBuilderProps { weddingId: string; entitlements: string[] }`; exported `isDesignLocked(tier: "free" | "premium", entitlements: readonly string[]): boolean`.

- [ ] **Step 1: Write the failing tests**

In `cire/organiser/src/components/InviteBuilder.test.tsx` (Read the harness first: `authFetchMock`, `json()`, `EMPTY_CUSTOMISATION`, `sentBody(suffix)` — mirror existing tests' render + `waitFor` idiom; existing renders gain the new required prop `entitlements={[]}`):

1. Add `designId: "classic"` to the `EMPTY_CUSTOMISATION` fixture.
2. Add:

```tsx
import InviteBuilder, { isDesignLocked } from "./InviteBuilder";

describe("isDesignLocked", () => {
  it("never locks a free design", () => {
    expect(isDesignLocked("free", [])).toBe(false);
  });

  it("locks a premium design without the entitlement", () => {
    expect(isDesignLocked("premium", [])).toBe(true);
    expect(isDesignLocked("premium", ["vendors"])).toBe(true);
  });

  it("unlocks a premium design with premium_templates", () => {
    expect(isDesignLocked("premium", ["premium_templates"])).toBe(false);
  });
});

describe("design selector", () => {
  it("renders a card per catalog design with the active one marked", async () => {
    // GET mock returns EMPTY_CUSTOMISATION (designId "classic").
    // Render <InviteBuilder weddingId="w1" entitlements={[]} />, waitFor load.
    // Expect a radio named "Classic" with aria-checked "true".
  });

  it("clicking the current design does not save", async () => {
    // As above; click the "Classic" card; expect no PUT whose URL ends with "/design".
  });

  it("selecting a different design PUTs and updates the builder", async () => {
    // GET mock returns { ...EMPTY_CUSTOMISATION, designId: "other" } (an id
    // from a newer deploy — Classic is then NOT active). Mock the PUT /design
    // response as json({ ...EMPTY_CUSTOMISATION, designId: "classic" }).
    // Click "Classic"; expect sentBody("/design") to equal { designId: "classic" },
    // and the Classic card to become aria-checked "true".
  });
});
```

Write the three design-selector tests as real code following the file's existing render/query/waitFor patterns (they are sketched here because the harness idiom is the file's; the assertions above are the contract).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd cire/organiser test`
Expected: FAIL — no `isDesignLocked` export, no Design section, and existing renders fail typecheck until the prop lands.

- [ ] **Step 3: Implement**

`cire/organiser/src/components/ModuleShell.tsx` (~line 273):

```tsx
<InviteBuilder weddingId={props.weddingId} entitlements={props.entitlements} />
```

`cire/organiser/src/components/InviteBuilder.tsx`:

1. Import: `import { DESIGNS } from "@shared/invite-designs";` (ensure `For`/`Show`/`createSignal` are in the solid-js import).
2. Local `interface InviteCustomisation` (~83): add final field `designId?: string;`.
3. `interface InviteBuilderProps` (~109):

```ts
interface InviteBuilderProps {
  weddingId: string;
  /** The wedding's entitlement keys — locks premium designs in the selector. */
  entitlements: string[];
}
```

4. Module-level export (near the other helpers):

```ts
/** Whether a catalog design is locked for this wedding (premium without the
 *  `premium_templates` entitlement). The server enforces this regardless —
 *  this only drives the disabled state + lock badge. */
export function isDesignLocked(
  tier: "free" | "premium",
  entitlements: readonly string[],
): boolean {
  return tier === "premium" && !entitlements.includes("premium_templates");
}
```

5. Next to `saveInvite` (~336), a design save that fires immediately on card click (no dirty-tracking — one PUT per selection), mirroring `saveInvite`'s fetch/auth-expiry/toast idiom exactly:

```ts
const [savingDesign, setSavingDesign] = createSignal(false);

const selectDesign = async (designId: string) => {
  if (savingDesign() || data()?.designId === designId) return;
  setSavingDesign(true);
  try {
    const res = await authFetch(`${base()}/design`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ designId }),
    });
    if (!res.ok) throw new Error(`Design save failed (${res.status})`);
    mutate((await res.json()) as InviteCustomisation);
    toast.success("Design updated");
  } catch (err) {
    if (isAuthExpired(err)) {
      redirectToLogin();
      return;
    }
    toast.error("Could not update the design");
  } finally {
    setSavingDesign(false);
  }
};
```

(Use the file's actual helper names — `authFetch`, `isAuthExpired`, `redirectToLogin`, `mutate`, `toast` — as `saveInvite` uses them.)

6. New fieldset as the FIRST section inside the `<Show when={data()}>` content, before the "Look" fieldset (~468), matching its shell + legend classes:

```tsx
<fieldset class="border-border flex flex-col gap-5 rounded-sm border p-4">
  <legend class="font-body text-gold-dim px-2 text-[0.72rem] tracking-[0.1em] uppercase">
    Design
  </legend>
  <div class="flex flex-wrap gap-3" role="radiogroup" aria-label="Invite design">
    <For each={[...DESIGNS]}>
      {(design) => (
        <button
          type="button"
          role="radio"
          aria-checked={(d().designId ?? "classic") === design.id}
          disabled={isDesignLocked(design.tier, props.entitlements) || savingDesign()}
          onClick={() => void selectDesign(design.id)}
          class="border-border flex min-w-[8rem] flex-col items-start gap-1 rounded-sm border px-4 py-3 text-left disabled:cursor-not-allowed disabled:opacity-50"
          classList={{ "border-gold": (d().designId ?? "classic") === design.id }}
        >
          <span class="font-body text-[0.85rem]">{design.name}</span>
          <Show when={isDesignLocked(design.tier, props.entitlements)}>
            <span class="text-gold-dim text-[0.7rem] tracking-[0.08em] uppercase">Locked</span>
          </Show>
          <Show when={(d().designId ?? "classic") === design.id}>
            <span class="text-gold text-[0.7rem] tracking-[0.08em] uppercase">Current</span>
          </Show>
        </button>
      )}
    </For>
  </div>
  <p class="text-gold-dim text-[0.78rem]">
    Saved instantly — open your invite link to preview it live.
  </p>
</fieldset>
```

(`d()` is the `<Show when={data()}>` children accessor already in scope. The inline WYSIWYG preview stays classic-shaped by design — spec §3.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd cire/organiser test`
Expected: PASS — new tests plus every pre-existing InviteBuilder/ModuleShell test.

- [ ] **Step 5: Commit**

```bash
git add cire/organiser/src/components/ModuleShell.tsx cire/organiser/src/components/InviteBuilder.tsx cire/organiser/src/components/InviteBuilder.test.tsx
git commit -m "feat(cire/organiser): invite Design selector with premium lock badges"
```

---

### Task 7: Ship — changesets, wiki, full suite, draft PR

**Files:**
- Create: `.changeset/invite-design-selector.md`
- Create: `.changeset/shared-invite-designs-pkg.md`
- Create: `cire/wiki/systems/invite-designs.md`
- Modify: `cire/wiki/todo/web.md`, `cire/wiki/todo/api.md`, `cire/wiki/todo/db.md` (completed entries + `last-reviewed: 2026-07-22`)

- [ ] **Step 1: Changesets (two files — never mix version-less `@cire/*` with versioned `@shared/*`)**

`.changeset/invite-design-selector.md`:

```md
---
"@cire/api": patch
"@cire/db": patch
"@cire/web": patch
"@cire/organiser": patch
---

Invite design selector: `design_id` on the customisation row, `PUT /invite/design` with catalog validation and a (dormant) `premium_templates` entitlement gate, a guest-site design registry with the existing layout as the `classic` pack, and an organiser Design section with lock badges.
```

`.changeset/shared-invite-designs-pkg.md`:

```md
---
"@shared/invite-designs": minor
---

New package: the invite design catalog (ids, display names, free/premium tiers) shared by cire api, web, and organiser.
```

- [ ] **Step 2: Wiki**

`cire/wiki/systems/invite-designs.md` (match sibling pages' frontmatter shape):

```md
---
title: "Invite design selector"
tags: [systems, web, api]
related:
  - "[[index]]"
  - "[[invite-builder]]"
last-reviewed: 2026-07-22
---

# Invite design selector

A wedding's invite renders as one of several full template packs. The design id
lives on `wedding_invite_customisations.design_id` (0045, default `classic`);
the guest `[slug].astro` SSR fetch resolves it — same link, zero extra
round-trips.

## Pieces

- **Catalog** — `@shared/invite-designs`: `DESIGNS` (`{ id, name, tier }`),
  `DesignId` union, `isDesignId`, `DEFAULT_DESIGN_ID`. Single source of truth
  for api validation, the organiser selector, and the web registry keys.
- **API** — both invite GETs surface `designId`;
  `PUT /api/organiser/weddings/:weddingId/invite/design` (weddingEditor)
  validates against the catalog (unknown → 422) and gates `premium` tiers on
  the `premium_templates` entitlement (403). `inviteService.setDesign` bumps
  `updatedAt` only — never `imagesUpdatedAt` (WT-P-I1).
- **Web** — `cire/web/src/designs/`: `registry.ts` maps `DesignId` →
  per-design component tree (`classic/` holds the original layout);
  `resolve.ts` (`resolveDesignId`) falls back to classic on unknown ids so a
  guest invite never 500s. Registry imports `.astro`, so vitest tests target
  `resolve.ts` only. Truly shared pieces (LoginSection, RsvpModal,
  DetailsModal, EventCard, PulseAccountLink, invite-theme, invite-images) stay
  in `components/`.
- **Organiser** — Design section in `InviteBuilder`; card per catalog entry,
  lock badge on unentitled premium designs, instant save. The inline WYSIWYG
  preview stays classic-shaped; other designs preview via the live invite link.

## Adding a design

1. Catalog entry in `@shared/invite-designs` (type error in the web registry
   until step 2 lands).
2. New pack folder `cire/web/src/designs/<id>/` + registry entry. Each pack's
   `Document.astro` owns its font preloads and islands, so guests never
   download another design's assets.
3. Tier `premium` → gate already enforced; no api change.

## Testing seams

- `AppOptions.inviteDesigns` / `createInviteOrganiserRoutes` 5th param inject
  a test catalog (the launch catalog is all-free, so premium-gate tests add a
  fixture design).
```

Todo shards: add a ticked entry under the relevant section of each of `web.md`, `api.md`, `db.md` (e.g. `- [x] Invite design selector — registry + classic pack / design routes + entitlement gate / 0045 design_id (2026-07-22, see [[invite-designs]])`) and bump each `last-reviewed` to 2026-07-22. Follow each shard's existing entry style.

- [ ] **Step 3: Full verification (schema changed → full monorepo suite)**

```bash
bun run test
bun run --cwd cire/web build
bun run lint
```

Expected: all green. Fix anything that isn't before shipping.

- [ ] **Step 4: Commit, push, draft PR**

```bash
git add .changeset cire/wiki
git commit -m "chore(cire): changesets + wiki for invite design selector"
git push -u origin feat/invite-design-selector
gh pr create --draft --title "feat(cire): invite design selector (classic pack + premium gate)" --body "..."
```

PR body: summary of the four surfaces, the spec/plan links, note that prod rollout needs `cd cire/api && bunx wrangler d1 migrations apply cire-db` (additive column, default `classic`, zero visual change), and the `*.pages.dev` preview note. End the body with the standard generation footer.
