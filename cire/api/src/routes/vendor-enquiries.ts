import { directoryVendors, vendorEnquiries, vendors, weddings } from "@cire/db";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { eq, inArray } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { runCire } from "../observability";
import type { createEnquiryService, EnquiryRow } from "../services/enquiries";
import type { OsnOrgMembershipResolver, OsnProfileOrgsResolver } from "../services/osn-bridge";

// Sentinel parse hook: stops Elysia consuming the body so the handler parses it
// by hand — a malformed payload degrades to the schema's 400. Same idiom as the
// other write routes.
const manualParse = { parse: () => ({}) };

/** POST /enquiries/:id/messages — reply. */
const ReplyBody = Schema.Struct({
  message: Schema.String.pipe(Schema.minLength(1)),
});

/** POST /enquiries/:id/quote — structured quote. */
const QuoteBody = Schema.Struct({
  amountMinor: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  note: Schema.optional(Schema.String),
});

export interface VendorEnquiryRoutesDeps {
  enquiryService: ReturnType<typeof createEnquiryService>;
  /**
   * Resolves whether a profile is a member of the org that owns a listing.
   * Null membership → 404 (cross-tenant, no enumeration) — mirrors the vendor
   * portal org-gate but resolves the org from the enquiry's listing.
   */
  orgMembership: OsnOrgMembershipResolver;
  /**
   * Resolves the org ids a profile belongs to, used to SCOPE the list query to
   * the caller's own tenants BEFORE the scan (no cross-tenant full-table read,
   * no per-org membership fan-out). Fail-soft (empty array) on any ARC/infra
   * failure — the list then degrades to empty rather than falling back to an
   * unscoped scan.
   */
  profileOrgs: OsnProfileOrgsResolver;
  limiter: RateLimiterBackend;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const internal = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 500;
    return { error: "Internal error" };
  });

const notFound = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "enquiry_not_found" };
  });

function unauthorisedSync(set: { status?: number | string }) {
  set.status = 401;
  return { error: "unauthorised" };
}

const zapUnavailable = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 503;
    return { error: "vendor_chat_unavailable" };
  });

const awaitingVendor = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 409;
    return { error: "awaiting_vendor" };
  });

const badRequest = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 400;
    return { error: "Missing or invalid fields" };
  });

/** The mapped tagged errors shared by every write handler. */
const catchEnquiryTags = (set: { status?: number | string }) => ({
  EnquiryNotFound: () => notFound(set),
  EnquiryAwaitingVendor: () => awaitingVendor(set),
  ZapUnavailable: () => zapUnavailable(set),
});

/**
 * ORG GATE. Load the enquiry by id → its listing's `ownerOrgId` →
 * `orgMembership(ownerOrgId, profileId)`. Any of {missing enquiry, missing
 * listing, unowned listing, null membership} resolves to `null` so the caller
 * answers 404 — a cross-tenant id never reveals that the row exists, and no
 * membership → 404 (NOT 403), so an outsider can't enumerate other tenants'
 * enquiries.
 */
const loadEnquiryForVendor = (
  db: Db,
  orgMembership: OsnOrgMembershipResolver,
  enquiryId: string,
  profileId: string,
): Effect.Effect<EnquiryRow | null, never, DbService> =>
  Effect.gen(function* () {
    const [row] = yield* dbQuery(() =>
      db
        .select({
          enquiry: vendorEnquiries,
          ownerOrgId: directoryVendors.ownerOrgId,
        })
        .from(vendorEnquiries)
        .innerJoin(directoryVendors, eq(vendorEnquiries.directoryVendorId, directoryVendors.id))
        .where(eq(vendorEnquiries.id, enquiryId))
        .all(),
    );
    const found = row as { enquiry: EnquiryRow; ownerOrgId: string | null } | undefined;
    if (!found || !found.ownerOrgId) return null;
    const role = yield* Effect.promise(() => orgMembership(found.ownerOrgId!, profileId));
    if (!role) return null;
    return found.enquiry;
  });

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Vendor-facing enquiry routes (Vendors S4), mounted at /api/vendor. Every route
 * is osnAuth()-gated; the per-enquiry org gate resolves the owning org from the
 * enquiry's listing and 404s on a cross-tenant id (no enumeration). Writes
 * (reply / quote) run behind a per-user limiter (spam control §96).
 *
 *   GET  /api/vendor/enquiries                — enquiries across the caller's claimed listings
 *   GET  /api/vendor/enquiries/:id/messages   — thread (org-scoped; 404 cross-tenant)
 *   POST /api/vendor/enquiries/:id/messages   — reply (limiter) → 201
 *   POST /api/vendor/enquiries/:id/quote      — structured quote (limiter) → 201
 *
 * Tagged-error mapping (same as the couple-side routes): EnquiryNotFound→404,
 * EnquiryAwaitingVendor→409 `awaiting_vendor`, ZapUnavailable→503, parse→400.
 */
export function createVendorEnquiriesRoutes(
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  deps: VendorEnquiryRoutesDeps,
) {
  const { enquiryService, orgMembership, profileOrgs, limiter } = deps;

  return (
    new Elysia({ prefix: "/api/vendor" })
      .use(osnAuth(osnAuthOptions))
      // GET /enquiries — enquiries across the caller's claimed listings.
      // SCOPED to the caller's own org(s) BEFORE the scan: resolve the caller's
      // org ids, then read only enquiries whose listing's `owner_org_id` is one
      // of them (indexed by `directory_vendors_owner_idx`). No cross-tenant
      // full-table read, no per-org membership fan-out. Fail-closed: if the
      // profile-orgs resolver yields no orgs (absent ARC key / infra failure),
      // the list is empty — never an unscoped scan.
      .get("/enquiries", async ({ set, ...ctx }) => {
        const profileId = (ctx as unknown as { osnProfileId?: string }).osnProfileId;
        if (!profileId) return unauthorisedSync(set);

        return runCire(
          Effect.gen(function* () {
            const callerOrgIds = yield* Effect.promise(() => profileOrgs(profileId));
            // No memberships (or resolver unavailable) → empty, never an
            // unscoped scan. Preserves the "any member of the owner org sees the
            // org's enquiries" semantic: the DB filter below keys on membership.
            if (callerOrgIds.length === 0) return { enquiries: [] };

            const rows = yield* dbQuery(() =>
              db
                .select({
                  enquiry: vendorEnquiries,
                  vendorName: vendors.name,
                  category: vendors.category,
                  weddingName: weddings.displayName,
                })
                .from(vendorEnquiries)
                .innerJoin(
                  directoryVendors,
                  eq(vendorEnquiries.directoryVendorId, directoryVendors.id),
                )
                .innerJoin(vendors, eq(vendorEnquiries.vendorId, vendors.id))
                .innerJoin(weddings, eq(vendorEnquiries.weddingId, weddings.id))
                .where(inArray(directoryVendors.ownerOrgId, callerOrgIds))
                .all(),
            );
            const all = rows as Array<{
              enquiry: EnquiryRow;
              vendorName: string;
              category: string;
              weddingName: string;
            }>;

            const enquiries = all
              .map((r) => ({
                ...toVendorDto(r.enquiry),
                vendorName: r.vendorName,
                category: r.category,
                weddingName: r.weddingName,
              }))
              .sort((a, b) => b.lastMessageAt - a.lastMessageAt);

            return { enquiries };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchAllDefect(() => internal(set)),
          ),
        );
      })
      // GET /enquiries/:id/messages — thread (org-scoped).
      .get("/enquiries/:id/messages", async ({ params, set, ...ctx }) => {
        const profileId = (ctx as unknown as { osnProfileId?: string }).osnProfileId;
        if (!profileId) return unauthorisedSync(set);

        return runCire(
          Effect.gen(function* () {
            const enquiry = yield* loadEnquiryForVendor(db, orgMembership, params.id, profileId);
            if (!enquiry) return yield* notFound(set);
            const messages = yield* enquiryService.getMessages(enquiry);
            return { messages };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTags(catchEnquiryTags(set)),
            Effect.catchAllDefect(() => internal(set)),
          ),
        );
      })
      // Writes — reply + quote, behind the per-user limiter.
      .use(rateLimitMiddlewareByUser(limiter))
      .post(
        "/enquiries/:id/messages",
        async ({ params, request, set, ...ctx }) => {
          const profileId = (ctx as unknown as { osnProfileId?: string }).osnProfileId;
          if (!profileId) return unauthorisedSync(set);
          const raw: unknown = await request.json().catch(() => null);

          return runCire(
            Effect.gen(function* () {
              const body = yield* Schema.decodeUnknown(ReplyBody)(raw);
              const enquiry = yield* loadEnquiryForVendor(db, orgMembership, params.id, profileId);
              if (!enquiry) return yield* notFound(set);
              const message = yield* enquiryService.reply({
                enquiry,
                senderProfileId: profileId,
                senderName: "The vendor",
                // The reply email targets the couple; recipient resolution is
                // left to a later UI pass — null suppresses the notify without
                // failing the reply.
                recipientEmail: null,
                recipientName: "there",
                message: body.message,
              });
              set.status = 201;
              return { message };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTag("ParseError", () => badRequest(set)),
              Effect.catchTags(catchEnquiryTags(set)),
              Effect.catchAllDefect(() => internal(set)),
            ),
          );
        },
        manualParse,
      )
      .post(
        "/enquiries/:id/quote",
        async ({ params, request, set, ...ctx }) => {
          const profileId = (ctx as unknown as { osnProfileId?: string }).osnProfileId;
          if (!profileId) return unauthorisedSync(set);
          const raw: unknown = await request.json().catch(() => null);

          return runCire(
            Effect.gen(function* () {
              const body = yield* Schema.decodeUnknown(QuoteBody)(raw);
              const enquiry = yield* loadEnquiryForVendor(db, orgMembership, params.id, profileId);
              if (!enquiry) return yield* notFound(set);
              // Resolve the CRM vendor's name for the quote email/chat body.
              const [vendorRow] = yield* dbQuery(() =>
                db
                  .select({ name: vendors.name })
                  .from(vendors)
                  .where(eq(vendors.id, enquiry.vendorId))
                  .all(),
              );
              const vendorName = (vendorRow as { name: string } | undefined)?.name ?? "Vendor";
              // The quote is formatted in the wedding's own currency (NOT NULL,
              // default 'AUD'); only the display string is affected — stored
              // `quoted_minor` is currency-agnostic integer cents.
              const [weddingRow] = yield* dbQuery(() =>
                db
                  .select({ currency: weddings.currency })
                  .from(weddings)
                  .where(eq(weddings.id, enquiry.weddingId))
                  .all(),
              );
              const currency = (weddingRow as { currency: string } | undefined)?.currency ?? "AUD";
              const enquiryDto = yield* enquiryService.quote({
                enquiry,
                senderProfileId: profileId,
                amountMinor: body.amountMinor,
                ...(body.note !== undefined ? { note: body.note } : {}),
                // Recipient resolution deferred; null suppresses the notify.
                coupleEmail: null,
                vendorName,
                currency,
              });
              set.status = 201;
              return { enquiry: enquiryDto };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTag("ParseError", () => badRequest(set)),
              Effect.catchTags(catchEnquiryTags(set)),
              Effect.catchAllDefect(() => internal(set)),
            ),
          );
        },
        manualParse,
      )
  );
}

// Local DTO projection so the list route doesn't leak the raw Drizzle row
// (Date timestamps, pendingBody). Mirrors the enquiry service's toDto.
function toVendorDto(r: EnquiryRow) {
  return {
    id: r.id,
    weddingId: r.weddingId,
    directoryVendorId: r.directoryVendorId,
    vendorId: r.vendorId,
    zapChatId: r.zapChatId,
    status: r.status,
    createdBy: r.createdBy,
    quotedMinor: r.quotedMinor,
    lastMessageAt: r.lastMessageAt.getTime(),
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}
