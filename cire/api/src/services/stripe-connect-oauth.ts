/**
 * STRIPE CONNECT OAUTH — connecting a Stripe account the couple already have.
 *
 * Every account `createAccount` makes is an Express account cire created and
 * runs onboarding for. OAuth is the other way in, and the only one Stripe offers
 * for an account that exists outside the platform: the couple sign in to
 * Stripe, choose an account, approve cire, and come back with a one-time code
 * this file exchanges for the account's id. The account is a Standard one —
 * the couple's own, in their own Dashboard, carrying Stripe's fees and its
 * disputes itself on the direct charges cire makes for gifts.
 *
 * Three calls, all on `connect.stripe.com`:
 *
 *  - the AUTHORIZE page the couple's browser is sent to (a URL, not a call);
 *  - the TOKEN exchange, `POST /oauth/token` with the code. A code is single
 *    use and lives five minutes, and exchanging one twice REVOKES the
 *    connection — so the caller makes sure a code reaches here once;
 *  - DEAUTHORIZE, `POST /oauth/deauthorize`, which hands an account back when
 *    nothing in cire uses it.
 *
 * WHAT IS KEPT. The token reply carries `stripe_user_id` (the account id) and,
 * deprecated, an access token, a refresh token and a publishable key. Only the
 * id leaves this file: cire acts as the account through the platform key and
 * the `Stripe-Account` header, as it does for every Express account. The rest
 * of the reply is never read, stored or logged.
 *
 * The authorize page is always Stripe's own host. The portal refuses to send a
 * browser anywhere else (`isStripeConnectUrl`), and `connectBase` — moved only
 * for the local stand-in — reaches the two server calls alone.
 */

import { Data, Effect } from "effect";

import { createStripeTransport } from "./stripe";
import type { StripeError, StripeRequest } from "./stripe";

/** Stripe Connect's host: the token and deauthorize calls. */
export const STRIPE_CONNECT_BASE = "https://connect.stripe.com";

/** Where the couple's browser is sent to choose and approve an account. */
export const STRIPE_AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize";

/** A platform's OAuth client id, as Stripe issues it. */
const CLIENT_ID = /^ca_[A-Za-z0-9]+$/;

/** A connected account id, as the token reply must name one. */
const ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;

/** The one scope cire asks for: direct charges need `read_write`. */
export const OAUTH_SCOPE = "read_write";

export interface StripeConnectOAuth {
  /** The platform's `ca_…` id, sent on the authorize URL and on deauthorize. */
  readonly clientId: string;
  /** Where Stripe sends the browser back: cire-api's own callback, fixed. */
  readonly redirectUri: string;
  /** The authorize page for one `state`. */
  authorizeUrl(state: string): string;
  /**
   * Exchange a code for the account it connected. Fails with `StripeError`:
   * `rejected` + status 400 when Stripe refused the code (`invalid_grant`:
   * used, expired, another platform's, or the other mode's), anything else
   * when the fault is ours or the network's. A reply without an `acct_…` id
   * or with any scope but `read_write` is a failure too, with the id it did
   * carry in `connectedAccountId` so the caller can hand it back.
   */
  exchangeCode(code: string): Effect.Effect<{ accountId: string }, StripeError | OAuthReplyError>;
  /** Hand an account back: cire can no longer reach it, nor it cire. */
  deauthorize(accountId: string): Effect.Effect<void, StripeError>;
}

/**
 * The token endpoint answered 200 with something cire cannot use. When it
 * named an account, that account is now connected to the platform with
 * nothing in cire storing it, which is why the id travels here.
 */
export class OAuthReplyError extends Data.TaggedError("OAuthReplyError")<{
  readonly connectedAccountId: string | null;
}> {}

export interface StripeConnectOAuthConfig {
  secretKey: string;
  clientId: string;
  redirectUri: string;
  /** Connect's host for the two server calls. Local stand-in only. */
  connectBase?: string;
  fetchImpl?: typeof fetch;
}

export function createStripeConnectOAuth(config: StripeConnectOAuthConfig): StripeConnectOAuth {
  const request: StripeRequest = createStripeTransport({
    secretKey: config.secretKey,
    base: config.connectBase ?? STRIPE_CONNECT_BASE,
    fetchImpl: config.fetchImpl,
  });

  return {
    clientId: config.clientId,
    redirectUri: config.redirectUri,

    authorizeUrl(state) {
      const url = new URL(STRIPE_AUTHORIZE_URL);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("scope", OAUTH_SCOPE);
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", config.redirectUri);
      return url.toString();
    },

    exchangeCode(code) {
      return request("POST", "/oauth/token", { grant_type: "authorization_code", code }).pipe(
        Effect.flatMap((payload) => {
          // Two fields and no more: the deprecated tokens beside them are
          // never read, so they cannot reach a log or a row by accident.
          const reply = payload as { stripe_user_id?: unknown; scope?: unknown };
          const accountId =
            typeof reply?.stripe_user_id === "string" && ACCOUNT_ID.test(reply.stripe_user_id)
              ? reply.stripe_user_id
              : null;
          return accountId && reply.scope === OAUTH_SCOPE
            ? Effect.succeed({ accountId })
            : Effect.fail(new OAuthReplyError({ connectedAccountId: accountId }));
        }),
        Effect.withSpan("cire.stripe.oauthExchange"),
      );
    },

    deauthorize(accountId) {
      return request("POST", "/oauth/deauthorize", {
        client_id: config.clientId,
        stripe_user_id: accountId,
      }).pipe(Effect.asVoid, Effect.withSpan("cire.stripe.oauthDeauthorize"));
    },
  };
}

/** Why the OAuth half is off, for the one log line building the app writes. */
export type StripeConnectOAuthGap = "malformed_client_id" | null;

/** The client from configuration, or none and why. */
export interface StripeConnectOAuthSetup {
  oauth: StripeConnectOAuth | null;
  gap: StripeConnectOAuthGap;
}

/**
 * The OAuth client from configuration, or `null` with the reason it is off.
 * It needs the platform key (the token call is made with it), the platform's
 * client id, and cire-api's own public origin, which the fixed redirect URI is
 * built on — the same origin the organiser sign-in callback uses. A client id
 * that is set but not a `ca_…` id is refused rather than sent to Stripe, and
 * named, so a deploy that mistyped it says so once.
 */
export function stripeConnectOAuthFromEnv(
  env: {
    STRIPE_SECRET_KEY?: string;
    STRIPE_CONNECT_CLIENT_ID?: string;
    CIRE_API_ORIGIN?: string;
  },
  local: { connectBase?: string } = {},
): StripeConnectOAuthSetup {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const clientId = env.STRIPE_CONNECT_CLIENT_ID?.trim();
  const apiOrigin = env.CIRE_API_ORIGIN?.trim().replace(/\/+$/, "");
  if (!clientId) return { oauth: null, gap: null };
  if (!CLIENT_ID.test(clientId)) return { oauth: null, gap: "malformed_client_id" };
  if (!secretKey || !apiOrigin) return { oauth: null, gap: null };
  return {
    oauth: createStripeConnectOAuth({
      secretKey,
      clientId,
      redirectUri: `${apiOrigin}${STRIPE_OAUTH_CALLBACK_PATH}`,
      connectBase: local.connectBase,
    }),
    gap: null,
  };
}

/** The callback's path on cire-api, which the redirect URI registered at Stripe names. */
export const STRIPE_OAUTH_CALLBACK_PATH = "/api/organiser/stripe/oauth/callback";
