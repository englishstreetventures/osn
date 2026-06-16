import type { D1Database } from "@cloudflare/workers-types";
import { makeDbD1Live } from "@zap/db/service";

import { createApp, type App } from "./app";

// Re-export the Eden treaty type so `@zap/api` consumers and `./client` keep
// importing `App` from the package entry point.
export type { App };
export { createApp } from "./app";

/**
 * Worker bindings + vars. Mirrors `wrangler.toml` ([[d1_databases]], [vars]);
 * regenerate the full set with `bunx wrangler types` when bindings change.
 * `DB` is optional so a misconfigured deployment fails at the edge with a 503
 * rather than a type lie.
 */
export interface Env {
  DB?: D1Database;
  /** Secret for verifying OSN access tokens (a wrangler secret in deployed envs). */
  OSN_JWT_SECRET?: string;
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
    // Fail closed at the edge if a required binding/secret is missing rather
    // than falling back to the bun:sqlite `local` layer or — worse — the
    // hardcoded dev JWT secret (S-H1). A deployed Zap Worker MUST verify Bearer
    // tokens with the real OSN secret; an unset secret would otherwise degrade
    // to a publicly-known key and let anyone forge a `sub` to read/write any
    // user's chats.
    if (!env.DB) return misconfigured("missing DB");
    if (!env.OSN_JWT_SECRET) return misconfigured("missing OSN_JWT_SECRET");

    if (!cached || cached.dbBinding !== env.DB) {
      cached = {
        dbBinding: env.DB,
        app: createApp({ dbLayer: makeDbD1Live(env.DB), jwtSecret: env.OSN_JWT_SECRET }),
      };
    }

    return cached.app.fetch(request);
  },
};
