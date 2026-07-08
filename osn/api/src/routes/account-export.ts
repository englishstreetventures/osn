import { Db, DbLive } from "@osn/db/service";
import {
  createRateLimiter,
  getClientIp,
  isUnresolvedIp,
  type ClientIpOptions,
  type RateLimiterBackend,
} from "@shared/rate-limit";
import { Layer } from "effect";
import { Elysia } from "elysia";

import { resolveAccessTokenPrincipal } from "../lib/auth-derive";
import { arcFetchStream } from "../lib/outbound-arc";
import { publicError } from "../lib/public-error";
import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import { metricAccountExportRequested } from "../metrics";
import {
  defaultExportDownstreams,
  exportLines,
  ndjsonStream,
  type ExportDownstream,
} from "../services/account-export";
import { createAuthService, type AuthConfig } from "../services/auth";

/**
 * C-H1 — `GET /account/export` (DSAR Art. 15 access / Art. 20 portability).
 *
 * Self-service, step-up gated, rate-limited to 1 export / 24 h / account.
 * Streams the bundle as NDJSON (see `services/account-export.ts` for the wire
 * contract and `[[wiki/compliance/dsar]]` for the locked spec). The step-up
 * token rides the `x-step-up-token` header (a GET has no body) and must carry
 * `purpose: "account_export"`.
 */
export function createAccountExportRoutes(
  authConfig: AuthConfig,
  dbLayer: Layer.Layer<Db> = DbLive,
  loggerLayer: Layer.Layer<never> = Layer.empty,
  /**
   * Per-ACCOUNT limiter — 1 export / 24 h. Keyed on the server-derived
   * accountId (never client-supplied), so it can't be sidestepped by rotating
   * IPs. In-memory default; production wires a Redis backend at composition.
   */
  exportRateLimiter: RateLimiterBackend = createRateLimiter({
    maxRequests: 1,
    windowMs: 24 * 60 * 60 * 1000,
  }),
  /**
   * Per-IP guard on the pre-auth surface so an unauthenticated flood can't
   * spin up JWKS verification cost. Generous; the per-account limiter is the
   * real 1/24h cap.
   */
  ipRateLimiter: RateLimiterBackend = createRateLimiter({ maxRequests: 30, windowMs: 60_000 }),
  clientIpConfig: Omit<ClientIpOptions, "socketIp"> = {},
  runtime?: AppRuntime,
  downstreams: ExportDownstream[] = defaultExportDownstreams(),
) {
  const auth = createAuthService(authConfig);
  const { run } = makeAppRunner<Db>(runtime, Layer.merge(dbLayer, loggerLayer));
  const handleError = (e: unknown) => publicError(e, loggerLayer);

  type IpCtx = {
    server: { requestIP?: (req: Request) => { address?: string } | null } | null;
    request: Request;
  };
  const socketIpOf = (ctx: IpCtx): string | null =>
    ctx.server?.requestIP?.(ctx.request)?.address ?? null;

  return new Elysia({ prefix: "/account" }).get(
    "/export",
    async ({ headers, set, server, request }) => {
      // Pre-auth per-IP throttle (fail-closed).
      const ip = getClientIp(headers, {
        ...clientIpConfig,
        socketIp: socketIpOf({ server, request }),
      });
      if (isUnresolvedIp(ip)) {
        metricAccountExportRequested("rate_limited");
        set.status = 429;
        return { error: "rate_limited" };
      }
      let ipAllowed: boolean;
      try {
        ipAllowed = await ipRateLimiter.check(ip);
      } catch {
        ipAllowed = false;
      }
      if (!ipAllowed) {
        metricAccountExportRequested("rate_limited");
        set.status = 429;
        return { error: "rate_limited" };
      }

      try {
        const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
        if (!claims) {
          set.status = 401;
          metricAccountExportRequested("unauthorized");
          return { error: "unauthorized" };
        }
        const profile = await run(auth.findProfileById(claims.profileId));
        if (!profile) {
          set.status = 401;
          metricAccountExportRequested("unauthorized");
          return { error: "unauthorized" };
        }

        const stepUpToken = headers["x-step-up-token"];
        if (!stepUpToken) {
          set.status = 403;
          metricAccountExportRequested("step_up_failed");
          return { error: "step_up_required" };
        }
        try {
          await run(auth.verifyStepUpForAccountExport(profile.accountId, stepUpToken));
        } catch (e) {
          set.status = 403;
          metricAccountExportRequested("step_up_failed");
          const { body: errBody } = handleError(e);
          return { error: "step_up_required", detail: errBody };
        }

        // Per-account 1/24h cap — consumed only AFTER a successful step-up so a
        // fumbled ceremony never burns the user's daily allowance.
        let allowed: boolean;
        try {
          allowed = await exportRateLimiter.check(profile.accountId);
        } catch {
          allowed = false;
        }
        if (!allowed) {
          set.status = 429;
          metricAccountExportRequested("rate_limited");
          return { error: "rate_limited" };
        }

        const { db } = await run(Db);
        const stream = ndjsonStream(
          exportLines({
            db,
            accountId: profile.accountId,
            downstreams,
            fetchStream: (ds, body) =>
              arcFetchStream(ds.url, body, {
                audience: ds.audience,
                scope: "account:export",
                timeoutMs: 10_000,
              }),
          }),
        );
        metricAccountExportRequested("ok");
        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-store",
            "content-disposition": 'attachment; filename="osn-account-export.ndjson"',
          },
        });
      } catch (e) {
        metricAccountExportRequested("error");
        const { status, body: errBody } = handleError(e);
        set.status = status;
        return errBody;
      }
    },
  );
}
