/**
 * CONNECTING A STRIPE ACCOUNT THE COUPLE ALREADY HAVE — Stripe Connect OAuth.
 *
 *   POST /api/organiser/weddings/:weddingId/registry/stripe/oauth   (weddingOwner + Gold)
 *   GET  /api/organiser/stripe/oauth/callback                        (Stripe's redirect)
 *
 * The third way a wedding gets a Stripe account, beside an Express account cire
 * creates (`…/stripe/session`) and one the owner connected on another wedding
 * (`…/stripe/reuse`). The couple sign in to Stripe, choose an account and
 * approve cire; Stripe sends the browser back to the callback with a one-time
 * code; the callback exchanges it for the account's id. The account is a
 * Standard one: the couple's own, managed in their own Dashboard, carrying
 * Stripe's fees and its disputes itself on the direct charges cire makes.
 *
 * **The `state` is the binding.** The start mints `<weddingId>.<32 random
 * bytes>`, keeps only its SHA-256, bound to the owner who pressed it, and
 * hands Stripe the state. The callback finds the owner from the organiser
 * session cookie — `SameSite=Lax`, so Stripe's top-level redirect carries it,
 * as the issuer's does for sign-in — and deletes the one row that matches the
 * wedding, that owner and the hash. That DELETE is what makes a state good
 * once, for that owner, for that wedding: a forged one matches nothing, a
 * replay finds the row gone and never reaches Stripe, where a code exchanged
 * twice revokes the connection. One answer, `expired`, for every such state.
 *
 * **Every answer is a redirect to the portal.** The callback is a page load,
 * not an API call: the browser lands on the wedding's registry settings with
 * `?stripe_connect=<outcome>`, and the portal says what happened. The address
 * is the configured portal origin and, once the state is used up, the
 * wedding the stored row named. Nothing from the query — Stripe's
 * `error_description`, the state's own wedding part — goes into it.
 *
 * **Where an account may go.** An account another wedding already names joins
 * this one only where the reuse rules let it (`accountMayJoin` in the
 * service): Stripe's sign-in proves the caller holds the account, not that it
 * belongs beside this wedding's owners. One account across weddings of
 * different couples is a planner's, which englishstreetventures/osn#2018
 * decides. It must settle in the wedding's currency, as a reuse must.
 *
 * **Handing an account back.** Once the exchange succeeds the account is
 * connected to the platform, whatever cire does next. If the connect is then
 * refused, cire deauthorizes it — unless some wedding names it, since
 * Stripe's deauthorization event clears every row naming the account.
 *
 * **What is kept.** The account id, its type and what Stripe said about it. The
 * token reply's deprecated tokens are never read (`stripe-connect-oauth.ts`),
 * and no log line carries the code or Stripe's description of an error.
 */

import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { getClientIp, isUnresolvedIp } from "../lib/client-ip";
import { metricRegistryStripeOAuth } from "../metrics";
import type { StripeOAuthOutcome } from "../metrics";
import { osnAuth, resolveOsnProfileId } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { rateLimitMiddlewareByUser } from "../middleware/rate-limit";
import { weddingOwner } from "../middleware/wedding-owner";
import { weddingTier } from "../middleware/wedding-tier";
import { runCire } from "../observability";
import { sha256Hex } from "../services/email-suppression";
import { registryService, settingsForReader } from "../services/registry";
import type { StripeAccount, StripeClient } from "../services/stripe";
import { STRIPE_OAUTH_CALLBACK_PATH } from "../services/stripe-connect-oauth";
import type { StripeConnectOAuth } from "../services/stripe-connect-oauth";

/** How long a started connect may take: Stripe's page can include making a login. */
export const STRIPE_OAUTH_STATE_LIFETIME_MS = 30 * 60 * 1000;

/** `<weddingId>.<43 base64url characters>`: the only state the callback reads. */
const OAUTH_STATE = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/;

/** A code longer than this is not one Stripe issued. */
const MAX_CODE_LENGTH = 256;

/** Every caller past `weddingOwner` may edit and manage: what the settings carry. */
const OWNER_READER = { canEdit: true, canManage: true } as const;

export interface RegistryStripeOAuthDeps {
  readonly stripe: StripeClient;
  readonly oauth: StripeConnectOAuth;
  /** The onboarding routes' per-organiser limiter: the start shares its budget. */
  readonly limiter: RateLimiterBackend;
  /**
   * The callback's own, per IP. It is a page load from Stripe that only a
   * valid state lets spend a Stripe call, and every valid state needs a start,
   * which the per-organiser limiter bounds.
   */
  readonly callbackLimiter: RateLimiterBackend;
  /** Portal origin, where every callback answer sends the browser. */
  readonly organiserOrigin: string;
  /** Whether this deployment takes money gifts, for the settings a 409 carries. */
  readonly takesPayments: boolean;
}

/** 32 random bytes, base64url without padding: 43 characters. */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const hashOf = (state: string) => Effect.promise(() => sha256Hex(state));

export const createRegistryStripeOAuthRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  deps: RegistryStripeOAuthDeps,
) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        .use(weddingOwner(db))
        .use(weddingTier(db, "gold"))
        .use(rateLimitMiddlewareByUser(deps.limiter))
        .post("/registry/stripe/oauth", ({ weddingId, osnProfileId, set }) => {
          if (!weddingId || !osnProfileId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          return runCire(
            Effect.gen(function* () {
              const settings = yield* registryService.settingsView(weddingId, deps);
              // A wedding's account is the couple's bank by another name; one
              // that has an account keeps it, as every way in insists.
              if (settings.stripeConnected) {
                set.status = 409;
                return {
                  error: "stripe_already_connected",
                  settings: settingsForReader(settings, OWNER_READER),
                };
              }
              const state = `${weddingId}.${randomToken()}`;
              const now = new Date();
              yield* registryService.issueStripeOAuthState({
                weddingId,
                osnProfileId,
                stateHash: yield* hashOf(state),
                expiresAt: new Date(now.getTime() + STRIPE_OAUTH_STATE_LIFETIME_MS),
                now,
              });
              return { url: deps.oauth.authorizeUrl(state) };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.tapDefect((cause) =>
                Effect.logError("registry stripe oauth defect", cause).pipe(
                  Effect.annotateLogs({ weddingId }),
                ),
              ),
              Effect.catchDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        }),
    );

interface Landing {
  readonly outcome: StripeOAuthOutcome;
  /** Known only once the stored row matched; never the query's. */
  readonly weddingId?: string;
}

/** The callback's query, as Elysia hands it over. */
type CallbackQuery = Readonly<Record<string, string | undefined>>;

/** An account the exchange connected, for the defect handler to hand back. */
interface ConnectedAccount {
  accountId: string | null;
}

/** The query values the callback reads, as strings or nothing. */
function queryString(query: CallbackQuery, key: string): string | null {
  const value = query[key];
  return typeof value === "string" ? value : null;
}

export const createStripeOAuthCallbackRoutes = (
  db: Db,
  osnAuthOptions: OsnAuthOptions,
  deps: RegistryStripeOAuthDeps,
) => {
  const portal = deps.organiserOrigin.replace(/\/+$/, "");

  const land = ({ outcome, weddingId }: Landing): Response => {
    metricRegistryStripeOAuth(outcome);
    const hash = weddingId ? `#/w/${encodeURIComponent(weddingId)}/registry/settings` : "";
    return new Response(null, {
      status: 302,
      headers: {
        location: `${portal}/?stripe_connect=${outcome}${hash}`,
        "cache-control": "no-store",
      },
    });
  };

  /**
   * Give an account cire connected back to its holder, when no wedding names
   * it. A failure leaves it connected with nothing storing it, so its id is
   * logged for a hand fix, as a created-but-not-stored Express account is.
   */
  const handBack = (accountId: string, weddingId: string) =>
    Effect.gen(function* () {
      if (yield* registryService.stripeAccountNamed(accountId)) return;
      const handedBack = yield* deps.oauth.deauthorize(accountId).pipe(
        Effect.as(true),
        Effect.catchTag("StripeError", () =>
          Effect.logError("stripe account connected but not stored").pipe(
            Effect.annotateLogs({ weddingId, stripeAccountId: accountId }),
            Effect.as(false),
          ),
        ),
      );
      if (!handedBack) return;
      // A wedding that took the account while Stripe was revoking it holds a
      // connection that no longer exists. cire knows, so it clears it now
      // rather than wait for an event that may predate the connect.
      if (yield* registryService.detachStripeAccount({ accountId })) {
        yield* Effect.logError("stripe account handed back while a wedding connected it").pipe(
          Effect.annotateLogs({ weddingId, stripeAccountId: accountId }),
        );
      }
    });

  const connect = (
    query: CallbackQuery,
    caller: string,
    weddingId: string,
    state: string,
    connected: ConnectedAccount,
  ) =>
    Effect.gen(function* () {
      const used = yield* registryService.consumeStripeOAuthState({
        weddingId,
        osnProfileId: caller,
        stateHash: yield* hashOf(state),
        now: new Date(),
      });
      if (!used) return { outcome: "expired" } satisfies Landing;
      const at = (outcome: StripeOAuthOutcome): Landing => ({ outcome, weddingId });

      // The couple said no on Stripe's page. Its words are Stripe's, unbounded,
      // and never repeated.
      if (queryString(query, "error") !== null) return at("denied");

      const target = yield* registryService.stripeOAuthTarget(weddingId, caller);
      if (!target.allowed) return at("forbidden");
      if (target.hasAccount) return at("already_connected");

      const code = queryString(query, "code");
      if (!code || code.length > MAX_CODE_LENGTH) return at("rejected");

      const exchanged = yield* deps.oauth.exchangeCode(code).pipe(
        Effect.map(({ accountId }) => ({ accountId })),
        Effect.catchTag("StripeError", (error) =>
          Effect.logWarning(
            error.reason === "timeout"
              ? "stripe oauth exchange timed out"
              : "stripe oauth exchange refused",
          ).pipe(
            Effect.annotateLogs({
              weddingId,
              stripeStatus: error.status ?? "none",
              stripeCode: error.code ?? "none",
            }),
            // A 400 is the code: used, expired, or not this platform's. Any
            // other refusal is cire's key, Stripe's limits or the network.
            Effect.as({
              outcome: (error.status === 400 ? "rejected" : "unavailable") as StripeOAuthOutcome,
              handBack: null as string | null,
            }),
          ),
        ),
        Effect.catchTag("OAuthReplyError", (error) =>
          Effect.logWarning("stripe oauth reply unusable").pipe(
            Effect.annotateLogs({ weddingId }),
            Effect.as({
              outcome: "unavailable" as StripeOAuthOutcome,
              handBack: error.connectedAccountId,
            }),
          ),
        ),
      );
      if ("outcome" in exchanged) {
        if (exchanged.handBack) yield* handBack(exchanged.handBack, weddingId);
        return at(exchanged.outcome);
      }
      const { accountId } = exchanged;
      connected.accountId = accountId;
      const refuse = (outcome: StripeOAuthOutcome) =>
        handBack(accountId, weddingId).pipe(Effect.as(at(outcome)));

      // What Stripe says the account is: required, because the type and the
      // payout currency decide whether it may take this wedding's gifts.
      const account: StripeAccount | null = yield* deps.stripe
        .retrieveAccount(accountId)
        .pipe(
          Effect.catchTag("StripeError", () =>
            Effect.logWarning("stripe account read failed after connect").pipe(
              Effect.annotateLogs({ weddingId }),
              Effect.as(null),
            ),
          ),
        );
      if (!account || account.type !== "standard") return yield* refuse("unavailable");
      if (
        account.defaultCurrency !== null &&
        account.defaultCurrency.toUpperCase() !== target.currency.toUpperCase()
      ) {
        return yield* refuse("currency_mismatch");
      }

      const saved = yield* registryService.attachStripeAccount(
        weddingId,
        {
          id: accountId,
          chargesEnabled: account.chargesEnabled,
          payoutsEnabled: account.payoutsEnabled,
          defaultCurrency: account.defaultCurrency,
        },
        caller,
        { accountType: "standard", ownersMustFit: true },
      );
      if (!saved) {
        return yield* refuse(
          yield* registryService.stripeOAuthRefusal(
            weddingId,
            caller,
            accountId,
            account.defaultCurrency,
          ),
        );
      }
      // Another request filled the row first: it keeps what it holds.
      if (saved.stripeAccountId !== accountId || saved.stripeConnectedByOsnProfileId !== caller) {
        return yield* refuse("already_connected");
      }
      yield* Effect.logInfo("stripe account connected").pipe(
        Effect.annotateLogs({ weddingId, via: "oauth" }),
      );
      return at("connected");
    });

  return new Elysia().get(STRIPE_OAUTH_CALLBACK_PATH, async ({ request, query }) => {
    // The limiter's own refusal is JSON; a page load needs a page.
    const ip = getClientIp(request.headers);
    if (isUnresolvedIp(ip) || !(await deps.callbackLimiter.check(ip))) {
      return land({ outcome: "unavailable" });
    }
    const raw = queryString(query, "state");
    const parsed = raw === null ? null : OAUTH_STATE.exec(raw);
    if (!raw || !parsed?.[1]) return land({ outcome: "expired" });
    const weddingId = parsed[1];

    const caller = await resolveOsnProfileId(request, osnAuthOptions).catch(() => undefined);
    // Signed out while on Stripe's page: the state stays, and lapses on its own.
    if (!caller) return land({ outcome: "signed_out" });

    const connected: ConnectedAccount = { accountId: null };
    const landing = await runCire(
      connect(query, caller, weddingId, raw, connected).pipe(
        Effect.provideService(DbService, db),
        Effect.tapDefect((cause) =>
          Effect.logError("stripe oauth callback defect", cause).pipe(
            Effect.annotateLogs({ weddingId }),
          ),
        ),
        // A defect after the exchange leaves an account connected: hand it
        // back where nothing names it, then say it did not work.
        Effect.catchDefect(() =>
          (connected.accountId
            ? handBack(connected.accountId, weddingId).pipe(Effect.provideService(DbService, db))
            : Effect.void
          ).pipe(
            Effect.catchDefect(() => Effect.void),
            Effect.as({ outcome: "unavailable" } as Landing),
          ),
        ),
      ),
    );
    return land(landing);
  });
};
