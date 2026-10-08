import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuthResolve } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { runCire } from "../observability";
import { ConsumeClaimBody, UpsertListingBody } from "../schemas/vendors";
import type { createDirectoryService } from "../services/directory";
import type { OsnOrgMembershipResolver, OsnProfileOrgsResolver } from "../services/osn-bridge";

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

const orgHasListing = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 409;
    return { error: "org_has_listing" };
  });

const awaitingConfirmation = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 409;
    return { error: "listing_awaiting_confirmation" };
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
   * The caller's OSN organisations, resolved over ARC. The portal cannot read
   * osn-api itself — it holds a cire session cookie, not an OSN token — so
   * `GET /orgs` proxies this.
   */
  profileOrgs: OsnProfileOrgsResolver;
}

/**
 * Vendor-facing portal routes (Vendors Slice 1, platform Phase 2):
 *
 *   GET  /api/vendor/claims/:token              — preview (no auth required)
 *   POST /api/vendor/claims/:token/consume      — consume claim; held for an operator (OSN sign-in + org member gate)
 *   GET  /api/vendor/orgs                       — the caller's OSN orgs (OSN sign-in)
 *   GET  /api/vendor/orgs/:orgId/listing        — read listing (OSN sign-in + org member gate)
 *   PUT  /api/vendor/orgs/:orgId/listing        — upsert listing; 409 while a claim is held (OSN sign-in + org member gate)
 *
 * Mounted at /api/vendor (NOT under the wedding group — these are org-scoped,
 * not wedding-scoped). The claim preview is deliberately unauthenticated so the
 * vendor claim page can render the listing name before the vendor signs in.
 *
 * The org-member gate for consume and org/* routes is applied inline in each
 * handler (rather than as a group middleware plugin) because:
 *  - For /consume: orgId comes from the request body, not a URL param, so it
 *    cannot be derived at group level.
 *  - For /orgs/:orgId/*: inline is consistent and mounts the OSN check once
 *    on this instance.
 *
 * The OSN check is `osnAuthResolve`, a before-handle hook, so the per-IP
 * limiter mounted first refuses a request before its organiser session is
 * looked up or its token verified.
 */
export function createVendorPortalRoutes(
  db: Db,
  deps: VendorPortalDeps,
  osnAuthOptions: OsnAuthOptions,
  limiter: RateLimiterBackend,
) {
  const { directoryService, orgMembership, profileOrgs } = deps;

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
            Effect.catchDefect(() => internal(set)),
          ),
        );
      })
      // ── Auth-gated routes ───────────────────────────────────────────────────
      .use(osnAuthResolve(osnAuthOptions))
      // POST /api/vendor/claims/:token/consume
      // orgId comes from the body — gate is applied inline.
      .post(
        "/claims/:token/consume",
        async ({ params, request, set, osnProfileId: profileId }) => {
          if (!profileId) return unauthorisedSync(set);

          const raw: unknown = await request.json().catch(() => null);

          return runCire(
            Effect.gen(function* () {
              const body = yield* Schema.decodeUnknownEffect(ConsumeClaimBody)(raw);
              const { orgId } = body;

              // Org-member gate (inline: orgId from body, not URL)
              const role = yield* Effect.promise(() => orgMembership(orgId, profileId));
              if (!role) return forbiddenNotMember(set);

              // The claim is held for an operator: the listing comes back
              // `awaitingConfirmation`, not live, and buffered enquiries stay
              // buffered until the confirm's hand-off (daily cron).
              const listing = yield* directoryService.consumeClaim(params.token, orgId, profileId);
              return { listing };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTag("SchemaError", () => badRequest(set)),
              Effect.catchTag("ClaimInvalid", () => claimInvalid(set)),
              Effect.catchTag("OrgAlreadyHasListing", () => orgHasListing(set)),
              Effect.catchDefect(() => internal(set)),
            ),
          );
        },
        manualParse,
      )
      // GET /api/vendor/orgs — the caller's OSN organisations.
      // Scoped to the caller by construction (the resolver keys on the profile
      // id from the verified session), so no extra gate applies. Fail-soft: an
      // ARC hiccup resolves to an empty list, which the portal renders as "no
      // organisations yet" rather than an error.
      .get("/orgs", async ({ set, osnProfileId: profileId }) => {
        if (!profileId) return unauthorisedSync(set);

        const organisations = await profileOrgs(profileId);
        return { organisations };
      })
      // GET /api/vendor/orgs/:orgId/listing
      .get("/orgs/:orgId/listing", async ({ params, set, osnProfileId: profileId }) => {
        if (!profileId) return unauthorisedSync(set);

        const role = await orgMembership(params.orgId, profileId);
        if (!role) return forbiddenNotMember(set);

        return runCire(
          directoryService.getListingByOrg(params.orgId).pipe(
            Effect.provideService(DbService, db),
            Effect.map((listing) => ({ listing })),
            Effect.catchDefect(() => internal(set)),
          ),
        );
      })
      // PUT /api/vendor/orgs/:orgId/listing
      .put(
        "/orgs/:orgId/listing",
        async ({ params, request, set, osnProfileId: profileId }) => {
          if (!profileId) return unauthorisedSync(set);

          const role = await orgMembership(params.orgId, profileId);
          if (!role) return forbiddenNotMember(set);

          const raw: unknown = await request.json().catch(() => null);

          return runCire(
            Effect.gen(function* () {
              const body = yield* Schema.decodeUnknownEffect(UpsertListingBody)(raw);
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
              Effect.catchTag("SchemaError", () => badRequest(set)),
              Effect.catchTag("ListingAwaitingConfirmation", () => awaitingConfirmation(set)),
              Effect.catchDefect(() => internal(set)),
            ),
          );
        },
        manualParse,
      )
  );
}
