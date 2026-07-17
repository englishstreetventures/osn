import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { SERVICE_CATEGORIES } from "../lib/service-categories";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { runCire } from "../observability";
import { AddFromDirectoryBody } from "../schemas/vendors";
import { directoryService } from "../services/directory";
import { vendorsService } from "../services/vendors";

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
                  const listing = yield* directoryService.getLiveListingById(
                    params.directoryVendorId,
                  );
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
                  Effect.catchAllDefect((d) =>
                    isUniqueViolation(d) ? conflict(set) : internal(set),
                  ),
                ),
              );
            },
            manualParse,
          ),
      ),
    );
