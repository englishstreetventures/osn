import { Hono } from "hono";
import { cors } from "hono/cors";
import { claimRoute } from "./routes/claim";
import { organiserRoute } from "./routes/organiser";
import { createRateLimiter } from "./services/rate-limit";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import type { RateLimiter } from "./services/rate-limit";
import type { Db } from "./db";

type AppVariables = { db: Db };

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

  // Inject db into every request
  app.use("*", (c, next) => {
    c.set("db", db);
    return next();
  });

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (origin === webOrigin ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  // Rate limit the claim endpoint (brute-force protection — S-C2)
  app.use("/api/claim", rateLimitMiddleware(claimLimiter));

  app.route("/api/claim", claimRoute);
  app.route("/api/organiser", organiserRoute);
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}
