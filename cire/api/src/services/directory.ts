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
import { rowsChanged } from "@shared/db-utils";
import { likeContains } from "@shared/db-utils/search";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Data, Effect } from "effect";

import { commitBatch, commitBatchResults, DbService, dbQuery } from "../db";
import { metricVendorClaimReview } from "../metrics";
import { VendorNotInWedding } from "./vendors";

// ── Tagged errors ────────────────────────────────────────────────────────────

/** No directory listing for this org / id. 404-class. */
export class ListingNotFound extends Data.TaggedError("ListingNotFound") {}

/** Claim token is unknown, expired, or already consumed. 4xx-class. */
export class ClaimInvalid extends Data.TaggedError("ClaimInvalid") {}

/**
 * The org a claim would bind to already owns a listing; an org owns at most
 * one (`directory_vendors.owner_org_id` is unique). 409-class.
 */
export class OrgAlreadyHasListing extends Data.TaggedError("OrgAlreadyHasListing") {}

/**
 * The org's listing is a redeemed claim still waiting for an operator; the
 * vendor cannot edit or publish it until then. 409-class.
 */
export class ListingAwaitingConfirmation extends Data.TaggedError("ListingAwaitingConfirmation") {}

// ── Constants ────────────────────────────────────────────────────────────────

/** 7 days in ms. */
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── DTOs ─────────────────────────────────────────────────────────────────────

/**
 * Union projection of the `directory_vendors` columns needed across the
 * enquiry-creation path (route claim-mint gate + service open() + claim
 * minting) — read once at the route and passed down.
 */
export interface DirectoryVendorRow {
  id: string;
  ownerOrgId: string | null;
  /** Org of a redeemed claim waiting for an operator; null when none is. */
  reviewOrgId: string | null;
  email: string | null;
  name: string;
  phone: string | null;
  claimedByProfileId: string | null;
  leadForwardEmail: string | null;
}

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
  /**
   * True while the listing is a redeemed claim waiting for an operator. It is
   * then not live, and no enquiry chat reaches the claimant.
   */
  awaitingConfirmation: boolean;
  categories: string[];
  createdAt: number;
  updatedAt: number;
}

export interface LiveListingInWeddingDto extends ListingDto {
  /** True when the asking wedding's CRM already has a row linking this listing. */
  inWedding: boolean;
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
  reviewOrgId?: string | null;
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
    awaitingConfirmation: row.reviewOrgId != null,
    categories,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** The listing `orgId` owns or is waiting on an operator for; an org has at most one. */
const ownedOrPending = (orgId: string) =>
  or(eq(directoryVendors.ownerOrgId, orgId), eq(directoryVendors.reviewOrgId, orgId));

/**
 * Why a claim's bind batch threw. The one expected cause is a unique index on
 * owner or pending org: `orgId` gained a listing, or another pending claim,
 * between the claim's pre-check and its bind.
 * A fresh read says whether that happened — the driver's error message is not
 * a reliable signal, since D1 does not carry SQLite's wording — and answers
 * `OrgAlreadyHasListing`. Anything else stays a defect.
 */
function bindRefused(
  orgId: string,
  error: unknown,
): Effect.Effect<never, OrgAlreadyHasListing, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [owned] = yield* dbQuery(() =>
      db
        .select({ id: directoryVendors.id })
        .from(directoryVendors)
        .where(ownedOrPending(orgId))
        .limit(1)
        .all(),
    );
    if (owned) return yield* Effect.fail(new OrgAlreadyHasListing());
    return yield* Effect.die(error);
  });
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
 * One atomic batch: a failure between the delete and the insert used to leave
 * the listing with ZERO categories — live but invisible to every
 * category-filtered browse.
 */
function replaceCategories(
  dvId: string,
  categories: string[],
): Effect.Effect<void, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const statements: BatchItem<"sqlite">[] = [
      db
        .delete(directoryVendorCategories)
        .where(eq(directoryVendorCategories.directoryVendorId, dvId)),
    ];
    if (categories.length > 0) {
      statements.push(
        db
          .insert(directoryVendorCategories)
          .values(categories.map((c) => ({ directoryVendorId: dvId, category: c }))),
      );
    }
    yield* dbQuery(() => commitBatch(db, statements));
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

// ── Factory ───────────────────────────────────────────────────────────────────

export function createDirectoryService(config: DirectoryServiceConfig = {}) {
  const vendorPortalOrigin = config.vendorPortalOrigin ?? "https://vendor.cireweddings.com";

  const claimUrl = (token: string) => `${vendorPortalOrigin}/claim?token=${token}`;

  return {
    /**
     * Return the single listing this org owns, or the one its redeemed claim is
     * waiting on an operator for (`awaitingConfirmation`), or null.
     */
    getListingByOrg(orgId: string): Effect.Effect<ListingDto | null, never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const [row] = yield* dbQuery(() =>
          db.select().from(directoryVendors).where(ownedOrPending(orgId)).all(),
        );
        if (!row) return null;
        const dvRow = row as DvRow;
        const categories = yield* fetchCategories(dvRow.id);
        return toDto(dvRow, categories);
      }).pipe(Effect.withSpan("cire.directory.getListingByOrg"));
    },

    /**
     * Create-or-update the single listing owned by `orgId`. Always sets
     * `listed='live'`. Replaces the category set on every call. Fails
     * `ListingAwaitingConfirmation` while the org's claim waits for an
     * operator: that listing must not go live, and a second one would leave
     * the org two listings once the claim is confirmed.
     */
    upsertListingForOrg(
      orgId: string,
      body: UpsertListingBody,
    ): Effect.Effect<ListingDto, ListingAwaitingConfirmation, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const [found] = yield* dbQuery(() =>
          db.select().from(directoryVendors).where(ownedOrPending(orgId)).all(),
        );
        if (found && found.ownerOrgId !== orgId) {
          return yield* Effect.fail(new ListingAwaitingConfirmation());
        }
        const existing = found;

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
          // RETURNING hands back the updated row, so nothing re-reads it. The
          // WHERE repeats the owner, so a listing that changed owner after the
          // probe above is not written; that save fails with nothing changed.
          const [updated] = yield* dbQuery(() =>
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
              .where(and(eq(directoryVendors.id, dvId), eq(directoryVendors.ownerOrgId, orgId)))
              .returning()
              .all(),
          );
          if (!updated) {
            return yield* Effect.die(new Error("listing changed owner during save"));
          }
          dvRow = updated;
        }

        yield* replaceCategories(dvId, body.categories);
        // A committed replace stored exactly `body.categories`: the
        // (directory_vendor_id, category) primary key fails the whole batch on
        // a duplicate. Sorted to match the key order a read of the table gives.
        return toDto(dvRow, body.categories.toSorted());
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
     * Mint a single-use claim token + URL for an EXISTING listing so an
     * out-of-band surface (e.g. the couple-side enquiry-new email) can invite
     * the vendor to claim their listing via the canonical
     * `${vendorPortalOrigin}/claim?token=…` → `consumeClaim` flow.
     *
     * Returns `null` when the listing is unknown, already claimed
     * (`owner_org_id` set) or holding a claim that waits for an operator
     * (`review_org_id` set) — none of them can be claimed now. Otherwise
     * reuses the same token machinery as `seedFromCrm` (256-bit token, stored as
     * SHA-256 hash only, 7-day TTL). Tokens are hashed at rest, so an existing
     * unconsumed token cannot be recovered as plaintext — a fresh single-use
     * token is minted per call. This is a thin reuse of the existing claim
     * mechanism, not a new subsystem.
     */
    issueClaimForListing(
      dv: DirectoryVendorRow | null,
    ): Effect.Effect<{ claimToken: string; claimUrl: string } | null, never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;

        // Unknown, claimed or pending listing → no claim CTA.
        if (!dv || dv.ownerOrgId !== null || dv.reviewOrgId !== null) return null;

        const now = new Date();
        const token = generateToken();
        const tokenHash = yield* hashToken(token);
        const claimId = `clm_${crypto.randomUUID()}`;
        const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);

        yield* dbQuery(() =>
          db
            .insert(vendorClaims)
            .values({
              id: claimId,
              directoryVendorId: dv.id,
              tokenHash,
              email: dv.email ?? "",
              createdAt: now,
              expiresAt,
              consumedAt: null,
            })
            .run(),
        );

        return { claimToken: token, claimUrl: claimUrl(token) };
      }).pipe(Effect.withSpan("cire.directory.issueClaimForListing"));
    },

    /**
     * Validate an unconsumed, unexpired token and return listing summary.
     * Returns null if the token is unknown, expired or consumed, or its listing
     * is gone, already claimed or holding a claim that waits for an operator.
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

        // Fetch the listing name. A listing that is already claimed has
        // nothing left to claim, so its preview is null like a spent token's.
        const [dv] = yield* dbQuery(() =>
          db
            .select({
              id: directoryVendors.id,
              name: directoryVendors.name,
              ownerOrgId: directoryVendors.ownerOrgId,
              reviewOrgId: directoryVendors.reviewOrgId,
            })
            .from(directoryVendors)
            .where(eq(directoryVendors.id, claimRow.directoryVendorId))
            .all(),
        );
        if (!dv) return null;
        if (dv.ownerOrgId !== null || dv.reviewOrgId !== null) return null;
        const dvRow = dv;

        return {
          directoryVendorId: claimRow.directoryVendorId,
          name: dvRow.name,
        };
      }).pipe(Effect.withSpan("cire.directory.getClaimPreview"));
    },

    /**
     * Redeem a claim token: record `review_org_id=orgId`,
     * `review_profile_id=claimingProfileId` and `review_requested_at`, stamp
     * `consumed_at`, and burn every other live token for the listing. The
     * listing stays unowned and `draft` until an operator confirms
     * (`scripts/cire-vendor-claim-review.ts`).
     *
     * A claim proves control of an inbox the organiser chose, not that the
     * claimant is the business, so it must not bind ownership by itself.
     * Leaving `owner_org_id` and `claimed_by_profile_id` null keeps every
     * reader that decides "claimed" on them (`enquiries.open`, the vendor
     * enquiry org gate, browse) treating the listing as unclaimed: couples'
     * enquiries keep buffering and no chat reaches the claimant. The operator's
     * confirm writes both owner columns in one UPDATE.
     *
     * Fails `ClaimInvalid` if the token is unknown, expired or consumed, or its
     * listing is gone, claimed or already pending. Fails `OrgAlreadyHasListing`
     * if `orgId` already owns or is waiting on a listing; that check runs
     * before the burn, so the token stays live for the vendor to pick another org.
     */
    consumeClaim(
      token: string,
      orgId: string,
      claimingProfileId: string,
    ): Effect.Effect<ListingDto, ClaimInvalid | OrgAlreadyHasListing, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        const tokenHash = yield* hashToken(token);

        // One read answers every pre-check: the token, its listing's owner,
        // and whether `orgId` already owns a listing. None of them fails by
        // burning the token. The listing check runs before the org check, so a
        // token for a claimed listing reads as invalid, not as an org conflict.
        const [found] = yield* dbQuery(() =>
          db
            .select({
              claim: vendorClaims,
              listingId: directoryVendors.id,
              listingOwner: directoryVendors.ownerOrgId,
              listingReview: directoryVendors.reviewOrgId,
              orgHasListing: sql<number>`EXISTS (SELECT 1 FROM directory_vendors o WHERE o.owner_org_id = ${orgId} OR o.review_org_id = ${orgId})`,
            })
            .from(vendorClaims)
            .leftJoin(directoryVendors, eq(directoryVendors.id, vendorClaims.directoryVendorId))
            .where(eq(vendorClaims.tokenHash, tokenHash))
            .all(),
        );
        if (!found) return yield* Effect.fail(new ClaimInvalid());
        const claimRow = found.claim;

        if (claimRow.consumedAt !== null) return yield* Effect.fail(new ClaimInvalid());
        if (claimRow.expiresAt.getTime() < Date.now())
          return yield* Effect.fail(new ClaimInvalid());
        if (found.listingId === null || found.listingOwner !== null || found.listingReview !== null)
          return yield* Effect.fail(new ClaimInvalid());
        if (found.orgHasListing) return yield* Effect.fail(new OrgAlreadyHasListing());

        const now = new Date();

        // Compare-and-swap burn: the UPDATE itself is the exclusive guard.
        // The WHERE clause on `consumed_at IS NULL` means only one concurrent
        // caller can change 0→1 rows; all others get 0 rows changed and bail.
        //
        // Fail-closed ordering: burn FIRST, bind SECOND. A crash between the
        // two writes leaves the token consumed-but-unbound (safe — a new invite
        // is needed) rather than bound-but-reusable (unsafe).
        //
        // `rowsChanged` normalises the run-result across drivers — read it
        // through nothing else, or the gate inverts on D1.
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

        // Burn succeeded — now record the pending claim and burn the listing's
        // other live tokens, in one batch. The write only matches a listing
        // that is unowned and not already pending, so a second token can never
        // move a claim to another org. RETURNING hands back the row, so nothing
        // re-reads it.
        //
        // The write comes first in the batch: if it violates the unique
        // pending-org index (`orgId` gained a pending claim after the
        // pre-check), the batch stops before the other tokens are burned. On
        // D1 the whole batch rolls back; this token stays burned either way,
        // so that race fails closed with `OrgAlreadyHasListing`. An org that
        // gains an OWNED listing in that window is not caught here; the
        // operator's confirm refuses it (the script checks, and the unique
        // owner index backs it). Burning the other tokens when the write
        // matched nothing is harmless: they could no longer bind anything.
        //
        // Only the batch and the category read run together, and only after
        // the burn and its gate above: the bind must never start before the
        // burn has committed. The category read touches no claim or ownership
        // state, and the batch does not write categories.
        const [bindResults, categories] = yield* Effect.all(
          [
            Effect.tryPromise(() =>
              commitBatchResults(db, [
                db
                  .update(directoryVendors)
                  .set({
                    reviewOrgId: orgId,
                    reviewProfileId: claimingProfileId,
                    reviewRequestedAt: now,
                    updatedAt: now,
                  })
                  .where(
                    and(
                      eq(directoryVendors.id, claimRow.directoryVendorId),
                      isNull(directoryVendors.ownerOrgId),
                      isNull(directoryVendors.reviewOrgId),
                    ),
                  )
                  .returning(),
                db
                  .update(vendorClaims)
                  .set({ consumedAt: now })
                  .where(
                    and(
                      eq(vendorClaims.directoryVendorId, claimRow.directoryVendorId),
                      isNull(vendorClaims.consumedAt),
                    ),
                  ),
              ]),
            ).pipe(Effect.catch((error) => bindRefused(orgId, error))),
            fetchCategories(claimRow.directoryVendorId),
          ],
          { concurrency: "unbounded" },
        );
        const [bound] = bindResults[0] as DvRow[];
        // No row: the listing is gone, or was claimed or went pending after
        // the pre-check. The token is already burned, so this fails closed.
        if (!bound) return yield* Effect.fail(new ClaimInvalid());
        yield* Effect.sync(() => metricVendorClaimReview("requested"));
        // The operator's signal: no ops address is configured, so a log line
        // (Workers Logs) and the daily pending count are what tell them.
        yield* Effect.logWarning("vendor claim awaiting operator review").pipe(
          Effect.annotateLogs({ directoryVendorId: bound.id }),
        );
        return toDto(bound, categories);
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
          const t = likeContains(filter.q.trim());
          conds.push(
            sql`(lower(${directoryVendors.name}) LIKE lower(${t}) ESCAPE '\\' OR lower(coalesce(${directoryVendors.description}, '')) LIKE lower(${t}) ESCAPE '\\')`,
          );
        }
        if (filter.location && filter.location.trim() !== "") {
          const t = likeContains(filter.location.trim());
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
        Effect.catchDefect(() =>
          Effect.gen(function* () {
            yield* Effect.logWarning("cire.directory.browse failed").pipe(
              Effect.annotateLogs({ weddingId }),
            );
            return { listings: [] as BrowseListingDto[], total: 0 };
          }),
        ),
      );
    },

    /**
     * A live listing, and whether `weddingId`'s CRM already links it (the
     * same `inWedding` test `browse` makes). Null when the id is missing or
     * not live.
     */
    getLiveListingById(
      id: string,
      weddingId: string,
    ): Effect.Effect<LiveListingInWeddingDto | null, never, DbService> {
      return Effect.gen(function* () {
        const db = yield* DbService;
        // One statement, hit or miss: the listing LEFT JOINed to its
        // categories, with the wedding-link EXISTS as a column. An id that is
        // missing or not live returns no rows, so a miss never reads
        // `directory_vendor_categories`, and a hit pays no second query. A hit
        // comes back as one row per category (a listing with none still gives
        // one row, its `category` null); the listing columns and the EXISTS
        // repeat on each, and the category set is small.
        const rows = yield* dbQuery(() =>
          db
            .select({
              listing: directoryVendors,
              category: directoryVendorCategories.category,
              inWedding: sql<number>`EXISTS (SELECT 1 FROM ${vendors} v WHERE v.wedding_id = ${weddingId} AND v.directory_vendor_id = "directory_vendors"."id")`,
            })
            .from(directoryVendors)
            .leftJoin(
              directoryVendorCategories,
              eq(directoryVendorCategories.directoryVendorId, directoryVendors.id),
            )
            .where(and(eq(directoryVendors.id, id), eq(directoryVendors.listed, "live")))
            .all(),
        );
        const [first] = rows;
        if (!first) return null;
        const categories = rows.flatMap((r) => (r.category === null ? [] : [r.category]));
        return { ...toDto(first.listing, categories), inWedding: Boolean(first.inWedding) };
      }).pipe(Effect.withSpan("cire.directory.getLiveListingById"));
    },
  };
}

/**
 * Default singleton using prod config. Import `createDirectoryService` in tests
 * to inject a stub `vendorPortalOrigin`.
 */
export const directoryService = createDirectoryService();
