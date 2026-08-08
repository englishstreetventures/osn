import type { RateLimiterBackend } from "@shared/rate-limit";
import type { TurnstileVerifier } from "@shared/turnstile";
import { Data, Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { buildSessionCookie, clearSessionCookie, parseSessionToken } from "../lib/cookie";
import { sessionAuth } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { turnstileGate } from "../middleware/turnstile";
import { runCire } from "../observability";
import { ClaimBody } from "../schemas/claim";
import { claimService } from "../services/claim";
import { inviteService } from "../services/invite";
import { sessionService } from "../services/session";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ClaimRouteOptions {
  /** Primary origin (used for the session cookie's `secure` flag). */
  webOrigin: string;
  /** Per-IP rate limiter (brute-force protection — S-C2). */
  limiter: RateLimiterBackend;
  /**
   * Turnstile verifier (KEY-OPTIONAL). `null` ⇒ gate skipped; configured ⇒
   * a missing/invalid token fails closed (403) before the credential lookup.
   */
  turnstileVerifier?: TurnstileVerifier | null;
}

export const createClaimRoutes = (
  db: Db,
  { webOrigin, limiter, turnstileVerifier = null }: ClaimRouteOptions,
) =>
  new Elysia({ prefix: "/api/claim" }).use(rateLimitMiddleware(limiter)).post(
    "/",
    async ({ request, set }) => {
      const raw: unknown = await request.json().catch(() => null);

      // Turnstile bot gate (key-optional; no-op when unconfigured). Runs after
      // the per-IP limiter, before the credential lookup — a bot that can't pass
      // the challenge never reaches the claim-code oracle.
      const tsErr = await turnstileGate(turnstileVerifier, "claim", raw, request.headers);
      if (tsErr) {
        set.status = tsErr.status;
        return { error: tsErr.error };
      }

      return runCire(
        Effect.gen(function* () {
          const { publicId } = yield* Schema.decodeUnknown(ClaimBody)(raw);
          const result = yield* claimService.lookup(publicId.trim().toUpperCase());
          // Session write may fail (DB transient error) — we still hand the user
          // their invite payload and skip Set-Cookie. Error is logged inside the
          // service. They can re-login to mint a fresh session.
          const session: { token: string; expiresAt: Date } | undefined = yield* sessionService
            .create(result.familyId, SESSION_TTL_SECONDS)
            .pipe(Effect.catchTag("SessionWriteError", () => Effect.succeed(undefined)));
          if (session) {
            set.headers["set-cookie"] = buildSessionCookie(session.token, {
              secure: webOrigin.startsWith("https://"),
              maxAgeSeconds: SESSION_TTL_SECONDS,
            });
          }
          return result;
        }).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("ParseError", () =>
            Effect.sync(() => {
              set.status = 400;
              return { error: "Missing or invalid fields" };
            }),
          ),
          Effect.catchTag("InvalidCredentials", () =>
            Effect.sync(() => {
              set.status = 401;
              return { error: "Invalid credentials" };
            }),
          ),
        ),
      );
    },
    // Sentinel parse hook: stops Elysia from consuming the body so the handler
    // can parse it by hand — a malformed payload degrades to the schema's 400
    // instead of Elysia's parser error.
    { parse: () => ({}) },
  );

export interface ClaimSignoutRouteOptions {
  /** Primary origin (used for the cleared cookie's `secure` flag). */
  webOrigin: string;
  /** Per-IP limiter. Shares the restore route's page-load-sized budget. */
  limiter: RateLimiterBackend;
}

/**
 * `POST /api/claim/signout` — end the household session this browser holds.
 *
 * The guest counterpart to the organiser's `POST /api/auth/signout`, and the
 * server half of the guest site's "Not the <name> family? Sign out" control.
 * Until this existed there was NO way for a guest to end a `cire_session`:
 * `sessionService.revoke` had no guest-facing caller, so a 30-day credential
 * that auto-exercises on every page load could only be ended by expiry or an
 * organiser action (deactivate / remint). Shared and borrowed devices are the
 * normal case for a wedding invite — a family tablet, a phone handed to a
 * relative, a venue kiosk — and on those the surviving cookie is a live *write*
 * capability: it reads guest names and per-event dietary free text (Art. 9) and
 * it can submit or overwrite the household's RSVPs.
 *
 * A THIRD sibling instance rather than another route on `createClaimSessionRoutes`,
 * because it deliberately does NOT mount `sessionAuth`. Signing out is
 * idempotent and inherently safe: the only thing a caller can revoke is a token
 * they already present, so there is nothing to authorise. Requiring auth would
 * make the one case that most needs to succeed — an expired or already-revoked
 * cookie still sitting in the browser — answer 401 and leave the cookie in
 * place. This always clears it and always answers 204.
 *
 * The revoke is best-effort: a D1 blip must not leave the guest believing they
 * are still signed in, and the cleared cookie already makes the token
 * unreachable from this browser. `POST`, so `originGuard` covers it.
 */
export const createClaimSignoutRoutes = (
  db: Db,
  { webOrigin, limiter }: ClaimSignoutRouteOptions,
) =>
  new Elysia({ prefix: "/api/claim" })
    .use(rateLimitMiddleware(limiter))
    .post("/signout", async ({ request, set }) => {
      const token = parseSessionToken(request.headers.get("cookie"));

      // Clear unconditionally, and BEFORE the revoke can fail. This is the half
      // that always works and the half the guest can see.
      set.headers["set-cookie"] = clearSessionCookie({
        secure: webOrigin.startsWith("https://"),
      });
      set.headers["cache-control"] = "no-store";

      if (token) {
        await runCire(
          sessionService.revoke(token).pipe(
            Effect.provideService(DbService, db),
            // Already logged inside the service. Swallowed on purpose: the
            // cookie is gone either way, and reporting a failure here would
            // tell the guest they are still signed in when this browser can no
            // longer present the token.
            Effect.catchTag("SessionWriteError", () => Effect.void),
          ),
        );
      }

      set.status = 204;
      return null;
    });

/** The session is valid, but belongs to a different wedding than the one asked for. */
class SessionNotForWedding extends Data.TaggedError("SessionNotForWedding") {}

export interface ClaimSessionRouteOptions {
  /** Primary origin (used for the cleared cookie's `secure` flag). */
  webOrigin: string;
  /**
   * Per-IP limiter for the restore read. Deliberately NOT the claim limiter:
   * that one is a 5/min brute-force budget sized for a credential surface, and
   * this route is hit on every page load by guests who already hold a session —
   * a household behind one NAT would 429 itself just by reloading. See the
   * sibling-instance split below.
   */
  limiter: RateLimiterBackend;
}

/**
 * `GET /api/claim/session` — re-read the invite for the household this
 * `cire_session` cookie already belongs to.
 *
 * A SIBLING instance to `createClaimRoutes` rather than another route on it, so
 * the two get different limiters (Elysia applies a scoped middleware per
 * instance) — the same split as the organiser hosts read/write routes. The
 * credential surface keeps its tight budget; the restore read gets a page-load-
 * sized one.
 *
 * No Turnstile: the caller isn't presenting a code, they're presenting a session
 * this API minted. No Origin guard concerns either — it is a safe GET.
 *
 * Two different 401s, and the difference matters. A DEAD session (family
 * withdrawn, or its row gone) gets its cookie cleared, so the household lands
 * on the code form instead of retrying a dead cookie forever. A session that is
 * merely for ANOTHER WEDDING keeps its cookie — it is a perfectly good session,
 * and clearing it would sign a guest out of their own invite just because they
 * opened someone else's link. Both answer the same generic body, so the
 * endpoint still discloses nothing beyond "not your invite".
 */
export const createClaimSessionRoutes = (
  db: Db,
  { webOrigin, limiter }: ClaimSessionRouteOptions,
) =>
  new Elysia({ prefix: "/api/claim" })
    .use(rateLimitMiddleware(limiter))
    // Cache directives, set BEFORE `sessionAuth` so they land on every outcome —
    // including the 401 that plugin short-circuits with, which never reaches the
    // handler below. The 200 body is selected ENTIRELY by the cookie and carries
    // guest names, per-event dietary free text (Art. 9) and the S-H1-gated
    // closing note: `no-store` keeps it out of every cache — browser,
    // intermediary and CDN — whatever a future Cloudflare page rule says, and
    // `Vary: Cookie` is the backstop for a cache that ignores `no-store`, making
    // the cookie part of the key so one household's invite can never be replayed
    // to another.
    .onBeforeHandle({ as: "scoped" }, ({ set }) => {
      set.headers["cache-control"] = "no-store";
      set.headers.vary = "Origin, Cookie";
    })
    .use(sessionAuth(db))
    .get("/session", async ({ familyId, set, query }) => {
      // sessionAuth's onBeforeHandle guarantees this; the guard is a runtime
      // safety net (and narrows the type).
      if (!familyId) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      // The restore MUST name the wedding it is restoring into. The guest site
      // serves every wedding from one origin (`/<slug>`), while `cire_session`
      // names exactly one family — hence one wedding. Without this, a guest
      // holding wedding A's session who opens wedding B's link would have A's
      // events and members painted silently into B's shell, and an RSVP sent
      // from that state writes to A's events while they believe they answered
      // B's. Required, not optional: an unscoped restore has no correct answer.
      const slug = typeof query.slug === "string" ? query.slug : "";
      if (!slug) {
        set.status = 400;
        return { error: "Missing slug" };
      }

      return runCire(
        Effect.gen(function* () {
          // Same generic failure as every other refusal here, so the endpoint
          // still discloses nothing beyond "not your invite".
          const ownsWedding = yield* inviteService.sessionOwnsWedding(familyId, slug);
          if (!ownsWedding) return yield* Effect.fail(new SessionNotForWedding());
          return yield* claimService.restore(familyId);
        }).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("InvalidCredentials", () =>
            Effect.sync(() => {
              set.status = 401;
              // The session is genuinely dead (family withdrawn or gone), so
              // drop the cookie rather than leave the household retrying it.
              set.headers["set-cookie"] = clearSessionCookie({
                secure: webOrigin.startsWith("https://"),
              });
              return { error: "Invalid credentials" };
            }),
          ),
          Effect.catchTag("SessionNotForWedding", () =>
            Effect.sync(() => {
              set.status = 401;
              // Deliberately NO cookie clear: the session is perfectly valid,
              // just for a different wedding. Clearing it here would sign a
              // guest out of their own invite because they opened someone
              // else's link.
              return { error: "Invalid credentials" };
            }),
          ),
        ),
      );
    });
