import { createRateLimiter } from "@shared/rate-limit";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Db } from "./db";
import { sessionAuth } from "./middleware/auth";
import { osnAuth } from "./middleware/osn-auth";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { claimRoute } from "./routes/claim";
import { organiserRoute } from "./routes/organiser";
import { organiserImportRoute } from "./routes/organiser-import";
import { organiserWeddingsRoute } from "./routes/organiser-weddings";
import { rsvpRoute } from "./routes/rsvp";
import type { R2Bucket } from "./services/r2-imports";

export type AppVariables = {
  db: Db;
  webOrigin: string;
  // Set by `sessionAuth` on protected routes. Untyped (string) so unguarded
  // handlers don't accidentally rely on it being present.
  familyId?: string;
  // Set by `osnAuth` on /api/organiser/* routes.
  osnProfileId?: string;
  // Set by `weddingOwner` on /api/organiser/weddings/:weddingId/* routes.
  weddingId?: string;
  // Optional CF bindings + secrets, present when `createApp` was given them.
  r2?: R2Bucket;
  organiserToken?: string;
};

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
  /**
   * Shared secret for the organiser-import endpoints. Belt-and-braces
   * alongside the OSN JWT this phase; removed in Phase 6.
   */
  organiserToken?: string;
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
    organiserToken,
    osnJwksUrl = "http://localhost:4000/.well-known/jwks.json",
    osnAudience = "osn-access",
    osnTestKey,
  } = options;
  const corsOrigins = new Set(allowedOrigins ?? [webOrigin]);
  const app = new Hono<{ Variables: AppVariables }>();

  // Inject db + webOrigin (and R2 + organiser token when present) into every
  // request.
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("webOrigin", webOrigin);
    if (r2) c.set("r2", r2);
    if (organiserToken) c.set("organiserToken", organiserToken);
    return next();
  });

  app.use(
    "/api/*",
    cors({
      // Echo the request origin verbatim when it's in the allowlist — never `*` —
      // so the browser will include credentials. Any mismatch returns `null`
      // which Hono translates to no `Access-Control-Allow-Origin` header.
      origin: (origin) => (corsOrigins.has(origin) ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      // X-Organiser-Token stays until Phase 6 strips the shared-secret path.
      allowHeaders: ["Content-Type", "Authorization", "X-Organiser-Token"],
      credentials: true,
    }),
  );

  // Rate limit the claim endpoint (brute-force protection — S-C2)
  app.use("/api/claim", rateLimitMiddleware(claimLimiter));

  // Gate /api/rsvp behind a valid session cookie. Mounted before `app.route`
  // so the middleware fires on every method under that prefix.
  app.use("/api/rsvp", sessionAuth());
  app.use("/api/rsvp/*", sessionAuth());

  // Gate ALL organiser routes (reads, weddings, import group) behind a valid
  // OSN access token. The import group's X-Organiser-Token check remains as
  // belt-and-braces until Phase 6 deletes it.
  const organiserAuth = osnAuth({
    jwksUrl: osnJwksUrl,
    audience: osnAudience,
    _testKey: osnTestKey,
  });
  app.use("/api/organiser", organiserAuth);
  app.use("/api/organiser/*", organiserAuth);

  app.route("/api/claim", claimRoute);
  app.route("/api/organiser", organiserRoute);
  app.route("/api/organiser", organiserWeddingsRoute);
  app.route("/api/organiser/import", organiserImportRoute);
  app.route("/api/rsvp", rsvpRoute);
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}
