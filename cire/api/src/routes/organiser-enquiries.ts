import { directoryVendors, vendorEnquiries, vendors, weddings } from "@cire/db";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { isServiceCategory } from "../lib/service-categories";
import type { ServiceCategory } from "../lib/service-categories";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { runCire } from "../observability";
import type { createDirectoryService } from "../services/directory";
import type { createEnquiryService, EnquiryRow } from "../services/enquiries";

// Sentinel parse hook: stops Elysia from consuming the body so the handler can
// parse it by hand — a malformed payload degrades to the schema's 400 instead
// of Elysia's parser error. Same idiom as the other organiser routes.
const manualParse = { parse: () => ({}) };

/** POST /enquiries — open a thread. */
const OpenBody = Schema.Struct({
  directoryVendorId: Schema.String.pipe(Schema.minLength(1)),
  category: Schema.String.pipe(Schema.minLength(1)),
  message: Schema.String.pipe(Schema.minLength(1)),
});

/** POST /enquiries/:id/messages — reply. */
const ReplyBody = Schema.Struct({
  message: Schema.String.pipe(Schema.minLength(1)),
});

export interface EnquiryRoutesDeps {
  enquiryService: ReturnType<typeof createEnquiryService>;
  limiter: RateLimiterBackend;
  /**
   * Directory service — used to mint the vendor's claim token for the
   * enquiry-new email via the canonical `${vendorPortalOrigin}/claim?token=…`
   * flow (`issueClaimForListing`). Never hand-roll a claim URL here; the CTA
   * must be a real, consumable link on the vendor portal.
   */
  directoryService: ReturnType<typeof createDirectoryService>;
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

/**
 * Re-load an enquiry by id AND assert it belongs to `weddingId` (from the gate).
 * A cross-tenant id (another wedding's enquiry, or a missing one) resolves to
 * `null` → the caller maps it to 404, never leaking that the row exists.
 */
const loadEnquiryInWedding = (
  weddingId: string,
  enquiryId: string,
): Effect.Effect<EnquiryRow | null, never, DbService> =>
  Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = yield* dbQuery(() =>
      db
        .select()
        .from(vendorEnquiries)
        .where(and(eq(vendorEnquiries.id, enquiryId), eq(vendorEnquiries.weddingId, weddingId)))
        .all(),
    );
    return (row as EnquiryRow | undefined) ?? null;
  });

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Couple-side vendor-enquiry routes (Vendors S4), mounted under /api/organiser.
 * osnAuth() gates every route. The per-wedding subtree splits by authorisation:
 *  - READS (`GET /enquiries`, `GET /enquiries/:id/messages`) use
 *    `weddingMember()` — owner OR any co-host (editor AND viewer).
 *  - WRITES (`POST /enquiries`, reply, add-to-budget) use `weddingEditor()`
 *    (owner or editor; a viewer co-host gets 403 `read_only_role`) behind a
 *    per-user limiter (spam control §96).
 *
 * Every handler that takes an `:id` re-loads the enquiry scoped to the gated
 * `weddingId` and answers 404 on a mismatch (cross-tenant hidden). Service
 * tagged errors map: EnquiryNotFound→404, EnquiryAwaitingVendor→409
 * `awaiting_vendor`, ZapUnavailable→503.
 */
export const createOrganiserEnquiriesRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  deps: EnquiryRoutesDeps,
) => {
  const { enquiryService, limiter, directoryService } = deps;

  return (
    new Elysia({ prefix: "/api/organiser" })
      .use(osnAuth(osnAuthOptions))
      // Reads — owner OR any co-host (weddingMember).
      .group("/weddings/:weddingId", (group) =>
        group
          .use(weddingMember(db))
          .get("/enquiries", ({ weddingId, set }) => {
            if (!weddingId) return internalSync(set);
            return runCire(
              enquiryService.list(weddingId).pipe(
                Effect.provideService(DbService, db),
                Effect.map((enquiries) => ({ enquiries })),
                Effect.catchAllDefect(() => internal(set)),
              ),
            );
          })
          .get("/enquiries/:id/messages", ({ weddingId, params, set }) => {
            if (!weddingId) return internalSync(set);
            return runCire(
              Effect.gen(function* () {
                const enquiry = yield* loadEnquiryInWedding(weddingId, params.id);
                if (!enquiry) return yield* notFound(set);
                const messages = yield* enquiryService.getMessages(enquiry);
                return { messages };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  ZapUnavailable: () =>
                    Effect.sync(() => {
                      set.status = 503;
                      return { error: "vendor_chat_unavailable" };
                    }),
                  // getMessages never fails EnquiryNotFound/AwaitingVendor, but
                  // the union requires exhaustive tags — map defensively.
                  EnquiryNotFound: () => notFound(set),
                  EnquiryAwaitingVendor: () => notFound(set),
                }),
                Effect.catchAllDefect(() => internal(set)),
              ),
            );
          }),
      )
      // Writes — owner or editor (weddingEditor; viewer → 403 read_only_role),
      // behind a per-user limiter. Split into a sibling group so the write
      // limiter never gates the reads above.
      .group("/weddings/:weddingId", (group) =>
        group
          .use(weddingEditor(db))
          .use(rateLimitMiddlewareByUser(limiter))
          .post(
            "/enquiries",
            async ({ weddingId, osnProfileId, request, set }) => {
              if (!weddingId || !osnProfileId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(OpenBody)(raw);
                  // Route supplies the email fields + claim URL from the listing.
                  const db_ = yield* DbService;
                  const [listing] = yield* dbQuery(() =>
                    db_
                      .select({
                        email: directoryVendors.email,
                        leadForwardEmail: directoryVendors.leadForwardEmail,
                      })
                      .from(directoryVendors)
                      .where(eq(directoryVendors.id, body.directoryVendorId))
                      .all(),
                  );
                  const [wedding] = yield* dbQuery(() =>
                    db_
                      .select({ displayName: weddings.displayName })
                      .from(weddings)
                      .where(eq(weddings.id, weddingId))
                      .all(),
                  );
                  const listingRow = listing as
                    | { email: string | null; leadForwardEmail: string | null }
                    | undefined;
                  // Claim CTA: mint a single-use token on the listing via the
                  // canonical directory flow → `${vendorPortalOrigin}/claim?token=…`,
                  // consumable by `POST /api/vendor/claims/:token/consume`. Returns
                  // null for an already-claimed (or unknown) listing, in which case
                  // the enquiry-new email omits the CTA anyway (open() only sends it
                  // when unclaimed). Never hand-roll a `?listing=` URL.
                  const claim = yield* directoryService.issueClaimForListing(
                    body.directoryVendorId,
                  );
                  const enquiry = yield* enquiryService.open({
                    weddingId,
                    weddingName:
                      (wedding as { displayName: string } | undefined)?.displayName ?? "A couple",
                    directoryVendorId: body.directoryVendorId,
                    category: body.category,
                    message: body.message,
                    createdBy: osnProfileId,
                    vendorEmail: listingRow?.email ?? null,
                    leadForwardEmail: listingRow?.leadForwardEmail ?? null,
                    claimUrl: claim?.claimUrl ?? "",
                  });
                  set.status = 201;
                  return { enquiry };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () =>
                    Effect.sync(() => {
                      set.status = 400;
                      return { error: "Missing or invalid fields" };
                    }),
                  ),
                  Effect.catchTags({
                    EnquiryNotFound: () => notFound(set),
                    EnquiryAwaitingVendor: () =>
                      Effect.sync(() => {
                        set.status = 409;
                        return { error: "awaiting_vendor" };
                      }),
                    ZapUnavailable: () =>
                      Effect.sync(() => {
                        set.status = 503;
                        return { error: "vendor_chat_unavailable" };
                      }),
                  }),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          )
          .post(
            "/enquiries/:id/messages",
            async ({ weddingId, osnProfileId, params, request, set }) => {
              if (!weddingId || !osnProfileId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(ReplyBody)(raw);
                  const enquiry = yield* loadEnquiryInWedding(weddingId, params.id);
                  if (!enquiry) return yield* notFound(set);
                  const message = yield* enquiryService.reply({
                    enquiry,
                    senderProfileId: osnProfileId,
                    senderName: "The couple",
                    // The reply email targets the vendor; the route has the
                    // listing email but leaves recipient resolution to the couple
                    // UI later — null suppresses the notify without failing.
                    recipientEmail: null,
                    recipientName: "there",
                    message: body.message,
                  });
                  set.status = 201;
                  return { message };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () =>
                    Effect.sync(() => {
                      set.status = 400;
                      return { error: "Missing or invalid fields" };
                    }),
                  ),
                  Effect.catchTags({
                    EnquiryNotFound: () => notFound(set),
                    EnquiryAwaitingVendor: () =>
                      Effect.sync(() => {
                        set.status = 409;
                        return { error: "awaiting_vendor" };
                      }),
                    ZapUnavailable: () =>
                      Effect.sync(() => {
                        set.status = 503;
                        return { error: "vendor_chat_unavailable" };
                      }),
                  }),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          )
          .post("/enquiries/:id/add-to-budget", ({ weddingId, params, set }) => {
            if (!weddingId) return internalSync(set);
            return runCire(
              Effect.gen(function* () {
                const enquiry = yield* loadEnquiryInWedding(weddingId, params.id);
                if (!enquiry) return yield* notFound(set);
                // Resolve the CRM vendor's name + category for the budget item.
                const db_ = yield* DbService;
                const [vendorRow] = yield* dbQuery(() =>
                  db_
                    .select({ name: vendors.name, category: vendors.category })
                    .from(vendors)
                    .where(eq(vendors.id, enquiry.vendorId))
                    .all(),
                );
                const row = vendorRow as { name: string; category: string } | undefined;
                const vendorName = row?.name ?? "Vendor";
                // The stored category is already from the closed set, but guard
                // against drift — an unknown value maps to the `other` catch-all.
                const category: ServiceCategory =
                  row && isServiceCategory(row.category) ? row.category : "other";
                const result = yield* enquiryService.addToBudget({
                  enquiry,
                  vendorName,
                  category,
                });
                set.status = 201;
                return result;
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTags({
                  EnquiryNotFound: () => notFound(set),
                  EnquiryAwaitingVendor: () => notFound(set),
                  ZapUnavailable: () =>
                    Effect.sync(() => {
                      set.status = 503;
                      return { error: "vendor_chat_unavailable" };
                    }),
                }),
                Effect.catchAllDefect(() => internal(set)),
              ),
            );
          }),
      )
  );
};

function internalSync(set: { status?: number | string }) {
  set.status = 500;
  return { error: "Internal error" };
}
