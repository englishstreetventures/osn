/**
 * A stand-in for the two Stripe hosts cire-api calls when an owner connects a
 * Stripe account they already have, so the OAuth connect runs end to end with
 * no Stripe account behind it.
 *
 * cire-api sends Stripe calls here when `STRIPE_API_URL` and `STRIPE_CONNECT_URL`
 * are loopback origins (`cire/api/src/lib/local-stripe.ts`, read only by
 * `src/local.ts`). It answers three calls and counts each:
 *
 *  - `POST /oauth/token` — the code exchange. Any code connects
 *    {@link STRIPE_STANDIN_ACCOUNT} with `read_write` scope, as Stripe answers a
 *    platform. A code is good once here too: a second exchange of one code is a
 *    400 `invalid_grant`, as Stripe answers a used code;
 *  - `POST /oauth/deauthorize` — handing an account back;
 *  - `GET /v1/accounts/:id` — the account, a Standard one that can take charges
 *    and settles in AUD, so the portal's page-load refresh has nothing to ask.
 *
 * `GET /__e2e/stripe/calls` answers how many of each it has served. Anything
 * else is a 404 in Stripe's error shape. The browser never reaches this: the
 * authorize page is Stripe's own host, which the flow routes itself.
 */

/** The Standard account every exchange connects. */
export const STRIPE_STANDIN_ACCOUNT = "acct_e2eStandard";

export interface StripeCalls {
  token: number;
  deauthorize: number;
  account: number;
}

export interface StripeServer {
  readonly port: number;
  readonly calls: StripeCalls;
  stop(): Promise<void>;
}

const stripeError = (status: number, error: string): Response =>
  Response.json({ error, error_description: "stand-in refusal" }, { status });

export function startStripeServer(port: number): StripeServer {
  const calls: StripeCalls = { token: 0, deauthorize: 0, account: 0 };
  const usedCodes = new Set<string>();
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/__e2e/stripe/calls") {
        return Response.json(calls);
      }
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        calls.token += 1;
        const form = new URLSearchParams(await request.text());
        const code = form.get("code") ?? "";
        if (form.get("grant_type") !== "authorization_code" || code === "") {
          return stripeError(400, "invalid_request");
        }
        if (usedCodes.has(code)) return stripeError(400, "invalid_grant");
        usedCodes.add(code);
        return Response.json({
          stripe_user_id: STRIPE_STANDIN_ACCOUNT,
          scope: "read_write",
          livemode: false,
          token_type: "bearer",
        });
      }
      if (request.method === "POST" && url.pathname === "/oauth/deauthorize") {
        calls.deauthorize += 1;
        const form = new URLSearchParams(await request.text());
        return Response.json({ stripe_user_id: form.get("stripe_user_id") });
      }
      const account = /^\/v1\/accounts\/(acct_[A-Za-z0-9_]+)$/.exec(url.pathname);
      if (request.method === "GET" && account) {
        calls.account += 1;
        return Response.json({
          id: account[1],
          object: "account",
          type: "standard",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          default_currency: "aud",
        });
      }
      return Response.json(
        { error: { type: "invalid_request_error", code: "resource_missing" } },
        { status: 404 },
      );
    },
  });
  return {
    port: server.port ?? port,
    calls,
    stop: async () => {
      await server.stop(true);
    },
  };
}
