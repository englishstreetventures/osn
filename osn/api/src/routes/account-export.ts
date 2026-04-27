import { DbLive, type Db } from "@osn/db/service";
import { EmailService, makeLogEmailLive } from "@shared/email";
import { type RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../lib/auth-derive";
import { metricAuthRateLimited } from "../metrics";
import {
  closeDsarRequest,
  getExportStatus,
  openDsarRequest,
  streamAccountExport,
} from "../services/accountExport";
import { createAuthService, type AuthConfig } from "../services/auth";

/**
 * `GET /account/export` (C-H1, GDPR Art. 15 + Art. 20, CCPA right-to-know).
 *
 * Streams the account holder's full data bundle as NDJSON. Gated by:
 *   1. Bearer access token (resolves the caller's profile / accountId).
 *   2. Step-up token (`X-Step-Up-Token` header or `step_up_token` query
 *      param) — same allowed AMR as `/recovery/generate` (passkey or
 *      OTP). A stolen access token alone must not exfiltrate the
 *      account's personal data.
 *   3. Per-account daily limiter (1 request per 24 h, dsar.md line 73).
 *
 * `GET /account/export/status` is a lightweight companion endpoint for
 * the UI to render a countdown without burning the daily budget. It
 * does NOT require step-up — the response carries no personal data.
 */

export interface AccountExportRateLimiters {
  readonly accountExport: RateLimiterBackend;
  readonly accountExportStatus: RateLimiterBackend;
}

export function createDefaultAccountExportRateLimiters(): AccountExportRateLimiters {
  // In-memory dev defaults match the Redis-backed production budgets
  // configured in lib/redis-rate-limiters.ts.
  const { createRateLimiter } =
    require("@shared/rate-limit") as typeof import("@shared/rate-limit");
  return {
    accountExport: createRateLimiter({ maxRequests: 1, windowMs: 86_400_000 }),
    accountExportStatus: createRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
  };
}

export function createAccountExportRoutes(
  authConfig: AuthConfig,
  dbLayer: Layer.Layer<Db | EmailService> = Layer.merge(DbLive, makeLogEmailLive().layer),
  loggerLayer: Layer.Layer<never> = Layer.empty,
  rateLimiters: AccountExportRateLimiters = createDefaultAccountExportRateLimiters(),
) {
  const auth = createAuthService(authConfig);

  const run = <A, E, R extends Db | EmailService>(eff: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(dbLayer), Effect.provide(loggerLayer)) as Effect.Effect<
        A,
        never,
        never
      >,
    );

  /**
   * Per-account fail-closed limiter check. Mirrors the auth-route helper
   * but keys on `accountId` rather than IP — see dsar.md §"Auth" for
   * why per-IP is the wrong knob for the most data-sensitive endpoint.
   */
  async function rateLimitByAccount(
    accountId: string,
    endpoint: "account_export" | "account_export_status",
    limiter: RateLimiterBackend,
  ): Promise<{ error: string } | null> {
    let allowed: boolean;
    try {
      allowed = await limiter.check(accountId);
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
    new Elysia({ prefix: "" })
      // -----------------------------------------------------------------------
      // Status — lightweight, no step-up required.
      // -----------------------------------------------------------------------
      .get("/account/export/status", async ({ headers, set }) => {
        try {
          const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
          if (!claims) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const profile = await run(auth.findProfileById(claims.profileId));
          if (!profile) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const rlErr = await rateLimitByAccount(
            profile.accountId,
            "account_export_status",
            rateLimiters.accountExportStatus,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          const status = await run(getExportStatus(profile.accountId));
          return status;
        } catch (e) {
          set.status = 500;
          return { error: "internal_error", message: (e as Error)?.message ?? "" };
        }
      })
      // -----------------------------------------------------------------------
      // Streaming export — step-up gated, 1/day per account.
      // -----------------------------------------------------------------------
      .get(
        "/account/export",
        async ({ headers, query, set }) => {
          const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
          if (!claims) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const profile = await run(auth.findProfileById(claims.profileId));
          if (!profile) {
            set.status = 401;
            return { error: "unauthorized" };
          }

          // Step-up: header preferred (no query-string secret leakage in
          // logs); query-param accepted as a fallback because the browser
          // <a download> path can't easily inject a header. The token is
          // single-use (jti consumed by verifyStepUpToken) so even if it
          // does end up in an access log it's already burned.
          const stepUpToken =
            (headers["x-step-up-token"] as string | undefined) ??
            (query.step_up_token as string | undefined);
          if (!stepUpToken) {
            set.status = 403;
            return { error: "step_up_required" };
          }

          try {
            await run(auth.verifyStepUpForAccountExport(profile.accountId, stepUpToken));
          } catch {
            set.status = 401;
            return { error: "invalid_step_up_token" };
          }

          const rlErr = await rateLimitByAccount(
            profile.accountId,
            "account_export",
            rateLimiters.accountExport,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }

          // Open the dsar_requests audit row up front — even on error,
          // the row records that the request happened (closedAt set in
          // the finally branch below).
          const { id: dsarId } = await run(openDsarRequest(profile.accountId, "access"));

          const result = await run(streamAccountExport({ accountId: profile.accountId }));

          const enc = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              let crashed = false;
              try {
                for await (const line of result.stream) {
                  controller.enqueue(enc.encode(line.raw + "\n"));
                }
              } catch (err) {
                crashed = true;
                const msg = (err as Error)?.message ?? "stream_error";
                controller.enqueue(
                  enc.encode(JSON.stringify({ degraded: "orchestrator", reason: msg }) + "\n"),
                );
                controller.enqueue(
                  enc.encode(
                    JSON.stringify({ end: true, completedAt: new Date().toISOString() }) + "\n",
                  ),
                );
              } finally {
                controller.close();
                try {
                  await run(closeDsarRequest(dsarId, crashed ? "partial" : result.decision()));
                } catch {
                  // Audit-row close is best-effort — never block on it.
                }
              }
            },
          });

          // S-L1: explicit security headers on the streaming response.
          set.headers["content-type"] = "application/x-ndjson; charset=utf-8";
          set.headers["cache-control"] = "no-store";
          set.headers["x-content-type-options"] = "nosniff";
          // Suggest a filename so browser direct-download saves cleanly.
          const stamp = new Date().toISOString().slice(0, 10);
          set.headers["content-disposition"] =
            `attachment; filename="osn-data-export-${stamp}.ndjson"`;
          // Proactively log the open. No PII in this annotation — accountId
          // goes in the span via withDsarExport, not in the structured log.
          await Effect.runPromise(
            Effect.logInfo("dsar.export opened").pipe(
              Effect.annotateLogs({ dsarRequestId: dsarId }),
              Effect.provide(loggerLayer),
            ),
          );
          return stream;
        },
        {
          query: t.Object({
            step_up_token: t.Optional(t.String()),
          }),
        },
      )
  );
}
