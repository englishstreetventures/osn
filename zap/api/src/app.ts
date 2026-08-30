import { cors } from "@elysiajs/cors";
import { healthRoutes, observabilityPlugin } from "@shared/observability";
import { DbLive, type Db } from "@zap/db/service";
import type { Layer } from "effect";
import { Elysia } from "elysia";

import { DEFAULT_VERIFICATION, type OsnTokenVerification } from "./lib/jwks";
import {
  createChatsRoutes,
  createDefaultZapRateLimiters,
  type ZapRateLimiters,
} from "./routes/chats";
import { createInternalRoutes } from "./routes/internal";

export const SERVICE_NAME = "zap-api";

export interface AppOptions {
  /**
   * DB service layer. Defaults to the bun:sqlite `local` layer (dev + tests);
   * the Workers entry (`index.ts`) passes `makeDbD1Live(env.DB)` for the
   * `dev` / `staging` / `prod` environments.
   */
  dbLayer?: Layer.Layer<Db>;
  /**
   * Where the OSN issuer's access-token signing keys live, and the `iss` its
   * tokens must carry (W1/W2 — ES256 verification via
   * `@shared/osn-auth-client`). Workers supply both from the `OSN_JWKS_URL`
   * and `OSN_ISSUER_URL` bindings; the local dev server falls back to
   * `DEFAULT_VERIFICATION`.
   */
  verification?: OsnTokenVerification;
  /**
   * Per-IP write limiters (Cloudflare-keyed, S-H1). Defaults to in-memory
   * counters; a deployment that needs a globally-shared throttle wires a
   * durable backend at the composition root.
   */
  rateLimiters?: ZapRateLimiters;
  /**
   * CORS allowlist (S-M2). Replaces the open reflect-any default. The
   * composition root resolves + fail-closed-validates this. Omitted → the
   * permissive `cors()` default (tests only).
   */
  corsOrigins?: string[];
}

/**
 * Compose the Zap Elysia app. Factored out of the entry points so the same
 * graph runs on Bun.serve (`local.ts`, bun:sqlite) and on Cloudflare Workers
 * (`index.ts`, D1) with only the injected DB layer + config differing.
 */
export function createApp(options: AppOptions = {}) {
  const {
    dbLayer = DbLive,
    verification = DEFAULT_VERIFICATION,
    rateLimiters = createDefaultZapRateLimiters(),
    corsOrigins,
  } = options;

  return (
    // `aot: false` — Elysia's ahead-of-time compilation builds handlers via
    // `new Function`, which Cloudflare Workers forbid (no dynamic code eval).
    new Elysia({ aot: false })
      .use(corsOrigins ? cors({ origin: corsOrigins, credentials: true }) : cors())
      .use(observabilityPlugin({ serviceName: SERVICE_NAME }))
      .use(healthRoutes({ serviceName: SERVICE_NAME }))
      .get("/", () => ({ status: "ok", service: SERVICE_NAME }))
      .use(createChatsRoutes(dbLayer, verification, undefined, rateLimiters))
      .use(createInternalRoutes(dbLayer))
  );
}

export type App = ReturnType<typeof createApp>;
