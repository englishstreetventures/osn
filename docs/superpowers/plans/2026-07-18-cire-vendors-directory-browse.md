# cire Vendors S3 — Directory Browse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let signed-in organisers browse published vendor listings from their wedding dashboard (filter by category / keyword / location), view a listing's detail, and add a listing to their wedding CRM in one action.

**Architecture:** All additive. A new index-only migration (0041) adds a partial unique index for dedup + a `listed` filter index. `directoryService` gains a `browse` query (`live`-only, filters, `inWedding` flag, pagination) and a `getLiveListingById`. Two new route factories (browse read = `weddingMember`, add write = `weddingEditor`) reuse the per-user rate limiter. The organiser Vendors module gains a "Browse" sub-tab rendering a new `DirectoryBrowseView`; "Add to my wedding" reuses `vendorsService.create` with a server-side contact snapshot and 409-on-duplicate.

**Tech Stack:** Elysia on Cloudflare Workers + Effect + Drizzle/D1 (backend, `bun test`); Astro static + SolidJS islands (organiser, vitest + happy-dom). Repo conventions in `cire/CLAUDE.md` (no `console.*`, `Data.TaggedError`, `dbQuery`, sentinel `manualParse`, `runCire`).

## Global Constraints

- **All additive.** No table drops, no column changes; migration `0041` is index-only. Never edit `_journal.json` (hand-numbered migrations; CI applies `--remote` on merge).
- **Lockstep invariant:** migration SQL ↔ `cire/db/src/schema.ts` ↔ `cire/api/src/db/setup.ts` DDL must agree — `ddl-lockstep.test.ts` enforces it. Every schema change touches all three.
- **`listed='live'` only** is ever returned by browse or accepted by add. Draft/other states are invisible to organisers.
- **Tenancy:** every browse read + add write is scoped by `weddingId`; a foreign id is a 404/403, never a cross-tenant touch. The `inWedding` flag's `vendors` join is scoped to `weddingId`.
- **Category keys** come from the server enum `cire/api/src/lib/service-categories.ts` (Effect `CategoryKey = Schema.Literal(...SERVICE_CATEGORIES.map(c=>c.key))`) and its client mirror `cire/organiser/src/lib/service-categories.ts`. Keys: `venue, catering, photography, videography, decor_styling, florals, music_entertainment, celebrant, cake, stationery, hair_makeup, transport, attire, other`.
- **Roles:** browse = `weddingMember` (any role incl. viewer); add = `weddingEditor` (viewer → 403 `read_only_role`). Gate error strings match existing routes.
- **Package versioning:** `@cire/*` are UNVERSIONED → a single EMPTY changeset covers the whole PR. `scripts/validate-changesets.sh` enforces it.
- **No Effect in frontend** (`cire/organiser`): plain `fetch` via `useAuth().authFetch` + `apiUrl` (see `VendorsView.tsx`).

---

### Task 1: Migration 0041 + schema + setup (dedup index + listed index)

**Files:**
- Create: `cire/db/migrations/0041_directory_browse.sql`
- Modify: `cire/db/src/schema.ts` (add two indexes; add `sql` import if absent)
- Modify: `cire/api/src/db/setup.ts` (mirror DDL)
- Test: `cire/db/src/migration-0041.test.ts` (or wherever the ddl-lockstep + migration tests live — mirror the existing `migration-0033.test.ts` / `ddl-lockstep.test.ts` location)

**Interfaces:**
- Produces: a partial unique index `vendors_wedding_directory_uniq` on `vendors(wedding_id, directory_vendor_id) WHERE directory_vendor_id IS NOT NULL`, and `directory_vendors_listed_idx` on `directory_vendors(listed)`.

- [ ] **Step 1: Write the migration** `cire/db/migrations/0041_directory_browse.sql` (mirror the `--> statement-breakpoint` style of `0040_vendors.sql`):

```sql
-- 0041_directory_browse.sql — Vendors S3 directory browse (additive; index-only, no drops).
-- Dedup guard: at most one CRM row per (wedding, directory listing). Manual rows
-- (directory_vendor_id IS NULL) are unaffected — a wedding may hold many.
CREATE UNIQUE INDEX `vendors_wedding_directory_uniq`
  ON `vendors` (`wedding_id`, `directory_vendor_id`)
  WHERE `directory_vendor_id` IS NOT NULL;
--> statement-breakpoint
-- Browse filters directory_vendors on `listed`.
CREATE INDEX `directory_vendors_listed_idx` ON `directory_vendors` (`listed`);
```

- [ ] **Step 2: Add the indexes to `schema.ts`**

In `cire/db/src/schema.ts`, ensure `sql` is imported (`import { sql } from "drizzle-orm";` — add if missing). In the `directoryVendors` table's index array, add the `listed` index:

```ts
// directoryVendors table — index array becomes:
(t) => [
  index("directory_vendors_owner_idx").on(t.ownerOrgId),
  index("directory_vendors_listed_idx").on(t.listed),
],
```

In the `vendors` table's index array, add the partial unique index:

```ts
// vendors table — index array becomes:
(t) => [
  index("vendors_wedding_status_idx").on(t.weddingId, t.status, t.sortOrder),
  uniqueIndex("vendors_wedding_directory_uniq")
    .on(t.weddingId, t.directoryVendorId)
    .where(sql`${t.directoryVendorId} IS NOT NULL`),
],
```

(`uniqueIndex` is already imported in `schema.ts`.)

- [ ] **Step 3: Mirror in `setup.ts`**

In `cire/api/src/db/setup.ts`, after the existing `vendors_wedding_status_idx` line (~line 274) and the `directory_vendors_owner_idx` line (~line 251), add:

```sql
CREATE INDEX IF NOT EXISTS directory_vendors_listed_idx ON directory_vendors(listed);
CREATE UNIQUE INDEX IF NOT EXISTS vendors_wedding_directory_uniq ON vendors(wedding_id, directory_vendor_id) WHERE directory_vendor_id IS NOT NULL;
```

- [ ] **Step 4: Write the test** `migration-0041.test.ts` (mirror the existing migration test harness — use `createDb(":memory:")` from `cire/api/src/db/setup.ts` or the migration runner the sibling tests use):

```ts
import { describe, it, expect } from "bun:test";
import { createDb } from "../../api/src/db/setup"; // adjust path to match sibling migration tests

describe("0041 directory browse indexes", () => {
  it("rejects a second CRM row for the same (wedding, directory listing)", () => {
    const db = createDb(":memory:");
    // seed a wedding + a directory listing, then two vendors linked to it
    // (use the same seeding helpers the sibling migration tests use).
    // First insert with a non-null directory_vendor_id succeeds:
    // second identical (wedding_id, directory_vendor_id) throws UNIQUE.
    // ... insert wedding W, listing DV ...
    // insert vendor 1 (wedding W, directory DV) → ok
    // expect(() => insert vendor 2 (wedding W, directory DV)).toThrow(/UNIQUE/i)
  });

  it("permits multiple manual rows (directory_vendor_id NULL) in one wedding", () => {
    const db = createDb(":memory:");
    // two vendors in wedding W with directory_vendor_id = NULL → both ok
  });
});
```

Fill the seed/insert bodies using the exact helpers the sibling migration tests use (read one first). Keep the two assertions: duplicate non-null → throws `/UNIQUE/i`; two nulls → both succeed.

- [ ] **Step 5: Run migration + lockstep + new test**

Run: `bun run --cwd cire/api test` (the `ddl-lockstep` test must stay green — it compares migrations vs schema.ts vs setup.ts) and the new `migration-0041.test.ts`.
Expected: PASS. If lockstep fails, the three sources disagree — reconcile.

- [ ] **Step 6: Commit**

```bash
git add cire/db/migrations/0041_directory_browse.sql cire/db/src/schema.ts cire/api/src/db/setup.ts cire/db/src/migration-0041.test.ts
git commit -m "feat(cire/db): migration 0041 — vendors dedup index + directory_vendors listed index"
```

---

### Task 2: `directoryService.browse` + `getLiveListingById`

**Files:**
- Modify: `cire/api/src/services/directory.ts` (add `BrowseListingDto`, `BrowseFilter`, `escapeLike`, `browse`, `getLiveListingById`)
- Test: `cire/api/src/services/directory.test.ts` (add a `browse` + `getLiveListingById` describe block — mirror the existing directory service tests' seeding)

**Interfaces:**
- Consumes: `directoryVendors`, `directoryVendorCategories`, `vendors` from `@cire/db`; `DbService`, `dbQuery` from `../db`; `and`, `eq`, `asc`, `inArray`, `sql` from `drizzle-orm`.
- Produces:
  - `interface BrowseListingDto { id: string; name: string; description: string | null; categories: string[]; locationText: string | null; priceBand: string | null; priceMinMinor: number | null; priceMaxMinor: number | null; website: string | null; instagram: string | null; email: string | null; phone: string | null; inWedding: boolean }`
  - `interface BrowseFilter { category?: string | null; q?: string | null; location?: string | null; limit: number; offset: number }`
  - `browse(weddingId: string, filter: BrowseFilter): Effect<{ listings: BrowseListingDto[]; total: number }, never, DbService>`
  - `getLiveListingById(id: string): Effect<ListingDto | null, never, DbService>`
  (both added to the object returned by `createDirectoryService`, so they appear on `directoryService`.)

- [ ] **Step 1: Write the failing tests** (append to `directory.test.ts`; seed with the harness the file already uses — read it first). Cover:

```ts
// Seed helper (mirror the file's existing seeding): a live listing LA in
// categories ["venue","catering"] locationText "Sydney" desc "garden venue";
// a live listing LB in ["photography"] locationText "Melbourne" name "Bloom Photo";
// a DRAFT listing LD in ["venue"]; a wedding W1 and W2.

it("returns only live listings", async () => {
  const { listings, total } = await run(svc.browse("W1", { limit: 24, offset: 0 }));
  const ids = listings.map((l) => l.id);
  expect(ids).toContain("LA"); expect(ids).toContain("LB");
  expect(ids).not.toContain("LD"); // draft excluded
  expect(total).toBe(2);
});

it("filters by category", async () => {
  const { listings } = await run(svc.browse("W1", { category: "photography", limit: 24, offset: 0 }));
  expect(listings.map((l) => l.id)).toEqual(["LB"]);
});

it("filters by keyword across name and description", async () => {
  expect((await run(svc.browse("W1", { q: "garden", limit: 24, offset: 0 }))).listings.map((l) => l.id)).toEqual(["LA"]); // description hit
  expect((await run(svc.browse("W1", { q: "bloom", limit: 24, offset: 0 }))).listings.map((l) => l.id)).toEqual(["LB"]); // name hit, case-insensitive
});

it("filters by location", async () => {
  expect((await run(svc.browse("W1", { location: "sydney", limit: 24, offset: 0 }))).listings.map((l) => l.id)).toEqual(["LA"]);
});

it("paginates with a stable order and reports total", async () => {
  const page1 = await run(svc.browse("W1", { limit: 1, offset: 0 }));
  const page2 = await run(svc.browse("W1", { limit: 1, offset: 1 }));
  expect(page1.total).toBe(2); expect(page2.total).toBe(2);
  expect(page1.listings[0]!.id).not.toBe(page2.listings[0]!.id);
});

it("sets inWedding true only for listings already in THIS wedding's CRM", async () => {
  // add a CRM vendor in W1 linked to LA
  const w1 = await run(svc.browse("W1", { limit: 24, offset: 0 }));
  const w2 = await run(svc.browse("W2", { limit: 24, offset: 0 }));
  expect(w1.listings.find((l) => l.id === "LA")!.inWedding).toBe(true);
  expect(w1.listings.find((l) => l.id === "LB")!.inWedding).toBe(false);
  expect(w2.listings.find((l) => l.id === "LA")!.inWedding).toBe(false); // scoped to wedding
});

it("getLiveListingById returns a live listing with categories, null for draft/missing", async () => {
  expect((await run(svc.getLiveListingById("LA")))!.categories.sort()).toEqual(["catering", "venue"]);
  expect(await run(svc.getLiveListingById("LD"))).toBeNull(); // draft
  expect(await run(svc.getLiveListingById("nope"))).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --cwd cire/api test src/services/directory.test.ts`
Expected: FAIL — `browse`/`getLiveListingById` undefined.

- [ ] **Step 3: Implement `escapeLike`, `browse`, `getLiveListingById`** in `directory.ts`. Add `asc`, `inArray` to the `drizzle-orm` import (already imports `and`, `eq`, `sql`). Add the DTOs near the other DTOs. Add a module-scope helper:

```ts
/** Escape %, _ and the escape char for a LIKE pattern (used with ESCAPE '\'). */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}
```

Add both methods to the returned object in `createDirectoryService`:

```ts
browse(
  weddingId: string,
  filter: BrowseFilter,
): Effect.Effect<{ listings: BrowseListingDto[]; total: number }, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;

    const conds = [eq(directoryVendors.listed, "live")];
    if (filter.q && filter.q.trim() !== "") {
      const t = `%${escapeLike(filter.q.trim())}%`;
      conds.push(
        sql`(lower(${directoryVendors.name}) LIKE lower(${t}) ESCAPE '\\' OR lower(coalesce(${directoryVendors.description}, '')) LIKE lower(${t}) ESCAPE '\\')`,
      );
    }
    if (filter.location && filter.location.trim() !== "") {
      const t = `%${escapeLike(filter.location.trim())}%`;
      conds.push(sql`lower(coalesce(${directoryVendors.locationText}, '')) LIKE lower(${t}) ESCAPE '\\'`);
    }
    if (filter.category) {
      conds.push(
        sql`EXISTS (SELECT 1 FROM ${directoryVendorCategories} dvc WHERE dvc.directory_vendor_id = ${directoryVendors.id} AND dvc.category = ${filter.category})`,
      );
    }
    const whereExpr = and(...conds);

    const [countRow] = yield* dbQuery(() =>
      db.select({ n: sql<number>`count(*)` }).from(directoryVendors).where(whereExpr).all(),
    );
    const total = (countRow as { n: number } | undefined)?.n ?? 0;

    const rows = yield* dbQuery(() =>
      db
        .select({
          id: directoryVendors.id,
          name: directoryVendors.name,
          description: directoryVendors.description,
          locationText: directoryVendors.locationText,
          priceBand: directoryVendors.priceBand,
          priceMinMinor: directoryVendors.priceMinMinor,
          priceMaxMinor: directoryVendors.priceMaxMinor,
          website: directoryVendors.website,
          instagram: directoryVendors.instagram,
          email: directoryVendors.email,
          phone: directoryVendors.phone,
          inWedding: sql<number>`EXISTS (SELECT 1 FROM ${vendors} v WHERE v.wedding_id = ${weddingId} AND v.directory_vendor_id = ${directoryVendors.id})`,
        })
        .from(directoryVendors)
        .where(whereExpr)
        .orderBy(asc(directoryVendors.name), asc(directoryVendors.id))
        .limit(filter.limit)
        .offset(filter.offset)
        .all(),
    );

    const pageRows = rows as {
      id: string; name: string; description: string | null; locationText: string | null;
      priceBand: string | null; priceMinMinor: number | null; priceMaxMinor: number | null;
      website: string | null; instagram: string | null; email: string | null; phone: string | null;
      inWedding: number;
    }[];

    const ids = pageRows.map((r) => r.id);
    const catRows =
      ids.length === 0
        ? []
        : ((yield* dbQuery(() =>
            db
              .select({ dv: directoryVendorCategories.directoryVendorId, category: directoryVendorCategories.category })
              .from(directoryVendorCategories)
              .where(inArray(directoryVendorCategories.directoryVendorId, ids))
              .all(),
          )) as { dv: string; category: string }[]);
    const catsById = new Map<string, string[]>();
    for (const r of catRows) {
      const arr = catsById.get(r.dv) ?? [];
      arr.push(r.category);
      catsById.set(r.dv, arr);
    }

    const listings: BrowseListingDto[] = pageRows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      categories: catsById.get(r.id) ?? [],
      locationText: r.locationText,
      priceBand: r.priceBand,
      priceMinMinor: r.priceMinMinor,
      priceMaxMinor: r.priceMaxMinor,
      website: r.website,
      instagram: r.instagram,
      email: r.email,
      phone: r.phone,
      inWedding: Boolean(r.inWedding),
    }));

    return { listings, total };
  }).pipe(
    Effect.withSpan("cire.directory.browse"),
    // Fail-soft: a query error yields empty results, never a dashboard-blanking 500.
    Effect.catchAllDefect(() =>
      Effect.gen(function* () {
        yield* Effect.logWarning("cire.directory.browse failed").pipe(
          Effect.annotateLogs({ weddingId }),
        );
        return { listings: [] as BrowseListingDto[], total: 0 };
      }),
    ),
  );
},

getLiveListingById(id: string): Effect.Effect<ListingDto | null, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = yield* dbQuery(() =>
      db
        .select()
        .from(directoryVendors)
        .where(and(eq(directoryVendors.id, id), eq(directoryVendors.listed, "live")))
        .all(),
    );
    if (!row) return null;
    const dvRow = row as DvRow;
    const categories = yield* fetchCategories(dvRow.id);
    return toDto(dvRow, categories);
  }).pipe(Effect.withSpan("cire.directory.getLiveListingById"));
},
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run --cwd cire/api test src/services/directory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cire/api/src/services/directory.ts cire/api/src/services/directory.test.ts
git commit -m "feat(cire/api): directoryService.browse + getLiveListingById"
```

---

### Task 3: Browse route — `GET …/directory` (weddingMember + per-user limiter)

**Files:**
- Create: `cire/api/src/routes/vendor-directory.ts` (`createVendorDirectoryReadRoutes` here; the add factory lands in Task 4 in the same file)
- Modify: `cire/api/src/app.ts` (mount + a `directoryLimiter`)
- Test: `cire/api/src/routes/vendor-directory.test.ts`

**Interfaces:**
- Consumes: `directoryService.browse` (Task 2); `osnAuth`, `weddingMember`, `rateLimitMiddlewareByUser`, `runCire`, `DbService`, `SERVICE_CATEGORIES`.
- Produces: `createVendorDirectoryReadRoutes(db: Db, osnAuthOptions: OsnAuthOptions, limiter: RateLimiterBackend)` → Elysia instance. Route `GET /api/organiser/weddings/:weddingId/directory?category=&q=&location=&limit=&offset=` → `{ listings, total }`.

- [ ] **Step 1: Write the failing test** (`vendor-directory.test.ts`; mirror the app-construction + seeding in `vendors.test.ts`):

```ts
import { describe, it, expect } from "bun:test";
import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
// build an app with a seeded wedding + live listings, an owner/editor/viewer
// OSN token per the vendors.test.ts helpers (osnAuthOptions test verifier).

it("weddingMember can browse; returns live listings + total", async () => {
  // GET /api/organiser/weddings/:w/directory as a viewer → 200 { listings, total }
});
it("category + q + location filters pass through to the service", async () => {
  // GET …/directory?category=venue&q=garden&location=sydney → filtered set
});
it("clamps limit to 1..50 and offset to >=0", async () => {
  // ?limit=999 → at most 50; ?limit=0 → default; ?offset=-5 → 0 (no error)
});
it("401 without a token", async () => { /* no Authorization → 401 */ });
it("404 for a wedding the caller is not a member of", async () => { /* cross-tenant */ });
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --cwd cire/api test src/routes/vendor-directory.test.ts`
Expected: FAIL — factory/route missing.

- [ ] **Step 3: Implement `createVendorDirectoryReadRoutes`** in `vendor-directory.ts`. Mirror `createVendorReadRoutes` (from `routes/vendors.ts`) exactly, adding the limiter after the gate and a small query parser:

```ts
import { Effect } from "effect";
import { Elysia } from "elysia";
import type { RateLimiterBackend } from "@shared/rate-limit";

import { DbService } from "../db";
import type { Db } from "../db";
import { SERVICE_CATEGORIES } from "../lib/service-categories";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingMember } from "../middleware/wedding-member";
import { runCire } from "../observability";
import { directoryService } from "../services/directory";

// NOTE: Task 4 adds the `weddingEditor` import + `Schema` (effect) +
// `AddFromDirectoryBody` / `vendorsService` imports when it adds the write
// factory to this same file. Do NOT add them in Task 3 — an unused import
// fails the lint gate on Task 3's commit.

const CATEGORY_KEYS = new Set(SERVICE_CATEGORIES.map((c) => c.key));

function clampInt(raw: unknown, def: number, min: number, max: number): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function internalSync(set: { status?: number | string }) {
  set.status = 500;
  return { error: "Internal error" };
}

const internal = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 500;
    return { error: "Internal error" };
  });

export const createVendorDirectoryReadRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingMember(db))
        .use(rateLimitMiddlewareByUser(limiter))
        .get("/directory", async ({ weddingId, query, set }) => {
          if (!weddingId) return internalSync(set);
          const q = query as Record<string, string | undefined>;
          const category = q.category && CATEGORY_KEYS.has(q.category) ? q.category : null;
          return runCire(
            directoryService
              .browse(weddingId, {
                category,
                q: q.q ?? null,
                location: q.location ?? null,
                limit: clampInt(q.limit, 24, 1, 50),
                offset: clampInt(q.offset, 0, 0, 1_000_000),
              })
              .pipe(
                Effect.provideService(DbService, db),
                Effect.catchAllDefect(() => internal(set)),
              ),
          );
        }),
    );
```

- [ ] **Step 4: Mount in `app.ts`.** Add a per-user limiter default near the other `createRateLimiter` defaults (~line 90):

```ts
const defaultDirectoryLimiter = createRateLimiter({ maxRequests: 60, windowMs: 60_000 });
```

Add `directoryLimiter?: RateLimiterBackend;` to the app options interface, destructure `directoryLimiter = defaultDirectoryLimiter` in `createApp`, import `createVendorDirectoryReadRoutes` from `./routes/vendor-directory`, and add the mount next to the other vendor routes (~line 390):

```ts
.use(createVendorDirectoryReadRoutes(db, osnAuthOptions, directoryLimiter))
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run --cwd cire/api test src/routes/vendor-directory.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cire/api/src/routes/vendor-directory.ts cire/api/src/routes/vendor-directory.test.ts cire/api/src/app.ts
git commit -m "feat(cire/api): GET directory browse route (weddingMember + per-user limiter)"
```

---

### Task 4: Add-from-directory — `POST …/directory/:id/add` (weddingEditor)

**Files:**
- Modify: `cire/api/src/services/vendors.ts` (add `existsForDirectory`)
- Modify: `cire/api/src/schemas/vendors.ts` (add `AddFromDirectoryBody`)
- Modify: `cire/api/src/routes/vendor-directory.ts` (add `createVendorDirectoryWriteRoutes`)
- Modify: `cire/api/src/app.ts` (mount)
- Test: `cire/api/src/routes/vendor-directory.test.ts` (add write cases); `cire/api/src/services/vendors.test.ts` (add `existsForDirectory`)

**Interfaces:**
- Consumes: `directoryService.getLiveListingById` (Task 2); `vendorsService.create` + new `existsForDirectory`.
- Produces:
  - `vendorsService.existsForDirectory(weddingId: string, directoryVendorId: string): Effect<boolean, never, DbService>`
  - `AddFromDirectoryBody = Schema.Struct({ category: CategoryKey })`
  - `createVendorDirectoryWriteRoutes(db, osnAuthOptions, limiter)` → route `POST /api/organiser/weddings/:weddingId/directory/:directoryVendorId/add` body `{ category }` → 201 `{ vendor }` | 400 `invalid_category` | 404 `listing_not_found` | 409 `already_in_wedding` | 403 (viewer).

- [ ] **Step 1: Write the failing tests.** In `vendors.test.ts` add:

```ts
it("existsForDirectory is true only when a CRM row links that listing in that wedding", async () => {
  // create a vendor in W1 with directoryVendorId "DV1"
  expect(await run(vendorsService.existsForDirectory("W1", "DV1"))).toBe(true);
  expect(await run(vendorsService.existsForDirectory("W1", "DVX"))).toBe(false);
  expect(await run(vendorsService.existsForDirectory("W2", "DV1"))).toBe(false);
});
```

In `vendor-directory.test.ts` add:

```ts
it("editor adds a live listing to the CRM, snapshotting contact + chosen category", async () => {
  // POST …/directory/LA/add { category: "venue" } as editor → 201 { vendor }
  // vendor.directoryVendorId === "LA"; vendor.name === listing name;
  // vendor.email === listing email; vendor.category === "venue"; status "researching"
});
it("rejects a category not on the listing (400 invalid_category)", async () => {
  // LA categories are venue+catering; POST { category: "photography" } → 400
});
it("404 listing_not_found for a missing or draft listing", async () => {
  // POST …/directory/LD/add (draft) → 404; …/directory/nope/add → 404
});
it("409 already_in_wedding on a duplicate add", async () => {
  // add LA once (201), add LA again → 409
});
it("viewer gets 403 read_only_role", async () => {
  // POST as viewer → 403
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run --cwd cire/api test src/routes/vendor-directory.test.ts src/services/vendors.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `existsForDirectory` to `vendorsService`** (in `services/vendors.ts`, add to the exported object; `and`, `eq` already imported):

```ts
existsForDirectory(
  weddingId: string,
  directoryVendorId: string,
): Effect.Effect<boolean, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = yield* dbQuery(() =>
      db
        .select({ id: vendors.id })
        .from(vendors)
        .where(and(eq(vendors.weddingId, weddingId), eq(vendors.directoryVendorId, directoryVendorId)))
        .all(),
    );
    return Boolean(row);
  }).pipe(Effect.withSpan("cire.vendors.existsForDirectory"));
},
```

- [ ] **Step 4: Add the body schema** to `schemas/vendors.ts` (reuses the existing `CategoryKey`):

```ts
/** Organiser adds a directory listing to their wedding CRM under one category. */
export const AddFromDirectoryBody = Schema.Struct({
  category: CategoryKey,
});
```

- [ ] **Step 5: Implement `createVendorDirectoryWriteRoutes`** in `vendor-directory.ts`. Mirror `createVendorWriteRoutes` (weddingEditor guard + manualParse). Add the imports (`Schema` from effect, `AddFromDirectoryBody`, `vendorsService`, `directoryService`) and these helpers + factory:

```ts
const manualParse = { parse: () => ({}) };

const badRequest = (set: { status?: number | string }, code = "invalid_category") =>
  Effect.sync(() => {
    set.status = 400;
    return { error: code };
  });
const notFound = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "listing_not_found" };
  });
const conflict = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 409;
    return { error: "already_in_wedding" };
  });

/** UNIQUE-constraint backstop for a double-click race (bun:sqlite + D1 both
 *  carry "UNIQUE constraint" in the message). The pre-check handles the common
 *  case; this maps the rare concurrent collision to 409 instead of 500. */
function isUniqueViolation(defect: unknown): boolean {
  return String((defect as { message?: unknown })?.message ?? defect)
    .toLowerCase()
    .includes("unique constraint");
}

export const createVendorDirectoryWriteRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.guard((write) =>
        write
          .use(weddingEditor(db))
          .use(rateLimitMiddlewareByUser(limiter))
          .post(
            "/directory/:directoryVendorId/add",
            async ({ weddingId, params, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(AddFromDirectoryBody)(raw);
                  const listing = yield* directoryService.getLiveListingById(params.directoryVendorId);
                  if (!listing) return yield* notFound(set);
                  if (!listing.categories.includes(body.category)) return yield* badRequest(set);
                  const already = yield* vendorsService.existsForDirectory(
                    weddingId,
                    params.directoryVendorId,
                  );
                  if (already) return yield* conflict(set);
                  const vendor = yield* vendorsService.create({
                    weddingId,
                    name: listing.name,
                    category: body.category,
                    status: "researching",
                    contactName: null,
                    email: listing.email,
                    phone: listing.phone,
                    notes: null,
                    quotedMinor: null,
                    directoryVendorId: listing.id,
                  });
                  set.status = 201;
                  return { vendor };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchAllDefect((d) => (isUniqueViolation(d) ? conflict(set) : internal(set))),
                ),
              );
            },
            manualParse,
          ),
      ),
    );
```

Note: this task ADDS to `vendor-directory.ts`'s imports: `Schema` from `effect`; `weddingEditor` from `../middleware/wedding-editor`; `AddFromDirectoryBody` from `../schemas/vendors`; `vendorsService` from `../services/vendors`. (`directoryService`, `rateLimitMiddlewareByUser`, `runCire`, `DbService`, `osnAuth`, the `internal`/`internalSync` helpers already exist in the file from Task 3.)

- [ ] **Step 6: Mount in `app.ts`** next to the read route:

```ts
.use(createVendorDirectoryWriteRoutes(db, osnAuthOptions, directoryLimiter))
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun run --cwd cire/api test src/routes/vendor-directory.test.ts src/services/vendors.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add cire/api/src/services/vendors.ts cire/api/src/schemas/vendors.ts cire/api/src/routes/vendor-directory.ts cire/api/src/app.ts cire/api/src/services/vendors.test.ts cire/api/src/routes/vendor-directory.test.ts
git commit -m "feat(cire/api): POST add-from-directory (snapshot + 409 dedup, weddingEditor)"
```

---

### Task 5: Organiser Vendors "Browse" sub-tab wiring

**Files:**
- Modify: `cire/organiser/src/lib/dashboard-route.ts` (`MODULE_SUBS.vendors`)
- Modify: `cire/organiser/src/components/ModuleShell.tsx` (`MODULE_SUB_TABS.vendors`; render switch)
- Test: `cire/organiser/src/lib/dashboard-route.test.ts` (assert vendors subs) — if the file exists; else add a tiny one.

**Interfaces:**
- Consumes: `DirectoryBrowseView` (Task 6) — imported and rendered; until Task 6 lands, this task imports it, so **do Task 6 first OR stub the import**. To keep tasks independent, this task adds the sub-tab + render switch and imports `DirectoryBrowseView`; the implementer should confirm Task 6's file exists (it's a sibling task) — if executing strictly in order, run Task 6 before Task 5, or create `DirectoryBrowseView.tsx` as a one-line placeholder here and flesh it out in Task 6. **Recommended: execute Task 6 before Task 5.**
- Produces: `#/w/:weddingId/vendors/browse` route; the Vendors module shows two sub-tabs.

- [ ] **Step 1: Change `MODULE_SUBS.vendors`** in `dashboard-route.ts`:

```ts
vendors: ["index", "browse"],
```

- [ ] **Step 2: Add the sub-tab labels** in `ModuleShell.tsx` `MODULE_SUB_TABS`:

```ts
vendors: [
  { id: "index", label: "My vendors" },
  { id: "browse", label: "Browse" },
],
```

- [ ] **Step 3: Split the vendors render block** in `ModuleShell.tsx` to switch on `active()`:

```tsx
{/* ── Vendors: CRM ("My vendors") + directory Browse ──────────── */}
<Show when={props.module === "vendors"}>
  <Show when={active() === "index"}>
    <VendorsView
      weddingId={props.weddingId}
      currency={peekCachedBudget(props.weddingId)?.currency ?? "AUD"}
      canEdit={props.canEdit}
      canManage={props.canManage}
    />
  </Show>
  <Show when={active() === "browse"}>
    <DirectoryBrowseView weddingId={props.weddingId} canEdit={props.canEdit} />
  </Show>
</Show>
```

Add the import at the top of `ModuleShell.tsx`: `import DirectoryBrowseView from "./DirectoryBrowseView";`

- [ ] **Step 4: Test** — if `dashboard-route.test.ts` exists, add:

```ts
it("vendors module exposes index + browse subs", () => {
  expect(MODULE_SUBS.vendors).toEqual(["index", "browse"]);
  expect(isSubOf("vendors", "browse")).toBe(true);
  expect(defaultSub("vendors")).toBe("index");
});
```

Run: `bun run --cwd cire/organiser test:run` (build must resolve the `DirectoryBrowseView` import — Task 6 provides it).

- [ ] **Step 5: Commit**

```bash
git add cire/organiser/src/lib/dashboard-route.ts cire/organiser/src/components/ModuleShell.tsx cire/organiser/src/lib/dashboard-route.test.ts
git commit -m "feat(cire/organiser): Vendors 'Browse' sub-tab wiring"
```

---

### Task 6: `DirectoryBrowseView` component

**Files:**
- Create: `cire/organiser/src/components/DirectoryBrowseView.tsx`
- Test: `cire/organiser/src/components/DirectoryBrowseView.test.tsx`

**Interfaces:**
- Consumes: `useAuth` from `@osn/client/solid`; `apiUrl`, `isAuthExpired`, `redirectToLogin` from `../lib/api`; `SERVICE_CATEGORIES`, `categoryLabel` from `../lib/service-categories`; `invalidateVendors` from `../lib/vendors-store` (to refresh the CRM tab after an add).
- Produces: default-exported `DirectoryBrowseView` with props `{ weddingId: string; canEdit?: boolean }`.
- Response type (mirror the API): `interface BrowseListing { id: string; name: string; description: string | null; categories: string[]; locationText: string | null; priceBand: string | null; priceMinMinor: number | null; priceMaxMinor: number | null; website: string | null; instagram: string | null; email: string | null; phone: string | null; inWedding: boolean }`.

Behaviour:
- On mount + on filter change (debounced ~300ms), `authFetch(apiUrl(\`/api/organiser/weddings/${weddingId}/directory?…\`))` with `category`, `q`, `location`, `limit=24`, `offset`. 401/`AuthExpiredError` → `redirectToLogin()`. Store `{ listings, total }`.
- Filter bar: a category `<select>` (labelled; options from `SERVICE_CATEGORIES` via `categoryLabel`), a keyword `<input>` (labelled), a location `<input>` (labelled), and a "Clear filters" button.
- Results grid: one card per listing — name, category chips (`categoryLabel`), location, price band, a clamped description. Each card: a **View** button (opens the detail modal) and, when `props.canEdit`, an **Add to wedding** button — disabled and labelled **"Added ✓"** when `listing.inWedding`.
- Detail modal (a `<Show>`-gated panel with `role="dialog"`, focus-return, ESC/overlay close): full description, all category chips, location, price band + min/max range, contact (website + instagram as links, email, phone). Add CTA inside too. If the listing has >1 category, the Add action first shows a small category picker (radio over `listing.categories`, labelled by `categoryLabel`) and confirms; if exactly 1, add immediately with that category.
- Add: `POST apiUrl(\`…/directory/${id}/add\`)` body `{ category }`. On 201 or 409 → mark that listing `inWedding: true` locally + `invalidateVendors(weddingId)` (so the CRM tab refetches). On 400/404/500 → inline `role="alert"` error.
- States: loading (`role="status"`), empty ("No vendors match your filters"), directory-empty first-run copy, error (`role="alert"`). Pagination: a **"Load more"** button when `listings.length < total` (increments offset, appends).
- Accessibility (EAA): labelled controls, real `<button>`s, `role="status"`/`role="alert"`/`role="dialog"`, category chips not colour-only, keyboard-operable modal.

- [ ] **Step 1: Write the failing test** (`DirectoryBrowseView.test.tsx`, `// @vitest-environment happy-dom`; mirror `VendorsView.test.tsx`'s `useAuth` mock — `vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }))` with a `vi.fn()` `authFetch` returning `Response`s):

```tsx
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.fn();
vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../lib/vendors-store", () => ({ invalidateVendors: vi.fn() }));

import DirectoryBrowseView from "./DirectoryBrowseView";
import { invalidateVendors } from "../lib/vendors-store";

const listing = (over = {}) => ({
  id: "LA", name: "Acme Venue", description: "garden venue", categories: ["venue", "catering"],
  locationText: "Sydney", priceBand: "$$", priceMinMinor: null, priceMaxMinor: null,
  website: null, instagram: null, email: "a@x.com", phone: null, inWedding: false, ...over,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("DirectoryBrowseView", () => {
  it("renders live listings from the browse endpoint", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 }));
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    await waitFor(() => expect(screen.getByText("Acme Venue")).toBeInTheDocument());
    expect(String(authFetch.mock.calls[0]![0])).toContain("/api/organiser/weddings/w1/directory");
  });

  it("shows 'Added ✓' for a listing already in the wedding", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing({ inWedding: true })], total: 1 }));
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    await waitFor(() => expect(screen.getByText(/added/i)).toBeInTheDocument());
  });

  it("prompts for a category when the listing has several, then POSTs the add", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 })); // browse
    authFetch.mockResolvedValueOnce(json({ vendor: { id: "v1" } }, 201));        // add
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={true} />);
    await waitFor(() => screen.getByText("Acme Venue"));
    fireEvent.click(screen.getAllByRole("button", { name: /add to wedding/i })[0]!);
    // multi-category → pick one, then confirm
    await waitFor(() => screen.getByLabelText(/venue/i));
    fireEvent.click(screen.getByLabelText(/venue/i));
    fireEvent.click(screen.getByRole("button", { name: /confirm|add/i }));
    await waitFor(() => {
      const addCall = authFetch.mock.calls.find((c) => String(c[0]).includes("/directory/LA/add"));
      expect(addCall).toBeTruthy();
      expect(JSON.parse((addCall![1] as RequestInit).body as string)).toEqual({ category: "venue" });
    });
    expect(invalidateVendors).toHaveBeenCalledWith("w1");
  });

  it("hides the Add control for viewers (canEdit false)", async () => {
    authFetch.mockResolvedValueOnce(json({ listings: [listing()], total: 1 }));
    render(() => <DirectoryBrowseView weddingId="w1" canEdit={false} />);
    await waitFor(() => screen.getByText("Acme Venue"));
    expect(screen.queryByRole("button", { name: /add to wedding/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --cwd cire/organiser test:run src/components/DirectoryBrowseView.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement `DirectoryBrowseView.tsx`** per the Behaviour spec above, mirroring `VendorsView.tsx` idioms (useAuth, apiUrl, error signal, `createResource`/signals, `SERVICE_CATEGORIES`/`categoryLabel`, `@cire/theme` classes, `role` attributes). Debounce filters. Single-category add skips the picker. Add success/409 → set the listing `inWedding` + call `invalidateVendors(props.weddingId)`. Keep money display in major units if you show price min/max (`priceMinMinor/100`).

- [ ] **Step 4: Run the test + build**

Run: `bun run --cwd cire/organiser test:run src/components/DirectoryBrowseView.test.tsx && bun run --cwd cire/organiser build`
Expected: test PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add cire/organiser/src/components/DirectoryBrowseView.tsx cire/organiser/src/components/DirectoryBrowseView.test.tsx
git commit -m "feat(cire/organiser): DirectoryBrowseView (filter, cards, detail, add-to-wedding)"
```

> **Execution note:** run Task 6 before Task 5 so `ModuleShell`'s import of `DirectoryBrowseView` resolves at build time.

---

### Task 7: Docs + changeset

**Files:**
- Modify: `cire/wiki/systems/vendors.md` (Browse section)
- Modify: `wiki/compliance/data-map.md` (new-surface note)
- Modify: `cire/wiki/todo/platform.md` (S3 check-off) + `cire/wiki/todo/security.md` (VP-C-M3 note)
- Create: `.changeset/vendors-directory-browse.md` (empty)

**Interfaces:** none.

- [ ] **Step 1: `cire/wiki/systems/vendors.md`** — add a "Directory browse (organiser, S3)" section: the Browse sub-tab, `GET …/directory` (weddingMember, live-only, category/keyword/location filters, `inWedding` flag, pagination) + `POST …/directory/:id/add` (weddingEditor, snapshot + 409 dedup via the `vendors_wedding_directory_uniq` partial unique index), and that contact details are displayed to the wedding's authenticated organisers. Bump `last-reviewed`.

- [ ] **Step 2: `wiki/compliance/data-map.md`** — add a one-line note under the vendors rows that `directory_vendors.email`/`phone` are now **displayed to a wedding's authenticated organisers** via the S3 directory browse (new recipient/surface; no new data collected, basis unchanged Art. 6(1)(f)).

- [ ] **Step 3: `cire/wiki/todo/platform.md`** — check off the S3 directory-browse item (add a `- [x] **Vendors S3 (directory browse) SHIPPED …**` line under Phase 2). In `cire/wiki/todo/security.md`, append to the `VP-C-M3` note that S3 shipped organiser-only (access-controlled, no on-platform contracting) so DSA Art. 30 still does not bite; the gate is revisited on public browse / enquiries. Bump `last-reviewed` on touched shards.

- [ ] **Step 4: Empty changeset** `.changeset/vendors-directory-browse.md`:

```md
---
---

cire Vendors S3: organiser directory browse — browse published listings (category/keyword/location filters, inWedding flag, pagination) and add a listing to the wedding CRM (snapshot + dedup). Migration 0041 (index-only). No cire package version bump (unversioned).
```

- [ ] **Step 5: Validate + commit**

Run: `bash scripts/validate-changesets.sh` (must pass).

```bash
git add cire/wiki/systems/vendors.md wiki/compliance/data-map.md cire/wiki/todo/platform.md cire/wiki/todo/security.md .changeset/vendors-directory-browse.md
git commit -m "docs(cire): Vendors S3 directory-browse docs + changeset"
```

---

## Testing Summary

- **directoryService.browse** — live-only, category/keyword/location filters, combined, pagination + total, `inWedding` true/false + wedding-scoping, fail-soft; **getLiveListingById** — live vs draft/missing.
- **vendorsService.existsForDirectory** — true/false + wedding-scoping.
- **routes** — `GET /directory` weddingMember (viewer 200, 401 no token, cross-tenant 404, filter passthrough, limit/offset clamp); `POST …/add` weddingEditor (201 snapshot, 400 invalid_category, 404 listing_not_found/draft, 409 duplicate, viewer 403).
- **migration 0041** — applies; ddl-lockstep green; partial unique rejects duplicate, permits multiple NULLs.
- **DirectoryBrowseView** — renders listings, `inWedding`→"Added", multi-category add prompts + POSTs + invalidates CRM store, viewer sees no Add.

Then `/prep-pr` (perf + security/EAA reviews + structured PR body) as the pre-merge gate.

## Post-plan: authorized-at-merge step

Migration `0041` is an **additive index-only prod DB change** applied by CI (`wrangler d1 migrations apply --remote`) on merge — authorized at merge time. No new secrets, subdomain, or allowlist entries.
