import { cors } from "@elysiajs/cors";
import { createRateLimiter } from "@shared/rate-limit";
import type { RateLimiterBackend } from "@shared/rate-limit";
import type { TurnstileVerifier } from "@shared/turnstile";
import { Effect } from "effect";
import { Elysia } from "elysia";

import type { Db } from "./db";
import { originGuard } from "./lib/origin-guard";
import { runCireSync } from "./observability";
import { createAccountLinkPostRoute, createAccountLinkRoutes } from "./routes/account-link";
import { createClaimRoutes } from "./routes/claim";
import { createInviteOrganiserRoutes, createInvitePublicRoutes } from "./routes/invite";
import {
  createOrganiserHostsReadRoutes,
  createOrganiserHostsWriteRoutes,
} from "./routes/organiser-hosts";
import { createOrganiserImportRoutes } from "./routes/organiser-import";
import {
  createOrganiserPreviewRoutes,
  createOrganiserWeddingCreateRoute,
  createOrganiserWeddingsRoutes,
} from "./routes/organiser-weddings";
import { createRsvpRoutes } from "./routes/rsvp";
import type { AssetsBucket } from "./services/invite-assets";
import type { ImagesBindingLike } from "./services/invite-image-transform";
import type { OsnAccountResolver, OsnHandleResolver } from "./services/osn-bridge";
import type { R2Bucket } from "./services/r2-imports";

/** Default per-IP rate limiter for the claim endpoint: 5 attempts per minute. */
const defaultClaimLimiter = createRateLimiter({ maxRequests: 5, windowMs: 60_000 });
/**
 * Default per-IP rate limiter for the account-link surface (S-L1): 20 req/min.
 * Higher than claim because a household legitimately polls GET link-status, but
 * still caps the POST's ARC-sign + S2S amplifier and the membership-probe oracle.
 */
const defaultAccountLinkLimiter = createRateLimiter({ maxRequests: 20, windowMs: 60_000 });
/**
 * Default per-IP limiter for organiser invite-builder writes (IB-S-L1). An
 * authenticated organiser could otherwise drive unbounded 5 MB R2 image writes;
 * 30 req/min is generous for hand-editing while capping the storage/cost
 * amplifier.
 */
const defaultInviteLimiter = createRateLimiter({ maxRequests: 30, windowMs: 60_000 });
/**
 * Default per-IP limiter for the host preview-code endpoint (S-M2). Owner-gated
 * already, so this just caps the find-or-create + event-relink write amplifier;
 * 30/min is generous for clicking "Preview invite".
 */
const defaultPreviewLimiter = createRateLimiter({ maxRequests: 30, windowMs: 60_000 });
/**
 * Default per-IP limiter for the organiser wedding-create endpoint (S-L1).
 * Owner-gated already, so this just caps the unbounded-insert amplifier; 10/min
 * is generous for hand-creating weddings in the portal.
 */
const defaultWeddingCreateLimiter = createRateLimiter({ maxRequests: 10, windowMs: 60_000 });
/**
 * Default per-IP limiter for the co-host add/remove endpoints (S-L1). Owner-gated
 * already, so this just caps the ARC-sign + S2S handle-resolve amplifier on add
 * (and the management churn / handle-probe oracle); 20/min is generous for
 * hand-managing a wedding's hosts.
 */
const defaultHostLimiter = createRateLimiter({ maxRequests: 20, windowMs: 60_000 });

export interface AppOptions {
  /** Primary origin (used for the session cookie's `secure` flag). */
  webOrigin?: string;
  /** Extra origins allowed by CORS (organiser portal, etc). Defaults to `[webOrigin]`. */
  allowedOrigins?: string[];
  /** Override the claim rate limiter (useful for testing). */
  claimLimiter?: RateLimiterBackend;
  /** Override the account-link rate limiter (useful for testing). */
  accountLinkLimiter?: RateLimiterBackend;
  /** Override the invite-builder write rate limiter (useful for testing). */
  inviteLimiter?: RateLimiterBackend;
  /** Override the host preview-code rate limiter (useful for testing). */
  previewLimiter?: RateLimiterBackend;
  /** Override the wedding-create rate limiter (useful for testing). */
  weddingCreateLimiter?: RateLimiterBackend;
  /** Override the co-host add/remove rate limiter (useful for testing). */
  hostLimiter?: RateLimiterBackend;
  /** R2 bucket binding for the organiser import flow. */
  r2?: R2Bucket;
  /** R2 bucket binding for invite-builder images (separate from `r2`). */
  assets?: AssetsBucket;
  /**
   * Cloudflare Images binding for on-the-fly transforms of the invite-image
   * originals. Absent ⇒ the public serve route falls back to the raw R2 bytes.
   */
  images?: ImagesBindingLike;
  /** JWKS endpoint of the OSN issuer that signs organiser access tokens. */
  osnJwksUrl?: string;
  /** Expected `aud` claim on organiser access tokens. */
  osnAudience?: string;
  /** Test-only: inject the verifying key and skip the JWKS fetch. */
  osnTestKey?: CryptoKey;
  /**
   * Resolves an OSN profile id to its account id (server-to-server, ARC) for
   * the optional guest account-linking POST. When omitted, the link endpoint
   * answers 503 — linking is an additive, opt-in surface, so a deployment
   * without an ARC key simply doesn't offer it. Tests inject a stub.
   */
  resolveOsnAccountId?: OsnAccountResolver;
  /**
   * Resolves an OSN handle to a profile id (server-to-server, ARC) for the
   * add-co-host POST. When omitted, the add-host endpoint answers 503 — adding
   * hosts by handle is additive, so a deployment without an ARC key simply
   * doesn't offer it (listing + removing existing hosts still work). Tests
   * inject a stub.
   */
  resolveOsnProfileByHandle?: OsnHandleResolver;
  /**
   * Cloudflare Turnstile verifier (bot protection) for the public guest
   * surfaces (claim + rsvp). KEY-OPTIONAL: `null`/omitted ⇒ the
   * `TURNSTILE_SECRET_KEY` secret is unset and the gates are skipped (guest
   * flow unchanged). A verifier ⇒ claim + rsvp require a valid Turnstile token
   * and fail-closed. Built once per isolate in `index.ts`; tests inject a stub.
   */
  turnstileVerifier?: TurnstileVerifier | null;
}

export function createApp(db: Db, options: AppOptions = {}) {
  const {
    webOrigin = "http://localhost:4321",
    allowedOrigins,
    claimLimiter = defaultClaimLimiter,
    accountLinkLimiter = defaultAccountLinkLimiter,
    inviteLimiter = defaultInviteLimiter,
    previewLimiter = defaultPreviewLimiter,
    weddingCreateLimiter = defaultWeddingCreateLimiter,
    hostLimiter = defaultHostLimiter,
    r2,
    assets,
    images,
    osnJwksUrl = "http://localhost:4000/.well-known/jwks.json",
    osnAudience = "osn-access",
    osnTestKey,
    resolveOsnAccountId,
    resolveOsnProfileByHandle,
    turnstileVerifier = null,
  } = options;
  const corsOrigins = allowedOrigins ?? [webOrigin];

  const osnAuthOptions = {
    jwksUrl: osnJwksUrl,
    audience: osnAudience,
    _testKey: osnTestKey,
  };

  return (
    // `aot: false` — Elysia's ahead-of-time compilation builds handlers via
    // `new Function`, which Cloudflare Workers forbids (no dynamic code
    // evaluation). The dynamic handler is plenty for this API's traffic.
    new Elysia({ aot: false })
      .use(
        cors({
          // Echo the request origin verbatim when it's in the allowlist — never
          // `*` — so the browser will include credentials. Any mismatch gets no
          // `Access-Control-Allow-Origin` header.
          origin: corsOrigins,
          // DELETE: account-link unlink + invite image reset. PUT: invite text save.
          methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
          allowedHeaders: ["Content-Type", "Authorization"],
          credentials: true,
        }),
      )
      .onError(({ code, error, set }) => {
        if (code === "NOT_FOUND") {
          set.status = 404;
          return { error: "Not found" };
        }
        // S-M1: Elysia's default error renderer puts `error.message` in the
        // response body, which leaks internals (D1 error strings, Effect
        // causes, table names) to callers — the claim endpoint is pre-auth.
        // Log the detail, return a generic body.
        runCireSync(
          Effect.logError("unhandled request error", {
            code,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        set.status = 500;
        return { error: "Internal error" };
      })
      // C5 / S-L3: CSRF origin guard on every state-changing method, using the
      // same allowlist CORS echoes. Mounted before the route factories so it
      // gates the whole app. Empty allowlist (dev) disables it.
      .use(originGuard(corsOrigins))
      .use(createClaimRoutes(db, { webOrigin, limiter: claimLimiter, turnstileVerifier }))
      .use(createRsvpRoutes(db, { turnstileVerifier }))
      .use(createOrganiserWeddingsRoutes(db, osnAuthOptions))
      .use(createOrganiserWeddingCreateRoute(db, osnAuthOptions, weddingCreateLimiter))
      .use(createOrganiserPreviewRoutes(db, osnAuthOptions, previewLimiter))
      // Co-host management. Reads (list hosts) admit owner OR co-host; writes
      // (add/remove) are owner-only and behind a per-IP limiter — split into
      // sibling instances so the read isn't gated by the write limiter.
      .use(createOrganiserHostsReadRoutes(db, osnAuthOptions))
      .use(
        createOrganiserHostsWriteRoutes(db, osnAuthOptions, hostLimiter, resolveOsnProfileByHandle),
      )
      .use(createOrganiserImportRoutes(db, r2, osnAuthOptions))
      // Invite builder. Public reads (guest site) + organiser writes split into
      // sibling instances so the guest GET isn't behind osnAuth.
      .use(createInvitePublicRoutes(db, assets, images))
      .use(createInviteOrganiserRoutes(db, assets, osnAuthOptions, inviteLimiter))
      // Account linking. Two sibling instances on the same prefix: GET/DELETE
      // need only the guest session; the POST link additionally requires an OSN
      // token. Splitting them is what method-gates `osnAuth` to POST without
      // gating the guest-only reads (same sibling pattern as rsvp + organiser).
      .use(createAccountLinkRoutes(db, accountLinkLimiter))
      .use(
        createAccountLinkPostRoute(
          db,
          osnAuthOptions,
          accountLinkLimiter,
          resolveOsnAccountId,
          webOrigin,
        ),
      )
  );
}
