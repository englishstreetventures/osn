import type { DesignMeta } from "@cire/invite-designs";
import { cors } from "@elysiajs/cors";
import { EmailService, makeLogEmailLive } from "@shared/email";
import type { SendEmailInput } from "@shared/email";
import { createFeatureFlags } from "@shared/feature-flags";
import type { FeatureFlags } from "@shared/feature-flags";
import { createRateLimiter } from "@shared/rate-limit";
import type { RateLimiterBackend } from "@shared/rate-limit";
import type { TurnstileVerifier } from "@shared/turnstile";
import { Effect, Layer } from "effect";
import { Elysia } from "elysia";

import type { Db } from "./db";
import { originGuard } from "./lib/origin-guard";
import { runCireSync } from "./observability";
import { createAccountLinkPostRoute, createAccountLinkRoutes } from "./routes/account-link";
import { createBudgetReadRoutes, createBudgetWriteRoutes } from "./routes/budget";
import { createClaimRoutes } from "./routes/claim";
import { createCspReportRoutes } from "./routes/csp-report";
import { createInviteOrganiserRoutes, createInvitePublicRoutes } from "./routes/invite";
import { createOrganiserChangeRoutes } from "./routes/organiser-changes";
import { createOrganiserEnquiriesRoutes } from "./routes/organiser-enquiries";
import { createOrganiserHandleSearchRoutes } from "./routes/organiser-handle-search";
import {
  createOrganiserHostsReadRoutes,
  createOrganiserHostsWriteRoutes,
} from "./routes/organiser-hosts";
import { createOrganiserRsvpRoutes } from "./routes/organiser-rsvp";
import { createOrganiserSettingsRoutes } from "./routes/organiser-settings";
import {
  createOrganiserExportRoutes,
  createOrganiserPreviewRoutes,
  createOrganiserRemintRoutes,
  createOrganiserWeddingCreateRoute,
  createOrganiserWeddingsRoutes,
} from "./routes/organiser-weddings";
import { createPaymentWebhookSkeleton } from "./routes/payment-webhook";
import { createPrimaryWeddingRoutes } from "./routes/primary-wedding";
import { createRsvpRoutes } from "./routes/rsvp";
import { createTaskReadRoutes, createTaskWriteRoutes } from "./routes/tasks";
import {
  createVendorDirectoryReadRoutes,
  createVendorDirectoryWriteRoutes,
} from "./routes/vendor-directory";
import { createVendorEnquiriesRoutes } from "./routes/vendor-enquiries";
import { createVendorPortalRoutes } from "./routes/vendor-portal";
import { createVendorReadRoutes, createVendorWriteRoutes } from "./routes/vendors";
import { createDirectoryService } from "./services/directory";
import { createEnquiryService } from "./services/enquiries";
import type { AssetsBucket } from "./services/invite-assets";
import type { ImagesBindingLike } from "./services/invite-image-transform";
import type {
  OsnAccountResolver,
  OsnHandleResolver,
  OsnHandleSearchResolver,
  OsnOrgMembershipResolver,
  OsnProfileDisplayResolver,
  OsnProfileOrgsResolver,
} from "./services/osn-bridge";
import type { R2Bucket } from "./services/r2-imports";
import type { ZapChatClient } from "./services/zap-bridge";

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
 * Default per-USER limiter for the CSV + JSON RSVP export routes (CSV-S-L1).
 * An authenticated organiser (or a compromised organiser token) could otherwise
 * loop these reads and burn D1 read quota / Worker CPU on the Free tier.
 * 10 exports/min is generous for hand-use while capping the D1 amplifier.
 * Keys on `osnProfileId` (not IP) so each organiser has an independent bucket.
 */
const defaultExportLimiter = createRateLimiter({ maxRequests: 10, windowMs: 60_000 });
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
 * Default per-IP limiter for the vendor portal routes (S-L1). Covers both the
 * unauthenticated claim preview (DB-query amplifier) and the ARC-calling consume
 * endpoint; 20 req/min is generous for hand-use while bounding amplification.
 */
const defaultVendorPortalLimiter = createRateLimiter({ maxRequests: 20, windowMs: 60_000 });
/**
 * Default per-IP limiter for the PUBLIC CSP report collector. The endpoint is
 * unauthenticated (browsers POST here with no creds), so this is a generous
 * bucket purely to cap a log-spam DoS — a real visitor emits a handful of
 * reports per page load. Fail-OPEN at the route (a limiter miss just drops the
 * report; it still 204s).
 */
const defaultCspReportLimiter = createRateLimiter({ maxRequests: 60, windowMs: 60_000 });
/**
 * Default per-USER limiter for the vendor directory browse route. 60 reads/min
 * is generous for a paginated listing UI while capping the D1 query amplifier
 * from a scripted caller with a valid organiser token.
 */
const defaultDirectoryLimiter = createRateLimiter({ maxRequests: 60, windowMs: 60_000 });
/**
 * Default per-USER limiter for the couple-side enquiry write routes (Vendors S4,
 * spam control §96). An authenticated organiser opening/replying to vendor
 * threads drives an ARC-signed S2S provision + message into zap-api plus a
 * transactional email — 20 writes/min is generous for hand-use while capping the
 * amplifier. Keys on `osnProfileId` so each organiser has an independent bucket.
 */
const defaultEnquiryLimiter = createRateLimiter({ maxRequests: 20, windowMs: 60_000 });

export interface AppOptions {
  /** Primary origin (used for the session cookie's `secure` flag). */
  webOrigin?: string;
  /**
   * Organiser portal origin (`host.cireweddings.com`) — base for the enquiry
   * thread deep-link vendors/couples receive. Distinct from `webOrigin` (the
   * guest invite site). Defaults to the prod organiser origin.
   */
  organiserOrigin?: string;
  /**
   * Vendor portal origin (`vendor.cireweddings.com`) — base for the vendor
   * claim link (`/claim?token=…`). Threaded into the default directory service
   * so dev/staging tiers mint claim URLs on the correct host. Ignored when a
   * `directoryService` instance is injected. Defaults to the prod vendor origin.
   */
  vendorPortalOrigin?: string;
  /** Extra origins allowed by CORS (organiser portal, etc). Defaults to `[webOrigin]`. */
  allowedOrigins?: string[];
  /** Override the claim rate limiter (useful for testing). */
  claimLimiter?: RateLimiterBackend;
  /** Override the account-link rate limiter (useful for testing). */
  accountLinkLimiter?: RateLimiterBackend;
  /** Override the CSV + JSON RSVP export per-user rate limiter (useful for testing). */
  exportLimiter?: RateLimiterBackend;
  /** Override the invite-builder write rate limiter (useful for testing). */
  inviteLimiter?: RateLimiterBackend;
  /** Test seam: override the invite design catalog (e.g. to add a premium fixture). */
  inviteDesigns?: readonly DesignMeta[];
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
  /** Override the vendor portal rate limiter (useful for testing). */
  vendorPortalLimiter?: RateLimiterBackend;
  /** Override the vendor directory browse per-user rate limiter (useful for testing). */
  directoryLimiter?: RateLimiterBackend;
  /**
   * Phase-2 seam: mount the inert payment-webhook skeleton only when this is
   * `true`. Defaults to `false` — the route is NOT exposed unless explicitly
   * enabled. In Phase 2 the provider implementation replaces the skeleton body;
   * flipping this flag is the only change needed in production config.
   */
  paymentWebhookEnabled?: boolean;
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
  /**
   * Directory service for vendor listing + claim flow. Defaults to the
   * singleton `directoryService` (prod config). Tests inject a stub with a
   * local `vendorPortalOrigin`.
   */
  directoryService?: ReturnType<typeof createDirectoryService>;
  /**
   * Email transport layer for vendor claim-invite emails. Defaults to
   * `LogEmailLive` (no network). Tests inject their own `LogEmailLive`
   * instance; production index.ts injects `ResendEmailLive` when
   * `RESEND_API_KEY` is set.
   */
  emailLayer?: Layer.Layer<EmailService>;
  /**
   * Resolves whether an OSN profile is a member of an org (server-to-server,
   * ARC) for the vendor portal org-gate. When omitted, the vendor portal
   * routes answer 403 for all org-gated requests (fail-closed — no ARC key
   * means no vendor portal access). Tests inject a stub.
   */
  orgMembership?: OsnOrgMembershipResolver;
  /**
   * Resolves the org ids an OSN profile belongs to (server-to-server, ARC,
   * `org:read`). Scopes the vendor enquiry LIST query to the caller's own
   * tenants before the scan. When omitted, the list route fails closed (empty
   * list — no cross-tenant scan). Tests inject a stub.
   */
  profileOrgs?: OsnProfileOrgsResolver;
  /**
   * Zap c2b chat client for the couple-side enquiry routes (Vendors S4).
   * KEY-OPTIONAL: `null`/omitted ⇒ the ZAP_API_URL/ARC config is absent and the
   * enquiry routes still mount, but open/reply against a claimed listing answer
   * 503 (`ZapUnavailable`). Built once per isolate in `index.ts` via
   * `createZapChatClientFromEnv`; tests inject an in-memory fake.
   */
  enquiryZapClient?: ZapChatClient | null;
  /**
   * Email transport layer for enquiry notifications (enquiry-new / -reply /
   * -quote). Defaults to the vendor email layer (`emailLayer` ?? LogEmailLive),
   * so a deployment with `RESEND_API_KEY` dispatches for real and tests capture
   * in-memory. The enquiry service wraps `EmailService.send` with error channel
   * `never` (a broken transport logs a warning, never fails the enquiry).
   */
  enquiryEmailLayer?: Layer.Layer<EmailService>;
  /** Override the couple-side enquiry write rate limiter (useful for testing). */
  enquiryLimiter?: RateLimiterBackend;
  /**
   * GrowthBook feature-flag provider, decorated onto the request context as
   * `flags` so any route can do `await flags.forRequest({ id }).then(f =>
   * f.isOn("cire.some-flag"))`. KEY-OPTIONAL: omitted ⇒ a provider that serves
   * every flag's coded default from the registry with zero network (the state
   * before a GrowthBook account exists). Built once per isolate in `index.ts`
   * from `GROWTHBOOK_CLIENT_KEY` + the optional `KV_GB_PAYLOAD` cache; tests
   * inject a stub or rely on the default.
   */
  flags?: FeatureFlags;
}

export function createApp(db: Db, options: AppOptions = {}) {
  const {
    webOrigin = "http://localhost:4321",
    organiserOrigin = "https://host.cireweddings.com",
    vendorPortalOrigin = "https://vendor.cireweddings.com",
    allowedOrigins,
    claimLimiter = defaultClaimLimiter,
    accountLinkLimiter = defaultAccountLinkLimiter,
    exportLimiter = defaultExportLimiter,
    inviteLimiter = defaultInviteLimiter,
    inviteDesigns,
    previewLimiter = defaultPreviewLimiter,
    weddingCreateLimiter = defaultWeddingCreateLimiter,
    remintLimiter = defaultRemintLimiter,
    hostLimiter = defaultHostLimiter,
    handleSearchLimiter = defaultHandleSearchLimiter,
    cspReportLimiter = defaultCspReportLimiter,
    vendorPortalLimiter = defaultVendorPortalLimiter,
    directoryLimiter = defaultDirectoryLimiter,
    paymentWebhookEnabled = false,
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
    directoryService: directoryServiceOption,
    emailLayer: emailLayerOption,
    orgMembership,
    profileOrgs,
    enquiryZapClient = null,
    enquiryEmailLayer: enquiryEmailLayerOption,
    enquiryLimiter = defaultEnquiryLimiter,
    // Key-optional default: an inert provider that serves registry defaults with
    // no network, so an app built without GrowthBook config behaves exactly as
    // it did before flags existed.
    flags = createFeatureFlags({}),
  } = options;
  const corsOrigins = allowedOrigins ?? [webOrigin];

  // Vendor CRM deps — use injected instances (tests) or module-level defaults
  // (production). The email layer defaults to LogEmailLive so tests that don't
  // inject one still work without network access.
  const vendorDirectoryService =
    directoryServiceOption ?? createDirectoryService({ vendorPortalOrigin });
  const vendorEmailLayer = emailLayerOption ?? makeLogEmailLive().layer;
  // Fail-closed default: no ARC key means no org membership can be verified.
  const vendorOrgMembership = orgMembership ?? (() => Promise.resolve(null));
  // Fail-closed default: no ARC key ⇒ caller resolves to no orgs ⇒ the vendor
  // enquiry list is empty (never an unscoped cross-tenant scan).
  const vendorProfileOrgs = profileOrgs ?? (() => Promise.resolve([]));

  // Couple-side enquiry BFF service (Vendors S4). Its zap client + email sender
  // are injected (tests) or built from env (index.ts). The email layer reuses the
  // vendor email layer unless a dedicated one is supplied. `sendEmail` is
  // pre-wrapped with error channel `never`: an `EmailError` is caught, logged as
  // a warning, and swallowed so a broken transport never fails an enquiry.
  const enquiryEmailLayer = enquiryEmailLayerOption ?? vendorEmailLayer;
  const enquirySendEmail = (msg: SendEmailInput): Effect.Effect<void, never, never> =>
    EmailService.pipe(
      Effect.flatMap((email) => email.send(msg)),
      Effect.provide(enquiryEmailLayer),
      Effect.catchAll((error) =>
        Effect.logWarning("[enquiries] email send failed — swallowing", {
          template: msg.template,
          reason: error.reason,
        }),
      ),
      Effect.catchAllDefect((cause) =>
        Effect.logWarning("[enquiries] email send defected — swallowing", {
          template: msg.template,
          reason: String(cause),
        }),
      ),
    );
  const enquiryService = createEnquiryService({
    zap: enquiryZapClient,
    sendEmail: enquirySendEmail,
    // Organiser portal thread deep-link base. The enquiry thread is an
    // ORGANISER surface, so it must live on the organiser origin
    // (host.cireweddings.com) — NOT `webOrigin`, which is the guest invite site.
    threadBaseUrl: `${organiserOrigin.replace(/\/+$/, "")}/vendors/enquiries`,
  });

  const osnAuthOptions = {
    jwksUrl: osnJwksUrl,
    audience: osnAudience,
    _testKey: osnTestKey,
  };

  // Capture the chain so we can conditionally mount the payment webhook below.
  const app =
    // `aot: false` — Elysia's ahead-of-time compilation builds handlers via
    // `new Function`, which Cloudflare Workers forbids (no dynamic code
    // evaluation). The dynamic handler is plenty for this API's traffic.
    new Elysia({ aot: false })
      // Feature flags on the request context. Routes call
      // `await flags.forRequest({ id }).then(f => f.isOn("cire.some-flag"))`.
      // Decorated (not derived) — one provider per isolate; the per-request
      // attribute binding happens in `forRequest`.
      .decorate("flags", flags)
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
      .use(createOrganiserExportRoutes(db, osnAuthOptions, exportLimiter))
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
      // General change API (guest+event editor E4). Both front doors
      // (DesiredState JSON + `{eventsCsv, guestsCsv}`) funnel into one pipeline.
      // Mounted at TWO prefixes over the same factory: `changes` (canonical) and
      // `import` (a one-release alias so existing clients keep working; deleted
      // next release — see [[api]] TODO). Both serve identically.
      .use(createOrganiserChangeRoutes(db, r2, osnAuthOptions, "changes"))
      .use(createOrganiserChangeRoutes(db, r2, osnAuthOptions, "import"))
      // Wedding-profile Settings (platform Phase 0). Reads admit owner OR
      // co-host; the profile save is owner-only. No event location config —
      // an event's place is its free-text `address` (the sole location source).
      .use(createOrganiserSettingsRoutes(db, osnAuthOptions))
      // Organiser-recorded RSVPs (platform Phase 0). Editor records a
      // phone/paper RSVP on a guest's behalf into the SAME `rsvps` table the
      // invite writes to (upsert, last-writer-wins); stamped
      // `consent_source='organiser_attested'`. weddingEditor()-gated.
      .use(createOrganiserRsvpRoutes(db, osnAuthOptions))
      // Checklist tasks (platform Phase 1). Reads admit any member role
      // (weddingMember); writes require editor or owner (weddingEditor; viewer
      // gets 403 read_only_role). Split into sibling instances so the read gate
      // never cross-contaminates with the write gate.
      .use(createTaskReadRoutes(db, osnAuthOptions))
      .use(createTaskWriteRoutes(db, osnAuthOptions))
      .use(createBudgetReadRoutes(db, osnAuthOptions))
      .use(createBudgetWriteRoutes(db, osnAuthOptions))
      // Vendor CRM (platform Phase 1). Reads admit any member role (weddingMember);
      // writes require editor or owner (weddingEditor; viewer gets 403
      // read_only_role). Split into sibling instances so the read gate never
      // cross-contaminates with the write gate. Write factory carries
      // directoryService + emailLayer for the list-in-directory endpoint.
      .use(createVendorReadRoutes(db, osnAuthOptions))
      .use(
        createVendorWriteRoutes(db, osnAuthOptions, {
          directoryService: vendorDirectoryService,
          emailLayer: vendorEmailLayer,
        }),
      )
      // Vendor directory browse (platform Phase 2, Vendors Slice 1). Admits
      // any wedding member (weddingMember). Per-user rate limiter to cap the
      // D1 query amplifier from scripted callers with valid organiser tokens.
      .use(createVendorDirectoryReadRoutes(db, osnAuthOptions, directoryLimiter))
      // Vendor directory add-from-directory write route (platform Phase 2).
      // weddingEditor-gated (viewer gets 403 read_only_role).
      .use(createVendorDirectoryWriteRoutes(db, osnAuthOptions, directoryLimiter))
      // Couple-side vendor enquiries (Vendors S4). Reads (list + messages) admit
      // any member (weddingMember); writes (open / reply / add-to-budget) require
      // editor or owner (weddingEditor; viewer → 403 read_only_role) behind a
      // per-user limiter. The enquiry service was built once above with its zap
      // client + email sender; if zap is null, open/reply degrade to 503.
      .use(
        createOrganiserEnquiriesRoutes(db, osnAuthOptions, {
          enquiryService,
          limiter: enquiryLimiter,
          directoryService: vendorDirectoryService,
        }),
      )
      // Invite builder. Public reads (guest site) + organiser writes split into
      // sibling instances so the guest GET isn't behind osnAuth.
      .use(createInvitePublicRoutes(db, assets, images))
      .use(createInviteOrganiserRoutes(db, assets, osnAuthOptions, inviteLimiter, inviteDesigns))
      // Account linking. Two sibling instances on the same prefix: GET/DELETE
      // need only the guest session; the POST link additionally requires an OSN
      // token. Splitting them is what method-gates `osnAuth` to POST without
      // gating the guest-only reads (same sibling pattern as rsvp + organiser).
      .use(createAccountLinkRoutes(db, accountLinkLimiter, flags))
      .use(
        createAccountLinkPostRoute(
          db,
          osnAuthOptions,
          accountLinkLimiter,
          flags,
          resolveOsnAccountId,
          webOrigin,
        ),
      )
      // Vendor-facing portal: listing self-management + claim redemption.
      // Mounted at /api/vendor (NOT under the wedding/organiser group). The
      // enquiry service is threaded in so a successful claim flushes any
      // enquiries buffered against the just-claimed listing (onVendorClaimed).
      .use(
        createVendorPortalRoutes(
          db,
          {
            directoryService: vendorDirectoryService,
            orgMembership: vendorOrgMembership,
            enquiryService,
          },
          osnAuthOptions,
          vendorPortalLimiter,
        ),
      )
      // Vendor-side enquiry routes (Vendors S4): list + thread + reply + quote,
      // mounted at /api/vendor. osnAuth()-gated; the per-enquiry org gate
      // resolves the owning org from the enquiry's listing and 404s on a
      // cross-tenant id (no enumeration). Writes behind the shared per-user
      // enquiry limiter.
      .use(
        createVendorEnquiriesRoutes(db, osnAuthOptions, {
          enquiryService,
          orgMembership: vendorOrgMembership,
          profileOrgs: vendorProfileOrgs,
          limiter: enquiryLimiter,
        }),
      );
  // Phase-2 seam: mount the inert payment-webhook skeleton ONLY when the flag
  // is explicitly set. Default is false — the POST /api/payments/webhook route
  // is never reachable unless a deployment opts in. This keeps Phase 1 safe
  // (no unverified endpoint is ever exposed by default).
  //
  // `app` is widened to a bare `Elysia` (via `unknown`) before the final
  // conditional mount: adding the vendor-enquiry routes above grew the fluent
  // chain's inferred type to the point where threading it through one more
  // `.use()` tips TS past its instantiation-depth limit (TS2589). Erasing the
  // accumulated route-type surface here caps the depth; it's runtime-inert
  // (`.use()` only needs an Elysia instance) and scoped to this final mount.
  const rootApp = app as unknown as Elysia;
  return paymentWebhookEnabled ? rootApp.use(createPaymentWebhookSkeleton()) : rootApp;
}
