import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { metricOrganiserSessionRevoked } from "../metrics";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { runCire } from "../observability";
import { organiserSessionService } from "../services/organiser-session";

const PREFIX = "/internal";

/**
 * Back-channel organiser-session revocation.
 *
 * An organiser's cire session is a 7-day opaque cookie minted from an OSN OIDC
 * sign-in; cire holds no other live credential for them. Left alone it lives out
 * its full TTL even after the OSN side has revoked the connection or deleted the
 * account. This endpoint lets osn-api kill those sessions PROMPTLY on such an
 * event without touching the normal 7-day sliding window (renewal is still a
 * silent OIDC round-trip). It maps 1:1 onto `revokeAllForProfile`.
 *
 * **Auth.** cire-api is otherwise only an ARC *client* (it signs tokens to call
 * osn-api) and has no inbound ARC verifier — standing up osn-api key
 * distribution + a workerd-safe ARC receiver here is out of proportion to one
 * revoke hook. So this mirrors OSN's documented internal-bootstrap posture
 * (`Authorization: Bearer <shared secret>`, see `[[wiki/systems/arc-tokens]]`):
 * a single shared secret (`CIRE_INTERNAL_REVOKE_SECRET`, a wrangler secret),
 * compared in constant time. Absent secret ⇒ the route is DISABLED (503), never
 * open. osn-api must be provisioned with the same secret and send it as the
 * bearer token — that caller wiring lives on the osn-api side.
 *
 * Mounted BEFORE the app-wide CSRF origin guard (same as the CSP-report
 * collector): this is a server-to-server POST with no browser `Origin`, so the
 * guard — which 403s a state-changing request lacking an allowlisted Origin —
 * must not gate it. The bearer secret is what authenticates it, not an Origin.
 */

export interface InternalRevokeRouteOptions {
  /**
   * Shared secret the caller (osn-api) must present as `Authorization: Bearer`.
   * `null`/absent ⇒ the endpoint is disabled and answers 503.
   */
  revokeSecret: string | null;
  /** Per-IP limiter (fail-closed on an unresolved IP), like every cire route. */
  limiter: RateLimiterBackend;
}

/** Pulls the token out of an `Authorization: Bearer <token>` header. */
const bearer = (header: string | null): string | null => {
  if (!header) return null;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
};

export const createInternalRevokeRoutes = (
  db: Db,
  { revokeSecret, limiter }: InternalRevokeRouteOptions,
) =>
  new Elysia({ prefix: PREFIX }).use(rateLimitMiddleware(limiter)).post(
    "/revoke-organiser-sessions",
    async ({ request, set }) => {
      // Disabled when no secret is configured — fail closed, never open.
      if (!revokeSecret) {
        metricOrganiserSessionRevoked("disabled");
        set.status = 503;
        return { error: "revocation_unavailable" };
      }

      const presented = bearer(request.headers.get("authorization"));
      if (!presented || !timingSafeEqualString(revokeSecret, presented)) {
        metricOrganiserSessionRevoked("unauthorised");
        set.status = 401;
        return { error: "unauthorised" };
      }

      const raw: unknown = await request.json().catch(() => null);
      const osnProfileId =
        typeof raw === "object" && raw !== null && "osnProfileId" in raw
          ? (raw as { osnProfileId: unknown }).osnProfileId
          : null;
      if (typeof osnProfileId !== "string" || osnProfileId.length === 0) {
        metricOrganiserSessionRevoked("error");
        set.status = 400;
        return { error: "invalid_request" };
      }

      const ok = await runCire(
        organiserSessionService.revokeAllForProfile(osnProfileId).pipe(
          Effect.as(true),
          Effect.provideService(DbService, db),
          Effect.catchTag("OrganiserSessionWriteError", () => Effect.succeed(false)),
        ),
      );
      if (!ok) {
        metricOrganiserSessionRevoked("error");
        set.status = 500;
        return { error: "revoke_failed" };
      }

      // Idempotent: a profile with no live sessions still succeeds. We never
      // report a row count — that would be a free oracle on who is signed in.
      metricOrganiserSessionRevoked("ok");
      return { ok: true };
    },
    // Sentinel parse hook — read the body by hand so malformed JSON degrades to
    // the 400 above rather than a framework parse error.
    { parse: () => ({}) },
  );
