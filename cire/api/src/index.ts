import { makeLogEmailLive, makeResendEmailLive } from "@shared/email";
import { createFeatureFlags } from "@shared/feature-flags";
import { loadConfig, parseDeploymentEnvironment } from "@shared/observability/config";
import { createWorkersRateLimiter } from "@shared/rate-limit";
import type { WorkersRateLimitBinding } from "@shared/rate-limit";
import { createTurnstileVerifier } from "@shared/turnstile";
import { Effect, Layer } from "effect";

import { createApp } from "./app";
import { createD1Db, DbService } from "./db";
import { setExecutionCtx } from "./lib/execution-ctx";
import { CIRE_OIDC_TX_HMAC_INFO } from "./lib/oidc";
import { runCire } from "./observability";
import { assetReconcileService } from "./services/asset-reconcile";
import { maintenanceSweeps } from "./services/maintenance-sweeps";
import { organiserSessionService } from "./services/organiser-session";
import {
  createAccountResolverFromEnv,
  createConnectionSearchResolverFromEnv,
  createHandleResolverFromEnv,
  createHandleSearchResolverFromEnv,
  createOrgMembershipResolverFromEnv,
  createProfileDisplayResolverFromEnv,
  createProfileOrgsResolverFromEnv,
} from "./services/osn-bridge";
import { retentionService } from "./services/retention";
import { sessionService } from "./services/session";
import { createZapChatClientFromEnv } from "./services/zap-bridge";

// Worker bindings + vars. Mirrors `wrangler.toml` ([[d1_databases]], [[r2_buckets]],
// [vars]); regenerate the full set with `bunx wrangler types` when bindings change.
// Hand-typed (rather than committing the generated worker-configuration.d.ts blob)
// to match the package's minimal-interface style — see `R2Bucket` in
// `services/r2-imports.ts`. Bindings are optional because a misconfigured
// deployment must fail at the edge with a 503, not a type lie.
export interface Env {
  // Deployment tier — `local` | `dev` | `staging` | `production`. Set as a
  // plain var in EVERY wrangler env block; absent ⇒ `local`, which switches OFF
  // the fail-closed rate-limiter guard below, so it is security-relevant, not
  // just cosmetic. Read from the binding rather than `process.env` because on
  // workerd `process.env` is empty until first access and unavailable at module
  // scope; the binding is always correct.
  OSN_ENV?: string;
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
  // Organiser sign-in over OIDC. `OSN_ISSUER_URL` is the issuer origin
  // (`https://id.musubi.social`) and must equal the `iss` claim byte-for-byte;
  // `CIRE_API_ORIGIN` is this Worker's own public origin, used to build the
  // redirect URI registered with the issuer — also byte-for-byte, at both legs.
  // Both are plain vars. `CIRE_OIDC_CLIENT_SECRET` is a wrangler secret. Any of
  // the four missing ⇒ `/api/auth/oidc/*` answers 503 and nobody can sign in;
  // the guest invite site keeps working, so this is scoped to the routes that
  // genuinely cannot function, not the whole Worker.
  OSN_ISSUER_URL?: string;
  CIRE_API_ORIGIN?: string;
  CIRE_OIDC_CLIENT_ID?: string;
  CIRE_OIDC_CLIENT_SECRET?: string;
  // Optional — present only where guest account-linking is enabled. Base URL of
  // osn-api plus cire-api's ARC signing key (a wrangler secret, ES256 JWK) and
  // its `kid` (matching the public key registered in osn-api's service_accounts
  // under serviceId `cire-api`). All three absent ⇒ linking POST answers 503.
  OSN_API_URL?: string;
  CIRE_API_ARC_PRIVATE_KEY?: string;
  CIRE_API_ARC_KEY_ID?: string;
  // Shared secret for the internal back-channel organiser-session revoke
  // endpoint (POST /internal/revoke-organiser-sessions). osn-api presents it as
  // `Authorization: Bearer` on connection-revoke / account-delete so a revoked
  // OSN connection kills the cire organiser session promptly instead of waiting
  // out its 7-day TTL. A wrangler secret (`wrangler secret put
  // CIRE_INTERNAL_REVOKE_SECRET`). Absent ⇒ the endpoint is disabled (503).
  CIRE_INTERNAL_REVOKE_SECRET?: string;
  // Optional — base URL of zap-api for the vendor enquiry c2b chat bridge.
  // Absent (or combined with a missing ARC key) ⇒ vendor chat disabled (503).
  // The ARC signing key is shared with the osn-api bridge above; no new key
  // env vars are introduced.
  ZAP_API_URL?: string;
  // Native Workers Rate Limiting binding (C1/C4). When present, the claim
  // limiter is the global, atomic edge limiter. Absent ⇒ the per-isolate
  // in-memory fallback — allowed ONLY in the `local` tier (`bun run dev` /
  // bun:sqlite tests). In any deployed tier (dev/staging/production) a missing
  // binding is a fail-closed 503 at the edge (see the guard in `fetch`), because
  // a per-isolate limiter is no real cross-request brute-force defence and the
  // downgrade would otherwise be silent. Optional here so the missing-binding
  // case surfaces as that explicit 503, not a type lie.
  CLAIM_RATE_LIMITER?: WorkersRateLimitBinding;
  // Native Workers Rate Limiting binding for the guest SESSION-RESTORE read
  // (`GET /api/claim/session`). Separate namespace from CLAIM_RATE_LIMITER on
  // purpose — that one is a 5/min credential-surface budget, this route runs on
  // every invite page load. Absent ⇒ the per-isolate in-memory fallback in
  // `createApp`. Unlike the claim binding this is NOT a fail-closed 503 in a
  // deployed tier: the route is authenticated (a valid `cire_session` is
  // required to reach the handler at all), so an unbound limiter degrades a
  // throttle rather than removing a brute-force defence.
  CLAIM_SESSION_RATE_LIMITER?: WorkersRateLimitBinding;
  // Native Workers Rate Limiting bindings for the organiser registry amplifier
  // routes — the link preview (fetches a URL the caller typed) and the image
  // copy (that fetch plus an R2 write). Both are authenticated, entitlement-
  // gated organiser routes, so an absent binding degrades to the per-isolate
  // in-memory default in `createApp` rather than failing closed: the budget
  // exists to protect the third party being fetched, not to stop a brute force.
  REGISTRY_PREVIEW_RATE_LIMITER?: WorkersRateLimitBinding;
  REGISTRY_IMAGE_RATE_LIMITER?: WorkersRateLimitBinding;
  // Turnstile bot-protection secret (KEY-OPTIONAL). When set, the guest claim +
  // RSVP endpoints require a valid Turnstile token (fail-closed); unset ⇒ those
  // gates are skipped. `wrangler secret put TURNSTILE_SECRET_KEY`.
  TURNSTILE_SECRET_KEY?: string;
  // Resend API key for transactional email (vendor claim-invite emails). When
  // set, the vendor list-in-directory endpoint dispatches via Resend; absent ⇒
  // falls back to LogEmailLive (emails captured in-memory / logged). Fail-soft:
  // never throws on boot, just degrades gracefully.
  RESEND_API_KEY?: string;
  // GrowthBook feature flags (KEY-OPTIONAL). GROWTHBOOK_CLIENT_KEY unset ⇒ the
  // provider serves every flag's coded default with zero network (state before
  // a GrowthBook account exists); set it (via `[vars]` or
  // `wrangler secret put GROWTHBOOK_CLIENT_KEY`) to activate live evaluation.
  // GROWTHBOOK_API_HOST defaults to https://cdn.growthbook.io. KV_GB_PAYLOAD is
  // an OPTIONAL cross-isolate cache for the SDK payload — absent ⇒ each isolate
  // keeps its own in-memory cache (still correct, just not shared).
  GROWTHBOOK_CLIENT_KEY?: string;
  GROWTHBOOK_API_HOST?: string;
  KV_GB_PAYLOAD?: KVNamespace;
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
// `parseDeploymentEnvironment` into local|dev|staging|production (the same value
// that drives the log level in observability.ts). Using the shared parser rather
// than an ad-hoc "https WEB_ORIGIN" heuristic keeps the tier decision
// drift-proof: it is the ONE place the repo decides the environment, so this
// guard can never disagree with the logger about which tier we're in.
//
// The value comes from the request-scoped `env` binding, NOT `process.env`.
// workerd only populates `process.env` from wrangler `[vars]`/secrets on first
// access under `nodejs_compat_populate_process_env`, and never during module
// evaluation — so reading it here would be one flag away from silently
// resolving `local` on a live Worker and disabling the fail-closed
// CLAIM_RATE_LIMITER guard below. The binding has no such timing hazard.
// `loadConfig` still runs so its S-L3 production-mismatch check applies.
const isDeployedTier = (env: Env): boolean =>
  loadConfig({ serviceName: "cire-api", env: parseDeploymentEnvironment(env.OSN_ENV) }).env !==
  "local";

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
    if (!env.CLAIM_RATE_LIMITER && isDeployedTier(env)) {
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
      // Sibling ARC resolver for the graph-aware half of that autocomplete: the
      // organiser's OWN OSN connections, which rank above the global handle
      // search and are the only source that answers the portal's on-focus
      // (empty-query) fetch. Same key + graph:read scope. Null (⇒ the route
      // falls back to the global search alone) when the ARC config is absent —
      // fail-soft, never a 503/500.
      const resolveOsnConnectionSearch =
        (await createConnectionSearchResolverFromEnv({
          osnApiUrl: env.OSN_API_URL,
          arcPrivateKeyJwk: env.CIRE_API_ARC_PRIVATE_KEY,
          arcKeyId: env.CIRE_API_ARC_KEY_ID,
        })) ?? undefined;
      // Org-membership resolver for the vendor portal org-gate (org:read scope,
      // ARC-authenticated). Returns the fail-soft null-resolver when the ARC
      // config is absent — all org-gated vendor routes answer 403 (not a member)
      // rather than 503, consistent with the "no ARC key = access denied" model.
      const orgMembership = await createOrgMembershipResolverFromEnv({
        osnApiUrl: env.OSN_API_URL,
        arcPrivateKeyJwk: env.CIRE_API_ARC_PRIVATE_KEY,
        arcKeyId: env.CIRE_API_ARC_KEY_ID,
      });
      // Profile→orgs resolver: scopes the vendor enquiry LIST query to the
      // caller's own tenants (org:read scope, ARC). Fail-soft (no orgs) when the
      // ARC config is absent — the list is then empty (fail-closed), never an
      // unscoped cross-tenant scan.
      const profileOrgs = await createProfileOrgsResolverFromEnv({
        osnApiUrl: env.OSN_API_URL,
        arcPrivateKeyJwk: env.CIRE_API_ARC_PRIVATE_KEY,
        arcKeyId: env.CIRE_API_ARC_KEY_ID,
      });
      // Email layer for vendor claim-invite emails. Uses Resend when the API key
      // is present (deployed tiers); falls back to LogEmailLive (no network) so
      // the worker boots cleanly without the key (local dev + bun:sqlite tests).
      const emailLayer = env.RESEND_API_KEY
        ? makeResendEmailLive({
            apiKey: env.RESEND_API_KEY,
            fromAddress: "hello@cireweddings.com",
          })
        : makeLogEmailLive().layer;
      // Vendor-enquiry c2b chat bridge (Vendors S4). Reuses cire-api's existing
      // ARC key (same signing key, new audience `zap-api` + scope `chat:c2b`).
      // Null (⇒ enquiry open/reply answer 503) when ZAP_API_URL or the ARC
      // config is absent, or the JWK is corrupt — fail-soft, never crashes boot.
      const enquiryZapClient = await createZapChatClientFromEnv({
        zapApiUrl: env.ZAP_API_URL,
        arcPrivateKeyJwk: env.CIRE_API_ARC_PRIVATE_KEY,
        arcKeyId: env.CIRE_API_ARC_KEY_ID,
      });
      // C1/C4/AL-S-L1: prefer the native Workers rate-limit binding (global +
      // atomic) for every pre-auth / amplifier surface — claim (brute-force),
      // account-link (ARC-sign + S2S amplifier, membership oracle), invite
      // (R2 write amplifier). One binding ⇒ one shared global budget, which is
      // an acceptable (stricter) cap; absent the binding, each falls back to
      // createApp's per-surface in-memory default.
      const edgeLimiter = env.CLAIM_RATE_LIMITER
        ? createWorkersRateLimiter(env.CLAIM_RATE_LIMITER)
        : undefined;
      const sessionEdgeLimiter = env.CLAIM_SESSION_RATE_LIMITER
        ? createWorkersRateLimiter(env.CLAIM_SESSION_RATE_LIMITER)
        : undefined;
      // The registry link-preview and image-copy surfaces are amplifiers too:
      // each request makes us fetch a URL the caller chose and, on the image
      // leg, write to R2. createApp's in-memory default counts per ISOLATE, so
      // the "10 a minute" the design argues for is really 10 a minute per
      // isolate — a bound the caller can widen by spreading requests. These get
      // the native binding for the same reason claim does.
      const registryPreviewEdgeLimiter = env.REGISTRY_PREVIEW_RATE_LIMITER
        ? createWorkersRateLimiter(env.REGISTRY_PREVIEW_RATE_LIMITER)
        : undefined;
      const registryImageEdgeLimiter = env.REGISTRY_IMAGE_RATE_LIMITER
        ? createWorkersRateLimiter(env.REGISTRY_IMAGE_RATE_LIMITER)
        : undefined;
      // Turnstile bot protection (KEY-OPTIONAL). Unset secret ⇒ null ⇒ the
      // claim + rsvp gates are skipped. The secret is read here and never
      // logged or placed anywhere but Cloudflare's siteverify endpoint.
      const turnstileVerifier = createTurnstileVerifier(env.TURNSTILE_SECRET_KEY);
      // GrowthBook feature flags (KEY-OPTIONAL). Unset client key ⇒ an inert
      // provider that serves registry defaults with no network. Built once per
      // isolate alongside the app so its payload cache is isolate-lived. No
      // per-request `ctx` is passed: KV cache writes are best-effort (the
      // in-isolate memo is the primary cache; KV just shares it across isolates).
      const flags = createFeatureFlags({
        clientKey: env.GROWTHBOOK_CLIENT_KEY,
        apiHost: env.GROWTHBOOK_API_HOST,
        kv: env.KV_GB_PAYLOAD,
      });
      // OIDC relying-party config for organiser sign-in. All four pieces or
      // none: a half-configured client cannot complete a single exchange, so
      // `null` (⇒ 503 on the sign-in routes) is the honest state. Loud in a
      // deployed tier, silent locally where `bun run dev:cire` runs without an
      // issuer.
      const issuerBase = env.OSN_ISSUER_URL?.replace(/\/+$/, "");
      const apiOrigin = env.CIRE_API_ORIGIN?.replace(/\/+$/, "");
      const oidc =
        issuerBase && apiOrigin && env.CIRE_OIDC_CLIENT_ID && env.CIRE_OIDC_CLIENT_SECRET
          ? {
              issuer: issuerBase,
              jwksUrl: env.OSN_JWKS_URL,
              clientId: env.CIRE_OIDC_CLIENT_ID,
              clientSecret: env.CIRE_OIDC_CLIENT_SECRET,
              redirectUri: `${apiOrigin}/api/auth/oidc/callback`,
              allowedReturnOrigins: origins,
              txHmacInfo: CIRE_OIDC_TX_HMAC_INFO,
            }
          : null;
      if (!oidc && isDeployedTier(env)) {
        await runCire(
          Effect.logError("OIDC client config incomplete — organiser sign-in disabled", {
            detail:
              "set OSN_ISSUER_URL, CIRE_API_ORIGIN, CIRE_OIDC_CLIENT_ID and the CIRE_OIDC_CLIENT_SECRET secret",
          }),
        );
      }
      cached = {
        dbBinding: env.DB,
        app: createApp(db, {
          webOrigin: origins[0],
          // WEB_ORIGIN is a comma-list: [guest invite, organiser host, vendor
          // portal]. Enquiry thread links live on the organiser origin; vendor
          // claim links on the vendor portal. Fall back to createApp's prod
          // defaults if a tier only configures the guest origin.
          ...(origins[1] ? { organiserOrigin: origins[1] } : {}),
          ...(origins[2] ? { vendorPortalOrigin: origins[2] } : {}),
          allowedOrigins: origins,
          claimLimiter: edgeLimiter,
          accountLinkLimiter: edgeLimiter,
          inviteLimiter: edgeLimiter,
          // Its own edge limiter, NOT `edgeLimiter` — that one is bound to
          // CLAIM_RATE_LIMITER (5/min), the exact budget this route was split
          // away from. Absent binding ⇒ createApp's in-memory 60/min default.
          ...(sessionEdgeLimiter ? { claimSessionLimiter: sessionEdgeLimiter } : {}),
          ...(registryPreviewEdgeLimiter
            ? { registryPreviewLimiter: registryPreviewEdgeLimiter }
            : {}),
          ...(registryImageEdgeLimiter ? { registryImageLimiter: registryImageEdgeLimiter } : {}),
          r2: env.SHEETS,
          assets: env.ASSETS,
          images: env.IMAGES,
          osnJwksUrl: env.OSN_JWKS_URL,
          osnAudience: env.OSN_AUDIENCE,
          oidc,
          // Back-channel revoke endpoint: enabled only when the shared secret is
          // set (else it answers 503). No new rate limiter wired here — the
          // in-memory default in createApp is generous enough for the
          // infrequent revoke/delete calls.
          internalRevokeSecret: env.CIRE_INTERNAL_REVOKE_SECRET ?? null,
          resolveOsnAccountId,
          resolveOsnProfileByHandle,
          resolveOsnProfileDisplays,
          resolveOsnHandleSearch,
          resolveOsnConnectionSearch,
          turnstileVerifier,
          flags,
          orgMembership,
          profileOrgs,
          emailLayer,
          // Vendor-enquiry deps (Vendors S4). The zap client degrades to 503 for
          // open/reply when null; the enquiry email layer reuses the shared
          // transport (Resend in deployed tiers, LogEmailLive locally). The
          // per-user write limiter (spam control §96) uses createApp's default
          // (20/min); index.ts passes only the client + email layer.
          enquiryZapClient,
          enquiryEmailLayer: emailLayer,
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
  // single `[triggers] crons` entry in wrangler.toml — daily 04:00 UTC. Five
  // independent sweeps share the cron:
  //
  //  1. Expired-session sweep — guest logins leave session rows that are never
  //     deleted on the read path, so the table grows unbounded without this. The
  //     sweep deletes rows whose 30-day window has lapsed; `expiresAt` already
  //     encodes when a row becomes dead.
  //  2. Guest-data retention sweep — enforces the published privacy promise
  //     (cire/invites privacy.astro): guest PII (guests/families/rsvps incl. dietary
  //     + consent, plus imports bookkeeping) is deleted 1 year after a wedding's
  //     final event. Reaps the `cire-sheets` CSVs it orphans (env.SHEETS).
  //  3. `cire-assets` orphan reconciliation (IB-S-L2) — best-effort deletes
  //     invite-image objects under `assets/` referenced by NO live DB row and
  //     older than a 7-day grace window. Heavily guarded: aborts and deletes
  //     NOTHING if the referenced-key read fails or comes back empty against a
  //     non-empty bucket, and caps deletions per run. See asset-reconcile.ts.
  //  4. Expired vendor-claim tokens + 5. abandoned `preview` change rows (with
  //     their uploaded-sheet CSVs) — see services/maintenance-sweeps.ts.
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

    // Organiser sessions expire but do not delete themselves — `validate` only
    // reports expiry. Same reasoning as the guest sweep above: without this the
    // table grows for the life of the product, and every row holds a login-time
    // snapshot of an OSN profile (email, handle, display name), so keeping dead
    // ones is a data-retention problem as well as a size one.
    ctx.waitUntil(
      Effect.runPromise(
        organiserSessionService.sweepExpired().pipe(
          Effect.catchAll((err) =>
            Effect.logError("scheduled organiser session sweep failed", { reason: err.reason }),
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

    // Expired vendor-claim tokens: 7-day TTL, nothing else ever deleted them.
    ctx.waitUntil(
      Effect.runPromise(
        maintenanceSweeps.sweepExpiredVendorClaims().pipe(
          Effect.catchAll((err) =>
            Effect.logError("scheduled vendor-claim sweep failed", { reason: err.reason }),
          ),
          Effect.provide(dbLayer),
        ),
      ),
    );

    // Abandoned `preview` change rows + their uploaded-sheet CSVs (guest PII
    // in `cire-sheets`) — previously only reclaimed when the whole wedding
    // aged out of retention, a year+ later.
    ctx.waitUntil(
      Effect.runPromise(
        maintenanceSweeps.sweepStalePreviews(new Date(), { sheets: env.SHEETS }).pipe(
          Effect.catchAll((err) =>
            Effect.logError("scheduled stale-preview sweep failed", { reason: err.reason }),
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
