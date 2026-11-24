import { DbLive, type Db } from "@osn/db/service";
import {
  getClientIp,
  isUnresolvedIp,
  type ClientIpOptions,
  type RateLimiterBackend,
} from "@shared/rate-limit";
import { Layer } from "effect";
import { Elysia, t } from "elysia";

import { publishedOutboundKeys } from "../lib/outbound-arc";
import { publicError } from "../lib/public-error";
import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import { memoryLimiter, OSN_RATE_LIMITS } from "./auth/limiters";
import { errorResponse } from "./auth/response-schemas";

/**
 * A JWK Set of osn-api's outbound ARC public keys. `additionalProperties`
 * passes every JWK member through: Elysia deletes undeclared response keys,
 * and a dropped member would leave an app unable to import the key.
 */
const arcJwkSet = t.Object({
  keys: t.Array(
    t.Object(
      {
        kty: t.Optional(t.String()),
        crv: t.Optional(t.String()),
        x: t.Optional(t.String()),
        y: t.Optional(t.String()),
        kid: t.String(),
        alg: t.Literal("ES256"),
        use: t.Literal("sig"),
      },
      { additionalProperties: true },
    ),
  ),
});

/**
 * The route's per-address budgets (`OSN_RATE_LIMITS.arcJwksIp` and
 * `arcJwksIpHour`): the minute one first, so a flood is refused before it
 * reaches the hour one, which bounds the reads one address can cost.
 */
export interface ArcJwksRateLimiters {
  readonly minute: RateLimiterBackend;
  readonly hour: RateLimiterBackend;
}

/**
 * `GET /.well-known/arc-jwks.json`: the public keys osn-api signs its ARC
 * calls to apps with (`lib/outbound-arc.ts`). Apps resolve an osn-api token's
 * kid here (`@shared/osn-auth-client/arc`). Read fresh on every request, never
 * cached: a key an isolate wrote a moment ago may already sign a call, and the
 * app asks for it on that call. At most `PUBLISHED_OUTBOUND_KEYS_BOUND` keys,
 * the newest.
 *
 * Anyone may call it, so each caller's address has a minute and an hour
 * budget, and an address that cannot be resolved is refused, as at every
 * per-IP limiter here. A refusal is 429 before any key is read. An app that is
 * refused remembers the kid it asked for as unknown for 30 seconds and then
 * fetches again, so it recovers once its window ends.
 */
export function createArcJwksRoutes(
  dbLayer: Layer.Layer<Db> = DbLive,
  loggerLayer: Layer.Layer<never> = Layer.empty,
  runtime?: AppRuntime,
  limiters: ArcJwksRateLimiters = {
    minute: memoryLimiter(OSN_RATE_LIMITS.arcJwksIp),
    hour: memoryLimiter(OSN_RATE_LIMITS.arcJwksIpHour),
  },
  clientIpConfig: Omit<ClientIpOptions, "socketIp"> = {},
) {
  const { run } = makeAppRunner(runtime, Layer.merge(dbLayer, loggerLayer));

  /** Whether the caller's address is inside both budgets; a limiter that throws refuses. */
  const admitted = async (ip: string): Promise<boolean> => {
    try {
      return (await limiters.minute.check(ip)) && (await limiters.hour.check(ip));
    } catch {
      return false;
    }
  };

  return new Elysia().get(
    "/.well-known/arc-jwks.json",
    async ({ headers, set, server, request }) => {
      set.headers["cache-control"] = "no-store";
      const ip = getClientIp(headers, {
        ...clientIpConfig,
        socketIp: server?.requestIP?.(request)?.address ?? null,
      });
      if (isUnresolvedIp(ip) || !(await admitted(ip))) {
        set.status = 429;
        return { error: "rate_limited" };
      }
      try {
        return { keys: [...(await run(publishedOutboundKeys))] };
      } catch (e) {
        const { status, body } = publicError(e, loggerLayer);
        set.status = status;
        return body;
      }
    },
    {
      response: { 200: arcJwkSet, 429: errorResponse, 500: errorResponse },
      detail: { operationId: "getArcJwks" },
    },
  );
}
