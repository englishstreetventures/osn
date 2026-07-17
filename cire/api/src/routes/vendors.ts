import { EmailService } from "@shared/email";
import { Effect, Layer, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { sendClaimInviteEmail } from "../lib/vendor-email";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { runCire } from "../observability";
import {
  CreateVendorBody,
  ReorderVendorsBody,
  SeedListingBody,
  UpdateVendorBody,
} from "../schemas/vendors";
import { createDirectoryService } from "../services/directory";
import { vendorsService } from "../services/vendors";

// Sentinel parse hook — the handler parses by hand so a malformed payload
// degrades to the schema's 400 (same idiom as the other organiser write routes).
const manualParse = { parse: () => ({}) };

const badRequest = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 400;
    return { error: "Missing or invalid fields" };
  });

const vendorNotFound = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "vendor_not_found" };
  });

const internal = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 500;
    return { error: "Internal error" };
  });

function internalSync(set: { status?: number | string }) {
  set.status = 500;
  return { error: "Internal error" };
}

export interface VendorWriteDeps {
  directoryService: ReturnType<typeof createDirectoryService>;
  emailLayer: Layer.Layer<EmailService>;
}

/**
 * Vendor CRM — READ surface (platform Phase 1):
 *
 *   GET /api/organiser/weddings/:weddingId/vendors  (weddingMember — any role incl. viewer)
 *
 * Split from the write factory so the read gate (weddingMember) never
 * cross-contaminates the write gates. Mirrors createBudgetReadRoutes.
 */
export const createVendorReadRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.use(weddingMember(db)).get("/vendors", async ({ weddingId, set }) => {
        if (!weddingId) return internalSync(set);
        return runCire(
          vendorsService.list(weddingId).pipe(
            Effect.map((vendors) => ({ vendors })),
            Effect.provideService(DbService, db),
            Effect.catchAllDefect(() => internal(set)),
          ),
        );
      }),
    );

/**
 * Vendor CRM — WRITE surface (platform Phase 1):
 *
 *   POST   /vendors                              (weddingEditor) — create
 *   POST   /vendors/reorder                      (weddingEditor) — reorder (BEFORE /:vendorId)
 *   PATCH  /vendors/:vendorId                    (weddingEditor) — update
 *   DELETE /vendors/:vendorId                    (weddingEditor) — remove
 *   POST   /vendors/:vendorId/list-in-directory  (weddingEditor) — seed listing + claim invite
 *
 * A viewer gets 403 `read_only_role` on all writes. The service re-scopes every
 * write by wedding_id, so a cross-tenant id 404s (`vendor_not_found`).
 *
 * NOTE `/vendors/reorder` is registered BEFORE `/vendors/:vendorId` so the
 * literal wins over the param.
 *
 * The list-in-directory handler fires a best-effort claim-invite email via
 * `sendClaimInviteEmail` (error channel is `never`). The route ALWAYS returns
 * `{ directoryVendorId, claimUrl }` regardless of email delivery.
 */
export const createVendorWriteRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  deps: VendorWriteDeps,
) => {
  const { directoryService, emailLayer } = deps;

  return new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.guard((write) =>
        write
          .use(weddingEditor(db))
          .post(
            "/vendors",
            async ({ weddingId, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(CreateVendorBody)(raw);
                  const vendor = yield* vendorsService.create({
                    weddingId,
                    name: body.name,
                    category: body.category,
                    status: body.status,
                    contactName: body.contactName ?? null,
                    email: body.email ?? null,
                    phone: body.phone ?? null,
                    notes: body.notes ?? null,
                    quotedMinor: body.quotedMinor ?? null,
                  });
                  return { vendor };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          )
          // Register literal /vendors/reorder BEFORE /vendors/:vendorId
          .post(
            "/vendors/reorder",
            async ({ weddingId, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(ReorderVendorsBody)(raw);
                  yield* vendorsService.reorder(weddingId, body.status, body.orderedIds);
                  return { ok: true as const };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          )
          .patch(
            "/vendors/:vendorId",
            async ({ weddingId, params, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(UpdateVendorBody)(raw);
                  const vendor = yield* vendorsService.update(weddingId, params.vendorId, {
                    name: body.name,
                    category: body.category,
                    status: body.status,
                    contactName: body.contactName,
                    email: body.email,
                    phone: body.phone,
                    notes: body.notes,
                    quotedMinor: body.quotedMinor,
                  });
                  return { vendor };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchTag("VendorNotInWedding", () => vendorNotFound(set)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          )
          .delete("/vendors/:vendorId", async ({ weddingId, params, set }) => {
            if (!weddingId) return internalSync(set);
            return runCire(
              vendorsService.remove(weddingId, params.vendorId).pipe(
                Effect.map(() => ({ ok: true as const })),
                Effect.provideService(DbService, db),
                Effect.catchTag("VendorNotInWedding", () => vendorNotFound(set)),
                Effect.catchAllDefect(() => internal(set)),
              ),
            );
          })
          .post(
            "/vendors/:vendorId/list-in-directory",
            async ({ weddingId, params, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(SeedListingBody)(raw);
                  const result = yield* directoryService.seedFromCrm(weddingId, params.vendorId, {
                    name: body.name,
                    email: body.email,
                    description: body.description ?? null,
                    phone: body.phone ?? null,
                    website: body.website ?? null,
                    instagram: body.instagram ?? null,
                    locationText: body.locationText ?? null,
                    priceBand: null,
                    priceMinMinor: null,
                    priceMaxMinor: null,
                    categories: [...body.categories],
                  });
                  // Best-effort claim invite email — error channel is `never`,
                  // so providing the layer and running cannot fail the response.
                  yield* sendClaimInviteEmail({
                    to: body.email,
                    claimUrl: result.claimUrl,
                    vendorName: body.name,
                  }).pipe(Effect.provide(emailLayer));
                  return {
                    directoryVendorId: result.directoryVendorId,
                    claimUrl: result.claimUrl,
                  };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchTag("VendorNotInWedding", () => vendorNotFound(set)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          ),
      ),
    );
};
