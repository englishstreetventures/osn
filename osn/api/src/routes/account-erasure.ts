import { DbLive, type Db } from "@osn/db/service";
import { EmailService, makeLogEmailLive } from "@shared/email";
import {
  createRateLimiter,
  getClientIp,
  isUnresolvedIp,
  type ClientIpOptions,
  type RateLimiterBackend,
} from "@shared/rate-limit";
import { Layer } from "effect";
import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../lib/auth-derive";
import { readSessionCookie, type CookieSessionConfig } from "../lib/cookie-session";
import { publicError } from "../lib/public-error";
import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import { metricAccountDeletionRequested, metricAuthRateLimited } from "../metrics";
import * as accountErasure from "../services/account-erasure";
import { createAuthService, type AuthConfig } from "../services/auth";

/**
 * Per-account rate limits for the deletion endpoints. Tighter than the
 * normal auth surface because each call is a destructive ceremony — the
 * step-up gate is the primary defence; the limiter just curbs noise.
 */
export interface AccountErasureRateLimiters {
  readonly accountDelete: RateLimiterBackend;
  readonly accountRestore: RateLimiterBackend;
  readonly accountDeletionStatus: RateLimiterBackend;
}

export function createDefaultAccountErasureRateLimiters(): AccountErasureRateLimiters {
  return {
    accountDelete: createRateLimiter({ maxRequests: 5, windowMs: 3_600_000 }),
    accountRestore: createRateLimiter({ maxRequests: 10, windowMs: 3_600_000 }),
    accountDeletionStatus: createRateLimiter({ maxRequests: 30, windowMs: 60_000 }),
  };
}

/**
 * Flow A — full OSN account erasure. The user holds an OSN access token
 * + a fresh step-up token. After verification the service tombstones the
 * account; the route fires the cross-service fan-out as a daemon Effect
 * so the 202 response stays under the per-bridge timeout.
 */
export function createAccountErasureRoutes(
  authConfig: AuthConfig,
  dbLayer: Layer.Layer<Db | EmailService> = Layer.merge(DbLive, makeLogEmailLive().layer),
  loggerLayer: Layer.Layer<never> = Layer.empty,
  rateLimiters: AccountErasureRateLimiters = createDefaultAccountErasureRateLimiters(),
  cookieConfig: CookieSessionConfig = { secure: false },
  /**
   * Client-IP trust policy (S-M5 / S-M34). See `createAuthRoutes` for the
   * full contract. Defaults to `{}` (direct mode, socket peer only).
   */
  clientIpConfig: Omit<ClientIpOptions, "socketIp"> = {},
  /** Shared application runtime (see `createAuthRoutes`). */
  runtime?: AppRuntime,
) {
  const auth = createAuthService(authConfig);
  const rl = rateLimiters;

  const { run } = makeAppRunner(runtime, Layer.merge(dbLayer, loggerLayer));

  const handleError = (e: unknown) => publicError(e, loggerLayer);

  /** Per-request transport socket peer (S-M34); `null` under `app.handle`. */
  type IpCtx = {
    server: { requestIP?: (req: Request) => { address?: string } | null } | null;
    request: Request;
  };
  const socketIpOf = (ctx: IpCtx): string | null =>
    ctx.server?.requestIP?.(ctx.request)?.address ?? null;

  async function rateLimit(
    headers: Record<string, string | undefined>,
    socketIp: string | null,
    endpoint: "account_delete" | "account_restore" | "account_deletion_status",
    limiter: RateLimiterBackend,
  ): Promise<{ error: string } | null> {
    const ip = getClientIp(headers, { ...clientIpConfig, socketIp });
    // S-M34: never key the limiter on an unresolved IP — deny instead of
    // sharing one bucket across all un-attributable requests.
    if (isUnresolvedIp(ip)) {
      metricAuthRateLimited(endpoint);
      return { error: "rate_limited" };
    }
    let allowed: boolean;
    try {
      allowed = await limiter.check(ip);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      metricAuthRateLimited(endpoint);
      return { error: "rate_limited" };
    }
    return null;
  }

  return (
    new Elysia({ prefix: "/account" })
      // ---------------------------------------------------------------------
      // DELETE /account — Flow A: full OSN account deletion (soft delete).
      //
      // Requires: bearer access token, step-up token, body confirmation
      // (handle typed verbatim by the user). Returns 202 with `scheduled_for`.
      // Idempotent for an already-pending deletion.
      // ---------------------------------------------------------------------
      .delete(
        "",
        async ({ body, headers, set, server, request }) => {
          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "account_delete",
            rl.accountDelete,
          );
          if (rlErr) {
            set.status = 429;
            metricAccountDeletionRequested("rate_limited");
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              metricAccountDeletionRequested("error");
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileByIdIncludingTombstoned(claims.profileId));
            if (!profile) {
              set.status = 401;
              metricAccountDeletionRequested("error");
              return { error: "unauthorized" };
            }

            // Confirmation: the user must type their handle verbatim. Defends
            // against accidental clicks ("rm -rf ~ but worse").
            if (body.confirm_handle !== profile.handle) {
              set.status = 400;
              metricAccountDeletionRequested("error");
              return { error: "handle_mismatch" };
            }

            const stepUpToken = body.step_up_token ?? headers["x-step-up-token"];
            if (!stepUpToken) {
              set.status = 403;
              metricAccountDeletionRequested("step_up_failed");
              return { error: "step_up_required" };
            }
            try {
              await run(auth.verifyStepUpForAccountDelete(profile.accountId, stepUpToken));
            } catch (e) {
              set.status = 403;
              metricAccountDeletionRequested("step_up_failed");
              const { body: errBody } = handleError(e);
              return { error: "step_up_required", detail: errBody };
            }

            // Cancellation handle = current session id (hashed). Read from the
            // session cookie if present so the user can cancel during the grace
            // window without further auth.
            const rawCookie = headers.cookie;
            const sessionToken = rawCookie ? readSessionCookie(rawCookie, cookieConfig) : null;
            const cancelSessionId = sessionToken ? auth.hashSessionToken(sessionToken) : null;

            const result = await run(
              accountErasure.requestErasure({
                accountId: profile.accountId,
                cancelSessionId,
              }),
            );

            metricAccountDeletionRequested(result.newlyScheduled ? "ok" : "already_pending");

            // No fan-out here (S-H1): cross-service purges only fire from
            // the sweeper AFTER the 7-day grace window elapses, so a
            // restore during the window loses nothing on Pulse / Zap.
            // See `runFanOutSweep` in services/account-erasure.ts.

            set.status = 202;
            return {
              scheduled_for: result.scheduledFor,
              already_pending: !result.newlyScheduled,
            };
          } catch (e) {
            metricAccountDeletionRequested("error");
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            confirm_handle: t.String({ minLength: 1, maxLength: 64 }),
            step_up_token: t.Optional(t.String()),
          }),
        },
      )
      // ---------------------------------------------------------------------
      // POST /account/restore — cancellation flow during the grace window.
      //
      // The user must hit this endpoint with the cancellation session that
      // was preserved at soft-delete time (the only surviving session for
      // this account). We don't require step-up here — the session itself
      // is a fresh-enough authenticator within the 7-day window.
      // ---------------------------------------------------------------------
      .post("/restore", async ({ headers, set, server, request }) => {
        const rlErr = await rateLimit(
          headers,
          socketIpOf({ server, request }),
          "account_restore",
          rl.accountRestore,
        );
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
          if (!claims) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const profile = await run(auth.findProfileByIdIncludingTombstoned(claims.profileId));
          if (!profile) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const result = await run(accountErasure.cancelErasure(profile.accountId));
          return { cancelled: result.cancelled };
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      })
      // ---------------------------------------------------------------------
      // GET /account/deletion-status — UI banner support.
      // ---------------------------------------------------------------------
      .get("/deletion-status", async ({ headers, set, server, request }) => {
        const rlErr = await rateLimit(
          headers,
          socketIpOf({ server, request }),
          "account_deletion_status",
          rl.accountDeletionStatus,
        );
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
          if (!claims) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const profile = await run(auth.findProfileByIdIncludingTombstoned(claims.profileId));
          if (!profile) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const status = await run(accountErasure.getDeletionStatus(profile.accountId));
          return status;
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      })
  );
}
