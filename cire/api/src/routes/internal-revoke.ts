import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Option, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { getClientIp, isUnresolvedIp } from "../lib/client-ip";
import { metricOrganiserSessionRevoked } from "../metrics";
import { runCire } from "../observability";
import { organiserSessionService } from "../services/organiser-session";

const PREFIX = "/internal";

/**
 * Back-channel organiser-session revocation.
 *
 * An organiser's cire session is a 7-day opaque cookie minted from an OSN OIDC
 * sign-in; cire holds no other live credential for them. Left alone it lives out
 * its full TTL whatever happens on the OSN side. osn-api calls this endpoint,
 * once per profile of the account, when the account signs out everywhere else
 * or revokes cire's connection (`osn/api/src/services/cire-organiser-revoke.ts`),
 * without touching the normal 7-day sliding window. It maps 1:1 onto
 * `revokeAllForProfile`.
 *
 * **Auth.** cire-api is otherwise only an ARC *client* (it signs tokens to call
 * osn-api) and has no inbound ARC verifier — standing up osn-api key
 * distribution + a workerd-safe ARC receiver here is out of proportion to one
 * revoke hook. So this mirrors OSN's documented internal-bootstrap posture
 * (`Authorization: Bearer <shared secret>`, see `[[wiki/osn/arc-tokens]]`):
 * a single shared secret (`CIRE_INTERNAL_REVOKE_SECRET`, a wrangler secret),
 * compared in constant time. An absent secret, or one shorter than
 * {@link MIN_REVOKE_SECRET_LENGTH} characters, leaves the route DISABLED (503),
 * never open. osn-api holds the same secret and sends it as the bearer token;
 * the inventory shares one value between the two Workers.
 *
 * **Rate limit.** Only a refused caller spends the per-IP limiter. osn-api's
 * requests come through Cloudflare's Worker egress, which Cloudflare documents
 * as one address shared by every Worker, so a bucket every request spent could
 * be emptied by anyone's Worker and would then refuse the real caller; a
 * caller holding the secret is never limited. A
 * wrong or missing secret spends the bucket first, so guessing stays slow,
 * and an unresolved client address is refused as everywhere else.
 *
 * Mounted BEFORE the app-wide CSRF origin guard (same as the CSP-report
 * collector): this is a server-to-server POST with no browser `Origin`, so the
 * guard — which 403s a state-changing request lacking an allowlisted Origin —
 * must not gate it. The bearer secret is what authenticates it, not an Origin.
 */

export interface InternalRevokeRouteOptions {
  /**
   * Shared secret the caller (osn-api) must present as `Authorization: Bearer`.
   * `null`/absent, or shorter than {@link MIN_REVOKE_SECRET_LENGTH}, ⇒ the
   * endpoint is disabled and answers 503.
   */
  revokeSecret: string | null;
  /** Per-IP limiter for refused callers (fail-closed on an unresolved IP). */
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

/** The shortest secret the route accepts; a shorter one leaves it disabled (503). */
export const MIN_REVOKE_SECRET_LENGTH = 32;

/** `{ osnProfileId }`: one OSN profile id, `usr_…`, at most 64 characters. */
const RevokeBody = Schema.Struct({
  osnProfileId: Schema.String.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^usr_[A-Za-z0-9_]+$/),
  ),
});

export const createInternalRevokeRoutes = (
  db: Db,
  { revokeSecret, limiter }: InternalRevokeRouteOptions,
) =>
  new Elysia({ prefix: PREFIX }).post(
    "/revoke-organiser-sessions",
    async ({ request, set }) => {
      // Disabled when no usable secret is configured — fail closed, never open.
      if (!revokeSecret || revokeSecret.length < MIN_REVOKE_SECRET_LENGTH) {
        metricOrganiserSessionRevoked("disabled");
        set.status = 503;
        return { error: "revocation_unavailable" };
      }

      const presented = bearer(request.headers.get("authorization"));
      if (!presented || !timingSafeEqualString(revokeSecret, presented)) {
        const ip = getClientIp(request.headers);
        if (isUnresolvedIp(ip) || !(await limiter.check(ip))) {
          set.status = 429;
          set.headers["retry-after"] = "60";
          return { error: "Too many requests" };
        }
        metricOrganiserSessionRevoked("unauthorised");
        set.status = 401;
        return { error: "unauthorised" };
      }

      const raw: unknown = await request.json().catch(() => null);
      const body = Schema.decodeUnknownOption(RevokeBody)(raw);
      if (Option.isNone(body)) {
        metricOrganiserSessionRevoked("error");
        set.status = 400;
        return { error: "invalid_request" };
      }
      const { osnProfileId } = body.value;

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
