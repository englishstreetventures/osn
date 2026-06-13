import { cors } from "@elysiajs/cors";
import { createRateLimiter } from "@shared/rate-limit";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect } from "effect";
import { Elysia } from "elysia";

import type { Db } from "./db";
import { createClaimRoutes } from "./routes/claim";
import { createOrganiserImportRoutes } from "./routes/organiser-import";
import { createOrganiserWeddingsRoutes } from "./routes/organiser-weddings";
import { createRsvpRoutes } from "./routes/rsvp";
import type { R2Bucket } from "./services/r2-imports";

/** Default per-IP rate limiter for the claim endpoint: 5 attempts per minute. */
const defaultClaimLimiter = createRateLimiter({ maxRequests: 5, windowMs: 60_000 });

export interface AppOptions {
  /** Primary origin (used for the session cookie's `secure` flag). */
  webOrigin?: string;
  /** Extra origins allowed by CORS (organiser portal, etc). Defaults to `[webOrigin]`. */
  allowedOrigins?: string[];
  /** Override the claim rate limiter (useful for testing). */
  claimLimiter?: RateLimiterBackend;
  /** R2 bucket binding for the organiser import flow. */
  r2?: R2Bucket;
  /** JWKS endpoint of the OSN issuer that signs organiser access tokens. */
  osnJwksUrl?: string;
  /** Expected `aud` claim on organiser access tokens. */
  osnAudience?: string;
  /** Test-only: inject the verifying key and skip the JWKS fetch. */
  osnTestKey?: CryptoKey;
}

export function createApp(db: Db, options: AppOptions = {}) {
  const {
    webOrigin = "http://localhost:4321",
    allowedOrigins,
    claimLimiter = defaultClaimLimiter,
    r2,
    osnJwksUrl = "http://localhost:4000/.well-known/jwks.json",
    osnAudience = "osn-access",
    osnTestKey,
  } = options;
  const corsOrigins = allowedOrigins ?? [webOrigin];

  const osnAuthOptions = {
    jwksUrl: osnJwksUrl,
    audience: osnAudience,
    _testKey: osnTestKey,
  };

  return (
    // `aot: false` — Elysia's ahead-of-time compilation builds handlers via
    // `new Function`, which Cloudflare Workers forbids (no dynamic code
    // evaluation). The dynamic handler is plenty for this API's traffic.
    new Elysia({ aot: false })
      .use(
        cors({
          // Echo the request origin verbatim when it's in the allowlist — never
          // `*` — so the browser will include credentials. Any mismatch gets no
          // `Access-Control-Allow-Origin` header.
          origin: corsOrigins,
          methods: ["GET", "POST", "OPTIONS"],
          allowedHeaders: ["Content-Type", "Authorization"],
          credentials: true,
        }),
      )
      .onError(({ code, error, set }) => {
        if (code === "NOT_FOUND") {
          set.status = 404;
          return { error: "Not found" };
        }
        // S-M1: Elysia's default error renderer puts `error.message` in the
        // response body, which leaks internals (D1 error strings, Effect
        // causes, table names) to callers — the claim endpoint is pre-auth.
        // Log the detail, return a generic body.
        Effect.runSync(
          Effect.logError("unhandled request error", {
            code,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        set.status = 500;
        return { error: "Internal error" };
      })
      .use(createClaimRoutes(db, { webOrigin, limiter: claimLimiter }))
      .use(createRsvpRoutes(db))
      .use(createOrganiserWeddingsRoutes(db, osnAuthOptions))
      .use(createOrganiserImportRoutes(db, r2, osnAuthOptions))
  );
}
