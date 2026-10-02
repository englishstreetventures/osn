import { makeLogEmailLive, makeResendEmailLive } from "@shared/email";
import { createFeatureFlags } from "@shared/feature-flags";
import { loadConfig, parseDeploymentEnvironment } from "@shared/observability/config";
import { createWorkersRateLimiter } from "@shared/rate-limit";
import type { WorkersRateLimitBinding } from "@shared/rate-limit";
import { createTurnstileVerifier } from "@shared/turnstile";
import { Effect, Layer } from "effect";

import { type AppOptions, createApp } from "./app";
import { createD1Db, DbService } from "./db";
import { createSessionRoutedClient, runInD1Session } from "./db/d1-session";
import { claimReviewAlertTarget, sendClaimReviewAlert } from "./lib/claim-review-email";
import { setExecutionCtx } from "./lib/execution-ctx";
import { sendGiftSummaryEmails } from "./lib/gift-summary-email";
import { CIRE_OIDC_TX_HMAC_INFO } from "./lib/oidc";
import { organiserOriginFrom } from "./lib/organiser-origin";
import { registryOutboundLimiters } from "./lib/registry-limiters";
import { webOriginProblem } from "./lib/web-origin";
import { flushCireTelemetry, runCire } from "./observability";
import { assetReconcileService } from "./services/asset-reconcile";
import { claimReviewService, type PendingClaimsSummary } from "./services/claim-review";
import { maintenanceSweeps } from "./services/maintenance-sweeps";
import { organiserSessionService } from "./services/organiser-session";
import {
  createAccountResolverFromEnv,
  createConnectionSearchResolverFromEnv,
  createHandleResolverFromEnv,
  createHandleSearchResolverFromEnv,
  createOrganiserEmailLookupFromEnv,
  createOrganiserEmailResolverFromEnv,
  createOrgMembershipResolverFromEnv,
  createProfileDisplayResolverFromEnv,
  createProfileOrgsResolverFromEnv,
} from "./services/osn-bridge";
import { retentionService, type GiftSummaryNotice } from "./services/retention";
import { rsvpChangeService } from "./services/rsvp-changes";
import { rsvpDigestService } from "./services/rsvp-digest";
import { sessionService } from "./services/session";
import { sheetReconcileService } from "./services/sheet-reconcile";
import { createStripeClientFromEnv } from "./services/stripe";
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
  // `OSN_ISSUER_URL` is both the expected `iss` on organiser access tokens
  // and the OIDC issuer origin — one value, two uses, and it must equal
  // osn-api's own `OSN_ISSUER_URL` byte for byte.
  // Organiser sign-in over OIDC. `OSN_ISSUER_URL` is the issuer origin
  // (`https://id.musubi.social`) and must equal the `iss` claim byte-for-byte;
  // `CIRE_API_ORIGIN` is this Worker's own public origin, used to build the
  // redirect URI registered with the issuer — also byte-for-byte, at both legs.
  // Both are plain vars. `CIRE_OIDC_CLIENT_SECRET` is a wrangler secret. Any of
  // the four missing ⇒ `/api/auth/oidc/*` answers 503 and nobody can sign in;
  // the guest invite site keeps working, so this is scoped to the routes that
  // genuinely cannot function, not the whole Worker.
  OSN_ISSUER_URL: string;
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
  // copy (that fetch plus an R2 write). Absent in a deployed tier ⇒ those
  // routes answer 503 and log an error (lib/registry-limiters.ts); absent in
  // `local` ⇒ the per-isolate in-memory default in `createApp`.
  REGISTRY_PREVIEW_RATE_LIMITER?: WorkersRateLimitBinding;
  REGISTRY_IMAGE_RATE_LIMITER?: WorkersRateLimitBinding;
  // The link picker's thumbnails: one outbound fetch and one Images transform
  // per call, six per preview, so its own namespace sized at 60/min. Absent ⇒
  // as for the two above.
  REGISTRY_THUMB_RATE_LIMITER?: WorkersRateLimitBinding;
  // The guest registry write limiter — claiming and releasing a gift. Its own
  // namespace because guests are a different population from organisers: a
  // guest party working through a gift list must not spend the budget the
  // couple needs to edit it. Absent ⇒ the per-isolate in-memory default; the
  // route is session-authenticated, so an unbound limiter degrades a throttle.
  REGISTRY_GUEST_RATE_LIMITER?: WorkersRateLimitBinding;
  // Turnstile bot-protection secret (KEY-OPTIONAL). When set, the guest claim +
  // RSVP endpoints require a valid Turnstile token (fail-closed); unset ⇒ those
  // gates are skipped. `wrangler secret put TURNSTILE_SECRET_KEY`.
  TURNSTILE_SECRET_KEY?: string;
  // Stripe Connect for gift contributions (KEY-OPTIONAL, and the two halves are
  // independent). `STRIPE_SECRET_KEY` set ⇒ the organiser can connect a Stripe
  // account from the portal; unset ⇒ those routes are not mounted at all, so a
  // deployment with no Stripe account has no payment surface rather than a
  // broken one. `STRIPE_WEBHOOK_SECRET` set ⇒ `/api/stripe/webhook` exists and
  // verifies every delivery; unset ⇒ it does not exist, because nothing could
  // be verified and an endpoint that writes from unverified bodies is an
  // unauthenticated write API. Both: `wrangler secret put …`.
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // Signing secret for the PLATFORM webhook (upgrade purchases). A DIFFERENT
  // secret from STRIPE_WEBHOOK_SECRET: two Stripe endpoints, two secrets. That
  // one is Connect-scoped and hears about gifts on a couple's account; this one
  // hears about the platform's own charges. Absent ⇒ that route does not exist,
  // and a purchase could be paid but never granted.
  STRIPE_PLATFORM_WEBHOOK_SECRET?: string;
  // Stripe Price ids for the plan tiers (KEY-OPTIONAL, per Price). A tier with
  // no Price id here is not for sale in this deployment: it never appears in
  // the catalogue and the checkout route 404s for it. `CRIMSON_FROM_GOLD` is a
  // second Price on the Crimson product, charged to a wedding already on Gold;
  // unset, Crimson is not offered to a Gold wedding at all. NOT secrets — they
  // are `[vars]` in wrangler.toml, and named envs inherit none, so each
  // deployment declares its own. The AMOUNT lives at Stripe, never here.
  STRIPE_UPGRADE_PRICE_GOLD?: string;
  STRIPE_UPGRADE_PRICE_CRIMSON?: string;
  STRIPE_UPGRADE_PRICE_CRIMSON_FROM_GOLD?: string;
  // Two-letter country for a NEW connected account (`AU` unless set). Stripe
  // fixes an account's country at creation, so this is a per-deployment default
  // and not something a couple can change afterwards.
  STRIPE_ACCOUNT_COUNTRY?: string;
  // Resend API key for transactional email (vendor claim-invite emails). When
  // set, the vendor list-in-directory endpoint dispatches via Resend; absent ⇒
  // falls back to LogEmailLive (emails captured in-memory / logged). Fail-soft:
  // never throws on boot, just degrades gracefully.
  RESEND_API_KEY?: string;
  // Where the daily "vendor claims are waiting" reminder goes. A secret, not a
  // var: the repo is public and the address is a person's. Unset, or with no
  // RESEND_API_KEY, no reminder is sent and the cron's log line is the only
  // signal.
  CIRE_OPS_EMAIL?: string;
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

// The Elysia app graph (root + cors + route factories + auth plugins) is
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
// `loadConfig` still runs so its production-mismatch check applies.
const isDeployedTier = (env: Env): boolean =>
  loadConfig({ serviceName: "cire-api", env: parseDeploymentEnvironment(env.OSN_ENV) }).env !==
  "local";

// The same tier signal without `loadConfig`, which can throw on a malformed
// OTLP header value. The WEB_ORIGIN check runs in `scheduled` outside any
// catch, so it must not be able to stop the sweeps that follow it.
const isDeployedEnv = (env: Env): boolean => parseDeploymentEnvironment(env.OSN_ENV) !== "local";

const handler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    // Fail closed at the edge if any required binding/var is missing, rather
    // than letting createApp fall back to its localhost dev defaults for the
    // OSN issuer/audience in a misconfigured production deployment.
    const missing = [
      !env.DB && "DB",
      !env.WEB_ORIGIN && "WEB_ORIGIN",
      !env.OSN_JWKS_URL && "OSN_JWKS_URL",
      // Required, not optional-with-a-default. The default is the localhost
      // issuer, so an unset value in a deployed tier would expect
      // `http://localhost:4000` and reject every real token — a total outage
      // whose cause is invisible in the 401. Failing at startup names it.
      !env.OSN_ISSUER_URL && "OSN_ISSUER_URL",
      !env.OSN_AUDIENCE && "OSN_AUDIENCE",
    ].filter(Boolean);
    if (missing.length > 0 || !env.DB) {
      return misconfigured(`missing ${missing.join(", ")}`);
    }

    // A bad WEB_ORIGIN entry would widen the CORS allowlist, the CSRF origin
    // guard and the session cookie's `Secure` flag at once, so refuse to serve
    // instead. The rule lives in lib/web-origin.ts.
    const originProblem = webOriginProblem(env.WEB_ORIGIN, () => isDeployedEnv(env));
    if (originProblem) {
      return misconfigured(originProblem);
    }
    const origins = env.WEB_ORIGIN.split(",")
      .map((o) => o.trim())
      .filter(Boolean);

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
      // Built over the session-routing shim, not the binding itself: the handle
      // is baked into the cached app graph, so it must be stable for the life of
      // the isolate, while the D1 session it queries through has to be per
      // request. The shim is the seam between the two — see db/d1-session.ts.
      const db = createD1Db(createSessionRoutedClient(env.DB, "fetch"));
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
      // Prefer the native Workers rate-limit binding (global +
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
      // A deployed tier without one of these bindings refuses that route with
      // 503 rather than count per isolate (lib/registry-limiters.ts).
      const registryLimiters = registryOutboundLimiters(env, isDeployedTier(env));
      // The guest claim/release writes. Own namespace, not the two above: those
      // budgets belong to the couple building the list, this one to every guest
      // of every wedding, and a guest party working through the list must not
      // spend the budget the couple needs to edit it.
      const registryGuestEdgeLimiter = env.REGISTRY_GUEST_RATE_LIMITER
        ? createWorkersRateLimiter(env.REGISTRY_GUEST_RATE_LIMITER)
        : undefined;
      // Turnstile bot protection (KEY-OPTIONAL). Unset secret ⇒ null ⇒ the
      // claim + rsvp gates are skipped. The secret is read here and never
      // logged or placed anywhere but Cloudflare's siteverify endpoint.
      const turnstileVerifier = createTurnstileVerifier(env.TURNSTILE_SECRET_KEY);
      // `null` without a key, exactly like the Turnstile verifier above: the
      // absence of configuration is a state this product supports, not a fault.
      const stripe = createStripeClientFromEnv(env);
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
      const appOptions: AppOptions = {
        webOrigin: origins[0],
        allowedOrigins: origins,
        claimLimiter: edgeLimiter,
        accountLinkLimiter: edgeLimiter,
        inviteLimiter: edgeLimiter,
        r2: env.SHEETS,
        assets: env.ASSETS,
        images: env.IMAGES,
        // A deployed tier never serves a shop's bytes un-encoded: with no
        // Images binding the thumbnail route answers 503 instead.
        registryThumbRequireTransform: isDeployedTier(env),
        osnJwksUrl: env.OSN_JWKS_URL,
        osnIssuerUrl: env.OSN_ISSUER_URL,
        osnAudience: env.OSN_AUDIENCE,
        oidc,
        // Back-channel revoke endpoint: enabled only when the shared secret is
        // set (else it answers 503). No new rate limiter wired here — the
        // in-memory default in createApp is generous enough for the
        // infrequent revoke/delete calls.
        internalRevokeSecret: env.CIRE_INTERNAL_REVOKE_SECRET ?? null,
        // The digest's stop links are signed with a key derived from the OIDC
        // client secret; the cron below signs them from the same value.
        digestStopSecret: env.CIRE_OIDC_CLIENT_SECRET ?? null,
        resolveOsnAccountId,
        resolveOsnProfileByHandle,
        resolveOsnProfileDisplays,
        // Owner notices need both a way to find the owners' addresses and a
        // real transport; without Resend they would only reach the log
        // stand-in, so none are sent.
        organiserEmailLookup: env.RESEND_API_KEY
          ? ((await createOrganiserEmailLookupFromEnv({
              osnApiUrl: env.OSN_API_URL,
              arcPrivateKeyJwk: env.CIRE_API_ARC_PRIVATE_KEY,
              arcKeyId: env.CIRE_API_ARC_KEY_ID,
            })) ?? undefined)
          : undefined,
        resolveOsnHandleSearch,
        resolveOsnConnectionSearch,
        turnstileVerifier,
        stripe,
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
        stripePlatformWebhookSecret: env.STRIPE_PLATFORM_WEBHOOK_SECRET ?? null,
        upgradePrices: {
          gold: env.STRIPE_UPGRADE_PRICE_GOLD,
          crimson: env.STRIPE_UPGRADE_PRICE_CRIMSON,
          crimsonFromGold: env.STRIPE_UPGRADE_PRICE_CRIMSON_FROM_GOLD,
        },
        stripeAccountCountry: env.STRIPE_ACCOUNT_COUNTRY,
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
      };
      // WEB_ORIGIN is a comma-list: [guest invite, organiser host, vendor
      // portal]. Enquiry thread links live on the organiser origin; vendor
      // claim links on the vendor portal. Fall back to createApp's prod
      // defaults if a tier only configures the guest origin.
      if (origins[1]) appOptions.organiserOrigin = origins[1];
      if (origins[2]) appOptions.vendorPortalOrigin = origins[2];
      // Its own edge limiter, NOT `edgeLimiter` — that one is bound to
      // CLAIM_RATE_LIMITER (5/min), the exact budget this route was split
      // away from. Absent binding ⇒ createApp's in-memory 60/min default.
      if (sessionEdgeLimiter) appOptions.claimSessionLimiter = sessionEdgeLimiter;
      Object.assign(appOptions, registryLimiters);
      if (registryGuestEdgeLimiter) appOptions.registryGuestLimiter = registryGuestEdgeLimiter;
      cached = {
        dbBinding: env.DB,
        app: createApp(db, appOptions),
      };
    }

    // Bridge the Workers execution context to the in-flight request so route
    // handlers can reach `ctx.waitUntil` (Elysia's `fetch` doesn't forward it).
    // The public image serve route uses it to populate the Cache API in the
    // background after a transform. Keyed by this exact Request instance, which
    // Elysia passes straight through to the handler.
    setExecutionCtx(request, ctx);
    // One D1 session per request, so replicas can serve every query after the
    // first (see db/d1-session.ts). Wraps the whole dispatch, which is what puts
    // the session on the async context every handler inherits.
    // Bound out of the mutable module-level cache before the closure, so the
    // narrowing above survives into it.
    const { app } = cached;
    const response = await runInD1Session(env.DB, () => app.fetch(request));

    // Drain this request's spans to the OTLP collector. Awaited-then-scheduled,
    // in that order, for two reasons: every span the request opened has ended
    // by the time `app.fetch` resolves, and `waitUntil` keeps the isolate alive
    // for the POST without the guest waiting on it.
    //
    // This explicit drain is the ONLY reliable one on workerd — no fiber
    // survives between requests, so the exporter's background interval either
    // never fires or fires with no live context, and a failed background export
    // disables the exporter (dropping spans) for 60 seconds. `flushCireTelemetry`
    // is a no-op when no OTLP endpoint is configured and can never reject. See
    // `shared/observability/src/tracing/otlp.ts`.
    ctx.waitUntil(flushCireTelemetry());
    return response;
  },

  // Cron-triggered daily maintenance and mail. Configured by the single
  // `[triggers] crons` entry in wrangler.toml — daily 04:00 UTC. Eleven
  // independent jobs share the cron (ten when the digest has no transport):
  //
  //  1. Expired-session sweep — guest logins leave session rows that are never
  //     deleted on the read path, so the table grows unbounded without this. The
  //     sweep deletes rows whose 30-day window has lapsed; `expiresAt` already
  //     encodes when a row becomes dead.
  //  2. Expired organiser sessions — same growth problem, and each dead row
  //     holds a login-time snapshot of an OSN profile, so it is a retention
  //     question too.
  //  3. Guest-data retention sweep — enforces the published privacy promise
  //     (cire/invites privacy.astro): guest PII (guests/families/rsvps incl. dietary
  //     + consent, plus imports bookkeeping) is deleted 1 year after a wedding's
  //     final event. Reaps the `cire-sheets` CSVs it orphans (env.SHEETS).
  //  4. `cire-assets` orphan reconciliation — best-effort deletes invite-image
  //     objects under `assets/` referenced by NO live DB row and older than a
  //     7-day grace window. Heavily guarded: aborts and deletes NOTHING if the
  //     referenced-key read fails or comes back empty against a non-empty
  //     bucket, and caps deletions per run. See services/r2-reconcile.ts.
  //  5. Expired vendor-claim tokens + 6. abandoned `preview` change rows (with
  //     their uploaded-sheet CSVs) — see services/maintenance-sweeps.ts.
  //  7. Vendor claims held for an operator: hand-off of confirmed listings'
  //     buffered enquiries, and a daily count of those still waiting, emailed
  //     to CIRE_OPS_EMAIL when that and Resend are configured —
  //     services/claim-review.ts.
  //  8. RSVP change-log rows past their 90-day window — services/rsvp-changes.ts.
  //  9. The daily RSVP digest email to each wedding's owner and editors, sent
  //     only when osn-api can be asked for addresses and Resend is configured
  //     — services/rsvp-digest.ts.
  // 10. The purge of soft-deleted weddings past their restore window, a few a
  //     run, with the R2 objects their rows name — services/maintenance-sweeps.ts.
  // 11. `cire-sheets` orphan reconciliation — the same guarded walk as 4 over
  //     `imports/`, against the four key columns of `imports`, with a listing
  //     budget per run. See services/sheet-reconcile.ts.
  //
  // Each is its own `waitUntil` + `catchAll`, so a failure in one never aborts
  // the other and the isolate stays alive until each delete settles. All eleven
  // share this one invocation's Workers limits (CPU, subrequests, D1 queries).
  async scheduled(_event, env, ctx) {
    if (!env.DB) return;
    // Same session routing as `fetch`, for the same reason. The sweeps are
    // write-heavy, so this buys little today — but it keeps one path through
    // the D1 client rather than two, and the reads each sweep does to find its
    // work can be served by a replica once the first query has run.
    const db = createD1Db(createSessionRoutedClient(env.DB, "scheduled"));
    const dbLayer = Layer.succeed(DbService, db);

    // One session PER SWEEP, not one shared by all of them. `waitUntil` only
    // registers a promise — what decides which session a query rides is where
    // the promise was created — so each sweep gets its own `runInD1Session`
    // wrapping its own `Effect.runPromise`. Sharing one would couple
    // unrelated, delete-heavy sweeps to a single bookmark that each of them
    // keeps advancing, so every read would be forwarded to the primary anyway.
    //
    // The sweeps to keep in mind here are the two R2 reconciliations at the
    // bottom: they delete R2 objects no DB row references, so unlike the others
    // a stale read there would destroy live data rather than merely skip a row.
    // What bounds that is RECONCILE_GRACE_MS (7 days, services/r2-reconcile.ts)
    // plus the two abort guards — orders of magnitude more than any replica lag.
    // Shortening that window is the change that would make this paragraph matter.
    const d1 = env.DB;
    const runSweep = <Result>(body: () => Promise<Result>) =>
      ctx.waitUntil(runInD1Session(d1, body));

    runSweep(() =>
      Effect.runPromise(
        sessionService.sweepExpired().pipe(
          Effect.catch((err) =>
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
    runSweep(() =>
      Effect.runPromise(
        organiserSessionService.sweepExpired().pipe(
          Effect.catch((err) =>
            Effect.logError("scheduled organiser session sweep failed", { reason: err.reason }),
          ),
          Effect.provide(dbLayer),
        ),
      ),
    );

    // Pass the SHEETS binding so the retention sweep also reclaims the
    // personal-data objects it orphans: the uploaded guest/event spreadsheets and
    // before-images in `cire-sheets` referenced by the `imports` rows it deletes.
    // D1's ON DELETE cascade never reaches R2, so without this the CSVs (which
    // carry guest PII) would outlive the deleted DB rows forever. The `cire-assets`
    // invite images are NOT reaped here — those rows survive (the invite stays
    // live); see retentionService.sweepExpiredGuestData.
    // The parting summary needs two things the sweep itself does not have: a
    // way to ask osn-api for the organiser's address (cire stores none) and a
    // real mail transport. Both are assembled here, where the ARC key material
    // and the Resend key live, so the service keeps its DbService-only context.
    //
    // Both are optional and the sweep does not care: no ARC key, or no Resend
    // key, means no notifier and a silent sweep that still deletes on time.
    // `makeLogEmailLive` is deliberately NOT used as a stand-in — logging a
    // summary nobody reads is not delivery, and would make the compliance
    // record claim the couple was told when they were not.
    const resendApiKey = env.RESEND_API_KEY;
    const organiserEmails = await createOrganiserEmailResolverFromEnv({
      osnApiUrl: env.OSN_API_URL,
      arcPrivateKeyJwk: env.CIRE_API_ARC_PRIVATE_KEY,
      arcKeyId: env.CIRE_API_ARC_KEY_ID,
    });
    const giftSummaryNotifier =
      organiserEmails && resendApiKey
        ? (notices: readonly GiftSummaryNotice[]) =>
            sendGiftSummaryEmails(notices, organiserEmails).pipe(
              Effect.provide(
                makeResendEmailLive({
                  apiKey: resendApiKey,
                  fromAddress: "hello@cireweddings.com",
                }),
              ),
            )
        : undefined;

    runSweep(() =>
      Effect.runPromise(
        retentionService
          .sweepExpiredGuestData(new Date(), { sheets: env.SHEETS }, giftSummaryNotifier)
          .pipe(
            Effect.catch((err) =>
              Effect.logError("scheduled guest-data retention sweep failed", {
                reason: err.reason,
              }),
            ),
            Effect.provide(dbLayer),
          ),
      ),
    );

    // Expired vendor-claim tokens: 7-day TTL, nothing else ever deleted them.
    runSweep(() =>
      Effect.runPromise(
        maintenanceSweeps.sweepExpiredVendorClaims().pipe(
          Effect.catch((err) =>
            Effect.logError("scheduled vendor-claim sweep failed", { reason: err.reason }),
          ),
          Effect.provide(dbLayer),
        ),
      ),
    );

    // Vendor claims held for an operator: hand confirmed listings their
    // buffered enquiries, and log how many claims are still waiting. The zap
    // client is built the same way `fetch` builds it; null leaves the
    // enquiries buffered for a later run.
    const handoffZap = await createZapChatClientFromEnv({
      zapApiUrl: env.ZAP_API_URL,
      arcPrivateKeyJwk: env.CIRE_API_ARC_PRIVATE_KEY,
      arcKeyId: env.CIRE_API_ARC_KEY_ID,
    });
    // The operator reminder needs an address, a real transport and a deployed
    // tier; without them it is skipped and the sweep's log line stays the
    // signal.
    const alertTarget = claimReviewAlertTarget({
      CIRE_OPS_EMAIL: env.CIRE_OPS_EMAIL,
      RESEND_API_KEY: resendApiKey,
      tier: parseDeploymentEnvironment(env.OSN_ENV),
    });
    const alertOperator =
      alertTarget && resendApiKey
        ? (summary: PendingClaimsSummary) =>
            sendClaimReviewAlert({ ...alertTarget, summary }).pipe(
              Effect.provide(
                makeResendEmailLive({
                  apiKey: resendApiKey,
                  fromAddress: "hello@cireweddings.com",
                }),
              ),
            )
        : undefined;
    runSweep(() =>
      Effect.runPromise(
        claimReviewService.sweep(handoffZap, alertOperator ? { alertOperator } : {}).pipe(
          Effect.catch((err) =>
            Effect.logError("scheduled vendor claim review sweep failed", {
              reason: err.reason,
            }),
          ),
          Effect.provide(dbLayer),
        ),
      ),
    );

    // Abandoned `preview` change rows + their uploaded-sheet CSVs (guest PII
    // in `cire-sheets`) — previously only reclaimed when the whole wedding
    // aged out of retention, a year+ later.
    runSweep(() =>
      Effect.runPromise(
        maintenanceSweeps.sweepStalePreviews(new Date(), { sheets: env.SHEETS }).pipe(
          Effect.catch((err) =>
            Effect.logError("scheduled stale-preview sweep failed", { reason: err.reason }),
          ),
          Effect.provide(dbLayer),
        ),
      ),
    );

    // Soft-deleted weddings past their restore window, hard-deleted with every
    // child row and the sheet and image objects those rows name. Bounded per
    // run; a wedding with money still able to move is left for a later run.
    runSweep(() =>
      Effect.runPromise(
        maintenanceSweeps
          .purgeDeletedWeddings(new Date(), { sheets: env.SHEETS, assets: env.ASSETS })
          .pipe(
            Effect.catch((err) =>
              Effect.logError("scheduled wedding purge failed", { reason: err.reason }),
            ),
            Effect.provide(dbLayer),
          ),
      ),
    );

    // Change-log rows older than 90 days. They hold ids and a kind, never a
    // name, but they are still a record of a household's replies.
    runSweep(() =>
      Effect.runPromise(
        rsvpChangeService.sweepExpired(new Date()).pipe(
          Effect.catch((err) =>
            Effect.logError("scheduled rsvp change sweep failed", { reason: err.reason }),
          ),
          Effect.provide(dbLayer),
        ),
      ),
    );

    // The daily RSVP digest. Same two preconditions as the gift summary, for
    // the same reason: without a way to ask osn-api for addresses, or a real
    // transport, there is nobody to mail, and a log stand-in would move every
    // recipient's marker past changes nobody was told about. Its lookup keeps
    // "osn-api did not answer" apart from "no address", so an outage holds the
    // markers. The portal link uses the tier's organiser origin, the second
    // entry of WEB_ORIGIN, so the digest is skipped when WEB_ORIGIN fails the
    // same check `fetch` applies: an isolate woken only by cron never runs it.
    const digestOriginProblem = webOriginProblem(env.WEB_ORIGIN ?? "", () => isDeployedEnv(env));
    if (digestOriginProblem) {
      await runCire(
        Effect.logError("scheduled rsvp digest skipped: WEB_ORIGIN misconfigured", {
          detail: digestOriginProblem,
        }),
      );
    }
    const organiserEmailLookup = await createOrganiserEmailLookupFromEnv({
      osnApiUrl: env.OSN_API_URL,
      arcPrivateKeyJwk: env.CIRE_API_ARC_PRIVATE_KEY,
      arcKeyId: env.CIRE_API_ARC_KEY_ID,
    });
    if (organiserEmailLookup && resendApiKey && !digestOriginProblem) {
      const organiserOrigin = organiserOriginFrom(env.WEB_ORIGIN);
      // Each email's one-click stop link points at this Worker's own origin
      // and is signed with a key derived from the secret the stop route
      // verifies with. Either value missing ⇒ the emails go without a stop
      // link or unsubscribe header.
      const apiOrigin = env.CIRE_API_ORIGIN?.replace(/\/+$/, "");
      const stopLinks =
        apiOrigin && env.CIRE_OIDC_CLIENT_SECRET
          ? { apiOrigin, secret: env.CIRE_OIDC_CLIENT_SECRET }
          : undefined;
      runSweep(() =>
        Effect.runPromise(
          rsvpDigestService
            .sendDailyDigests({ organiserOrigin, lookup: organiserEmailLookup, stopLinks })
            .pipe(
              Effect.catch((err) =>
                Effect.logError("scheduled rsvp digest failed", { reason: err.reason }),
              ),
              Effect.provide(dbLayer),
              Effect.provide(
                makeResendEmailLive({
                  apiKey: resendApiKey,
                  fromAddress: "hello@cireweddings.com",
                }),
              ),
            ),
        ),
      );
    }

    // Reconcile orphaned `cire-assets` invite images (re-upload/remove
    // best-effort-delete failures leave objects no DB row references). Pass the
    // ASSETS binding; absent ⇒ the reconcile is a no-op. The service refuses to
    // delete anything unless it can positively confirm the live set (abort on a
    // failed/empty referenced-key read) and only reaps objects past a 7-day
    // grace window — so a freshly uploaded image whose row write lags is safe.
    runSweep(() =>
      Effect.runPromise(
        assetReconcileService.reconcileOrphans(env.ASSETS).pipe(
          Effect.catch((err) =>
            Effect.logError("scheduled cire-assets reconciliation failed", {
              reason: err.reason,
            }),
          ),
          Effect.provide(dbLayer),
        ),
      ),
    );

    // Reconcile orphaned `cire-sheets` objects: every flow that deletes or
    // rewrites an `imports` row deletes its objects best-effort afterwards, and
    // a failed delete leaves guest PII that nothing else retries. Same guards as
    // the assets walk, plus a listing budget. Absent SHEETS ⇒ no-op.
    runSweep(() =>
      Effect.runPromise(
        sheetReconcileService.reconcileOrphans(env.SHEETS).pipe(
          Effect.catch((err) =>
            Effect.logError("scheduled cire-sheets reconciliation failed", {
              reason: err.reason,
            }),
          ),
          Effect.provide(dbLayer),
        ),
      ),
    );
  },
};

export default handler;
