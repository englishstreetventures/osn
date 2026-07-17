/**
 * Directory + claim service (platform Phase 2, Vendors Slice 1).
 *
 * Two surfaces in one:
 *  1. Global directory listing — one listing per OSN org, self-managed via
 *     `getListingByOrg` / `upsertListingForOrg`.
 *  2. Seed-then-claim bridge — an organiser triggers `seedFromCrm` to create a
 *     draft listing from their CRM vendor row and generate a single-use,
 *     time-limited email claim token that the vendor can redeem via `consumeClaim`.
 *
 * TOKEN SECURITY: tokens are 32 random bytes → base64url (256 bits entropy).
 * Only the SHA-256 hex hash is stored in the DB — the same pattern as the session
 * service (`cire/api/src/services/session.ts`). A leaked DB dump cannot be
 * replayed to claim a listing.
 *
 * TENANCY: `seedFromCrm` scopes vendor lookup to the wedding via `requireVendor`
 * (re-implemented here to avoid a circular dependency; the error class is imported
 * from vendors.ts). Route-layer membership checks (organiser may touch weddingId)
 * are enforced upstream (Task 8).
 */
import { directoryVendorCategories, directoryVendors, vendorClaims, vendors } from "@cire/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { VendorNotInWedding } from "./vendors";

// ── Tagged errors ────────────────────────────────────────────────────────────

/** No directory listing for this org / id. 404-class. */
export class ListingNotFound extends Data.TaggedError("ListingNotFound") {}

/** Claim token is unknown, expired, or already consumed. 4xx-class. */
export class ClaimInvalid extends Data.TaggedError("ClaimInvalid") {}

// ── Constants ────────────────────────────────────────────────────────────────

/** 7 days in ms. */
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface ListingDto {
  id: string;
  ownerOrgId: string | null;
  name: string;
  description: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  instagram: string | null;
  locationText: string | null;
  priceBand: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  listed: string;
  categories: string[];
  createdAt: number;
  updatedAt: number;
}

export interface UpsertListingBody {
  name: string;
  description: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  instagram: string | null;
  locationText: string | null;
  priceBand: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  categories: string[];
}

export interface SeedFromCrmBody extends UpsertListingBody {
  // email is the claim recipient (may differ from the listing email); non-null
  // because SeedListingBody (the HTTP boundary) requires a non-empty email.
  email: string;
}

export interface DirectoryServiceConfig {
  vendorPortalOrigin?: string;
}

export interface BrowseListingDto {
  id: string;
  name: string;
  description: string | null;
  categories: string[];
  locationText: string | null;
  priceBand: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  website: string | null;
  instagram: string | null;
  email: string | null;
  phone: string | null;
  inWedding: boolean;
}

export interface BrowseFilter {
  category?: string | null;
  q?: string | null;
  location?: string | null;
  limit: number;
  offset: number;
}

// ── Internal row types ────────────────────────────────────────────────────────

interface DvRow {
  id: string;
  ownerOrgId: string | null;
  name: string;
  description: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  instagram: string | null;
  locationText: string | null;
  priceBand: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  listed: string;
  createdAt: Date;
  updatedAt: Date;
}

interface VendorRow {
  id: string;
  weddingId: string;
  directoryVendorId: string | null;
  name: string;
  category: string;
  status: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  quotedMinor: number | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * SHA-256 hex of the raw token. Reuses the same `crypto.subtle` pattern from
 * `cire/api/src/services/session.ts`. Only the hash is persisted — a leaked DB
 * dump cannot be replayed.
 */
function hashToken(raw: string): Effect.Effect<string> {
  return Effect.promise(async () => {
    const data = new TextEncoder().encode(raw);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  });
}

/**
 * 256 bits of entropy → base64url (no padding). URL-safe; embeddable in query strings.
 */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function toDto(row: DvRow, categories: string[]): ListingDto {
  return {
    id: row.id,
    ownerOrgId: row.ownerOrgId,
    name: row.name,
    description: row.description,
    email: row.email,
    phone: row.phone,
    website: row.website,
    instagram: row.instagram,
    locationText: row.locationText,
    priceBand: row.priceBand,
    priceMinMinor: row.priceMinMinor,
    priceMaxMinor: row.priceMaxMinor,
    listed: row.listed,
    categories,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * Fetch category strings for a directory vendor id.
 */
function fetchCategories(dvId: string): Effect.Effect<string[], never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({ category: directoryVendorCategories.category })
        .from(directoryVendorCategories)
        .where(eq(directoryVendorCategories.directoryVendorId, dvId))
        .all(),
    );
    return (rows as { category: string }[]).map((r) => r.category);
  });
}

/**
 * Replace the full category set for a directory vendor (delete all, reinsert).
 */
function replaceCategories(
  dvId: string,
  categories: string[],
): Effect.Effect<void, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    yield* dbQuery(() =>
      db
        .delete(directoryVendorCategories)
        .where(eq(directoryVendorCategories.directoryVendorId, dvId))
        .run(),
    );
    if (categories.length > 0) {
      yield* dbQuery(() =>
        db
          .insert(directoryVendorCategories)
          .values(categories.map((c) => ({ directoryVendorId: dvId, category: c })))
          .run(),
      );
    }
  });
}

/**
 * Scoped vendor lookup — fail VendorNotInWedding if not found under this wedding.
 */
function requireVendor(
  weddingId: string,
  vendorId: string,
): Effect.Effect<VendorRow, VendorNotInWedding, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = yield* dbQuery(() =>
      db
        .select()
        .from(vendors)
        .where(and(eq(vendors.id, vendorId), eq(vendors.weddingId, weddingId)))
        .all(),
    );
    if (!row) return yield* Effect.fail(new VendorNotInWedding());
    return row as VendorRow;
  });
}

/** Escape %, _ and the escape char for a LIKE pattern (used with ESCAPE '\'). */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createDirectoryService(config: DirectoryServiceConfig = {}) {
  const vendorPortalOrigin = config.vendorPortalOrigin ?? "https://vendor.cireweddings.com";

  const claimUrl = (token: string) => `${vendorPortalOrigin}/claim?token=${token}`;

  return {
    /**
     * Return the single listing owned by this org, or null if none exists.
     */
    getListingByOrg(orgId: string): Effect.Effect<ListingDto | null, never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const [row] = yield* dbQuery(() =>
          db.select().from(directoryVendors).where(eq(directoryVendors.ownerOrgId, orgId)).all(),
        );
        if (!row) return null;
        const dvRow = row as DvRow;
        const categories = yield* fetchCategories(dvRow.id);
        return toDto(dvRow, categories);
      }).pipe(Effect.withSpan("cire.directory.getListingByOrg"));
    },

    /**
     * Create-or-update the single listing owned by `orgId`. Always sets
     * `listed='live'`. Replaces the category set on every call.
     */
    upsertListingForOrg(
      orgId: string,
      body: UpsertListingBody,
    ): Effect.Effect<ListingDto, never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const [existing] = yield* dbQuery(() =>
          db.select().from(directoryVendors).where(eq(directoryVendors.ownerOrgId, orgId)).all(),
        );

        let dvId: string;
        let dvRow: DvRow;

        if (!existing) {
          // Insert
          dvId = `dv_${crypto.randomUUID()}`;
          const now = new Date();
          dvRow = {
            id: dvId,
            ownerOrgId: orgId,
            name: body.name,
            description: body.description,
            email: body.email,
            phone: body.phone,
            website: body.website,
            instagram: body.instagram,
            locationText: body.locationText,
            priceBand: body.priceBand,
            priceMinMinor: body.priceMinMinor,
            priceMaxMinor: body.priceMaxMinor,
            listed: "live",
            createdAt: now,
            updatedAt: now,
          };
          yield* dbQuery(() => db.insert(directoryVendors).values(dvRow).run());
        } else {
          dvId = (existing as DvRow).id;
          const now = new Date();
          yield* dbQuery(() =>
            db
              .update(directoryVendors)
              .set({
                name: body.name,
                description: body.description,
                email: body.email,
                phone: body.phone,
                website: body.website,
                instagram: body.instagram,
                locationText: body.locationText,
                priceBand: body.priceBand,
                priceMinMinor: body.priceMinMinor,
                priceMaxMinor: body.priceMaxMinor,
                listed: "live",
                updatedAt: now,
              })
              .where(eq(directoryVendors.id, dvId))
              .run(),
          );
          // Re-fetch updated row
          const [updated] = yield* dbQuery(() =>
            db.select().from(directoryVendors).where(eq(directoryVendors.id, dvId)).all(),
          );
          dvRow = updated as DvRow;
        }

        yield* replaceCategories(dvId, body.categories);
        const categories = yield* fetchCategories(dvId);
        return toDto(dvRow, categories);
      }).pipe(Effect.withSpan("cire.directory.upsertListingForOrg"));
    },

    /**
     * Wedding-scoped: the vendor row must belong to `weddingId`.
     * Creates a `draft` listing + categories, links `vendors.directoryVendorId`,
     * mints a claim token (returns plaintext + URL; stores only the SHA-256 hash).
     */
    seedFromCrm(
      weddingId: string,
      vendorId: string,
      body: SeedFromCrmBody,
    ): Effect.Effect<
      { claimToken: string; claimUrl: string; directoryVendorId: string },
      VendorNotInWedding,
      DbService
    > {
      return Effect.gen(function* () {
        const db = yield* DbService;

        // Gate: vendor must belong to this wedding
        yield* requireVendor(weddingId, vendorId);

        // Create draft listing
        const dvId = `dv_${crypto.randomUUID()}`;
        const now = new Date();
        yield* dbQuery(() =>
          db
            .insert(directoryVendors)
            .values({
              id: dvId,
              ownerOrgId: null,
              name: body.name,
              description: body.description,
              email: body.email,
              phone: body.phone,
              website: body.website,
              instagram: body.instagram,
              locationText: body.locationText,
              priceBand: body.priceBand,
              priceMinMinor: body.priceMinMinor,
              priceMaxMinor: body.priceMaxMinor,
              listed: "draft",
              createdAt: now,
              updatedAt: now,
            })
            .run(),
        );

        // Insert categories
        if (body.categories.length > 0) {
          yield* dbQuery(() =>
            db
              .insert(directoryVendorCategories)
              .values(body.categories.map((c) => ({ directoryVendorId: dvId, category: c })))
              .run(),
          );
        }

        // Link CRM vendor row
        yield* dbQuery(() =>
          db
            .update(vendors)
            .set({ directoryVendorId: dvId, updatedAt: new Date() })
            .where(and(eq(vendors.id, vendorId), eq(vendors.weddingId, weddingId)))
            .run(),
        );

        // Mint claim token
        const token = generateToken();
        const tokenHash = yield* hashToken(token);
        const claimId = `clm_${crypto.randomUUID()}`;
        const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);

        yield* dbQuery(() =>
          db
            .insert(vendorClaims)
            .values({
              id: claimId,
              directoryVendorId: dvId,
              tokenHash,
              email: body.email,
              createdAt: now,
              expiresAt,
              consumedAt: null,
            })
            .run(),
        );

        return {
          claimToken: token,
          claimUrl: claimUrl(token),
          directoryVendorId: dvId,
        };
      }).pipe(Effect.withSpan("cire.directory.seedFromCrm"));
    },

    /**
     * Validate an unconsumed, unexpired token and return listing summary.
     * Returns null if the token is unknown, expired, or consumed.
     */
    getClaimPreview(
      token: string,
    ): Effect.Effect<{ directoryVendorId: string; name: string } | null, never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const tokenHash = yield* hashToken(token);

        const [claim] = yield* dbQuery(() =>
          db.select().from(vendorClaims).where(eq(vendorClaims.tokenHash, tokenHash)).all(),
        );
        if (!claim) return null;

        const claimRow = claim as {
          id: string;
          directoryVendorId: string;
          tokenHash: string;
          email: string;
          createdAt: Date;
          expiresAt: Date;
          consumedAt: Date | null;
        };

        // Reject consumed or expired
        if (claimRow.consumedAt !== null) return null;
        if (claimRow.expiresAt.getTime() < Date.now()) return null;

        // Fetch the listing name
        const [dv] = yield* dbQuery(() =>
          db
            .select({ id: directoryVendors.id, name: directoryVendors.name })
            .from(directoryVendors)
            .where(eq(directoryVendors.id, claimRow.directoryVendorId))
            .all(),
        );
        if (!dv) return null;
        const dvRow = dv as { id: string; name: string };

        return {
          directoryVendorId: claimRow.directoryVendorId,
          name: dvRow.name,
        };
      }).pipe(Effect.withSpan("cire.directory.getClaimPreview"));
    },

    /**
     * Redeem a claim token: bind `owner_org_id=orgId`, flip `listed='live'`,
     * stamp `consumed_at`. Fails `ClaimInvalid` if unknown/expired/already consumed.
     */
    consumeClaim(token: string, orgId: string): Effect.Effect<ListingDto, ClaimInvalid, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const tokenHash = yield* hashToken(token);

        const [claim] = yield* dbQuery(() =>
          db.select().from(vendorClaims).where(eq(vendorClaims.tokenHash, tokenHash)).all(),
        );
        if (!claim) return yield* Effect.fail(new ClaimInvalid());

        const claimRow = claim as {
          id: string;
          directoryVendorId: string;
          tokenHash: string;
          email: string;
          createdAt: Date;
          expiresAt: Date;
          consumedAt: Date | null;
        };

        if (claimRow.consumedAt !== null) return yield* Effect.fail(new ClaimInvalid());
        if (claimRow.expiresAt.getTime() < Date.now())
          return yield* Effect.fail(new ClaimInvalid());

        const now = new Date();

        // Compare-and-swap burn: the UPDATE itself is the exclusive guard.
        // The WHERE clause on `consumed_at IS NULL` means only one concurrent
        // caller can change 0→1 rows; all others get 0 rows changed and bail.
        //
        // Fail-closed ordering: burn FIRST, bind SECOND. A crash between the
        // two writes leaves the token consumed-but-unbound (safe — a new invite
        // is needed) rather than bound-but-reusable (unsafe).
        //
        // `rowsChanged` normalises the run-result across drivers:
        //   bun:sqlite  → `{ changes: number }`
        //   Cloudflare D1 → `{ meta: { changes: number } }`
        function rowsChanged(result: unknown): number {
          if (typeof result !== "object" || result === null) return 0;
          const r = result as { changes?: number; meta?: { changes?: number } };
          return r.meta?.changes ?? r.changes ?? 0;
        }

        const burnResult = yield* dbQuery(() =>
          db
            .update(vendorClaims)
            .set({ consumedAt: now })
            .where(and(eq(vendorClaims.id, claimRow.id), sql`consumed_at IS NULL`))
            .run(),
        );

        if (rowsChanged(burnResult) === 0) {
          // Token was consumed by a concurrent or prior caller — fail closed.
          return yield* Effect.fail(new ClaimInvalid());
        }

        // Burn succeeded — now bind the listing.
        yield* dbQuery(() =>
          db
            .update(directoryVendors)
            .set({ ownerOrgId: orgId, listed: "live", updatedAt: now })
            .where(eq(directoryVendors.id, claimRow.directoryVendorId))
            .run(),
        );

        // Fetch updated listing + categories
        const [updated] = yield* dbQuery(() =>
          db
            .select()
            .from(directoryVendors)
            .where(eq(directoryVendors.id, claimRow.directoryVendorId))
            .all(),
        );
        const dvRow = updated as DvRow;
        const categories = yield* fetchCategories(dvRow.id);
        return toDto(dvRow, categories);
      }).pipe(Effect.withSpan("cire.directory.consumeClaim"));
    },

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
          conds.push(
            sql`lower(coalesce(${directoryVendors.locationText}, '')) LIKE lower(${t}) ESCAPE '\\'`,
          );
        }
        if (filter.category) {
          conds.push(
            sql`EXISTS (SELECT 1 FROM ${directoryVendorCategories} dvc WHERE dvc.directory_vendor_id = "directory_vendors"."id" AND dvc.category = ${filter.category})`,
          );
        }
        const whereExpr = and(...conds);

        // count(*) and the page SELECT share the same whereExpr but have no
        // data dependency — run them concurrently to save one D1 round-trip.
        const [countResult, rows] = yield* Effect.all(
          [
            dbQuery(() =>
              db
                .select({ n: sql<number>`count(*)` })
                .from(directoryVendors)
                .where(whereExpr)
                .all(),
            ),
            dbQuery(() =>
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
                  inWedding: sql<number>`EXISTS (SELECT 1 FROM ${vendors} v WHERE v.wedding_id = ${weddingId} AND v.directory_vendor_id = "directory_vendors"."id")`,
                })
                .from(directoryVendors)
                .where(whereExpr)
                .orderBy(asc(directoryVendors.name), asc(directoryVendors.id))
                .limit(filter.limit)
                .offset(filter.offset)
                .all(),
            ),
          ],
          { concurrency: 2 },
        );
        const [countRow] = countResult;
        const total = (countRow as { n: number } | undefined)?.n ?? 0;

        const pageRows = rows as {
          id: string;
          name: string;
          description: string | null;
          locationText: string | null;
          priceBand: string | null;
          priceMinMinor: number | null;
          priceMaxMinor: number | null;
          website: string | null;
          instagram: string | null;
          email: string | null;
          phone: string | null;
          inWedding: number;
        }[];

        const ids = pageRows.map((r) => r.id);
        const catRows =
          ids.length === 0
            ? []
            : ((yield* dbQuery(() =>
                db
                  .select({
                    dv: directoryVendorCategories.directoryVendorId,
                    category: directoryVendorCategories.category,
                  })
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
  };
}

/**
 * Default singleton using prod config. Import `createDirectoryService` in tests
 * to inject a stub `vendorPortalOrigin`.
 */
export const directoryService = createDirectoryService();
