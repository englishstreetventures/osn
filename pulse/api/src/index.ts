import type { D1Database } from "@cloudflare/workers-types";
import { makeDbD1Live } from "@pulse/db/service";

import { createApp, type App } from "./app";

// Re-export the Eden treaty type so `@pulse/api` consumers and `./client` keep
// importing `App` from the package entry point.
export type { App };
export { createApp } from "./app";

/**
 * Worker bindings + vars. Mirrors `wrangler.toml` ([[d1_databases]], [vars]);
 * regenerate with `bunx wrangler types` when bindings change. `DB` is optional
 * so a misconfigured deployment fails at the edge with a 503, not a type lie.
 *
 * NOTE: the leave-app sweepers (`runHardDeleteSweep` /
 * `runEventCancellationSweep`) run on the long-lived `local` host (`local.ts`).
 * On Workers they belong on a Cron Trigger — tracked in wiki/TODO.md.
 */
export interface Env {
  DB?: D1Database;
  /** JWKS endpoint of the OSN issuer that signs access tokens. */
  OSN_JWKS_URL?: string;
}

// Build the Elysia graph once per isolate — `env` bindings are stable within an
// isolate, and `aot: false` means none of the graph is amortised by
// compilation. Rebuild defensively if the D1 binding identity ever changes.
let cached: { app: App; dbBinding: D1Database } | undefined;

const misconfigured = (detail: string): Response =>
  new Response(JSON.stringify({ error: `Worker misconfigured: ${detail}` }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Fail closed at the edge if the D1 binding is missing rather than falling
    // back to the bun:sqlite `local` layer in a misconfigured deployment.
    if (!env.DB) return misconfigured("missing DB");

    if (!cached || cached.dbBinding !== env.DB) {
      cached = {
        dbBinding: env.DB,
        app: createApp({ dbLayer: makeDbD1Live(env.DB), jwksUrl: env.OSN_JWKS_URL }),
      };
    }

    return cached.app.fetch(request);
  },
};
