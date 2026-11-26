import { DbLive, type Db } from "@osn/db/service";
import {
  checkArcKid,
  holdsArcKidKey,
  readArcKeyAsk,
  type ArcKidSecrets,
} from "@shared/crypto/arc-kid";
import {
  clientNetwork,
  getClientIp,
  isUnresolvedIp,
  type ClientIpOptions,
  type RateLimiterBackend,
} from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import {
  OUTBOUND_KEY_LIFE_SECONDS,
  OutboundKeyReadError,
  publishedOutboundKeyById,
  publishedOutboundKeys,
  type PublishedArcKey,
} from "../lib/outbound-arc";
import { createOutboundKeyMemory, KEY_MEMORY_MAX } from "../lib/outbound-key-memory";
import { publicError } from "../lib/public-error";
import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import {
  metricArcJwksKeyLookup,
  metricArcJwksRefused,
  type ArcJwksLane,
  type ArcJwksRefusal,
} from "../metrics";
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

/** The ask for one key: `?kid=`, a kid as an ARC token's header carries it. */
const keyAsk = t.Object({ kid: t.Optional(t.String({ minLength: 1, maxLength: 128 })) });

/**
 * The route's budgets (`OSN_RATE_LIMITS.arcJwksIp` and `arcJwksIpHour`): the
 * minute one, per address or app zone, first, so a flood is refused before it
 * reaches the hour one, which bounds the reads of the whole list. The minute
 * one also budgets, under keys of their own, the asks for one key osn-api
 * cannot verify, and a direct caller's asks.
 */
export interface ArcJwksRateLimiters {
  readonly minute: RateLimiterBackend;
  readonly hour: RateLimiterBackend;
}

/** The address Cloudflare gives every Worker's subrequest to another zone. */
const WORKER_SUBREQUEST_ADDRESS = "2a06:98c0:3600::103";

/** Whether `limiter` admits `key`; one that throws refuses. */
async function admittedBy(limiter: RateLimiterBackend, key: string): Promise<boolean> {
  try {
    return await limiter.check(key);
  } catch {
    return false;
  }
}

/** How long an isolate remembers that the hour budget refused a key. */
const HOUR_REFUSAL_MEMO_MS = 60_000;

/** The most keys an isolate remembers as refused for the hour. */
const HOUR_REFUSAL_MEMO_MAX = 4_096;

/** How often, at most, a refusal is logged, per lane, per isolate. */
const REFUSAL_LOG_INTERVAL_MS = 60_000;

/** How often, at most, a full key memory is logged, per isolate. */
const MEMORY_FULL_LOG_INTERVAL_MS = 60_000;

/** The one hour budget every address shares for the whole list. */
const ADDRESSES_HOUR_KEY = "addresses";

/** How far a kid's expiry may sit ahead of this isolate's clock: a key's life and five minutes. */
const MAX_ASK_LIFE_SECONDS = OUTBOUND_KEY_LIFE_SECONDS + 300;

/** Holding no secret, as a local osn-api may. */
const NO_KID_SECRETS: ArcKidSecrets = { kidSecret: undefined, serviceSecret: undefined };

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
 * calls to apps with (`lib/outbound-arc.ts`), never cached by the client.
 *
 * `?kid=<kid>` asks for the one key an app needs (`@shared/osn-auth-client/arc`).
 * An ask no osn-api could have minted a kid for is answered with no key and
 * no read. A kid one of whose MACs verifies under a secret osn-api holds is
 * answered from this isolate's memory, which reads the database at most once
 * a minute for it (`lib/outbound-key-memory.ts`); a key written a moment ago
 * is read on its first ask. An app's ask for a kid osn-api verifies spends no
 * budget, so while this isolate holds the secret value a key was minted
 * under, nothing a sender makes an app ask for can refuse the asks for it. A
 * kid osn-api cannot verify (a made-up one, or one minted under a secret
 * value this isolate does not hold, during a rotation) is answered from
 * memory when its key is held, and otherwise read under a minute budget of
 * its own per address or app zone, which the native binding counts in each
 * Cloudflare location; a key that read finds is held, an absence never. A
 * direct caller's asks also spend its address's minute budget. No ask calls
 * the coordination store.
 *
 * Without `kid` it serves the whole list, read fresh, at most
 * `PUBLISHED_OUTBOUND_KEYS_BOUND` keys, the newest: apps on the code before
 * key-by-id fetch it, and a person may read it. Each caller's address (an
 * IPv6 one by its /64) has a minute budget and every address shares one hour
 * budget; a configured app's fetch is budgeted under its zone instead, apart
 * from every other Worker, which share one address. An address that cannot
 * be resolved is refused, as at every per-IP limiter here.
 *
 * Each refusal is counted (`osn.arc.jwks.refused`, by lane and reason), and
 * the first in each minute per lane is logged. A refusal is 429 before any
 * key is read. A refused app fetches again 30 seconds later, so it recovers
 * once its window ends. An isolate remembers an hour refusal for a minute, a
 * failing store's included, so after the store recovers an app can wait up
 * to about 90 seconds.
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
  kidSecrets: ArcKidSecrets = NO_KID_SECRETS,
) {
  const { run } = makeAppRunner(runtime, Layer.merge(dbLayer, loggerLayer));
  const checksKids = holdsArcKidKey(kidSecrets);
  const memory = createOutboundKeyMemory();
  let memoryFullLoggedAt = 0;

  /**
   * Keys the hour budget refused, until when: this isolate answers them from
   * here for a minute instead of asking the store on every call. Pruned on
   * each refusal and capped, so the map never grows past its cap.
   */
  const hourRefused = new Map<string, number>();

  const rememberHourRefusal = (key: string, now: number): void => {
    for (const [held, until] of hourRefused) if (until <= now) hourRefused.delete(held);
    if (hourRefused.size >= HOUR_REFUSAL_MEMO_MAX) return;
    hourRefused.set(key, now + HOUR_REFUSAL_MEMO_MS);
  };

  /**
   * Null when the key is inside both budgets, else the budget that refused it:
   * the minute one first, so a refused flood never reaches the store. A
   * limiter that fails refuses, as the deployed ones do themselves.
   */
  const refusal = async (minuteKey: string, hourKey: string): Promise<ArcJwksRefusal | null> => {
    const now = Date.now();
    if ((hourRefused.get(hourKey) ?? 0) > now) {
      return (await admittedBy(limiters.minute, minuteKey)) ? "hour" : "minute";
    }
    if (!(await admittedBy(limiters.minute, minuteKey))) return "minute";
    if (!(await admittedBy(limiters.hour, hourKey))) {
      rememberHourRefusal(hourKey, now);
      return "hour";
    }
    return null;
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

  /** Logs, at most once a minute, that the key memory was full. */
  const memoryFull = (): void => {
    const now = Date.now();
    if (now - memoryFullLoggedAt < MEMORY_FULL_LOG_INTERVAL_MS) return;
    memoryFullLoggedAt = now;
    void run(
      Effect.logWarning("osn.arc key memory is full; answering without holding", {
        max: KEY_MEMORY_MAX,
      }),
    ).catch(() => undefined);
  };

  /**
   * The answer to an ask for one key, or the budget that refused it. `minuteKey`
   * is the direct caller's address, null for an app's ask.
   */
  const keyById = async (
    ask: string,
    lane: ArcJwksLane,
    minuteKey: string | null,
    probeKey: string,
  ): Promise<PublishedArcKey | null | ArcJwksRefusal> => {
    if (minuteKey !== null && !(await admittedBy(limiters.minute, minuteKey))) return "minute";
    const now = Math.floor(Date.now() / 1000);
    const id = readArcKeyAsk(ask, now, MAX_ASK_LIFE_SECONDS);
    if (id === null) {
      metricArcJwksKeyLookup(lane, "refused");
      return null;
    }
    const read = () => run(publishedOutboundKeyById(id));
    if (checksKids && (await checkArcKid(ask, kidSecrets, now)) !== null) {
      const answer = await memory.answer(id, read, true);
      if (answer.full) memoryFull();
      metricArcJwksKeyLookup(lane, answer.read ? "read" : "memory");
      return answer.key;
    }
    // A kid this isolate cannot verify: a key already held is answered with
    // no read and no budget; otherwise one budgeted read, holding the key it
    // finds and never an absence, which a sender could choose.
    const held = memory.held(id);
    if (held) {
      metricArcJwksKeyLookup(lane, "memory");
      return held.key;
    }
    if (!(await admittedBy(limiters.minute, probeKey))) return "probe";
    metricArcJwksKeyLookup(lane, "probe");
    const answer = await memory.answer(id, read, false);
    if (answer.full) memoryFull();
    return answer.key;
  };

  return new Elysia().get(
    "/.well-known/arc-jwks.json",
    async ({ headers, set, server, request, query }) => {
      set.headers["cache-control"] = "no-store";
      const zone = appZone(headers, clientIpConfig.trustCloudflare === true, appHosts);
      const ip = getClientIp(headers, {
        ...clientIpConfig,
        socketIp: server?.requestIP?.(request)?.address ?? null,
      });
      const lane: ArcJwksLane = zone === null ? "address" : "app";
      const refuse = (reason: ArcJwksRefusal) => {
        refused(lane, reason);
        set.status = 429;
        return { error: "rate_limited" };
      };
      if (zone === null && isUnresolvedIp(ip)) return refuse("unresolved");
      const caller = zone === null ? clientNetwork(ip) : `zone:${zone}`;
      try {
        if (query.kid !== undefined) {
          const answer = await keyById(
            query.kid,
            lane,
            zone === null ? caller : null,
            `probe:${caller}`,
          );
          if (typeof answer === "string") return refuse(answer);
          return { keys: answer === null ? [] : [answer] };
        }
        const reason = await refusal(caller, zone === null ? ADDRESSES_HOUR_KEY : caller);
        if (reason !== null) return refuse(reason);
        return { keys: [...(await run(publishedOutboundKeys))] };
      } catch (e) {
        const { status, body } = publicError(e, loggerLayer);
        // A read that failed is osn-api's fault, never the caller's.
        if (e instanceof OutboundKeyReadError) {
          set.status = 500;
          return { error: "internal_error" };
        }
        set.status = status;
        return body;
      }
    },
    {
      query: keyAsk,
      response: { 200: arcJwkSet, 429: errorResponse, 500: errorResponse },
      detail: { operationId: "getArcJwks" },
    },
  );
}
