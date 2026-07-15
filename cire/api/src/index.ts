import { loadConfig } from "@shared/observability/config";
import { createWorkersRateLimiter } from "@shared/rate-limit";
import type { WorkersRateLimitBinding } from "@shared/rate-limit";
import { createTurnstileVerifier } from "@shared/turnstile";
import { Effect, Layer } from "effect";

import { createApp } from "./app";
import { createD1Db, DbService } from "./db";
import { setExecutionCtx } from "./lib/execution-ctx";
import { runCire } from "./observability";
import { assetReconcileService } from "./services/asset-reconcile";
import { createGoogleGeocoder } from "./services/geocode";
import {
  createAccountResolverFromEnv,
  createHandleResolverFromEnv,
  createHandleSearchResolverFromEnv,
  createProfileDisplayResolverFromEnv,
} from "./services/osn-bridge";
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
  // limiter is the global, atomic edge limiter. Absent ⇒ the per-isolate
  // in-memory fallback — allowed ONLY in the `local` tier (`bun run dev` /
  // bun:sqlite tests). In any deployed tier (dev/staging/production) a missing
  // binding is a fail-closed 503 at the edge (see the guard in `fetch`), because
  // a per-isolate limiter is no real cross-request brute-force defence and the
  // downgrade would otherwise be silent. Optional here so the missing-binding
  // case surfaces as that explicit 503, not a type lie.
  CLAIM_RATE_LIMITER?: WorkersRateLimitBinding;
  // Turnstile bot-protection secret (KEY-OPTIONAL). When set, the guest claim +
  // RSVP endpoints require a valid Turnstile token (fail-closed); unset ⇒ those
  // gates are skipped. `wrangler secret put TURNSTILE_SECRET_KEY`.
  TURNSTILE_SECRET_KEY?: string;
  // Google Geocoding API key (KEY-OPTIONAL, fail-soft). When set, the
  // organiser event-location editor can geocode a venue address server-side;
  // unset ⇒ the geocode endpoint answers `unavailable` and the editor falls
  // back to manual lat/lng entry. `wrangler secret put GOOGLE_GEOCODING_API_KEY`.
  // BEFORE SETTING: restrict the key to the Geocoding API AND set a daily
  // quota cap in the Google console (S-L2) — the per-IP limiter bounds each
  // caller, but only a Google-side cap bounds aggregate spend across IPs.
  GOOGLE_GEOCODING_API_KEY?: string;
}

// P-W1: the Elysia app graph (root + cors + route factories + auth plugins) is
// much heavier to compose than the old Hono app, and `aot: false` means none of
// it is amortised by compilation — so build once per isolate instead of per
// request. `env` bindings are stable within an isolate; the guard on the D1
// binding identity rebuilds defensively if that ever changes. The ARC account
// resolver (which imports the signing key) is built alongside it, once.
let cached: { app: ReturnType<typeof createApp>; dbBinding: D1Database } | undefined;

const misconfigured = (detail: string) =>
  new Response(JSON.stringify({ error: `Worker misconfigured: ${detail}` }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });

// Is this a *deployed* tier (dev/staging/production) rather than `local`? Reuse
// the canonical four-tier signal — `OSN_ENV`, parsed by `@shared/observability`'s
// `loadConfig` into local|dev|staging|production (the same value that drives the
// log level in observability.ts). On workerd `nodejs_compat` populates
// `process.env` from wrangler `[vars]`/secrets; in bun:sqlite/local dev it's
// native. Using `loadConfig` rather than an ad-hoc "https WEB_ORIGIN" heuristic
// keeps the tier decision drift-proof: it is the ONE place the repo decides the
// environment, so this guard can never disagree with the logger about which tier
// we're in.
const isDeployedTier = (): boolean => loadConfig({ serviceName: "cire-api" }).env !== "local";

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

    // C1/C4 (fail-closed): in a *deployed* tier the native Workers rate-limit
    // binding is MANDATORY. createApp otherwise silently falls back to a
    // per-isolate in-memory limiter, so the pre-auth claim-code brute-force
    // guard (small keyspace) would reset per cold isolate with NO signal — a
    // silent downgrade of the only cross-request throttle on the guest claim
    // endpoint. This is the wrangler foot-gun the config warns about: named
    // envs do NOT inherit the top-level `[[unsafe.bindings]]`, so a missing
    // `[[env.production.unsafe.bindings]]` block would ship prod with the
    // limiter unbound. Fail closed instead — mirrors the Turnstile /
    // weddingMember fail-closed convention and the other pre-cache boot checks
    // above (so it fires on every cold isolate, not only the first app build).
    // In `local` (the four-tier local dev / bun:sqlite tier) the in-memory
    // fallback is kept so `bun run dev` works without the binding. The real prod
    // Worker HAS the binding declared under `[env.production.unsafe.bindings]`
    // in wrangler.toml, so this only ever trips on a genuine misconfiguration.
    if (!env.CLAIM_RATE_LIMITER && isDeployedTier()) {
      await runCire(
        Effect.logError("CLAIM_RATE_LIMITER binding missing in a deployed tier", {
          detail:
            "refusing to serve with the per-isolate in-memory claim limiter as the only brute-force defence",
        }),
      );
      return misconfigured("missing CLAIM_RATE_LIMITER binding");
    }

    if (!cached || cached.dbBinding !== env.DB) {
      const db = createD1Db(env.DB);
      // Any authenticated OSN user is a first-class organiser: they sign in,
      // see their own weddings (an empty list for a new account — never a 503),
      // and create new ones via POST /api/organiser/weddings. There is no
      // pre-seeded owner and no global boot gate — per-wedding access is scoped
      // entirely by weddingOwner()/weddingMember() on the /:weddingId routes.
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
      // Sibling ARC resolver for host-list display (profileId → handle), same
      // key + graph:read scope. Null (⇒ host list shows profile ids as the
      // fallback) when the ARC config is absent — fail-soft, never a 503.
      const resolveOsnProfileDisplays =
        (await createProfileDisplayResolverFromEnv({
          osnApiUrl: env.OSN_API_URL,
          arcPrivateKeyJwk: env.CIRE_API_ARC_PRIVATE_KEY,
          arcKeyId: env.CIRE_API_ARC_KEY_ID,
        })) ?? undefined;
      // Sibling ARC resolver for add-co-host autocomplete (handle prefix search),
      // same key + graph:read scope. Null (⇒ handle-search route returns an empty
      // list, autocomplete disabled) when the ARC config is absent — fail-soft,
      // never a 503/500; the manual add path is unaffected.
      const resolveOsnHandleSearch =
        (await createHandleSearchResolverFromEnv({
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
      // Turnstile bot protection (KEY-OPTIONAL). Unset secret ⇒ null ⇒ the
      // claim + rsvp gates are skipped. The secret is read here and never
      // logged or placed anywhere but Cloudflare's siteverify endpoint.
      const turnstileVerifier = createTurnstileVerifier(env.TURNSTILE_SECRET_KEY);
      // Settings geocoder (KEY-OPTIONAL, fail-soft). Unset secret ⇒ null ⇒ the
      // geocode endpoint answers `unavailable` and the Settings form degrades
      // to manual lat/lng entry. The key is read here and never logged or sent
      // anywhere but Google's Geocoding endpoint.
      const geocoder = createGoogleGeocoder(env.GOOGLE_GEOCODING_API_KEY);
      cached = {
        dbBinding: env.DB,
        app: createApp(db, {
          webOrigin: origins[0],
          allowedOrigins: origins,
          claimLimiter: edgeLimiter,
          accountLinkLimiter: edgeLimiter,
          inviteLimiter: edgeLimiter,
          // Geocode rides the same shared edge budget — it's a billed upstream
          // amplifier, same class as the invite R2 writes.
          geocodeLimiter: edgeLimiter,
          r2: env.SHEETS,
          assets: env.ASSETS,
          images: env.IMAGES,
          osnJwksUrl: env.OSN_JWKS_URL,
          osnAudience: env.OSN_AUDIENCE,
          resolveOsnAccountId,
          resolveOsnProfileByHandle,
          resolveOsnProfileDisplays,
          resolveOsnHandleSearch,
          turnstileVerifier,
          geocoder,
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
  // single `[triggers] crons` entry in wrangler.toml — daily 04:00 UTC. Three
  // independent sweeps share the cron:
  //
  //  1. Expired-session sweep — guest logins leave session rows that are never
  //     deleted on the read path, so the table grows unbounded without this. The
  //     sweep deletes rows whose 30-day window has lapsed; `expiresAt` already
  //     encodes when a row becomes dead.
  //  2. Guest-data retention sweep — enforces the published privacy promise
  //     (cire/web privacy.astro): guest PII (guests/families/rsvps incl. dietary
  //     + consent, plus imports bookkeeping) is deleted 1 year after a wedding's
  //     final event. Reaps the `cire-sheets` CSVs it orphans (env.SHEETS).
  //  3. `cire-assets` orphan reconciliation (IB-S-L2) — best-effort deletes
  //     invite-image objects under `assets/` referenced by NO live DB row and
  //     older than a 7-day grace window. Heavily guarded: aborts and deletes
  //     NOTHING if the referenced-key read fails or comes back empty against a
  //     non-empty bucket, and caps deletions per run. See asset-reconcile.ts.
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

    // Pass the SHEETS binding so the retention sweep also reclaims the
    // personal-data objects it orphans (IB-S-L2 / C-H1): the uploaded guest/event
    // spreadsheets in `cire-sheets` referenced by the `imports` rows it deletes.
    // D1's ON DELETE cascade never reaches R2, so without this the CSVs (which
    // carry guest PII) would outlive the deleted DB rows forever. The `cire-assets`
    // invite images are NOT reaped here — those rows survive (the invite stays
    // live); see retentionService.sweepExpiredGuestData.
    ctx.waitUntil(
      Effect.runPromise(
        retentionService.sweepExpiredGuestData(new Date(), { sheets: env.SHEETS }).pipe(
          Effect.catchAll((err) =>
            Effect.logError("scheduled guest-data retention sweep failed", { reason: err.reason }),
          ),
          Effect.provide(dbLayer),
        ),
      ),
    );

    // IB-S-L2: reconcile orphaned `cire-assets` invite images (re-upload/remove
    // best-effort-delete failures leave objects no DB row references). Pass the
    // ASSETS binding; absent ⇒ the reconcile is a no-op. The service refuses to
    // delete anything unless it can positively confirm the live set (abort on a
    // failed/empty referenced-key read) and only reaps objects past a 7-day
    // grace window — so a freshly uploaded image whose row write lags is safe.
    ctx.waitUntil(
      Effect.runPromise(
        assetReconcileService.reconcileOrphans(env.ASSETS).pipe(
          Effect.catchAll((err) =>
            Effect.logError("scheduled cire-assets reconciliation failed", { reason: err.reason }),
          ),
          Effect.provide(dbLayer),
        ),
      ),
    );
  },
};

export default handler;
