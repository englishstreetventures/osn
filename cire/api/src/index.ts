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

// P-W1: the Elysia app graph (root + cors + four route factories + auth
// plugins) is much heavier to compose than the old Hono app, and `aot: false`
// means none of it is amortised by compilation — so build once per isolate
// instead of per request. `env` bindings are stable within an isolate; the
// guard on the D1 binding identity rebuilds defensively if that ever changes.
let cached: { app: ReturnType<typeof createApp>; dbBinding: D1Database } | undefined;

const misconfigured = (detail: string) =>
  new Response(JSON.stringify({ error: `Worker misconfigured: ${detail}` }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });

const handler: ExportedHandler<Env> = {
  async fetch(request, env) {
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
      return misconfigured(`missing ${missing.join(", ")}`);
    }

    const origins = env.WEB_ORIGIN.split(",")
      .map((o) => o.trim())
      .filter(Boolean);

    // S-L1: a schemeless WEB_ORIGIN entry would be scheme-stripped by the
    // CORS matcher (allowlisting BOTH http:// and https:// for credentialed
    // requests) and would silently disable the session cookie's Secure flag.
    // Fail closed instead of serving with a widened allowlist.
    const badOrigin = origins.find(
      (o) => !(o.startsWith("https://") || o.startsWith("http://localhost")),
    );
    if (badOrigin) {
      return misconfigured(
        `WEB_ORIGIN entry "${badOrigin}" must be https:// (or http://localhost in dev)`,
      );
    }

    if (!cached || cached.dbBinding !== env.DB) {
      const db = createD1Db(env.DB);
      cached = {
        dbBinding: env.DB,
        app: createApp(db, {
          webOrigin: origins[0],
          allowedOrigins: origins,
          r2: env.SHEETS,
          osnJwksUrl: env.OSN_JWKS_URL,
          osnAudience: env.OSN_AUDIENCE,
        }),
      };
    }

    return cached.app.fetch(request);
  },
};

export default handler;
