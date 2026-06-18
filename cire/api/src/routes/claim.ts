import type { RateLimiterBackend } from "@shared/rate-limit";
import type { TurnstileVerifier } from "@shared/turnstile";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { buildSessionCookie } from "../lib/cookie";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { turnstileGate } from "../middleware/turnstile";
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
