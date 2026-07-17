# cire Vendors Slice 1 — PR A (Foundation + CRM + Claim Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Patterns reference:** `docs/superpowers/plans/_vendors-patterns-ref.md` holds verbatim excerpts (with file:line) of every existing pattern this plan mirrors — the additive-migration/DDL-lockstep trio, the budget service/schema/route trio, the osn-bridge ARC pattern, the `@shared/email` surface, and the organiser store/view/sidebar pattern. **Each implementer must read the referenced section before writing code** — it carries the exact current signatures.

**Goal:** Ship the vendor identity/schema foundation, a wedding-scoped organiser Vendor CRM, and the vendor-facing claim/listing backend — everything except the `vendor.cireweddings.com` frontend app (that is PR B).

**Architecture:** Additive cire/db migration (`0040`) creating `directory_vendors` + `directory_vendor_categories` + `vendors` + `vendor_claims`, mirrored across the three DDL surfaces (migration ↔ `setup.ts` ↔ `schema.ts`). Effect services + Elysia route factories mirror the shipped Budget module verbatim (two-factory read/write split, tagged errors, wedding-scoping). A new osn-bridge resolver verifies OSN org membership over ARC (requires adding `org:read` to osn-api's permitted-scopes allowlist — a versioned `@osn/api` change). A fail-soft `@shared/email` wiring emails claim links; the link is always returned to the organiser regardless.

**Tech Stack:** Elysia on Cloudflare Workers (`aot:false`), Effect.ts, Drizzle/D1, `@shared/crypto` (ARC), `@shared/email` (Resend), SolidJS (organiser), bun:test + Vitest, oxlint/oxfmt, changesets.

## Global Constraints

- **Additive migration only** — new tables, no column drops. Next migration number is **`0040`**. Update ALL THREE DDL surfaces in one task: `cire/db/migrations/0040_vendors.sql`, `cire/api/src/db/setup.ts` DDL string, `cire/db/src/schema.ts` Drizzle tables. **Do NOT edit `cire/db/migrations/meta/_journal.json`** — it is intentionally frozen at 0008.
- **The `ddl-lockstep.test.ts` gate must pass** — migration replay == setup.ts DDL == schema.ts table shapes.
- **Effect is backend/DB only** — never import it in `cire/organiser`. Services return `Effect.Effect<A, E>`; tagged errors extend `Data.TaggedError`; routes unwrap with `runCire` + `Effect.provideService(DbService, db)` + `Effect.catchTag` per error + `Effect.catchAllDefect` → 500.
- **Elysia route pattern:** POST/PUT bodies use the sentinel `manualParse = { parse: () => ({}) }`, hand-parse `await request.json().catch(() => null)`, decode with `Schema.decodeUnknown`. Register literal sub-paths (e.g. `/vendors/reorder`) BEFORE param paths (`/vendors/:vendorId`).
- **cire role gates:** `weddingMember()` reads, `weddingEditor()` writes, `weddingOwner()` owner-only. For `/api/vendor/*`, `osnAuth()` extracts `profileId`; the new `vendorOrgMember(orgId)` check verifies membership.
- **Categories:** keys from `cire/api/src/lib/service-categories.ts` (`SERVICE_CATEGORY_KEYS`, 14 keys, `other` last). `directory_vendors` is **multi-category** (join table); `vendors` CRM rows are **single-category**.
- **Money:** minor units, integer columns. Timestamps: `integer(mode:"timestamp")`.
- **Changesets:** `@cire/*` are unversioned/ignored → **empty** changeset (frontmatter `---\n---`, no package lines). `@osn/api` is versioned → **separate** `"@osn/api": patch` changeset. NEVER mix them in one file (`scripts/validate-changesets.sh` enforces).
- **Claim tokens:** random, SHA-256 hashed at rest, single-use (`consumed_at`), 7-day TTL. Never store/log the plaintext token except in the returned link + optional email.
- **Fail-soft:** an osn-api/ARC outage degrades org-gated listing writes to 503 (never crash); a missing email transport surfaces the link to the organiser instead of erroring; every write is wedding- or org-scoped so a foreign id is 404/no-op (never a cross-tenant leak).
- **Prod steps (flagged, NOT automated):** (a) the osn-api `org:read` scope-allowlist change deploys with the `@osn/api` bump; (b) after deploy, cire-api's service account must be **re-registered per env** with `allowedScopes:"graph:read,graph:resolve-account,org:read"` via the runbook §6.2 curl — a manual authorized prod step.

---

## PR A file map

| File | Responsibility |
|---|---|
| `cire/db/migrations/0040_vendors.sql` (create) | additive DDL — 4 tables + indexes |
| `cire/db/src/schema.ts` (modify) | Drizzle tables mirroring the migration |
| `cire/api/src/db/setup.ts` (modify) | hand-written DDL mirror (lockstep) |
| `cire/api/src/schemas/vendors.ts` (create) | Effect Schema request bodies |
| `cire/api/src/services/vendors.ts` (create) | wedding-scoped CRM service |
| `cire/api/src/services/directory.ts` (create) | listing + claim service (categories, seed, claim token) |
| `cire/api/src/services/osn-bridge.ts` (modify) | add `listProfileOrgs` + `orgMembership` ARC resolvers |
| `cire/api/src/lib/vendor-email.ts` (create) | fail-soft claim-link email via `@shared/email` |
| `cire/api/src/middleware/vendor-org-member.ts` (create) | `vendorOrgMember(orgId)` gate |
| `cire/api/src/routes/vendors.ts` (create) | `/api/organiser/weddings/:weddingId/vendors` factories |
| `cire/api/src/routes/vendor-portal.ts` (create) | `/api/vendor/*` listing + claim routes |
| `cire/api/src/app.ts` (modify) | mount both route groups |
| `osn/api/src/routes/graph-internal.ts` (modify) | add `org:read` to `PERMITTED_SCOPES` |
| `osn/api/src/app.ts` (verify/modify) | ensure `createInternalOrganisationRoutes` is mounted |
| `cire/organiser/src/lib/vendors-store.ts` (create) | weddingId-keyed CRM cache + fetch-lift |
| `cire/organiser/src/components/VendorsView.tsx` (create) | CRM module UI |
| `cire/organiser/src/lib/dashboard-route.ts` (modify) | add `vendors` module + sub |
| `cire/organiser/src/components/ModuleSidebar.tsx` (modify) | add Vendors nav entry |
| `cire/organiser/src/components/ModuleShell.tsx` (modify) | render `<VendorsView>` |
| `cire/organiser/src/components/Overview.tsx` (modify) | live vendor count widget |
| docs + changesets | wiki system page, cire-auth update, data-map/retention, runbook §6.2, TODO, changesets |

---

### Task 1: Migration + schema + DDL (the three lockstep surfaces)

**Files:**
- Create: `cire/db/migrations/0040_vendors.sql`
- Modify: `cire/db/src/schema.ts` (append tables; mirror the budget tables' style — patterns-ref **A2**)
- Modify: `cire/api/src/db/setup.ts` (append DDL strings; mirror **A3**)
- Test: `cire/api/src/db/ddl-lockstep.test.ts` already exists — it must pass unchanged (patterns-ref **A4**).

**Interfaces produced (Drizzle table names + columns later tasks import):**
- `directoryVendors` (`directory_vendors`): `id` text PK, `ownerOrgId` text nullable, `name` text NN, `description` text, `email` text, `phone` text, `website` text, `instagram` text, `locationText` text, `priceBand` text, `priceMinMinor` int, `priceMaxMinor` int, `listed` text NN default `'draft'`, `createdAt`/`updatedAt` timestamp NN.
- `directoryVendorCategories` (`directory_vendor_categories`): `directoryVendorId` text NN, `category` text NN — composite PK `(directoryVendorId, category)`.
- `vendors` (`vendors`): `id` text PK, `weddingId` text NN FK→weddings CASCADE, `directoryVendorId` text nullable, `name` text NN, `category` text NN, `status` text NN default `'researching'`, `contactName` text, `email` text, `phone` text, `notes` text, `quotedMinor` int, `sortOrder` int NN default 0, `createdAt`/`updatedAt` timestamp NN.
- `vendorClaims` (`vendor_claims`): `id` text PK, `directoryVendorId` text NN FK→directory_vendors CASCADE, `tokenHash` text NN UNIQUE, `email` text NN, `createdAt` timestamp NN, `expiresAt` timestamp NN, `consumedAt` timestamp nullable.

- [ ] **Step 1: Read the patterns** — read patterns-ref sections **A1** (0039 migration), **A2** (schema.ts budget tables), **A3** (setup.ts DDL), **A4** (lockstep test). Note the exact `sqliteTable`, `text()`, `integer(… {mode:"timestamp"})`, `primaryKey`, index, and FK-with-`onDelete:"cascade"` idioms.

- [ ] **Step 2: Write the migration** — create `cire/db/migrations/0040_vendors.sql`:

```sql
-- 0040_vendors.sql — Vendors Slice 1 foundation (additive; no drops).
-- directory_vendors: the global business listing (one per OSN org).
CREATE TABLE directory_vendors (
  id TEXT PRIMARY KEY NOT NULL,
  owner_org_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  instagram TEXT,
  location_text TEXT,
  price_band TEXT,
  price_min_minor INTEGER,
  price_max_minor INTEGER,
  listed TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX directory_vendors_owner_idx ON directory_vendors (owner_org_id);

-- directory_vendor_categories: many service categories per listing.
CREATE TABLE directory_vendor_categories (
  directory_vendor_id TEXT NOT NULL REFERENCES directory_vendors(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  PRIMARY KEY (directory_vendor_id, category)
);
CREATE INDEX directory_vendor_categories_category_idx ON directory_vendor_categories (category);

-- vendors: the wedding-scoped CRM row (organiser-private).
CREATE TABLE vendors (
  id TEXT PRIMARY KEY NOT NULL,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  directory_vendor_id TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'researching',
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  notes TEXT,
  quoted_minor INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX vendors_wedding_status_idx ON vendors (wedding_id, status, sort_order);

-- vendor_claims: email-verification claim tokens (SHA-256 hashed, single-use, TTL).
CREATE TABLE vendor_claims (
  id TEXT PRIMARY KEY NOT NULL,
  directory_vendor_id TEXT NOT NULL REFERENCES directory_vendors(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX vendor_claims_vendor_idx ON vendor_claims (directory_vendor_id);
```

- [ ] **Step 3: Mirror in `schema.ts`** — append Drizzle tables to `cire/db/src/schema.ts` matching **A2**'s idiom exactly. Example for the first table (do all four + the two indexes that back queries):

```ts
export const directoryVendors = sqliteTable(
  "directory_vendors",
  {
    id: text("id").primaryKey(),
    ownerOrgId: text("owner_org_id"),
    name: text("name").notNull(),
    description: text("description"),
    email: text("email"),
    phone: text("phone"),
    website: text("website"),
    instagram: text("instagram"),
    locationText: text("location_text"),
    priceBand: text("price_band"),
    priceMinMinor: integer("price_min_minor"),
    priceMaxMinor: integer("price_max_minor"),
    listed: text("listed").notNull().default("draft"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("directory_vendors_owner_idx").on(t.ownerOrgId)],
);

export const directoryVendorCategories = sqliteTable(
  "directory_vendor_categories",
  {
    directoryVendorId: text("directory_vendor_id")
      .notNull()
      .references(() => directoryVendors.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.directoryVendorId, t.category] }),
    index("directory_vendor_categories_category_idx").on(t.category),
  ],
);

export const vendors = sqliteTable(
  "vendors",
  {
    id: text("id").primaryKey(),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    directoryVendorId: text("directory_vendor_id"),
    name: text("name").notNull(),
    category: text("category").notNull(),
    status: text("status").notNull().default("researching"),
    contactName: text("contact_name"),
    email: text("email"),
    phone: text("phone"),
    notes: text("notes"),
    quotedMinor: integer("quoted_minor"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("vendors_wedding_status_idx").on(t.weddingId, t.status, t.sortOrder)],
);

export const vendorClaims = sqliteTable(
  "vendor_claims",
  {
    id: text("id").primaryKey(),
    directoryVendorId: text("directory_vendor_id")
      .notNull()
      .references(() => directoryVendors.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp" }),
  },
  (t) => [index("vendor_claims_vendor_idx").on(t.directoryVendorId)],
);
```

(Confirm `index` and `primaryKey` are imported in `schema.ts`; add to the drizzle-orm/sqlite-core import if missing — check per **A2**.)

- [ ] **Step 4: Mirror in `setup.ts`** — append the same `CREATE TABLE`/`CREATE INDEX` strings to the DDL block in `cire/api/src/db/setup.ts` (byte-for-byte the SQL from Step 2), at the append point shown in **A3**.

- [ ] **Step 5: Run the lockstep + schema tests**

Run: `bun run --cwd cire/api test ddl-lockstep`
Expected: PASS (migration replay == setup.ts DDL == schema.ts).
Run: `bun run --cwd cire/db test:run` (if a schema test exists)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cire/db/migrations/0040_vendors.sql cire/db/src/schema.ts cire/api/src/db/setup.ts
git commit -m "feat(cire/db): vendors foundation tables (migration 0040)"
```

---

### Task 2: Effect request schemas (`cire/api/src/schemas/vendors.ts`)

**Files:**
- Create: `cire/api/src/schemas/vendors.ts`
- Test: `cire/api/src/schemas/vendors.test.ts`

**Interfaces produced:** `CreateVendorBody`, `UpdateVendorBody`, `ReorderVendorsBody`, `SeedListingBody`, `UpsertListingBody`, `ConsumeClaimBody` — Effect Schemas. `VENDOR_STATUSES` = `["researching","contacted","quoted","booked","declined"]`. Category literal derived from `SERVICE_CATEGORY_KEYS`.

- [ ] **Step 1: Read the pattern** — patterns-ref **B7** (`schemas/budget.ts`): how `Schema.Literal(...keys)` is derived from `SERVICE_CATEGORIES`, how `Minor`/bounds are built, how optional/nullable fields are expressed.

- [ ] **Step 2: Write the failing test** — `cire/api/src/schemas/vendors.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { Schema } from "effect";

import {
  ConsumeClaimBody,
  CreateVendorBody,
  ReorderVendorsBody,
  SeedListingBody,
  UpsertListingBody,
  VENDOR_STATUSES,
} from "./vendors";

const dec = <A>(s: Schema.Schema<A>, v: unknown) => Schema.decodeUnknownEither(s)(v);

describe("vendor schemas", () => {
  it("accepts a valid CRM vendor and rejects a bad category/status", () => {
    expect(dec(CreateVendorBody, { name: "Bloom", category: "florals", status: "researching" })._tag).toBe("Right");
    expect(dec(CreateVendorBody, { name: "Bloom", category: "not_a_cat", status: "researching" })._tag).toBe("Left");
    expect(dec(CreateVendorBody, { name: "Bloom", category: "florals", status: "nope" })._tag).toBe("Left");
    expect(dec(CreateVendorBody, { name: "", category: "florals", status: "researching" })._tag).toBe("Left");
  });

  it("SeedListingBody requires an email and >=1 category", () => {
    expect(dec(SeedListingBody, { name: "Bloom", email: "a@b.co", categories: ["florals"] })._tag).toBe("Right");
    expect(dec(SeedListingBody, { name: "Bloom", email: "a@b.co", categories: [] })._tag).toBe("Left");
    expect(dec(SeedListingBody, { name: "Bloom", categories: ["florals"] })._tag).toBe("Left");
  });

  it("UpsertListingBody accepts multi-category + optional price band", () => {
    expect(
      dec(UpsertListingBody, { name: "Bloom", categories: ["florals", "decor_styling"], priceBand: "$$" })._tag,
    ).toBe("Right");
    expect(dec(UpsertListingBody, { name: "Bloom", categories: ["bad"] })._tag).toBe("Left");
  });

  it("ReorderVendorsBody requires a status + id list", () => {
    expect(dec(ReorderVendorsBody, { status: "booked", orderedIds: ["ven_1"] })._tag).toBe("Right");
    expect(dec(ReorderVendorsBody, { status: "bad", orderedIds: [] })._tag).toBe("Left");
  });

  it("ConsumeClaimBody requires an orgId", () => {
    expect(dec(ConsumeClaimBody, { orgId: "org_1" })._tag).toBe("Right");
    expect(dec(ConsumeClaimBody, {})._tag).toBe("Left");
  });

  it("exposes the five statuses in order", () => {
    expect(VENDOR_STATUSES).toEqual(["researching", "contacted", "quoted", "booked", "declined"]);
  });
});
```

- [ ] **Step 3: Run it — FAIL** (`Cannot find module './vendors'`). `bun run --cwd cire/api test schemas/vendors`

- [ ] **Step 4: Implement** — `cire/api/src/schemas/vendors.ts`:

```ts
import { Schema } from "effect";

import { SERVICE_CATEGORIES } from "../lib/service-categories";

/** Vendor CRM lifecycle statuses, display order. */
export const VENDOR_STATUSES = [
  "researching",
  "contacted",
  "quoted",
  "booked",
  "declined",
] as const;

const CategoryKey = Schema.Literal(...SERVICE_CATEGORIES.map((c) => c.key));
const Status = Schema.Literal(...VENDOR_STATUSES);
const NonEmpty = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200));
const OptText = Schema.optional(Schema.Union(Schema.String.pipe(Schema.maxLength(2000)), Schema.Null));
const Email = Schema.String.pipe(Schema.minLength(3), Schema.maxLength(200));
const Minor = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(9_000_000_000_000));
const OptMinor = Schema.optional(Schema.Union(Minor, Schema.Null));
const PriceBand = Schema.optional(Schema.Union(Schema.Literal("$", "$$", "$$$", "$$$$"), Schema.Null));

// --- Organiser CRM ---
export const CreateVendorBody = Schema.Struct({
  name: NonEmpty,
  category: CategoryKey,
  status: Schema.optional(Status),
  contactName: OptText,
  email: OptText,
  phone: OptText,
  notes: OptText,
  quotedMinor: OptMinor,
});

export const UpdateVendorBody = Schema.Struct({
  name: Schema.optional(NonEmpty),
  category: Schema.optional(CategoryKey),
  status: Schema.optional(Status),
  contactName: OptText,
  email: OptText,
  phone: OptText,
  notes: OptText,
  quotedMinor: OptMinor,
});

export const ReorderVendorsBody = Schema.Struct({
  status: Status,
  orderedIds: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
});

/** Organiser seeds a directory listing + invites a vendor by email to claim it. */
export const SeedListingBody = Schema.Struct({
  name: NonEmpty,
  email: Email,
  categories: Schema.Array(CategoryKey).pipe(Schema.minItems(1)),
  description: OptText,
  phone: OptText,
  website: OptText,
  instagram: OptText,
  locationText: OptText,
});

/** Vendor create/update of their own listing (one per org). */
export const UpsertListingBody = Schema.Struct({
  name: NonEmpty,
  categories: Schema.Array(CategoryKey).pipe(Schema.minItems(1)),
  description: OptText,
  email: OptText,
  phone: OptText,
  website: OptText,
  instagram: OptText,
  locationText: OptText,
  priceBand: PriceBand,
  priceMinMinor: OptMinor,
  priceMaxMinor: OptMinor,
});

/** Vendor consumes a claim token, binding the listing to their chosen org. */
export const ConsumeClaimBody = Schema.Struct({
  orgId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(50)),
});
```

- [ ] **Step 5: Run it — PASS.** `bun run --cwd cire/api test schemas/vendors`

- [ ] **Step 6: Commit**

```bash
git add cire/api/src/schemas/vendors.ts cire/api/src/schemas/vendors.test.ts
git commit -m "feat(cire/api): vendor request schemas"
```

---

### Task 3: Vendor CRM service (`cire/api/src/services/vendors.ts`)

**Files:**
- Create: `cire/api/src/services/vendors.ts`
- Test: `cire/api/src/services/vendors.test.ts`

**Interfaces produced:** `vendorsService` with `list(weddingId)`, `create(input)`, `update(weddingId, vendorId, patch)`, `remove(weddingId, vendorId)`, `reorder(weddingId, status, orderedIds)`. Tagged error `VendorNotInWedding`. DTO `VendorDto` (ms-epoch numbers, `directoryVendorId` echoed). A `requireVendor(weddingId, vendorId)` helper scoping `and(eq(id), eq(weddingId))`.

- [ ] **Step 1: Read the pattern** — patterns-ref **B6** (`services/budget.ts`): the `Data.TaggedError` classes, `dbQuery`, the `requireItem` helper's `and(eq(...), eq(...))` wedding-scoping, DTO mapping to ms-epoch, `Effect.withSpan`. Mirror this structure exactly — `vendors` is the wedding-scoped table analogous to `budget_items`.

- [ ] **Step 2: Write the failing test** — `cire/api/src/services/vendors.test.ts`. Mirror `services/budget.test.ts` setup (the `db0()` two-wedding seed + `run` helper from patterns-ref context — reuse the SAME harness shape as `tasks.test.ts`/`budget.test.ts`). Cover: create appends to end of status group; list returns wedding's vendors ordered; update patches fields; **update/remove/reorder of another wedding's vendor is rejected/no-op (tenancy)**; reorder sets sort_order by index within a status. Concretely:

```ts
import { describe, expect, it } from "bun:test";
import { BOOTSTRAP_WEDDING_ID, vendors, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import { DbService } from "../db";
import { createDb, seedDb } from "../db/setup";
import { vendorsService, VendorNotInWedding } from "./vendors";

const OTHER = "wed_other";
function db0() {
  const db = createDb(":memory:");
  seedDb(db);
  db.insert(weddings).values({
    id: OTHER, slug: "other", displayName: "Other",
    ownerOsnProfileId: "usr_bob", createdAt: new Date(), updatedAt: new Date(),
  }).run();
  return db;
}
const run = <A, E>(db: ReturnType<typeof createDb>, e: Effect.Effect<A, E, DbService>) =>
  Effect.runPromiseExit(e.pipe(Effect.provideService(DbService, db)));

describe("vendorsService", () => {
  it("creates a vendor appended to its status group and lists it", async () => {
    const db = db0();
    const a = await run(db, vendorsService.create({ weddingId: BOOTSTRAP_WEDDING_ID, name: "Bloom", category: "florals", status: "researching", contactName: null, email: null, phone: null, notes: null, quotedMinor: null }));
    expect(Exit.isSuccess(a)).toBe(true);
    const list = await run(db, vendorsService.list(BOOTSTRAP_WEDDING_ID));
    if (!Exit.isSuccess(list)) throw new Error("list failed");
    expect(list.value.map((v) => v.name)).toEqual(["Bloom"]);
    expect(list.value[0]!.status).toBe("researching");
  });

  it("rejects updating another wedding's vendor (tenancy)", async () => {
    const db = db0();
    const mine = await run(db, vendorsService.create({ weddingId: BOOTSTRAP_WEDDING_ID, name: "Bloom", category: "florals", status: "researching", contactName: null, email: null, phone: null, notes: null, quotedMinor: null }));
    if (!Exit.isSuccess(mine)) throw new Error("create failed");
    const res = await run(db, vendorsService.update(OTHER, mine.value.id, { status: "booked" }));
    expect(Exit.isFailure(res) && res.cause._tag === "Fail" && res.cause.error instanceof VendorNotInWedding).toBe(true);
    // unchanged
    const row = db.select().from(vendors).where(eq(vendors.id, mine.value.id)).get();
    expect(row?.status).toBe("researching");
  });

  it("reorder is wedding-scoped and sets sort_order by index within a status", async () => {
    const db = db0();
    const ids: string[] = [];
    for (const name of ["A", "B", "C"]) {
      const r = await run(db, vendorsService.create({ weddingId: BOOTSTRAP_WEDDING_ID, name, category: "venue", status: "contacted", contactName: null, email: null, phone: null, notes: null, quotedMinor: null }));
      if (!Exit.isSuccess(r)) throw new Error("create failed");
      ids.push(r.value.id);
    }
    await run(db, vendorsService.reorder(BOOTSTRAP_WEDDING_ID, "contacted", [ids[2]!, ids[0]!, ids[1]!]));
    // foreign wedding reorder is a no-op
    await run(db, vendorsService.reorder(OTHER, "contacted", [ids[0]!, ids[1]!, ids[2]!]));
    const list = await run(db, vendorsService.list(BOOTSTRAP_WEDDING_ID));
    if (!Exit.isSuccess(list)) throw new Error("list failed");
    expect(list.value.filter((v) => v.status === "contacted").map((v) => v.name)).toEqual(["C", "A", "B"]);
  });
});
```

- [ ] **Step 3: Run — FAIL.** `bun run --cwd cire/api test services/vendors`

- [ ] **Step 4: Implement** — `cire/api/src/services/vendors.ts`, mirroring `budget.ts` structure. Key requirements (write the full service):
  - `VendorNotInWedding extends Data.TaggedError("VendorNotInWedding")<{}>`.
  - `create`: generate `ven_<random>` id (use the same id generator budget uses — see **B6**), `sort_order` = count of same (wedding, status) rows, `status` default `"researching"`, timestamps `new Date()`. Insert; return `VendorDto`.
  - `list(weddingId)`: select where `eq(weddingId)`, order by `status` then `sortOrder`; map to `VendorDto` (ms-epoch `createdAt`/`updatedAt`).
  - `requireVendor(weddingId, vendorId)`: select `and(eq(vendors.id, vendorId), eq(vendors.weddingId, weddingId))`; if none → `Effect.fail(new VendorNotInWedding())`.
  - `update`: `requireVendor` then `UPDATE … SET <patch>, updated_at where and(id, weddingId)`; return updated DTO.
  - `remove`: `requireVendor` then delete `and(id, weddingId)`.
  - `reorder(weddingId, status, orderedIds)`: in a transaction, for each id+index `UPDATE vendors SET sort_order=index WHERE and(eq(id), eq(weddingId), eq(status, status))` — foreign/wrong-status ids are no-ops (mirror `tasksService.reorder`). No fail.
  - Every method `.pipe(Effect.withSpan("cire.vendors.<op>"))`.
  - `VendorDto`: `{ id, weddingId, directoryVendorId, name, category, status, contactName, email, phone, notes, quotedMinor, sortOrder, createdAt (ms), updatedAt (ms) }`.

- [ ] **Step 5: Run — PASS.** `bun run --cwd cire/api test services/vendors`

- [ ] **Step 6: Commit** `feat(cire/api): wedding-scoped vendor CRM service`

---

### Task 4: Directory + claim service (`cire/api/src/services/directory.ts`)

**Files:**
- Create: `cire/api/src/services/directory.ts`
- Test: `cire/api/src/services/directory.test.ts`

**Interfaces produced:** `directoryService` with:
- `getListingByOrg(orgId): ListingDto | null`
- `upsertListingForOrg(orgId, body): ListingDto` — create-or-update the single listing owned by `orgId` (sets `listed='live'`); replaces its category set.
- `seedFromCrm(weddingId, vendorId, body): { claimToken: string; claimUrl: string; directoryVendorId: string }` — creates a `draft` listing + its categories, links `vendors.directoryVendorId`, mints a claim token (returns the PLAINTEXT token + full URL; stores only the hash). Wedding-scoped (the vendor row must belong to the wedding).
- `getClaimPreview(token): { directoryVendorId; name; email } | null` — validates an unconsumed/unexpired token, returns the listing summary.
- `consumeClaim(token, orgId): ListingDto` — binds `owner_org_id=orgId`, `listed='live'`, stamps `consumed_at`; caller-org-membership is enforced at the ROUTE layer (Task 8), not here.
- Tagged errors: `ListingNotFound`, `ClaimInvalid` (covers unknown/expired/consumed), `VendorNotInWedding` (reuse from Task 3 or re-declare).
- `hashToken(token): string` — SHA-256 hex (reuse cire's existing session-hash util if present — grep `sha256`/`hashSession` in `cire/api/src`; else `crypto.subtle`). Token generation: 32 random bytes → base64url.

- [ ] **Step 1: Read** — patterns-ref **B6** (service structure) again for tagged errors + `dbQuery`, and grep `cire/api/src` for the existing session-token hashing helper to REUSE (`grep -rn "sha256\|createHash\|token_hash\|hashToken" cire/api/src`). Reuse it; do not invent a second hashing routine.

- [ ] **Step 2: Write the failing test** — `cire/api/src/services/directory.test.ts`. Cover:
  - `upsertListingForOrg` creates a live listing with the given category set; a second call updates it (still one row for that org) and replaces categories.
  - `seedFromCrm` creates a `draft` listing, links the CRM row's `directoryVendorId`, and returns a non-empty `claimToken` + a `claimUrl` containing that token; the stored `vendor_claims` row holds a **hash**, not the plaintext.
  - `getClaimPreview` returns the listing for a fresh token, `null` for an unknown token.
  - `consumeClaim` binds `owner_org_id`, flips `listed` to `live`, stamps `consumed_at`; a SECOND `consumeClaim` with the same token fails `ClaimInvalid`.
  - `consumeClaim` with an expired token fails `ClaimInvalid` (seed a row with `expiresAt` in the past).
  - `seedFromCrm` for a vendor id not in the wedding fails `VendorNotInWedding`.

  (Write concrete assertions in the same `db0()`/`run` harness as Task 3. Use `directoryVendors`, `directoryVendorCategories`, `vendorClaims`, `vendors` from `@cire/db`.)

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Implement** — `cire/api/src/services/directory.ts`. Requirements:
  - `hashToken` reuses the found util (or `crypto.subtle.digest("SHA-256", …)` → hex). Token = `base64url(32 random bytes)`.
  - `CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000`.
  - `claimUrl(token)` = `` `${config.vendorPortalOrigin}/claim?token=${token}` `` where `vendorPortalOrigin` comes from config (default `https://vendor.cireweddings.com`; injected so tests pass a stub).
  - `upsertListingForOrg`: find listing by `eq(ownerOrgId, orgId)`; if none insert (`dv_*`, `listed='live'`); else update fields + `updated_at`. Then delete + reinsert `directory_vendor_categories` rows for that listing (replace the set). Return `ListingDto` (includes `categories: string[]`).
  - `seedFromCrm(weddingId, vendorId, body)`: `requireVendor(weddingId, vendorId)` (fail `VendorNotInWedding`); insert `draft` listing (`owner_org_id=null`) + categories; `UPDATE vendors SET directory_vendor_id=<dv> WHERE and(id, weddingId)`; generate token, insert `vendor_claims` (`token_hash=hashToken(token)`, `email=body.email`, `expires_at=now+TTL`); return `{ claimToken: token, claimUrl: claimUrl(token), directoryVendorId }`.
  - `getClaimPreview(token)`: look up `vendor_claims` by `eq(tokenHash, hashToken(token))`; if none / consumed / expired → `null`; else join the listing → `{ directoryVendorId, name, email }`.
  - `consumeClaim(token, orgId)`: look up by hash; fail `ClaimInvalid` if none/consumed/expired; `UPDATE directory_vendors SET owner_org_id=orgId, listed='live', updated_at WHERE id=claim.directoryVendorId`; `UPDATE vendor_claims SET consumed_at=now WHERE id=claim.id`; return the listing `ListingDto`.
  - All methods `Effect.withSpan("cire.directory.<op>")`.
  - `ListingDto`: `{ id, ownerOrgId, name, description, email, phone, website, instagram, locationText, priceBand, priceMinMinor, priceMaxMinor, listed, categories, createdAt(ms), updatedAt(ms) }`.

- [ ] **Step 5: Run — PASS.**

- [ ] **Step 6: Commit** `feat(cire/api): directory listing + email-verification claim service`

---

### Task 5: osn-bridge org resolvers + osn-api `org:read` scope

**Files:**
- Modify: `cire/api/src/services/osn-bridge.ts` (add two resolvers)
- Modify: `cire/api/src/services/osn-bridge.test.ts` (add resolver tests)
- Modify: `osn/api/src/routes/graph-internal.ts` (add `"org:read"` to `PERMITTED_SCOPES`)
- Modify: `osn/api/src/app.ts` (verify/mount `createInternalOrganisationRoutes`)
- Test: `osn/api/src/routes/graph-internal.test.ts` (assert `org:read` is now permitted) — or the existing register-service test.

**Interfaces produced (cire-side):**
- `listProfileOrgs(profileId: string): Effect<string[]>` — GET `/organisations/internal/profile-orgs?profileId=…` with ARC scope `org:read`; returns `organisationIds` (empty on any error — fail-soft).
- `orgMembership(orgId: string, profileId: string): Effect<"admin" | "member" | null>` — GET `/organisations/internal/membership?orgId=…&profileId=…`; `null` on non-member OR error (fail-soft, treated as "not a member").

- [ ] **Step 1: Read** — patterns-ref **C10** (`osn-bridge.ts` — the ARC minting + fetch + fail-soft pattern), **C11** (its test harness), **C12** (the org-internal endpoint contracts + response shapes), **C13** (the scope mechanism — `PERMITTED_SCOPES` at `graph-internal.ts:55-61`).

- [ ] **Step 2 (osn-api scope): add `org:read` to `PERMITTED_SCOPES`** in `osn/api/src/routes/graph-internal.ts` (the `Set` at ~line 55):

```ts
const PERMITTED_SCOPES = new Set([
  "graph:read",
  "graph:resolve-account",
  "account:erase",
  "step-up:verify",
  "app-enrollment:write",
  "org:read",
]);
```

Then **verify** `createInternalOrganisationRoutes` is mounted in `osn/api/src/app.ts` (grep it). If NOT mounted, mount it alongside the other internal route groups (follow the existing `.use(createInternal…Routes(...))` pattern). Add/adjust a test in `graph-internal.test.ts` asserting a `register-service` call requesting `org:read` is ACCEPTED (was previously `400 Unknown scopes`).

Run: `bun run --cwd osn/api test:run graph-internal`  → PASS.

- [ ] **Step 3 (cire-side): write the failing resolver test** in `osn-bridge.test.ts` mirroring the existing harness (**C11**): stub `fetch` to return `{ organisationIds: ["org_1","org_2"] }` for `/profile-orgs` and `{ role: "admin" }` for `/membership`; assert `listProfileOrgs("usr_x")` → `["org_1","org_2"]`, `orgMembership("org_1","usr_x")` → `"admin"`; and assert BOTH fail-soft to `[]` / `null` when fetch rejects or returns non-200. Also assert the ARC token is minted with scope `org:read` (the harness already inspects the Authorization header — follow it).

- [ ] **Step 4: Run — FAIL.**

- [ ] **Step 5: Implement the two resolvers** in `osn-bridge.ts`, mirroring the existing graph resolvers (**C10**) but with `scope: "org:read"` and the org-internal paths. Fail-soft: any thrown error / non-200 → `[]` (listProfileOrgs) or `null` (orgMembership). Reuse the existing ARC-minting helper + config; do NOT duplicate token logic.

- [ ] **Step 6: Run — PASS** (cire): `bun run --cwd cire/api test osn-bridge`

- [ ] **Step 7: Commit** `feat: org-membership ARC resolvers (cire-bridge + osn org:read scope)`

---

### Task 6: Fail-soft claim-link email (`cire/api/src/lib/vendor-email.ts`)

**Files:**
- Create: `cire/api/src/lib/vendor-email.ts`
- Test: `cire/api/src/lib/vendor-email.test.ts`

**Interfaces produced:** `sendClaimInviteEmail({ to, claimUrl, vendorName }): Effect<void>` — sends via `@shared/email`'s `EmailService`; **never fails the caller** (fail-soft: logs a warning on transport error/absence and returns void). The claim link is returned to the organiser separately (Task 7), so this is best-effort.

- [ ] **Step 1: Read** — patterns-ref **D14** (`@shared/email` surface: `EmailService` Tag, `send` signature, the layer selection precedence) and **D15** (cire-api has NO email dep today; needs `@shared/email` added to `cire/api/package.json` + a `RESEND_API_KEY` config path). Add `@shared/email` to `cire/api`'s deps (`bun add @shared/email --cwd cire/api`).

- [ ] **Step 2: Write the failing test** — provide a stub `EmailService` layer that records calls; assert `sendClaimInviteEmail` calls `send` once with the `to`, a subject mentioning claiming a listing, and a body containing `claimUrl`. Then provide a stub that THROWS and assert `sendClaimInviteEmail` still succeeds (Exit.isSuccess) — fail-soft.

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Implement** — compose an Effect that yields `EmailService`, calls `send({ to, subject, html/text with claimUrl })`, wrapped in `Effect.catchAll` → `Effect.logWarning(...)` → `Effect.void`. Follow the exact `send` shape from **D14**.

- [ ] **Step 5: Run — PASS.**

- [ ] **Step 6: Commit** `feat(cire/api): fail-soft vendor claim-invite email`

---

### Task 7: Organiser CRM routes (`/api/organiser/weddings/:weddingId/vendors`)

**Files:**
- Create: `cire/api/src/routes/vendors.ts`
- Modify: `cire/api/src/app.ts` (mount — see **B9**)
- Test: `cire/api/src/routes/vendors.test.ts`

**Interfaces produced (HTTP):**
- `GET  /vendors` (weddingMember) → `{ vendors: VendorDto[] }`
- `POST /vendors` (weddingEditor) → create → `VendorDto`
- `PATCH /vendors/:vendorId` (weddingEditor) → update
- `DELETE /vendors/:vendorId` (weddingEditor)
- `POST /vendors/reorder` (weddingEditor) — register BEFORE `/vendors/:vendorId`
- `POST /vendors/:vendorId/list-in-directory` (weddingEditor) — body `SeedListingBody`; calls `directoryService.seedFromCrm` + best-effort `sendClaimInviteEmail`; returns `{ directoryVendorId, claimUrl }` (the link the organiser shares).

- [ ] **Step 1: Read** — patterns-ref **B8** (`routes/budget.ts`): the two-factory read/write split (`createBudgetReadRoutes` weddingMember + `createBudgetWriteRoutes` weddingEditor), `manualParse`, `runCire`, `Effect.provideService(DbService, db)`, `Effect.catchTag` per error, `catchAllDefect`→500, the `weddingNotFound`/tagged-error → HTTP mapping, route registration order. Mirror it exactly.

- [ ] **Step 2: Write the failing route test** — mirror `routes/budget.test.ts`: build the app with a seeded in-memory db; assert GET member-gated returns seeded vendors; POST editor-gated creates; a viewer role write → 403 `read_only_role`; cross-tenant PATCH → 404; `POST /vendors/:id/list-in-directory` returns a `claimUrl` and creates a linked draft listing. (Follow the budget route-test harness for role stubbing.)

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Implement** — `createVendorReadRoutes(db)` (weddingMember) + `createVendorWriteRoutes(db, deps)` (weddingEditor), where `deps` carries `directoryService` + `sendClaimInviteEmail` + the vendor-portal origin config. Delegate to `vendorsService` / `directoryService`; map `VendorNotInWedding` → 404 `{error:"vendor_not_found"}`, `WeddingNotFound` → 404 `{error:"wedding_not_found"}`. The list-in-directory handler: `seedFromCrm` → fire `sendClaimInviteEmail` (best-effort, do not await-block the response on failure) → return `{ directoryVendorId, claimUrl }`.

- [ ] **Step 5: Mount in `app.ts`** after the budget mounts (per **B9**): both factories under the wedding group, reorder before param path.

- [ ] **Step 6: Run — PASS.** `bun run --cwd cire/api test routes/vendors`

- [ ] **Step 7: Commit** `feat(cire/api): organiser vendor CRM routes + list-in-directory`

---

### Task 8: Vendor portal routes (`/api/vendor/*`) + `vendorOrgMember` gate

**Files:**
- Create: `cire/api/src/middleware/vendor-org-member.ts`
- Create: `cire/api/src/routes/vendor-portal.ts`
- Modify: `cire/api/src/app.ts` (mount)
- Test: `cire/api/src/routes/vendor-portal.test.ts`

**Interfaces produced (HTTP, all `osnAuth()`-gated for the caller's `profileId`):**
- `GET  /api/vendor/claims/:token` → `getClaimPreview` → `{ listing: {directoryVendorId,name,email} } | 404` (auth NOT required to preview — the token IS the capability; decide in Step 4, default: allow unauthenticated preview so the claim page can render before sign-in).
- `POST /api/vendor/claims/:token/consume` (osnAuth) — body `ConsumeClaimBody {orgId}`; **gate: `vendorOrgMember(orgId)`** (caller must be owner/admin of `orgId`) → `consumeClaim(token, orgId)` → `ListingDto`.
- `GET  /api/vendor/orgs/:orgId/listing` (osnAuth + `vendorOrgMember`) → `getListingByOrg` → `{ listing: ListingDto | null }`.
- `PUT  /api/vendor/orgs/:orgId/listing` (osnAuth + `vendorOrgMember`) — body `UpsertListingBody` → `upsertListingForOrg` → `ListingDto`.

**`vendorOrgMember(orgId)`** (new middleware): after `osnAuth()` sets `profileId`, call `osnBridge.orgMembership(orgId, profileId)`; if `null` → 403 `{error:"not_org_member"}`; if the bridge is unreachable it returns `null` → 403 (fail-soft-closed for writes; acceptable — a transient osn outage blocks listing writes, never leaks). Attach `orgRole` to context.

- [ ] **Step 1: Read** — `cire/api/src/middleware/osn-auth.ts` (how `osnAuth` sets `profileId` on context) + patterns-ref **B8** for the route-factory + error-mapping idiom. Note: `osnAuth`-gated routes are NOT wedding-scoped — they use the OSN principal.

- [ ] **Step 2: Write the failing test** — stub `osnBridge.orgMembership` to return `"admin"` for `(org_ok, usr_me)` and `null` otherwise. Assert: unauthenticated PUT → 401; authenticated non-member (org_x) → 403 `not_org_member`; member PUT upserts + returns the listing; `consume` with a valid token + member org binds the listing; `consume` where caller is NOT a member of the target org → 403 (cannot claim into an org you don't control); claim preview returns the listing summary for a fresh token.

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Implement** the middleware + `createVendorPortalRoutes(db, deps)` where `deps` = `{ directoryService, orgMembership }`. Map `ClaimInvalid` → 410 `{error:"claim_invalid"}`, `ListingNotFound` → 404. Mount in `app.ts` under `/api/vendor` (NOT under the wedding group).

- [ ] **Step 5: Run — PASS.**

- [ ] **Step 6: Commit** `feat(cire/api): vendor portal listing + claim routes (org-gated)`

---

### Task 9: Organiser frontend — Vendors CRM module

**Files:**
- Create: `cire/organiser/src/lib/vendors-store.ts`
- Create: `cire/organiser/src/components/VendorsView.tsx`
- Modify: `cire/organiser/src/lib/dashboard-route.ts` (add `vendors` to `MODULES` + `MODULE_SUBS`)
- Modify: `cire/organiser/src/components/ModuleSidebar.tsx` (add `MODULE_NAV` entry)
- Modify: `cire/organiser/src/components/ModuleShell.tsx` (render `<VendorsView>`)
- Modify: `cire/organiser/src/components/Overview.tsx` (live vendor count)
- Tests: `cire/organiser/src/lib/vendors-store.test.ts`, `cire/organiser/src/components/VendorsView.test.tsx`

**Interfaces produced:** `vendors-store` — `vendorsAccessor(weddingId)`, `ensureVendorsLoaded`, `peekCachedVendors`, `setCachedVendors`, `invalidateVendors`, `vendorCount(weddingId)`, `__resetVendorsCache`, `type VendorRow`. `VendorsView(props: { weddingId; canEdit; canManage })`.

- [ ] **Step 1: Read** — patterns-ref **E16** (`budget-store.ts` — the weddingId-keyed cache + inflight fetch-lift; mirror it as `vendors-store`), **E17** (`dashboard-route.ts` MODULES/MODULE_SUBS — add `"vendors"` after `"checklist"`/`"budget"`), **E18** (`ModuleShell.tsx` dispatch), **E19** (`BudgetView.tsx` top — imports, props, store hookup, optimistic mutation), **E20** (`lib/api.ts` — `apiUrl`, and that `authFetch` comes from `useAuth()` context, not this file). NEVER import Effect here.

- [ ] **Step 2: Write the failing store test** — mirror `budget-store.test.ts` / `tasks-store.test.ts`: loads once + reuses cache; `vendorCount` is null before load, then the row count; `invalidateVendors` clears. Run `bun run --cwd cire/organiser test:run vendors-store` → FAIL.

- [ ] **Step 3: Implement `vendors-store.ts`** mirroring `budget-store.ts` (weddingId-keyed signal cache, inflight Map fetch-lift, `VendorRow` = the `VendorDto` shape with ms-epoch numbers). → test PASS.

- [ ] **Step 4: Write the failing `VendorsView` test** — mirror `BudgetView.test.tsx` harness (happy-dom, mocked `authFetch` via `useAuth`): renders vendors grouped by status; an editor sees the add form + "list in directory" action; a viewer (`canEdit=false`) sees read-only (no add/edit controls). Run → FAIL.

- [ ] **Step 5: Implement `VendorsView.tsx`** — status-grouped sections (researching → declined) with per-vendor cards (name, category chip, contact, quoted), add/edit/delete (editor only), the **"list in directory + invite to claim"** action (opens a small form → POST `/vendors/:id/list-in-directory` → surface the returned `claimUrl` for the organiser to copy). Optimistic mutations reconciling against the cache (mirror BudgetView). → test PASS.

- [ ] **Step 6: Wire the module** — `dashboard-route.ts`: add `"vendors"` to `MODULES` (after `"budget"`) + `MODULE_SUBS.vendors = ["index"]`. `ModuleSidebar.tsx`: add `MODULE_NAV` entry `{ id:"vendors", label:"Vendors", glyph:"◇", hint:"Track and book your suppliers" }`. `ModuleShell.tsx`: render `<VendorsView weddingId={…} canEdit={…} canManage={…} />` for the `vendors` module. `Overview.tsx`: add a small live vendor-count card via `vendorCount(weddingId)` + `ensureVendorsLoaded` in the resource (mirror the checklist/budget Overview cards). Run the full organiser suite: `bun run --cwd cire/organiser test:run` → PASS.

- [ ] **Step 7: Commit** `feat(cire/organiser): Vendors CRM module + store + Overview count`

---

### Task 10: Docs, compliance, runbook, changesets

**Files:**
- Create: `cire/wiki/systems/vendors.md`
- Modify: `wiki/systems/cire-auth.md` (root) — document the vendor principal (OSN account + org membership)
- Modify: `wiki/compliance/data-map.md` + `wiki/compliance/retention.md` (root) — vendor contact-detail + claim-email rows
- Modify: `wiki/runbooks/production-deploy.md` (root) §6.2 — cire-api re-registration with `org:read`
- Modify: `cire/wiki/todo/platform.md` — tick Vendors Slice-1 PR A
- Create: `.changeset/cire-vendors-foundation.md` (EMPTY — cire unversioned) + `.changeset/osn-api-org-read-scope.md` (`"@osn/api": patch`)

- [ ] **Step 1: Wiki system page** — `cire/wiki/systems/vendors.md` with frontmatter (`title`, `tags: [systems, cire, vendors, phase2]`, `related: [cire-auth, budget, checklist-tasks]`, `last-reviewed: 2026-07-16`). Document: the 4 tables; the three principals (guest cookie / organiser JWT / **vendor = organiser JWT + org membership**); the org-membership ARC resolver (scope `org:read`); the email-verification claim flow (organiser-initiated, link returned + fail-soft email); one-profile-per-org / many-categories / second-org-for-a-brand; what's deferred (browse, availability, enquiries, search, pricing, budget/task linkage).

- [ ] **Step 2: cire-auth + compliance + runbook** —
  - `wiki/systems/cire-auth.md`: add the vendor principal + the `org:read` bridge to the model.
  - `wiki/compliance/data-map.md` + `retention.md`: rows for `directory_vendors.email/phone`, `vendors.email/phone/contact_name`, `vendor_claims.email` (sole-trader personal data; purpose = vendor listing/contact; lawful basis = legitimate interest / contract; retention TBD-per-policy — follow the existing row format).
  - `wiki/runbooks/production-deploy.md` §6.2: update cire-api's registration curl to `allowedScopes:"graph:read,graph:resolve-account,org:read"` and note it must be re-run per env AFTER the `@osn/api` `PERMITTED_SCOPES` change deploys.

- [ ] **Step 3: TODO** — `cire/wiki/todo/platform.md`: tick "Vendors Slice 1 PR A (foundation + CRM + claim backend) SHIPPED 2026-07-16" with a one-line summary + `[[systems/vendors]]`; note PR B (portal app) is next.

- [ ] **Step 4: Changesets** —
  - `.changeset/cire-vendors-foundation.md`: empty frontmatter (`---\n---`) + body describing the cire vendor CRM + claim backend.
  - `.changeset/osn-api-org-read-scope.md`:
    ```markdown
    ---
    "@osn/api": patch
    ---
    Add `org:read` to the register-service permitted-scopes allowlist so downstream services (cire-api) can resolve OSN org membership over ARC for the Vendors feature.
    ```
  - Run `bash scripts/validate-changesets.sh` → passes (ignored + versioned NOT mixed).

- [ ] **Step 5: Commit** `docs(cire,osn): vendors system page, cire-auth + compliance + runbook, changesets`

---

## Final Verification (after all tasks)

- [ ] `bun run --cwd cire/api test` — full cire-api suite green (incl. new vendor service/route/schema tests + `ddl-lockstep`).
- [ ] `bun run --cwd osn/api test:run` — osn-api green (incl. the `org:read` permitted-scope test).
- [ ] `bun run --cwd cire/organiser test:run` — organiser green (VendorsView + store + Overview).
- [ ] `bash scripts/validate-changesets.sh` — passes.
- [ ] `bun run lint` — no new errors.
- [ ] Whole-branch review (superpowers:requesting-code-review, most-capable model) — pointed at the Minor-findings ledger.
- [ ] **`/prep-pr`** (parallel perf + security reviews + structured PR body) before opening the PR — mandatory per the project convention.
- [ ] superpowers:finishing-a-development-branch → push + open PR to main.
- [ ] **At merge:** the migration `0040` auto-applies to prod cire-db (additive, zero-risk) and the `@osn/api` `PERMITTED_SCOPES` change deploys — both need the usual explicit prod-authorization. **After deploy:** perform the manual §6.2 cire-api re-registration per env with the widened `org:read` scope (authorized separately). Until it runs, org-gated listing writes fail-soft to 503; the CRM + claim-link generation work regardless.

## Notes for the PR B plan (next cycle — NOT this plan)

The `cire/vendor` Astro+SolidJS Pages app on `vendor.cireweddings.com` (sign-in → org create/pick → listing editor → `/claim` landing), its `deploy-cire-vendor` job, DNS, and the `vendor.` allowlist additions to cire-api `WEB_ORIGIN` + osn-api origins. It consumes the `/api/vendor/*` routes built here. Delete `docs/superpowers/plans/_vendors-patterns-ref.md` is NOT required — keep it for PR B.
