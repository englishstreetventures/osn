import { createRateLimiter } from "@shared/rate-limit";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Db } from "./db";
import { originGuard } from "./lib/origin-guard";
import { createWorkersRateLimiter } from "./lib/workers-rate-limiter";
import type { WorkersRateLimitBinding } from "./lib/workers-rate-limiter";
import { sessionAuth } from "./middleware/auth";
import { osnAuth } from "./middleware/osn-auth";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { claimRoute } from "./routes/claim";
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
  // Set by `weddingOwner` on /api/organiser/weddings/:weddingId/* routes and
  // by `ownedWedding` on the import group.
  weddingId?: string;
  // Optional CF bindings, present when `createApp` was given them.
  r2?: R2Bucket;
};

/** Default per-IP rate limiter for the claim endpoint: 5 attempts per minute. */
const defaultClaimLimiter = createRateLimiter({ maxRequests: 5, windowMs: 60_000 });

export interface AppOptions {
  /** Primary origin (used for the session cookie's `secure` flag). */
  webOrigin?: string;
  /** Extra origins allowed by CORS (organiser portal, etc). Defaults to `[webOrigin]`. */
  allowedOrigins?: string[];
  /**
   * Explicit claim rate limiter. Takes precedence over `claimRateLimitBinding`
   * — used by tests to inject an in-memory limiter with a known budget.
   */
  claimLimiter?: RateLimiterBackend;
  /**
   * Native Cloudflare Workers Rate Limiting binding (C1/C4). When present (and
   * `claimLimiter` is not), the claim endpoint is throttled globally + atomically
   * at the edge instead of by the per-isolate in-memory limiter. Absent ⇒ the
   * in-memory default is used (local dev / tests). The window/limit live in
   * `wrangler.toml` (`simple = { limit = 5, period = 60 }`), matching the 5/min
   * in-memory default.
   */
  claimRateLimitBinding?: WorkersRateLimitBinding;
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
    claimLimiter,
    claimRateLimitBinding,
    r2,
    osnJwksUrl = "http://localhost:4000/.well-known/jwks.json",
    osnAudience = "osn-access",
    osnTestKey,
  } = options;
  // Backend selection (C1/C4): an explicit limiter wins (tests); otherwise the
  // native Workers binding when present (prod); otherwise the in-memory default
  // (local dev). One throttle, one source of truth for its window in wrangler.toml.
  const resolvedClaimLimiter: RateLimiterBackend =
    claimLimiter ??
    (claimRateLimitBinding ? createWorkersRateLimiter(claimRateLimitBinding) : defaultClaimLimiter);
  const corsOrigins = new Set(allowedOrigins ?? [webOrigin]);
  const app = new Hono<{ Variables: AppVariables }>();

  // Inject db + webOrigin (and R2 when present) into every request.
  app.use("*", (c, next) => {
    c.set("db", db);
    c.set("webOrigin", webOrigin);
    if (r2) c.set("r2", r2);
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
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  );

  // CSRF defence (S-L3): validate the Origin header on every state-changing
  // request, uniformly, sourced from the same allowlist CORS uses. cire has no
  // inbound ARC/S2S routes, so there is no exemption. Runs after CORS (so the
  // preflight still resolves) and before any auth/route handler. A missing or
  // mismatched Origin on POST/PUT/PATCH/DELETE returns 403 when an allowlist is
  // configured; in dev (no allowlist) it's a pass-through.
  app.use("/api/*", originGuard({ allowedOrigins: corsOrigins }));

  // Rate limit the claim endpoint (brute-force protection — S-C2)
  app.use("/api/claim", rateLimitMiddleware(resolvedClaimLimiter));

  // Gate /api/rsvp behind a valid session cookie. Mounted before `app.route`
  // so the middleware fires on every method under that prefix.
  app.use("/api/rsvp", sessionAuth());
  app.use("/api/rsvp/*", sessionAuth());

  // Gate ALL organiser routes (weddings + import group) behind a valid OSN
  // access token.
  const organiserAuth = osnAuth({
    jwksUrl: osnJwksUrl,
    audience: osnAudience,
    _testKey: osnTestKey,
  });
  app.use("/api/organiser", organiserAuth);
  app.use("/api/organiser/*", organiserAuth);

  app.route("/api/claim", claimRoute);
  app.route("/api/organiser", organiserWeddingsRoute);
  app.route("/api/organiser/import", organiserImportRoute);
  app.route("/api/rsvp", rsvpRoute);
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}
