import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Db } from "./db";
import { sessionAuth } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { claimRoute } from "./routes/claim";
import { organiserRoute } from "./routes/organiser";
import { organiserImportRoute } from "./routes/organiser-import";
import { rsvpRoute } from "./routes/rsvp";
import type { R2Bucket } from "./services/r2-imports";
import { createRateLimiter } from "./services/rate-limit";
import type { RateLimiter } from "./services/rate-limit";

export type AppVariables = {
  db: Db;
  webOrigin: string;
  // Set by `sessionAuth` on protected routes. Untyped (string) so unguarded
  // handlers don't accidentally rely on it being present.
  familyId?: string;
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
  claimLimiter?: RateLimiter;
  /** R2 bucket binding for the organiser import flow. */
  r2?: R2Bucket;
  /** Shared secret for the organiser-import endpoints. */
  organiserToken?: string;
}

export function createApp(db: Db, options: AppOptions = {}) {
  const {
    webOrigin = "http://localhost:4321",
    allowedOrigins,
    claimLimiter = defaultClaimLimiter,
    r2,
    organiserToken,
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
      allowHeaders: ["Content-Type", "X-Organiser-Token"],
      credentials: true,
    }),
  );

  // Rate limit the claim endpoint (brute-force protection — S-C2)
  app.use("/api/claim", rateLimitMiddleware(claimLimiter));

  // Gate /api/rsvp behind a valid session cookie. Mounted before `app.route`
  // so the middleware fires on every method under that prefix.
  app.use("/api/rsvp", sessionAuth());
  app.use("/api/rsvp/*", sessionAuth());

  app.route("/api/claim", claimRoute);
  app.route("/api/organiser", organiserRoute);
  app.route("/api/organiser/import", organiserImportRoute);
  app.route("/api/rsvp", rsvpRoute);
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}
