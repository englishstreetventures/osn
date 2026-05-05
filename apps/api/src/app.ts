import { Hono } from "hono";
import { cors } from "hono/cors";
import { claimRoute } from "./routes/claim";
import { organiserRoute } from "./routes/organiser";
import { rsvpRoute } from "./routes/rsvp";
import { createRateLimiter } from "./services/rate-limit";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { sessionAuth } from "./middleware/auth";
import type { RateLimiter } from "./services/rate-limit";
import type { Db } from "./db";

export type AppVariables = {
  db: Db;
  webOrigin: string;
  // Set by `sessionAuth` on protected routes. Untyped (string) so unguarded
  // handlers don't accidentally rely on it being present.
  familyId?: string;
};

/** Default per-IP rate limiter for the claim endpoint: 5 attempts per minute. */
const defaultClaimLimiter = createRateLimiter({ maxRequests: 5, windowMs: 60_000 });

interface AppOptions {
  webOrigin?: string;
  /** Override the claim rate limiter (useful for testing). */
  claimLimiter?: RateLimiter;
}

export function createApp(db: Db, options: AppOptions = {}) {
  const { webOrigin = "http://localhost:4321", claimLimiter = defaultClaimLimiter } = options;
  const app = new Hono<{ Variables: AppVariables }>();

  // Inject db + webOrigin into every request
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("webOrigin", webOrigin);
    return next();
  });

  app.use(
    "/api/*",
    cors({
      // Echo the configured origin verbatim — never `*` — so the browser will
      // include credentials. Any mismatch falls back to `null` which Hono
      // translates to no `Access-Control-Allow-Origin` header.
      origin: (origin) => (origin === webOrigin ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
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
  app.route("/api/rsvp", rsvpRoute);
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}
