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
import { createCspReportRoutes } from "./routes/csp-report";
import { createInviteOrganiserRoutes, createInvitePublicRoutes } from "./routes/invite";
import { createOrganiserHandleSearchRoutes } from "./routes/organiser-handle-search";
import {
  createOrganiserHostsReadRoutes,
  createOrganiserHostsWriteRoutes,
} from "./routes/organiser-hosts";
import { createOrganiserImportRoutes } from "./routes/organiser-import";
import { createOrganiserSettingsRoutes } from "./routes/organiser-settings";
import {
  createOrganiserPreviewRoutes,
  createOrganiserRemintRoutes,
  createOrganiserWeddingCreateRoute,
  createOrganiserWeddingsRoutes,
} from "./routes/organiser-weddings";
import { createPrimaryWeddingRoutes } from "./routes/primary-wedding";
import { createRsvpRoutes } from "./routes/rsvp";
import type { Geocoder } from "./services/geocode";
import type { AssetsBucket } from "./services/invite-assets";
import type { ImagesBindingLike } from "./services/invite-image-transform";
import type {
  OsnAccountResolver,
  OsnHandleResolver,
  OsnHandleSearchResolver,
  OsnProfileDisplayResolver,
} from "./services/osn-bridge";
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
 * Default per-IP limiter for the organiser remint + mark-shared endpoints (C3).
 * Owner-gated already, so this just caps the destructive bulk-write amplifier
 * (remint rotates every family code + revokes sessions) and the high-frequency
 * mark-shared writes; 30/min is generous for hand-driving the dashboard.
 */
const defaultRemintLimiter = createRateLimiter({ maxRequests: 30, windowMs: 60_000 });
/**
 * Default per-IP limiter for the co-host add/remove endpoints (S-L1). Owner-gated
 * already, so this just caps the ARC-sign + S2S handle-resolve amplifier on add
 * (and the management churn / handle-probe oracle); 20/min is generous for
 * hand-managing a wedding's hosts.
 */
const defaultHostLimiter = createRateLimiter({ maxRequests: 20, windowMs: 60_000 });
/**
 * Default per-IP limiter for the co-host handle-search autocomplete (S-L1).
 * osnAuth-gated already, so this just caps the per-keystroke ARC-sign + S2S
 * amplifier (the route debounces client-side, but a scripted caller wouldn't);
 * 60/min is generous for hand-typing a handle while bounding the amplification.
 */
const defaultHandleSearchLimiter = createRateLimiter({ maxRequests: 60, windowMs: 60_000 });
/**
 * Default per-IP limiter for the Settings geocode endpoint. Member-gated
 * (owner OR co-host — it serves the member-editable event locations), so this
 * just caps the billed upstream Geocoding calls an authenticated organiser can
 * drive; 20/min is generous for hand-looking-up a handful of event venues.
 */
const defaultGeocodeLimiter = createRateLimiter({ maxRequests: 20, windowMs: 60_000 });
/**
 * Default per-IP limiter for the PUBLIC CSP report collector. The endpoint is
 * unauthenticated (browsers POST here with no creds), so this is a generous
 * bucket purely to cap a log-spam DoS — a real visitor emits a handful of
 * reports per page load. Fail-OPEN at the route (a limiter miss just drops the
 * report; it still 204s).
 */
const defaultCspReportLimiter = createRateLimiter({ maxRequests: 60, windowMs: 60_000 });

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
  /** Override the remint + mark-shared rate limiter (useful for testing). */
  remintLimiter?: RateLimiterBackend;
  /** Override the co-host add/remove rate limiter (useful for testing). */
  hostLimiter?: RateLimiterBackend;
  /** Override the co-host handle-search rate limiter (useful for testing). */
  handleSearchLimiter?: RateLimiterBackend;
  /** Override the public CSP-report collector rate limiter (useful for testing). */
  cspReportLimiter?: RateLimiterBackend;
  /** Override the Settings geocode rate limiter (useful for testing). */
  geocodeLimiter?: RateLimiterBackend;
  /**
   * Key-optional server-side geocoder for the wedding Settings form.
   * `null`/omitted ⇒ the `GOOGLE_GEOCODING_API_KEY` secret is unset and the
   * geocode endpoint answers `unavailable` — the form falls back to manual
   * lat/lng entry, so the profile works with no third-party flow at all.
   * Built once per isolate in `index.ts`; tests inject a stub.
   */
  geocoder?: Geocoder | null;
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
   * Batch-resolves OSN profile ids to display metadata (handle + display name,
   * server-to-server over ARC) so the host-list GET shows handles instead of
   * raw profile ids. KEY-OPTIONAL + FAIL-SOFT: when omitted (no ARC key) or
   * unreachable, the list degrades to showing profile ids — never a 503/500.
   * Tests inject a stub.
   */
  resolveOsnProfileDisplays?: OsnProfileDisplayResolver;
  /**
   * Suggests OSN profiles whose handle starts with a typed prefix (server-to-
   * server over ARC) for the add-co-host autocomplete. KEY-OPTIONAL + FAIL-SOFT:
   * when omitted (no ARC key) or unreachable, the search route returns an empty
   * list — autocomplete suggests nothing, the manual add path is unaffected, and
   * it never 503/500s. Tests inject a stub.
   */
  resolveOsnHandleSearch?: OsnHandleSearchResolver;
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
    remintLimiter = defaultRemintLimiter,
    hostLimiter = defaultHostLimiter,
    handleSearchLimiter = defaultHandleSearchLimiter,
    cspReportLimiter = defaultCspReportLimiter,
    geocodeLimiter = defaultGeocodeLimiter,
    geocoder = null,
    r2,
    assets,
    images,
    osnJwksUrl = "http://localhost:4000/.well-known/jwks.json",
    osnAudience = "osn-access",
    osnTestKey,
    resolveOsnAccountId,
    resolveOsnProfileByHandle,
    resolveOsnProfileDisplays,
    resolveOsnHandleSearch,
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
        //
        // OBS-S-L2: log only NON-SENSITIVE identifiers — the Elysia error
        // `code`, the error `name`, and (for `Data.TaggedError` defects) the
        // tagged `_tag`. We deliberately do NOT log the free-form
        // `error.message`: `redact()` scrubs by object KEY, not by substring
        // inside a string value, so a rare unhandled message echoing guest
        // input or a D1 internal would land verbatim in operator logs. The
        // name/_tag are enough to triage the failure class without that risk.
        const errorName = error instanceof Error ? error.name : typeof error;
        const errorTag =
          typeof error === "object" && error !== null && "_tag" in error
            ? String((error as { _tag: unknown })._tag)
            : undefined;
        runCireSync(
          Effect.logError("unhandled request error", {
            code,
            name: errorName,
            ...(errorTag ? { tag: errorTag } : {}),
          }),
        );
        set.status = 500;
        return { error: "Internal error" };
      })
      // Public CSP violation-report collector. Mounted BEFORE the origin guard:
      // browsers POST CSP reports as an automated, creds-less request with a
      // cross-origin (or null) `Origin` and no claim code, so the CSRF origin
      // guard would 403 every real report. The route is unauthenticated, does no
      // D1 write, and always 204s — there is no state to protect here. (Elysia
      // `onBeforeHandle({ as: "global" })` applies to routes mounted after it on
      // the chain, so ordering this `.use` first keeps the guard off this route.)
      .use(createCspReportRoutes({ limiter: cspReportLimiter }))
      // C5 / S-L3: CSRF origin guard on every state-changing method, using the
      // same allowlist CORS echoes. Mounted before the route factories so it
      // gates the whole app. Empty allowlist (dev) disables it.
      .use(originGuard(corsOrigins))
      // Public bare-domain resolver for the guest site (`/` → /<slug>). No auth
      // — the slug is the public invite URL. Mounted first so it's plainly a
      // public read alongside the guest claim + invite routes.
      .use(createPrimaryWeddingRoutes(db))
      .use(createClaimRoutes(db, { webOrigin, limiter: claimLimiter, turnstileVerifier }))
      // No Turnstile on RSVP: guests reach it only with a valid `cire_session`
      // cookie minted by a Turnstile-gated `/api/claim`, so a second bot check
      // here is pure friction. Claim + organiser login keep the gate.
      .use(createRsvpRoutes(db))
      .use(createOrganiserWeddingsRoutes(db, osnAuthOptions))
      .use(createOrganiserWeddingCreateRoute(db, osnAuthOptions, weddingCreateLimiter))
      .use(createOrganiserPreviewRoutes(db, osnAuthOptions, previewLimiter))
      .use(createOrganiserRemintRoutes(db, osnAuthOptions, remintLimiter))
      // Co-host management. Reads (list hosts) admit owner OR co-host; writes
      // (add/remove) are owner-only and behind a per-IP limiter — split into
      // sibling instances so the read isn't gated by the write limiter.
      .use(createOrganiserHostsReadRoutes(db, osnAuthOptions, resolveOsnProfileDisplays))
      .use(
        createOrganiserHostsWriteRoutes(db, osnAuthOptions, hostLimiter, resolveOsnProfileByHandle),
      )
      // Co-host handle autocomplete. osnAuth-only (not wedding-scoped) — any
      // signed-in organiser can search handles while typing a co-host. Sibling
      // instance so its limiter doesn't gate the host read/write routes.
      .use(
        createOrganiserHandleSearchRoutes(
          osnAuthOptions,
          handleSearchLimiter,
          resolveOsnHandleSearch,
        ),
      )
      .use(createOrganiserImportRoutes(db, r2, osnAuthOptions))
      // Wedding-profile Settings + per-event locations (platform Phase 0).
      // Reads admit owner OR co-host; the profile save is owner-only; the
      // event-location PUT and the geocode POST are member-level (location is
      // schedule data, like the import), with the geocode behind a per-IP
      // limiter (billed upstream call).
      .use(createOrganiserSettingsRoutes(db, osnAuthOptions, { geocoder, geocodeLimiter }))
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
