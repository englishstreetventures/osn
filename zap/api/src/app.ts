import { cors } from "@elysiajs/cors";
import { healthRoutes, observabilityPlugin } from "@shared/observability";
import { DbLive, type Db } from "@zap/db/service";
import type { Layer } from "effect";
import { Elysia } from "elysia";

import { createChatsRoutes } from "./routes/chats";

export const SERVICE_NAME = "zap-api";

export interface AppOptions {
  /**
   * DB service layer. Defaults to the bun:sqlite `local` layer (dev + tests);
   * the Workers entry (`index.ts`) passes `makeDbD1Live(env.DB)` for the
   * `dev` / `staging` / `prod` environments.
   */
  dbLayer?: Layer.Layer<Db>;
  /**
   * Secret used to verify OSN access tokens. Workers supply it from a binding;
   * the local dev server falls back to `OSN_JWT_SECRET` inside the route.
   */
  jwtSecret?: string;
}

/**
 * Compose the Zap Elysia app. Factored out of the entry points so the same
 * graph runs on Bun.serve (`local.ts`, bun:sqlite) and on Cloudflare Workers
 * (`index.ts`, D1) with only the injected DB layer differing.
 */
export function createApp(options: AppOptions = {}) {
  const { dbLayer = DbLive, jwtSecret } = options;

  return (
    // `aot: false` — Elysia's ahead-of-time compilation builds handlers via
    // `new Function`, which Cloudflare Workers forbid (no dynamic code eval).
    new Elysia({ aot: false })
      .use(cors())
      .use(observabilityPlugin({ serviceName: SERVICE_NAME }))
      .use(healthRoutes({ serviceName: SERVICE_NAME }))
      .get("/", () => ({ status: "ok", service: SERVICE_NAME }))
      .use(createChatsRoutes(dbLayer, jwtSecret))
  );
}

export type App = ReturnType<typeof createApp>;
