import { createApp } from "./app";
import { createD1Db } from "./db";

// Worker bindings + vars. Mirrors `wrangler.toml` ([[d1_databases]], [[r2_buckets]],
// [vars]); regenerate the full set with `bunx wrangler types` when bindings change.
// Hand-typed (rather than committing the generated worker-configuration.d.ts blob)
// to match the package's minimal-interface style — see `R2Bucket` in
// `services/r2-imports.ts`. Bindings are optional because a misconfigured
// deployment must fail at the edge with a 503, not a type lie.
export interface Env {
  DB?: D1Database;
  SHEETS?: R2Bucket;
  WEB_ORIGIN: string;
  OSN_JWKS_URL: string;
  OSN_AUDIENCE: string;
}

const handler: ExportedHandler<Env> = {
  // Workers have no long-lived process: the D1 binding only exists on `env`
  // inside `fetch`, so the Drizzle client and the Hono app are built per
  // request. Construction is cheap (no connection pool — D1 is a binding).
  async fetch(request, env, ctx) {
    // Fail closed at the edge if any required binding/var is missing, rather
    // than letting createApp fall back to its localhost dev defaults for the
    // OSN issuer/audience in a misconfigured production deployment (S-M1).
    const missing = [
      !env.DB && "DB",
      !env.WEB_ORIGIN && "WEB_ORIGIN",
      !env.OSN_JWKS_URL && "OSN_JWKS_URL",
      !env.OSN_AUDIENCE && "OSN_AUDIENCE",
    ].filter(Boolean);
    if (missing.length > 0 || !env.DB) {
      return new Response(
        JSON.stringify({ error: `Worker misconfigured: missing ${missing.join(", ")}` }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    const db = createD1Db(env.DB);
    const origins = env.WEB_ORIGIN.split(",")
      .map((o) => o.trim())
      .filter(Boolean);

    const app = createApp(db, {
      webOrigin: origins[0],
      allowedOrigins: origins,
      r2: env.SHEETS,
      osnJwksUrl: env.OSN_JWKS_URL,
      osnAudience: env.OSN_AUDIENCE,
    });

    return app.fetch(request, env, ctx);
  },
};

export default handler;
