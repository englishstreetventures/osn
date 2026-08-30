import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { DbLive, type Db } from "@pulse/db/service";
import { healthRoutes, observabilityPlugin } from "@shared/observability";
import type { OidcConfig } from "@shared/osn-auth-client/oidc-rp";
import type { ClientIpOptions } from "@shared/rate-limit";
import type { Layer } from "effect";
import { Elysia } from "elysia";

import type { OsnTokenVerification } from "./lib/jwks";
import { originGuard } from "./lib/origin-guard";
import { makeMemoryRateLimiters, type PulseRateLimiters } from "./redis";
import { createAccountRoutes } from "./routes/account";
import { createAuthRoutes } from "./routes/auth";
import { createCloseFriendsRoutes } from "./routes/closeFriends";
import { createEventsRoutes } from "./routes/events";
import { createInternalRoutes } from "./routes/internal";
import { createOnboardingRoutes } from "./routes/onboarding";
import { createSeriesRoutes } from "./routes/series";
import { createSettingsRoutes } from "./routes/settings";
import { createVenuesRoutes } from "./routes/venues";

export const SERVICE_NAME = "pulse-api";

export interface AppOptions {
  /**
   * DB service layer. Defaults to the bun:sqlite `local` layer (dev + tests);
   * the Workers entry (`index.ts`) passes `makeDbD1Live(env.DB)` for the
   * `dev` / `staging` / `prod` environments.
   */
  dbLayer?: Layer.Layer<Db>;
  /** JWKS endpoint of the OSN issuer that signs access tokens. */
  verification?: OsnTokenVerification;
  /**
   * Rate limiter backends (W4). The composition root (`local.ts` long-lived
   * Bun host, or the per-isolate `index.ts` Worker) builds these from Redis
   * when `REDIS_URL` is configured and falls back to in-memory counters
   * otherwise. Omitted → in-memory limiters built here (tests / local).
   */
  rateLimiters?: PulseRateLimiters;
  /**
   * Client-IP trust policy (S-M34) for the per-IP limiters on the
   * unauthenticated discover / share / exposure surfaces. The composition
   * root derives this from `PULSE_TRUSTED_PROXY_COUNT` (or `trustCloudflare`
   * behind CF). Defaults to `{}` — direct mode, socket peer only.
   */
  clientIpConfig?: Omit<ClientIpOptions, "socketIp">;
  /**
   * CORS allowlist (P3). Replaces the bare `cors()` wildcard. The composition
   * root resolves + fail-closed-validates this via `lib/cors-config`. Omitted
   * → wildcard `cors()` (tests only).
   */
  corsOrigins?: string[];
  /**
   * OIDC relying-party config for browser sign-in. `null`/omitted ⇒ the tier
   * has no OSN client credentials, and `/api/auth/oidc/*` answers with the
   * `sign_in_unavailable` marker instead of half-starting a flow. The
   * composition root builds it from env (see `lib/oidc.ts` for the HMAC info).
   */
  oidc?: OidcConfig | null;
  /** Cookie `Secure` flag — true on every https tier, false for local http. */
  secureCookies?: boolean;
  /**
   * Absolute URL of the Pulse web login page. Terminal sign-in failures with
   * no trusted `return_to` land here with an `?auth_error` marker. Defaults to
   * the local web app.
   */
  loginFallbackUrl?: string;
  /**
   * Whether to mount the `@elysiajs/openapi` plugin — the Scalar UI at
   * `/openapi` and the document at `/openapi/json`. Defaults to `true`, which
   * is right for tests, local dev and `scripts/generate-openapi.ts` (which
   * boots this app to fetch its own document).
   *
   * The Workers entry passes `false` on every deployed tier except `dev`. The
   * document is a complete map of every route, parameter and error shape, and
   * nothing reads it at runtime — `shared/openapi/pulse.json` is committed and
   * the generated clients are built from that file — so serving it from a
   * public host only hands out reconnaissance. The entry derives the flag from
   * the request-scoped `OSN_ENV` binding, never `process.env`, which workerd
   * leaves empty during module evaluation.
   */
  includeOpenapi?: boolean;
}

/**
 * Compose the Pulse Elysia app. Factored out of the entry points so the same
 * graph runs on Bun.serve (`local.ts`, bun:sqlite) and on Cloudflare Workers
 * (`index.ts`, D1), with only the injected DB layer + rate-limiter backends
 * differing. Each route factory accepts the `dbLayer` and its rate limiters,
 * so the local/prod switch is purely a matter of the arguments threaded here.
 */
export function createApp(options: AppOptions = {}) {
  const {
    dbLayer = DbLive,
    verification,
    rateLimiters = makeMemoryRateLimiters(),
    clientIpConfig = {},
    corsOrigins,
    oidc = null,
    secureCookies = false,
    loginFallbackUrl = "http://localhost:1420/",
    includeOpenapi = true,
  } = options;

  const { write, discovery, share, exposure, authStart, authSession } = rateLimiters;

  const base =
    // `aot: false` — Elysia's ahead-of-time compilation builds handlers via
    // `new Function`, which Cloudflare Workers forbid (no dynamic code eval).
    new Elysia({ aot: false })
      .use(corsOrigins ? cors({ origin: corsOrigins, credentials: true }) : cors())
      .use(observabilityPlugin({ serviceName: SERVICE_NAME }))
      // CSRF guard for the cookie-authenticated surface — mounted before any
      // route factory so it gates the whole app. Only fires when the request
      // carries `pulse_web_session`; see `lib/origin-guard.ts` for why Pulse
      // cannot guard every state-changing request the way cire does.
      .use(originGuard(corsOrigins ?? []))
      .use(healthRoutes({ serviceName: SERVICE_NAME }))
      .get("/", () => ({ status: "ok", service: SERVICE_NAME }));

  // Mounted in the same position either way: the plugin renders from the
  // finished route table, so the document is identical wherever it sits, but a
  // fixed position keeps the committed `shared/openapi/pulse.json` byte-stable.
  const withDocs = includeOpenapi
    ? base.use(
        openapi({
          documentation: {
            openapi: "3.1.0",
            info: { title: "Pulse API", version: "1.0.0" },
            components: {
              securitySchemes: {
                bearerAuth: {
                  type: "http",
                  scheme: "bearer",
                  bearerFormat: "JWT",
                },
              },
            },
          },
          exclude: {
            paths: [
              "/",
              "/health",
              "/ready",
              "/internal/register-service",
              "/internal/service-keys/:keyId",
              "/internal/account-deleted",
              "/internal/account-export",
            ],
          },
        }),
      )
    : base;

  return withDocs
    .use(
      createAuthRoutes(dbLayer, {
        oidc,
        secureCookies,
        loginFallbackUrl,
        startLimiter: authStart,
        sessionLimiter: authSession,
        clientIpConfig,
      }),
    )
    .use(
      createEventsRoutes(
        dbLayer,
        verification,
        undefined,
        discovery,
        share,
        exposure,
        {
          eventCreate: write.event_create,
          eventUpdate: write.event_update,
          rsvpUpsert: write.rsvp_upsert,
          eventInvite: write.event_invite,
          commsBlast: write.comms_blast,
        },
        clientIpConfig,
      ),
    )
    .use(
      createSeriesRoutes(dbLayer, verification, undefined, {
        seriesCreate: write.series_create,
        seriesUpdate: write.series_update,
      }),
    )
    .use(createVenuesRoutes(dbLayer, verification))
    .use(createSettingsRoutes(dbLayer, verification))
    .use(createCloseFriendsRoutes(dbLayer, verification, undefined, write.close_friend_mutate))
    .use(createOnboardingRoutes(dbLayer, verification))
    .use(createAccountRoutes(dbLayer, verification))
    .use(createInternalRoutes(dbLayer));
}

export type App = ReturnType<typeof createApp>;
