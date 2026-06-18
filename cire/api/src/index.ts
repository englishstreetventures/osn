import { BOOTSTRAP_WEDDING_ID, weddings } from "@cire/db";
import { createWorkersRateLimiter } from "@shared/rate-limit";
import type { WorkersRateLimitBinding } from "@shared/rate-limit";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { createApp } from "./app";
import { createD1Db, DbService, type Db } from "./db";
import {
  BOOTSTRAP_OWNER_SENTINEL,
  isDeployedEnv,
  resolveBootstrapOwnerProfileId,
} from "./db/bootstrap-owner";
import { setExecutionCtx } from "./lib/execution-ctx";
import { runCire } from "./observability";
import { createAccountResolverFromEnv, createHandleResolverFromEnv } from "./services/osn-bridge";
import { retentionService } from "./services/retention";
import { sessionService } from "./services/session";

// Worker bindings + vars. Mirrors `wrangler.toml` ([[d1_databases]], [[r2_buckets]],
// [vars]); regenerate the full set with `bunx wrangler types` when bindings change.
// Hand-typed (rather than committing the generated worker-configuration.d.ts blob)
// to match the package's minimal-interface style — see `R2Bucket` in
// `services/r2-imports.ts`. Bindings are optional because a misconfigured
// deployment must fail at the edge with a 503, not a type lie.
export interface Env {
  DB?: D1Database;
  SHEETS?: R2Bucket;
  // R2 bucket for invite-builder images. Separate from SHEETS (different
  // lifecycle: binary, served publicly). Absent ⇒ image upload/serve fail at
  // use, text customisation still works.
  ASSETS?: R2Bucket;
  // Cloudflare Workers Images binding — transforms the R2 originals into
  // responsive, modern-format variants on the public serve path. Absent (local
  // `wrangler dev` / miniflare / unit tests, or an account without the Images
  // product) ⇒ the serve route falls back to the raw R2 bytes, never 500s.
  IMAGES?: ImagesBinding;
  WEB_ORIGIN: string;
  OSN_JWKS_URL: string;
  OSN_AUDIENCE: string;
  // Optional — present only where guest account-linking is enabled. Base URL of
  // osn-api plus cire-api's ARC signing key (a wrangler secret, ES256 JWK) and
  // its `kid` (matching the public key registered in osn-api's service_accounts
  // under serviceId `cire-api`). All three absent ⇒ linking POST answers 503.
  OSN_API_URL?: string;
  CIRE_API_ARC_PRIVATE_KEY?: string;
  CIRE_API_ARC_KEY_ID?: string;
  // Native Workers Rate Limiting binding (C1/C4). When present, the claim
  // limiter is the global, atomic edge limiter; absent (local `wrangler dev`
  // without the binding, or non-Workers runtimes) ⇒ the in-memory fallback.
  CLAIM_RATE_LIMITER?: WorkersRateLimitBinding;
}

// P-W1: the Elysia app graph (root + cors + route factories + auth plugins) is
// much heavier to compose than the old Hono app, and `aot: false` means none of
// it is amortised by compilation — so build once per isolate instead of per
// request. `env` bindings are stable within an isolate; the guard on the D1
// binding identity rebuilds defensively if that ever changes. The ARC account
// resolver (which imports the signing key) is built alongside it, once.
let cached: { app: ReturnType<typeof createApp>; dbBinding: D1Database } | undefined;

/**
 * Repoint the bootstrap wedding from migration 0006's inert sentinel owner to
 * the real organiser profile id (BOOTSTRAP_OWNER_PROFILE_ID). Migrations bake
 * only the sentinel; this is the prod path that gives the bootstrap wedding a
 * real owner — `seedDb` (which carries the local/dev default) never runs
 * against D1. Runs once per isolate alongside app construction.
 *
 * Idempotent + safe to re-run: the UPDATE is guarded to the sentinel, so once
 * the row carries a real owner this is a no-op. `resolveBootstrapOwnerProfileId`
 * THROWS in a deployed env when the var is missing/placeholder — that throw
 * propagates to `fetch` and is turned into a 503, so a misconfigured deploy
 * fails loud rather than serving a wedding owned by a nonexistent profile.
 */
export async function ensureBootstrapOwner(
  db: Db,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  // Only deployed tiers (dev/staging/prod) get a D1 repoint. Locally the seed —
  // not this fixup — owns the row, so never write the dev default to D1. In a
  // deployed env `resolveBootstrapOwnerProfileId` returns a real usr_* id or
  // THROWS (⇒ 503), so a misconfigured deploy fails loud.
  if (!isDeployedEnv(env)) return;
  const owner = resolveBootstrapOwnerProfileId(env);

  await Promise.resolve(
    db
      .update(weddings)
      .set({ ownerOsnProfileId: owner })
      .where(
        and(
          eq(weddings.id, BOOTSTRAP_WEDDING_ID),
          eq(weddings.ownerOsnProfileId, BOOTSTRAP_OWNER_SENTINEL),
        ),
      )
      .run(),
  );
  await runCire(
    Effect.logInfo("bootstrap wedding owner ensured", { weddingId: BOOTSTRAP_WEDDING_ID }),
  );
}

const misconfigured = (detail: string) =>
  new Response(JSON.stringify({ error: `Worker misconfigured: ${detail}` }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });

const handler: ExportedHandler<Env> = {
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
      // Repoint the bootstrap wedding off migration 0006's inert sentinel onto
      // the real organiser id. Throws (⇒ 503) in a deployed env when
      // BOOTSTRAP_OWNER_PROFILE_ID is missing/placeholder — fail loud rather
      // than serve a wedding owned by a nonexistent profile.
      try {
        await ensureBootstrapOwner(db);
      } catch (error) {
        return misconfigured(error instanceof Error ? error.message : "bootstrap owner unset");
      }
      // Built once per isolate with the app. Returns null (⇒ linking disabled,
      // POST answers 503) when the ARC config is absent.
      const resolveOsnAccountId =
        (await createAccountResolverFromEnv({
          osnApiUrl: env.OSN_API_URL,
          arcPrivateKeyJwk: env.CIRE_API_ARC_PRIVATE_KEY,
          arcKeyId: env.CIRE_API_ARC_KEY_ID,
        })) ?? undefined;
      // Sibling ARC resolver for add-co-host-by-handle, same key + graph:read
      // scope. Null (⇒ add-host POST answers 503) when the ARC config is absent.
      const resolveOsnProfileByHandle =
        (await createHandleResolverFromEnv({
          osnApiUrl: env.OSN_API_URL,
          arcPrivateKeyJwk: env.CIRE_API_ARC_PRIVATE_KEY,
          arcKeyId: env.CIRE_API_ARC_KEY_ID,
        })) ?? undefined;
      // C1/C4/AL-S-L1: prefer the native Workers rate-limit binding (global +
      // atomic) for every pre-auth / amplifier surface — claim (brute-force),
      // account-link (ARC-sign + S2S amplifier, membership oracle), invite
      // (R2 write amplifier). One binding ⇒ one shared global budget, which is
      // an acceptable (stricter) cap; absent the binding, each falls back to
      // createApp's per-surface in-memory default.
      const edgeLimiter = env.CLAIM_RATE_LIMITER
        ? createWorkersRateLimiter(env.CLAIM_RATE_LIMITER)
        : undefined;
      cached = {
        dbBinding: env.DB,
        app: createApp(db, {
          webOrigin: origins[0],
          allowedOrigins: origins,
          claimLimiter: edgeLimiter,
          accountLinkLimiter: edgeLimiter,
          inviteLimiter: edgeLimiter,
          r2: env.SHEETS,
          assets: env.ASSETS,
          images: env.IMAGES,
          osnJwksUrl: env.OSN_JWKS_URL,
          osnAudience: env.OSN_AUDIENCE,
          resolveOsnAccountId,
          resolveOsnProfileByHandle,
        }),
      };
    }

    // Bridge the Workers execution context to the in-flight request so route
    // handlers can reach `ctx.waitUntil` (Elysia's `fetch` doesn't forward it).
    // The public image serve route uses it to populate the Cache API in the
    // background after a transform. Keyed by this exact Request instance, which
    // Elysia passes straight through to the handler.
    setExecutionCtx(request, ctx);
    return cached.app.fetch(request);
  },

  // Cron-triggered daily maintenance (C-M2/C-M15 + retention). Configured by the
  // single `[triggers] crons` entry in wrangler.toml — daily 04:00 UTC. Two
  // independent sweeps share the cron:
  //
  //  1. Expired-session sweep — guest logins leave session rows that are never
  //     deleted on the read path, so the table grows unbounded without this. The
  //     sweep deletes rows whose 30-day window has lapsed; `expiresAt` already
  //     encodes when a row becomes dead.
  //  2. Guest-data retention sweep — enforces the published privacy promise
  //     (cire/web privacy.astro): guest PII (guests/families/rsvps incl. dietary
  //     + consent, plus imports bookkeeping) is deleted 1 year after a wedding's
  //     final event.
  //
  // Each is its own `waitUntil` + `catchAll`, so a failure in one never aborts
  // the other and the isolate stays alive until each delete settles.
  async scheduled(_event, env, ctx) {
    if (!env.DB) return;
    const db = createD1Db(env.DB);
    const dbLayer = Layer.succeed(DbService, db);

    ctx.waitUntil(
      Effect.runPromise(
        sessionService.sweepExpired().pipe(
          Effect.catchAll((err) =>
            Effect.logError("scheduled session sweep failed", { reason: err.reason }),
          ),
          Effect.provide(dbLayer),
        ),
      ),
    );

    ctx.waitUntil(
      Effect.runPromise(
        retentionService.sweepExpiredGuestData().pipe(
          Effect.catchAll((err) =>
            Effect.logError("scheduled guest-data retention sweep failed", { reason: err.reason }),
          ),
          Effect.provide(dbLayer),
        ),
      ),
    );
  },
};

export default handler;
