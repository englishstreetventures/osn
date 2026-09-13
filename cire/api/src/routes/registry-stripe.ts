/**
 * CONNECTING A COUPLE'S BANK ACCOUNT — Stripe Connect onboarding, from the
 * organiser portal.
 *
 *   POST /api/organiser/weddings/:weddingId/registry/stripe/session  (weddingOwner)
 *   POST /api/organiser/weddings/:weddingId/registry/stripe/refresh  (weddingOwner)
 *
 * **Owner-only, not editor.** Every other registry write is `weddingEditor`,
 * because adding a gift is ordinary help. This is not: it names the bank account
 * the money lands in, and a co-host with edit rights has no business pointing a
 * couple's gifts at anything. The role split already exists for exactly this
 * kind of line (codes, deletion, co-host removal), and this belongs on the same
 * side of it.
 *
 * **Create-or-resume, never create-again.** Onboarding is a form people abandon
 * and come back to, and every return trip runs through this route. It reads the
 * settings row first: an account already on it is reused and only the hosted
 * link is fresh. Stripe's idempotency key is the second belt — a double-tapped
 * button cannot mint two connected accounts for one couple, which is the
 * failure that needs a human at Stripe to unpick.
 *
 * **Nothing here turns cash gifts ON.** Connecting an account and offering
 * guests a contribute button are two decisions, and the second is the couple's:
 * `PUT /registry/settings` still owns it, still refuses while Stripe cannot take
 * a charge (`stripe_not_ready`), and this route deliberately does not reach over
 * and set it for them.
 *
 * **Key-optional.** With no `STRIPE_SECRET_KEY` the client is `null` and these
 * routes are not mounted at all, so a deployment without Stripe has no payment
 * surface rather than a broken one. Unlike the account-linking flag, the portal
 * does NOT probe: nothing in `@cire/host` reads a capability, the Money-gifts
 * panel renders on every tier, and a keyless deployment surfaces itself as the
 * 404 this route's absence produces when a couple presses Connect.
 */

import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingEntitlement } from "../middleware/wedding-entitlement";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import { registryService } from "../services/registry";
import type { StripeClient, StripeError } from "../services/stripe";

/**
 * Stripe would not play. 502, and a log line naming WHICH — a revoked key, a
 * withdrawn Connect capability and a Stripe outage otherwise produce an
 * identical bare 502 with nothing to tell them apart, on the surface that
 * decides where a couple's gift money lands.
 *
 * `status` and `code` only. `StripeError` carries no message precisely because
 * Stripe's is written for a developer's console and quotes the request into it.
 */
const badGateway = (set: { status?: number | string }, weddingId: string) => (error: StripeError) =>
  Effect.logWarning("stripe call failed").pipe(
    Effect.annotateLogs({
      weddingId,
      stripeStatus: error.status ?? "none",
      stripeCode: error.code ?? "none",
    }),
    Effect.andThen(
      Effect.sync(() => {
        set.status = 502;
        return { error: "stripe_unavailable" };
      }),
    ),
  );

const internal = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 500;
    return { error: "Internal error" };
  });

function internalSync(set: { status?: number | string }) {
  set.status = 500;
  return { error: "Internal error" };
}

/**
 * Annotated with `weddingId` and nothing else. A defect here can carry a Stripe
 * account id or an onboarding URL, and neither belongs in a log line.
 */
const logDefect = (weddingId: string) => (cause: unknown) =>
  Effect.logError("registry stripe handler defect", cause).pipe(Effect.annotateLogs({ weddingId }));

export interface RegistryStripeDeps {
  /** Absent ⇒ these routes are never mounted. See the header. */
  readonly stripe: StripeClient;
  /**
   * Per-organiser limiter. Every request here spends an outbound Stripe call,
   * which is the shape the link-preview route already carries one for: an owner
   * holding the button, or a portal bug polling `refresh`, would otherwise burn
   * the PLATFORM's Stripe quota — a cross-tenant denial of service reached from
   * one tenant's credentials.
   */
  readonly limiter: RateLimiterBackend;
  /** Portal origin, for the two URLs Stripe sends the couple back to. */
  readonly organiserOrigin: string;
  /** Two-letter country for a new connected account. */
  readonly defaultCountry?: string;
}

/**
 * Where Stripe returns the couple: the registry's SETTINGS tab, which is where
 * the button they pressed lives and where the panel that reads their new status
 * is. Landing them on the gift list would be landing them one tab away from the
 * thing they just did.
 */
function portalRegistryUrl(origin: string, weddingId: string): string {
  return `${origin.replace(/\/+$/, "")}/#/w/${encodeURIComponent(weddingId)}/registry/settings`;
}

export const createRegistryStripeRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  deps: RegistryStripeDeps,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .use(weddingEntitlement(db, "registry"))
        // Gate order: owner (403) → entitlement (402) → limiter (429), so a
        // stranger never spends the couple's budget.
        .use(rateLimitMiddlewareByUser(deps.limiter))
        .post("/registry/stripe/session", ({ weddingId, set }) => {
          if (!weddingId) return internalSync(set);
          return runCire(
            Effect.gen(function* () {
              const settings = yield* registryService.settingsOnly(weddingId);
              // An account already on the row is REUSED. It is the couple's
              // bank account by another name, and a second one would silently
              // repoint every future gift; only the hosted link is fresh.
              let accountId = settings.stripeAccountId;
              let chargesEnabled = settings.stripeChargesEnabled;
              let payoutsEnabled = settings.stripePayoutsEnabled;
              if (!accountId) {
                const created = yield* deps.stripe.createAccount({
                  country: deps.defaultCountry ?? "AU",
                  weddingId,
                });
                // If this write fails the account still exists at Stripe
                // and nothing records its id — and Stripe's idempotency key
                // expires after 24h, so a later retry would mint a SECOND
                // account for this couple. Logging the id at the one moment it
                // would otherwise be lost turns an unrecoverable orphan into a
                // manual fix. It is an account identifier, not a credential.
                const saved = yield* registryService
                  .attachStripeAccount(weddingId, created)
                  .pipe(
                    Effect.tapDefect(() =>
                      Effect.logError("stripe account created but not stored").pipe(
                        Effect.annotateLogs({ weddingId, stripeAccountId: created.id }),
                      ),
                    ),
                  );
                accountId = saved.stripeAccountId ?? created.id;
                chargesEnabled = saved.stripeChargesEnabled;
                payoutsEnabled = saved.stripePayoutsEnabled;
              }

              const returnUrl = portalRegistryUrl(deps.organiserOrigin, weddingId);
              const link = yield* deps.stripe.createAccountLink({
                accountId,
                // Stripe uses `refresh_url` when the link it was given has
                // expired — pointing it back at the portal means the couple
                // land on the button that mints a fresh one, rather than on a
                // Stripe error page.
                refreshUrl: returnUrl,
                returnUrl,
              });

              return {
                url: link.url,
                expiresAt: link.expiresAt,
                status: { connected: true, chargesEnabled, payoutsEnabled },
              };
            }).pipe(
              Effect.provideService(DbService, db),
              // Stripe refusing, or being unreachable, is not this API's
              // fault and not the couple's: 502 says so, and the portal can
              // offer the button again rather than reporting a broken account.
              Effect.catchTag("StripeError", badGateway(set, weddingId)),
              Effect.tapDefect(logDefect(weddingId)),
              Effect.catchDefect(() => internal(set)),
            ),
          );
        })
        .post("/registry/stripe/refresh", ({ weddingId, set }) => {
          if (!weddingId) return internalSync(set);
          return runCire(
            Effect.gen(function* () {
              const settings = yield* registryService.settingsOnly(weddingId);
              const accountId = settings.stripeAccountId;
              if (!accountId) {
                return {
                  connected: false,
                  chargesEnabled: false,
                  payoutsEnabled: false,
                };
              }
              // A live read, unlike the cached columns every other surface
              // uses. It exists for one moment: the couple have just come back
              // from onboarding and the `account.updated` webhook may be
              // seconds behind them. Asking Stripe once, here, is the
              // difference between "connected" and a panel that still says
              // "finish setting up" to someone who just did.
              const account = yield* deps.stripe.retrieveAccount(accountId);
              yield* registryService.applyStripeAccountState(account);
              return {
                connected: true,
                chargesEnabled: account.chargesEnabled,
                payoutsEnabled: account.payoutsEnabled,
              };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTag("StripeError", badGateway(set, weddingId)),
              Effect.tapDefect(logDefect(weddingId)),
              Effect.catchDefect(() => internal(set)),
            ),
          );
        }),
    );
