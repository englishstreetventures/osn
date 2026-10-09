import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService, driverErrorText } from "../db";
import type { Db } from "../db";
import { isServiceCategory } from "../lib/service-categories";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { weddingTier } from "../middleware/wedding-tier";
import { runCire } from "../observability";
import { AddFromDirectoryBody } from "../schemas/vendors";
import { directoryService } from "../services/directory";
import { vendorsService } from "../services/vendors";

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

/**
 * Whether a failed add is the listing already in the wedding: the
 * `vendors_wedding_directory_uniq` index refusing the insert, which happens
 * when a second add lands between this one's listing read and its insert. The
 * read's `inWedding` column answers the common case; this maps the rare
 * concurrent collision to 409 instead of 500.
 *
 * Read through `driverErrorText`: on D1 the database's reason sits on the
 * error's `cause`, under drizzle's `Failed query: <statement>`. Matched on the
 * database's unquoted `table.column` wording, which the statement, quoting
 * every name, never contains.
 */
export function isDirectoryDuplicate(defect: unknown): boolean {
  const text = driverErrorText(defect);
  return text.includes("UNIQUE constraint failed") && text.includes("vendors.directory_vendor_id");
}

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
        .use(weddingTier(db, "crimson"))
        .use(rateLimitMiddlewareByUser(limiter))
        .get("/directory", async ({ weddingId, query, set }) => {
          if (!weddingId) return internalSync(set);
          const q = query as Record<string, string | undefined>;
          const category = q.category && isServiceCategory(q.category) ? q.category : null;
          return runCire(
            directoryService
              .browse(weddingId, {
                category,
                q: q.q ?? null,
                location: q.location ?? null,
                limit: clampInt(q.limit, 24, 1, 50),
                // OFFSET is O(offset) in SQLite — it walks and discards. The
                // old 1e6 ceiling let a single request force a million-row
                // walk; 10k (200 pages of 50) is far past any UI reach while
                // the keyed-cursor rework remains the real fix.
                offset: clampInt(q.offset, 0, 0, 10_000),
              })
              .pipe(
                Effect.provideService(DbService, db),
                Effect.catchDefect(() => internal(set)),
              ),
          );
        }),
    );

export const createVendorDirectoryWriteRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingEditor(db))
        .use(weddingTier(db, "crimson"))
        .use(rateLimitMiddlewareByUser(limiter))
        .post(
          "/directory/:directoryVendorId/add",
          async ({ weddingId, params, request, set }) => {
            if (!weddingId) return internalSync(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(AddFromDirectoryBody)(raw);
                const listing = yield* directoryService.getLiveListingById(
                  params.directoryVendorId,
                  weddingId,
                );
                if (!listing) return yield* notFound(set);
                if (!listing.categories.includes(body.category)) return yield* badRequest(set);
                if (listing.inWedding) return yield* conflict(set);
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
                Effect.catchTag("SchemaError", () => badRequest(set)),
                Effect.catchDefect((d) =>
                  isDirectoryDuplicate(d) ? conflict(set) : internal(set),
                ),
              ),
            );
          },
          manualParse,
        ),
    );
