/**
 * Buying a locked module.
 *
 *   GET  /api/organiser/weddings/:weddingId/upgrade/catalogue        (member)
 *   POST /api/organiser/weddings/:weddingId/upgrade/session          (OWNER)
 *   GET  /api/organiser/weddings/:weddingId/upgrade/purchases/:id    (member)
 *
 * **Owner-only for the session route**, matching `registry-stripe.ts`: it names
 * a card. Reads admit any member, so a co-host can see what a module costs
 * without being able to buy it.
 *
 * **NO entitlement gate anywhere here, deliberately.** Gating the route that
 * SELLS an entitlement on that entitlement is a 402 loop. This is also why the
 * role gates are mounted with no key: a key passed here would fold an
 * entitlement lookup into the owner/member query on a route whose answer can
 * never depend on it. See `wiki/cire/cire-entitlements.md`.
 *
 * **Key-optional.** With no `STRIPE_SECRET_KEY` these routes are not mounted,
 * so a deployment without Stripe has no purchase surface rather than a broken
 * one — the same posture as the registry's Connect routes.
 *
 * **Nothing here grants anything.** A 200 from the session route means a
 * payment page exists, never that it was paid. Only a signature-verified
 * webhook delivery grants an entitlement, which is why the browser's return
 * from Stripe polls the purchase rather than reporting success for itself.
 */

import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingMember } from "../middleware/wedding-member";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { entitlementService } from "../services/entitlements";
import { isPurchasable, type UpgradeCatalogue } from "../services/upgrade-catalogue";
import type { UpgradeService } from "../services/upgrades";

export interface UpgradeDeps {
  readonly catalogue: UpgradeCatalogue;
  readonly upgrades: UpgradeService;
  /**
   * Per-organiser limiter. Starting a purchase spends an outbound Stripe call
   * (two, when it probes an existing session) against the PLATFORM's quota, so
   * without one a single tenant's credentials reach a cross-tenant denial of
   * service. The catalogue read mostly does not — its prices are cached — but
   * it shares the limiter rather than carrying a second one.
   */
  readonly limiter: RateLimiterBackend;
  /** Portal origin, for the two URLs Stripe sends the organiser back to. */
  readonly organiserOrigin: string;
}

/**
 * Where Stripe returns the organiser.
 *
 * The receipt rides in the QUERY, not the fragment: the portal is hash-routed,
 * so the hash is the route, and a fragment is also the part of a URL this
 * product has never asked Stripe to preserve. `w` and `m` travel the same way
 * so the return handler can set the hash itself once it knows the purchase
 * landed.
 */
function returnUrl(origin: string, weddingId: string, module: string, purchaseId?: string): string {
  const base = origin.replace(/\/+$/, "");
  const params = new URLSearchParams({ w: weddingId, m: module });
  if (purchaseId) params.set("upgrade", purchaseId);
  return `${base}/?${params.toString()}`;
}

/** The module a bought entitlement unlocks, for the return URL. */
const MODULE_FOR: Record<string, string> = Object.freeze({
  vendors: "vendors",
  registry: "registry",
});

export const createUpgradeRoutes = (db: Db, osnAuthOptions: OsnAuthOptions, deps: UpgradeDeps) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        // Reads: any member. NO entitlement key — see the header.
        .use(weddingMember(db))
        .use(rateLimitMiddlewareByUser(deps.limiter))
        .get("/upgrade/catalogue", ({ weddingId, set }) => {
          if (!weddingId) {
            set.status = 500;
            return { error: "internal" };
          }
          return runCire(
            Effect.gen(function* () {
              // Concurrent on purpose: one half is a third-party HTTP API and
              // the other a D1 table, so neither can answer the other and
              // nothing here binds a key the other produced. `Effect.all`
              // without this option runs them in sequence.
              const [entries, held] = yield* Effect.all(
                [deps.catalogue.list(), entitlementService.setsForWeddings([weddingId])],
                { concurrency: "unbounded" },
              );
              const owned = new Set(held.get(weddingId) ?? []);
              return {
                // `held` is what makes the dialog honest about a module the
                // wedding already has — the nav row unfades on the same data,
                // so the two cannot disagree.
                upgrades: entries.map((e) => ({
                  entitlement: e.entitlement,
                  title: e.title,
                  blurb: e.blurb,
                  amountMinor: e.amountMinor,
                  currency: e.currency,
                  held: owned.has(e.entitlement),
                })),
              };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.tapDefect((cause) =>
                Effect.logError("upgrade catalogue failed", { weddingId, cause: String(cause) }),
              ),
              Effect.catchDefect(() => {
                set.status = 500;
                return Effect.succeed({ error: "internal" });
              }),
            ),
          );
        })
        .get("/upgrade/purchases/:purchaseId", ({ params, weddingId, set }) => {
          const purchaseId = (params as { purchaseId?: string }).purchaseId;
          if (!weddingId || !purchaseId) {
            set.status = 404;
            return { error: "not_found" };
          }
          return runCire(
            Effect.gen(function* () {
              // Wedding-scoped, so a purchase id belonging to another wedding
              // is not found rather than readable.
              const row = yield* deps.upgrades.purchaseStatus(weddingId, purchaseId);
              if (row === null) {
                set.status = 404;
                return { error: "not_found" };
              }
              return { purchase: row };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchDefect(() => {
                set.status = 500;
                return Effect.succeed({ error: "internal" });
              }),
            ),
          );
        }),
    )
    // The write is its own group: `weddingOwner` rather than `weddingMember`,
    // and an Elysia guard would otherwise spread one gate across both.
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .use(rateLimitMiddlewareByUser(deps.limiter))
        .post("/upgrade/session", ({ weddingId, body, osnProfileId, set }) => {
          const entitlement = (body as { entitlement?: unknown } | null)?.entitlement;
          if (!weddingId || !osnProfileId) {
            set.status = 500;
            return { error: "internal" };
          }
          if (typeof entitlement !== "string" || !isPurchasable(entitlement)) {
            // Not a key this surface sells. 404 rather than 400: an
            // entitlement that exists but is not self-serve is, from here,
            // indistinguishable from one that does not exist.
            set.status = 404;
            return { error: "not_purchasable" };
          }
          const module = MODULE_FOR[entitlement] ?? "overview";
          return runCire(
            deps.upgrades
              .startPurchase({
                weddingId,
                entitlement,
                actorProfileId: osnProfileId,
                successUrlFor: (purchaseId) =>
                  returnUrl(deps.organiserOrigin, weddingId, module, purchaseId),
                cancelUrl: returnUrl(deps.organiserOrigin, weddingId, module),
              })
              .pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("UpgradeConflict", (e) => {
                  set.status = 409;
                  return Effect.succeed({ error: e.reason });
                }),
                Effect.catchTag("UpgradeUnavailable", () => {
                  set.status = 404;
                  return Effect.succeed({ error: "not_purchasable" });
                }),
                Effect.catchTag("UpgradeProviderError", (e) =>
                  Effect.logError("upgrade checkout could not be created", {
                    weddingId,
                    reason: e.reason,
                  }).pipe(
                    Effect.andThen(() => {
                      // Stripe refusing is not this API's fault and not the
                      // organiser's: 502 lets the portal offer the button again
                      // rather than reporting a broken account.
                      set.status = 502;
                      return Effect.succeed({ error: "payment_provider_unavailable" });
                    }),
                  ),
                ),
                Effect.catchTag("UpgradeWriteError", (e) =>
                  Effect.logError("upgrade purchase write failed", {
                    weddingId,
                    op: e.op,
                    reason: e.reason,
                  }).pipe(
                    Effect.andThen(() => {
                      set.status = 500;
                      return Effect.succeed({ error: "internal" });
                    }),
                  ),
                ),
                Effect.catchDefect(() => {
                  set.status = 500;
                  return Effect.succeed({ error: "internal" });
                }),
              ),
          );
        }),
    );
