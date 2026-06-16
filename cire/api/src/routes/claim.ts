import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { buildSessionCookie } from "../lib/cookie";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { runCire } from "../observability";
import { ClaimBody } from "../schemas/claim";
import { claimService } from "../services/claim";
import { sessionService } from "../services/session";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ClaimRouteOptions {
  /** Primary origin (used for the session cookie's `secure` flag). */
  webOrigin: string;
  /** Per-IP rate limiter (brute-force protection — S-C2). */
  limiter: RateLimiterBackend;
}

export const createClaimRoutes = (db: Db, { webOrigin, limiter }: ClaimRouteOptions) =>
  new Elysia({ prefix: "/api/claim" }).use(rateLimitMiddleware(limiter)).post(
    "/",
    async ({ request, set }) => {
      const raw: unknown = await request.json().catch(() => null);

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
