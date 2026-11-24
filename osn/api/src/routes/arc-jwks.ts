import { DbLive, type Db } from "@osn/db/service";
import {
  clientNetwork,
  getClientIp,
  isUnresolvedIp,
  type ClientIpOptions,
  type RateLimiterBackend,
} from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { publishedOutboundKeys } from "../lib/outbound-arc";
import { publicError } from "../lib/public-error";
import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import { metricArcJwksRefused, type ArcJwksLane, type ArcJwksRefusal } from "../metrics";
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

/** The address Cloudflare gives every Worker's subrequest to another zone. */
const WORKER_SUBREQUEST_ADDRESS = "2a06:98c0:3600::103";

/** How often, at most, a refusal is logged, per lane, per isolate. */
const REFUSAL_LOG_INTERVAL_MS = 60_000;

/** Zones many tenants' Workers run under, never taken as an app's own. */
const SHARED_PLATFORM_ZONES: ReadonlySet<string> = new Set(["workers.dev", "pages.dev"]);

/**
 * The app zone a request comes from, or null: behind Cloudflare only, its
 * `CF-Worker` names the zone of a configured app host, and it comes from the
 * Worker subrequest address or carries none. A direct caller cannot present
 * that address, and another tenant's Worker carries its own zone.
 */
function appZone(
  headers: Record<string, string | undefined>,
  trustCloudflare: boolean,
  appHosts: readonly string[],
): string | null {
  if (!trustCloudflare) return null;
  const zone = headers["cf-worker"]?.trim().toLowerCase();
  if (!zone || !zone.includes(".") || SHARED_PLATFORM_ZONES.has(zone)) return null;
  const from = headers["cf-connecting-ip"];
  if (from !== undefined && from !== WORKER_SUBREQUEST_ADDRESS) return null;
  return appHosts.some((host) => host === zone || host.endsWith(`.${zone}`)) ? zone : null;
}

/**
 * `GET /.well-known/arc-jwks.json`: the public keys osn-api signs its ARC
 * calls to apps with (`lib/outbound-arc.ts`). Apps resolve an osn-api token's
 * kid here (`@shared/osn-auth-client/arc`). Read fresh on every request, never
 * cached: a key an isolate wrote a moment ago may already sign a call, and the
 * app asks for it on that call. At most `PUBLISHED_OUTBOUND_KEYS_BOUND` keys,
 * the newest.
 *
 * Anyone may call it, so each caller's address (an IPv6 one by its /64) has a
 * minute and an hour budget, and an address that cannot be resolved is
 * refused, as at every per-IP limiter here. A configured app's fetch is
 * budgeted under its zone instead, apart from every other Worker, which share
 * one address. Each refusal is counted (`osn.arc.jwks.refused`, by lane and
 * reason), and the first in each minute per lane is logged. A refusal is 429 before any key is read. An app that is
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
  appHosts: readonly string[] = [],
) {
  const { run } = makeAppRunner(runtime, Layer.merge(dbLayer, loggerLayer));

  /** Null when the key is inside both budgets, else why not; a limiter that throws refuses. */
  const refusal = async (key: string): Promise<ArcJwksRefusal | null> => {
    try {
      if (!(await limiters.minute.check(key))) return "minute";
      if (!(await limiters.hour.check(key))) return "hour";
      return null;
    } catch {
      return "limiter_error";
    }
  };

  /** When each lane last logged a refusal, in this isolate. */
  const loggedAt = { app: 0, address: 0 } satisfies Record<ArcJwksLane, number>;

  /** Counts every refusal, and logs the first in each minute per lane. */
  const refused = (lane: ArcJwksLane, reason: ArcJwksRefusal): void => {
    metricArcJwksRefused(lane, reason);
    const now = Date.now();
    if (now - loggedAt[lane] < REFUSAL_LOG_INTERVAL_MS) return;
    loggedAt[lane] = now;
    void run(
      Effect.logWarning("osn.arc key list refused a caller over its budget", { lane, reason }),
    ).catch(() => undefined);
  };

  return new Elysia().get(
    "/.well-known/arc-jwks.json",
    async ({ headers, set, server, request }) => {
      set.headers["cache-control"] = "no-store";
      const zone = appZone(headers, clientIpConfig.trustCloudflare === true, appHosts);
      const ip = getClientIp(headers, {
        ...clientIpConfig,
        socketIp: server?.requestIP?.(request)?.address ?? null,
      });
      const lane: ArcJwksLane = zone === null ? "address" : "app";
      const reason =
        zone === null && isUnresolvedIp(ip)
          ? "unresolved"
          : await refusal(zone === null ? clientNetwork(ip) : `zone:${zone}`);
      if (reason !== null) {
        refused(lane, reason);
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
