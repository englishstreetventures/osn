/**
 * CONNECTING A COUPLE'S BANK ACCOUNT — Stripe Connect onboarding, from the
 * organiser portal.
 *
 *   POST /api/organiser/weddings/:weddingId/registry/stripe/session   (weddingOwner, then the account's connector)
 *   POST /api/organiser/weddings/:weddingId/registry/stripe/refresh   (weddingOwner)
 *   GET  /api/organiser/weddings/:weddingId/registry/stripe/accounts  (weddingOwner)
 *   POST /api/organiser/weddings/:weddingId/registry/stripe/reuse     (weddingOwner, then the source account's connector)
 *
 * **Owner-only, not editor.** Every other registry write is `weddingEditor`,
 * because adding a gift is ordinary help. This is not: it names the bank account
 * the money lands in, and a co-host with edit rights has no business pointing a
 * couple's gifts at anything. The role split already exists for exactly this
 * kind of line (codes, deletion, co-host removal), and this belongs on the same
 * side of it.
 *
 * **Once connected, the connector's alone.** Whoever runs onboarding puts their
 * own identity and bank account on the Express account, so a wedding's other
 * owners must not be handed a link into it. Any owner may connect a wedding
 * that has no account, and is recorded as its connector
 * (`stripe_connected_by_osn_profile_id`, in the write that fills the id). After
 * that the session route answers every other owner 403 `stripe_connector_only`
 * before it asks Stripe anything — and so does a row with an account and no
 * recorded connector, since nobody can say whose it is. The refresh stays open
 * to every owner: it reads the account's status, which they all see.
 *
 * **One account, several weddings.** An owner who connected an account on one
 * wedding may give it to another wedding of theirs (`…/accounts` lists the
 * candidates, `…/reuse` attaches one), with no trip to Stripe. The body names
 * the wedding the account is on, never the account, and cire's own record of
 * who connected it is the proof: the caller must be its connector there and
 * still own that wedding, and every owner here must own that wedding too, so
 * the account goes nowhere it does not already sit beside each of them. Any
 * source the caller may not use is one 404, which says nothing about weddings
 * they cannot see. A wedding that has an account keeps it.
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
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingOwner } from "../middleware/wedding-owner";
import { weddingTier } from "../middleware/wedding-tier";
import { runCire } from "../observability";
import { ReuseStripeAccountBody } from "../schemas/registry";
import { registryService, settingsForReader } from "../services/registry";
import type { RegistrySettingsDto } from "../services/registry";
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
 * Why an owner was refused an onboarding link: the account was already another
 * owner's (or nobody's on record), or another owner connected it while this
 * request was creating one.
 */
type ConnectorRefusal = "not_connector" | "connected_meanwhile";

/**
 * 403 `stripe_connector_only`, logged by wedding and reason — never by person,
 * so the line names nobody's profile.
 */
const notConnector = (
  set: { status?: number | string },
  weddingId: string,
  refusal: ConnectorRefusal,
) =>
  Effect.logInfo("stripe onboarding refused").pipe(
    Effect.annotateLogs({ weddingId, refusal }),
    Effect.andThen(
      Effect.sync(() => {
        set.status = 403;
        return { error: "stripe_connector_only" };
      }),
    ),
  );

/**
 * Annotated with `weddingId` and nothing else. A defect here can carry a Stripe
 * account id or an onboarding URL, and neither belongs in a log line.
 */
const logDefect = (weddingId: string) => (cause: unknown) =>
  Effect.logError("registry stripe handler defect", cause).pipe(Effect.annotateLogs({ weddingId }));

/** Every caller past `weddingOwner` may edit and manage: what the settings carry. */
const OWNER_READER = { canEdit: true, canManage: true } as const;

/** Why an owner was refused another wedding's account, as the log line names it. */
type ReuseRefusal = "already_connected" | "not_found" | "owners_differ" | "currency_mismatch";

/**
 * A refused reuse: logged by wedding and reason — never by person or account —
 * and answered with the error code, and with the settings as they stand where
 * the page holding them is what is out of date.
 */
const reuseRefused = (
  set: { status?: number | string },
  weddingId: string,
  refusal: ReuseRefusal,
  answer: { status: number; error: string; current?: RegistrySettingsDto },
) =>
  Effect.logInfo("stripe account reuse refused").pipe(
    Effect.annotateLogs({ weddingId, refusal }),
    Effect.andThen(
      Effect.sync(() => {
        set.status = answer.status;
        return answer.current
          ? { error: answer.error, settings: settingsForReader(answer.current, OWNER_READER) }
          : { error: answer.error };
      }),
    ),
  );

/** The handler parses its own JSON body, so a malformed one is the schema's 400. */
const manualParse = { parse: () => ({}) };

export interface RegistryStripeDeps {
  /** Absent ⇒ these routes are never mounted. See the header. */
  readonly stripe: StripeClient;
  /**
   * Per-organiser limiter. The onboarding and refresh requests each spend an
   * outbound Stripe call (the account list and the reuse spend none, and share
   * the budget because a Connect press runs one of them before the call it
   * leads to), which is the shape the link-preview route already carries one for: an owner
   * holding the button, or a portal bug polling `refresh`, would otherwise burn
   * the PLATFORM's Stripe quota — a cross-tenant denial of service reached from
   * one tenant's credentials.
   */
  readonly limiter: RateLimiterBackend;
  /** Portal origin, for the two URLs Stripe sends the couple back to. */
  readonly organiserOrigin: string;
  /** Two-letter country for a new connected account. */
  readonly defaultCountry?: string;
  /**
   * Whether this deployment can take a money gift at all (`createApp`). These
   * routes mount on the key alone, so it can be false here; the refresh's
   * `moneyGiftsBlockedBy` is judged on it.
   */
  readonly takesPayments: boolean;
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
        .use(weddingTier(db, "gold"))
        // Gate order: owner (403) → tier (402) → limiter (429), so a
        // stranger never spends the couple's budget.
        .use(rateLimitMiddlewareByUser(deps.limiter))
        .post("/registry/stripe/session", ({ weddingId, osnProfileId, set }) => {
          if (!weddingId || !osnProfileId) return internalSync(set);
          return runCire(
            Effect.gen(function* () {
              const settings = yield* registryService.settingsOnly(weddingId);
              // An account already on the row is REUSED. It is the couple's
              // bank account by another name, and a second one would silently
              // repoint every future gift; only the hosted link is fresh —
              // and only for the owner who connected it. A NULL connector
              // matches nobody.
              let accountId = settings.stripeAccountId;
              let chargesEnabled = settings.stripeChargesEnabled;
              let payoutsEnabled = settings.stripePayoutsEnabled;
              if (accountId && settings.stripeConnectedByOsnProfileId !== osnProfileId) {
                return yield* notConnector(set, weddingId, "not_connector");
              }
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
                  .attachStripeAccount(weddingId, created, osnProfileId)
                  .pipe(
                    Effect.tapDefect(() =>
                      Effect.logError("stripe account created but not stored").pipe(
                        Effect.annotateLogs({ weddingId, stripeAccountId: created.id }),
                      ),
                    ),
                  );
                // The caller stopped owning the wedding, or it was deleted,
                // while Stripe was making the account: nothing was written,
                // so the account exists at Stripe with nothing storing it.
                // The same log line as a failed write, and the refusal the
                // gate would now give.
                if (!saved) {
                  yield* Effect.logError("stripe account created but not stored").pipe(
                    Effect.annotateLogs({ weddingId, stripeAccountId: created.id }),
                  );
                  return yield* Effect.sync(() => {
                    set.status = 403;
                    return { error: "forbidden" };
                  });
                }
                // Another request attached an account first. When it is not
                // the one this request created — Stripe's idempotency key
                // lasts 24h — that one exists at Stripe with nothing storing
                // it, so its id is logged for the same manual fix as above.
                if (saved.stripeAccountId !== created.id) {
                  yield* Effect.logError("stripe account created but not stored").pipe(
                    Effect.annotateLogs({ weddingId, stripeAccountId: created.id }),
                  );
                }
                // And when another owner attached it, it is theirs: this
                // owner gets no link into it.
                if (saved.stripeConnectedByOsnProfileId !== osnProfileId) {
                  return yield* notConnector(set, weddingId, "connected_meanwhile");
                }
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
              const before = yield* registryService.stripeStatus(weddingId, deps);
              if (!before.accountId) return before.status;
              // A live read, unlike the cached columns every other surface
              // uses. It exists for one moment: the couple have just come back
              // from onboarding and the `account.updated` webhook may be
              // seconds behind them. Asking Stripe once, here, is the
              // difference between "connected" and a panel that still says
              // "finish setting up" to someone who just did.
              const account = yield* deps.stripe.retrieveAccount(before.accountId);
              // The answer is the row as it now stands, not the live read: the
              // write keeps a later state Stripe already sent, and the guest
              // gate reads the row, so this is what guests are offered.
              return yield* registryService.refreshStripeStatus(weddingId, account, deps);
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTag("StripeError", badGateway(set, weddingId)),
              Effect.tapDefect(logDefect(weddingId)),
              Effect.catchDefect(() => internal(set)),
            ),
          );
        })
        // The accounts this owner connected on other weddings of theirs, for
        // the portal to offer when they connect. A read of cire's own rows:
        // no Stripe call. It is fetched when the owner presses Connect, so it
        // spends one slot of the limiter beside the call it leads to.
        .get("/registry/stripe/accounts", ({ weddingId, osnProfileId, set }) => {
          if (!weddingId || !osnProfileId) return internalSync(set);
          return runCire(
            registryService.reusableStripeAccounts(weddingId, osnProfileId).pipe(
              Effect.map((accounts) => ({ accounts })),
              Effect.provideService(DbService, db),
              Effect.tapDefect(logDefect(weddingId)),
              Effect.catchDefect(() => internal(set)),
            ),
          );
        })
        .post(
          "/registry/stripe/reuse",
          async ({ weddingId, osnProfileId, request, set }) => {
            if (!weddingId || !osnProfileId) return internalSync(set);
            const raw: unknown = await request.json().catch(() => null);
            return runCire(
              Effect.gen(function* () {
                const body = yield* Schema.decodeUnknownEffect(ReuseStripeAccountBody)(raw);
                // Nothing here asks Stripe anything: the account and what
                // Stripe last said about it come off the source row, which the
                // webhook keeps current for every wedding naming the account.
                const settings = yield* registryService.adoptStripeAccount(
                  weddingId,
                  body.fromWeddingId,
                  osnProfileId,
                  deps,
                );
                yield* Effect.logInfo("stripe account reused").pipe(
                  Effect.annotateLogs({ weddingId }),
                );
                return { settings: settingsForReader(settings, OWNER_READER) };
              }).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("SchemaError", () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                ),
                Effect.catchTag("StripeAlreadyConnected", (e) =>
                  reuseRefused(set, weddingId, "already_connected", {
                    status: 409,
                    error: "stripe_already_connected",
                    current: e.current,
                  }),
                ),
                Effect.catchTag("StripeAccountNotFound", () =>
                  reuseRefused(set, weddingId, "not_found", {
                    status: 404,
                    error: "stripe_account_not_found",
                  }),
                ),
                Effect.catchTag("StripeOwnersDiffer", (e) =>
                  reuseRefused(set, weddingId, "owners_differ", {
                    status: 409,
                    error: "stripe_owners_differ",
                    current: e.current,
                  }),
                ),
                Effect.catchTag("CurrencyMismatch", (e) =>
                  reuseRefused(set, weddingId, "currency_mismatch", {
                    status: 409,
                    error: "currency_mismatch",
                    current: e.current,
                  }),
                ),
                Effect.tapDefect(logDefect(weddingId)),
                Effect.catchDefect(() => internal(set)),
              ),
            );
          },
          manualParse,
        ),
    );
