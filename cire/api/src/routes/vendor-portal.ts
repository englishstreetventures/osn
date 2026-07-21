import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { runCire } from "../observability";
import { ConsumeClaimBody, UpsertListingBody } from "../schemas/vendors";
import type { createDirectoryService } from "../services/directory";
import type { createEnquiryService } from "../services/enquiries";
import type { OsnOrgMembershipResolver } from "../services/osn-bridge";

// Sentinel parse hook — the handler parses by hand so a malformed payload
// degrades to the schema's 400 (same idiom as the other organiser write routes).
const manualParse = { parse: () => ({}) };

const badRequest = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 400;
    return { error: "Missing or invalid fields" };
  });

const claimInvalid = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 410;
    return { error: "claim_invalid" };
  });

const internal = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 500;
    return { error: "Internal error" };
  });

function unauthorisedSync(set: { status?: number | string }) {
  set.status = 401;
  return { error: "unauthorised" };
}

function forbiddenNotMember(set: { status?: number | string }) {
  set.status = 403;
  return { error: "not_org_member" };
}

export interface VendorPortalDeps {
  directoryService: ReturnType<typeof createDirectoryService>;
  orgMembership: OsnOrgMembershipResolver;
  /**
   * Couple-side enquiry BFF service. After a successful claim we flush any
   * enquiries buffered against the just-claimed listing (`onVendorClaimed`) —
   * best-effort (its error channel is `never`), so a flush hiccup never fails
   * the claim itself.
   */
  enquiryService: ReturnType<typeof createEnquiryService>;
}

/**
 * Vendor-facing portal routes (Vendors Slice 1, platform Phase 2):
 *
 *   GET  /api/vendor/claims/:token              — preview (no auth required)
 *   POST /api/vendor/claims/:token/consume      — consume claim (osnAuth + org member gate)
 *   GET  /api/vendor/orgs/:orgId/listing        — read listing (osnAuth + org member gate)
 *   PUT  /api/vendor/orgs/:orgId/listing        — upsert listing (osnAuth + org member gate)
 *
 * Mounted at /api/vendor (NOT under the wedding group — these are org-scoped,
 * not wedding-scoped). The claim preview is deliberately unauthenticated so the
 * vendor claim page can render the listing name before the vendor signs in.
 *
 * The org-member gate for consume and org/* routes is applied inline in each
 * handler (rather than as a group middleware plugin) because:
 *  - For /consume: orgId comes from the request body, not a URL param, so it
 *    cannot be derived at group level.
 *  - For /orgs/:orgId/*: inline is consistent and avoids multiple osnAuth
 *    plugin instances on the same Elysia instance.
 */
export function createVendorPortalRoutes(
  db: Db,
  deps: VendorPortalDeps,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) {
  const { directoryService, orgMembership, enquiryService } = deps;

  return (
    new Elysia({ prefix: "/api/vendor" })
      .use(rateLimitMiddleware(limiter))
      // ── Public: claim preview (no auth) ────────────────────────────────────
      .get("/claims/:token", async ({ params, set }) => {
        return runCire(
          directoryService.getClaimPreview(params.token).pipe(
            Effect.provideService(DbService, db),
            Effect.map((preview) => {
              if (!preview) {
                set.status = 404;
                return { error: "claim_not_found" };
              }
              return { listing: preview };
            }),
            Effect.catchAllDefect(() => internal(set)),
          ),
        );
      })
      // ── Auth-gated routes ───────────────────────────────────────────────────
      .use(osnAuth(osnAuthOptions))
      // POST /api/vendor/claims/:token/consume
      // orgId comes from the body — gate is applied inline.
      .post(
        "/claims/:token/consume",
        async ({ params, request, set, ...ctx }) => {
          const profileId = (ctx as unknown as { osnProfileId?: string }).osnProfileId;
          if (!profileId) return unauthorisedSync(set);

          const raw: unknown = await request.json().catch(() => null);

          return runCire(
            Effect.gen(function* () {
              const body = yield* Schema.decodeUnknown(ConsumeClaimBody)(raw);
              const { orgId } = body;

              // Org-member gate (inline: orgId from body, not URL)
              const role = yield* Effect.promise(() => orgMembership(orgId, profileId));
              if (!role) return forbiddenNotMember(set);

              const listing = yield* directoryService.consumeClaim(params.token, orgId, profileId);

              // Claim-flush: provision + send any enquiries buffered against this
              // listing while it was unclaimed. Best-effort (error channel
              // `never`) — a flush failure is logged inside the service and must
              // not fail the claim, which already succeeded above.
              yield* enquiryService.onVendorClaimed({
                directoryVendorId: listing.id,
                vendorProfileId: profileId,
              });

              return { listing };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTag("ParseError", () => badRequest(set)),
              Effect.catchTag("ClaimInvalid", () => claimInvalid(set)),
              Effect.catchAllDefect(() => internal(set)),
            ),
          );
        },
        manualParse,
      )
      // GET /api/vendor/orgs/:orgId/listing
      .get("/orgs/:orgId/listing", async ({ params, set, ...ctx }) => {
        const profileId = (ctx as unknown as { osnProfileId?: string }).osnProfileId;
        if (!profileId) return unauthorisedSync(set);

        const role = await orgMembership(params.orgId, profileId);
        if (!role) return forbiddenNotMember(set);

        return runCire(
          directoryService.getListingByOrg(params.orgId).pipe(
            Effect.provideService(DbService, db),
            Effect.map((listing) => ({ listing })),
            Effect.catchAllDefect(() => internal(set)),
          ),
        );
      })
      // PUT /api/vendor/orgs/:orgId/listing
      .put(
        "/orgs/:orgId/listing",
        async ({ params, request, set, ...ctx }) => {
          const profileId = (ctx as unknown as { osnProfileId?: string }).osnProfileId;
          if (!profileId) return unauthorisedSync(set);

          const role = await orgMembership(params.orgId, profileId);
          if (!role) return forbiddenNotMember(set);

          const raw: unknown = await request.json().catch(() => null);

          return runCire(
            Effect.gen(function* () {
              const body = yield* Schema.decodeUnknown(UpsertListingBody)(raw);
              const listing = yield* directoryService.upsertListingForOrg(params.orgId, {
                name: body.name,
                description: body.description ?? null,
                email: body.email ?? null,
                phone: body.phone ?? null,
                website: body.website ?? null,
                instagram: body.instagram ?? null,
                locationText: body.locationText ?? null,
                priceBand: body.priceBand ?? null,
                priceMinMinor: body.priceMinMinor ?? null,
                priceMaxMinor: body.priceMaxMinor ?? null,
                categories: [...body.categories],
              });
              return { listing };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTag("ParseError", () => badRequest(set)),
              Effect.catchAllDefect(() => internal(set)),
            ),
          );
        },
        manualParse,
      )
  );
}
